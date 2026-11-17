import { BrowserWindow } from 'electron'
import https from 'node:https'
import crypto from 'node:crypto'
import os from 'node:os'
import fs from 'node:fs'
import { WebSocketServer, WebSocket } from 'ws'
import selfsigned from 'selfsigned'
import { dataFile, writeFileAtomic, writeJsonAtomic } from './dataDir'
import { getMessages, onMessages, type RemoteMessage } from './conversation'
import {
  getStatus,
  listSummaries,
  onSessionEvent,
  setMode,
  writeInput,
  type PermissionMode
} from './sessionManager'

// ── Persisted state: pairing secret + paired devices (hashes only on disk) ──

interface DeviceEntry {
  tokenHash: string
  name: string
  addedAt: number
  lastSeen: number
}

interface RemoteAuth {
  /** Plaintext secret, shown on the pairing page over local IPC only */
  secret: string
  secretHash: string
  devices: DeviceEntry[]
}

const sha256 = (s: string): string => crypto.createHash('sha256').update(s, 'utf-8').digest('hex')

function newSecret(): string {
  return crypto.randomBytes(16).toString('hex')
}

function loadAuth(): RemoteAuth {
  try {
    const a = JSON.parse(fs.readFileSync(dataFile('remote-auth.json'), 'utf-8')) as RemoteAuth
    if (a.secret && a.secretHash && Array.isArray(a.devices)) return a
  } catch {
    // First run — generate below
  }
  const fresh: RemoteAuth = { secret: newSecret(), secretHash: '', devices: [] }
  fresh.secretHash = sha256(fresh.secret)
  saveAuth(fresh)
  return fresh
}

function saveAuth(a: RemoteAuth): void {
  writeJsonAtomic(dataFile('remote-auth.json'), a)
}

export function getRemoteSecret(): string {
  return loadAuth().secret
}

export function listRemoteDevices(): DeviceEntry[] {
  return loadAuth().devices
}

/** Regenerate the secret and drop every paired device (they must pair again) */
export function regenerateRemoteSecret(): string {
  const a = loadAuth()
  a.secret = newSecret()
  a.secretHash = sha256(a.secret)
  a.devices = []
  saveAuth(a)
  for (const c of clients) {
    if (c.authed) c.ws.close()
  }
  return a.secret
}

export function revokeRemoteDevice(tokenHash: string): boolean {
  const a = loadAuth()
  const before = a.devices.length
  a.devices = a.devices.filter((d) => d.tokenHash !== tokenHash)
  if (a.devices.length === before) return false
  saveAuth(a)
  for (const c of clients) {
    if (c.authed && c.tokenHash === tokenHash) c.ws.close()
  }
  return true
}

// ── Self-signed certificate (TOFU: the fingerprint is shown for manual comparison) ──

let cachedFp = ''

async function ensureCert(): Promise<{ key: string; cert: string }> {
  const keyFile = dataFile('remote-key.pem')
  const certFile = dataFile('remote-cert.pem')
  try {
    const key = fs.readFileSync(keyFile, 'utf-8')
    const cert = fs.readFileSync(certFile, 'utf-8')
    return { key, cert }
  } catch {
    // Generate below
  }
  const pems = await selfsigned.generate(
    [{ name: 'commonName', value: 'CodeCockpit' }],
    {
      keySize: 2048,
      notAfterDate: new Date(Date.now() + 3650 * 86_400_000),
      extensions: [
        {
          name: 'subjectAltName',
          altNames: [
            { type: 2, value: 'localhost' },
            { type: 7, ip: '127.0.0.1' }
          ]
        }
      ]
    }
  )
  writeFileAtomic(keyFile, pems.private)
  writeFileAtomic(certFile, pems.cert)
  return { key: pems.private, cert: pems.cert }
}

/** SHA-256 over the cert PEM, grouped 4×8 so a human can compare it on both ends */
export function remoteFingerprint(): string {
  if (cachedFp) return cachedFp
  try {
    const hex = sha256(fs.readFileSync(dataFile('remote-cert.pem'), 'utf-8'))
    const groups: string[] = []
    for (let i = 0; i < hex.length; i += 8) groups.push(hex.slice(i, i + 8))
    cachedFp = groups.join(' ')
  } catch {
    cachedFp = ''
  }
  return cachedFp
}

/** Non-internal IPv4 addresses; 100.64/10 (CGNAT) flagged as the usual Tailscale range */
export function remoteNetInfo(): Array<{ address: string; iface: string; tailscale: boolean }> {
  const out: Array<{ address: string; iface: string; tailscale: boolean }> = []
  const tsRange = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./
  for (const [iface, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue
      out.push({ address: a.address, iface, tailscale: tsRange.test(a.address) })
    }
  }
  return out
}

// ── Server lifecycle ──

export const DEFAULT_REMOTE_PORT = 47315

const MAX_CLIENTS = 4
const AUTH_WINDOW_MS = 10_000
const MAX_FAILS = 5
const FAIL_BAN_MS = 60_000

interface ClientCtx {
  ws: WebSocket
  authed: boolean
  tokenHash: string
  attached: Set<string>
  authTimer?: NodeJS.Timeout
}

const clients = new Set<ClientCtx>()
/** Auth failures per peer IP: n = fails in the current window, until = ban deadline, at = last fail */
const failLog = new Map<string, { n: number; until: number; at: number }>()

let server: https.Server | null = null
let wss: WebSocketServer | null = null
let runningPort = 0
let unsubConv: (() => void) | null = null
let unsubEvents: (() => void) | null = null

export function remoteRunning(): boolean {
  return server !== null
}

export function remotePort(): number {
  return runningPort
}

export function remoteClientCount(): number {
  return authedCount()
}

function authedCount(): number {
  let n = 0
  for (const c of clients) if (c.authed) n++
  return n
}

function notifyWindows(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send(channel, payload)
  }
}

function sendTo(c: ClientCtx, msg: Record<string, unknown>): void {
  if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg))
}

function sendAttached(sessionId: string, msg: Record<string, unknown>): void {
  for (const c of clients) {
    if (c.authed && c.attached.has(sessionId)) sendTo(c, msg)
  }
}

export async function startRemote(port = DEFAULT_REMOTE_PORT): Promise<void> {
  if (server) return
  loadAuth() // Materialize the secret before anything can connect
  const { key, cert } = await ensureCert()
  const srv = https.createServer({ key, cert })
  const pool = new WebSocketServer({ server: srv, maxPayload: 1024 * 1024 })
  pool.on('connection', (ws, req) => onConnection(ws, req.socket.remoteAddress ?? ''))
  srv.listen(port, '0.0.0.0', () => {
    runningPort = (srv.address() as { port: number }).port
  })
  srv.on('error', () => {
    // Port taken / listener dropped — surface as stopped; the settings tab polls remoteState
    stopRemote()
  })
  server = srv
  wss = pool
  cachedFp = ''
  // Conversation stream: every recorded batch goes to clients attached to that session
  unsubConv = onMessages((sessionId, msgs) => {
    sendAttached(sessionId, { type: 'conv_append', id: sessionId, messages: msgs })
  })
  // Session events mirror the renderer broadcasts
  unsubEvents = onSessionEvent((channel, payload) => {
    const p = payload as Record<string, unknown>
    const id = typeof p.id === 'string' ? p.id : ''
    if (!id) return
    if (channel === 'pty:busy') sendAttached(id, { type: 'busy', id, busy: p.busy === true, bg: p.bg ?? 0 })
    else if (channel === 'pty:status') sendAttached(id, { type: 'status', id, status: p.status })
    else if (channel === 'pty:exit') {
      sendAttached(id, { type: 'exit', id, code: p.exitCode })
      for (const c of clients) c.attached.delete(id)
    } else if (channel === 'pty:session-id') sendAttached(id, { type: 'session_id', id, claudeSessionId: p.claudeSessionId })
  })
}

export function stopRemote(): void {
  unsubConv?.()
  unsubEvents?.()
  unsubConv = null
  unsubEvents = null
  for (const c of clients) c.ws.close()
  clients.clear()
  wss?.close()
  server?.close()
  wss = null
  server = null
  runningPort = 0
  notifyWindows('remote:clients', { count: 0 })
}

function onConnection(ws: WebSocket, ip: string): void {
  const ctx: ClientCtx = { ws, authed: false, tokenHash: '', attached: new Set() }
  clients.add(ctx)
  ctx.authTimer = setTimeout(() => {
    ws.close() // Never authenticated within the window — drop the connection
  }, AUTH_WINDOW_MS)
  ws.on('message', (data) => {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(String(data)) as Record<string, unknown>
    } catch {
      return
    }
    try {
      handleMessage(ctx, ip, msg)
    } catch {
      sendTo(ctx, { type: 'error', message: 'internal error' })
    }
  })
  ws.on('close', () => {
    if (ctx.authTimer) clearTimeout(ctx.authTimer)
    clients.delete(ctx)
    if (ctx.authed) notifyWindows('remote:clients', { count: authedCount() })
  })
}

function handleMessage(ctx: ClientCtx, ip: string, msg: Record<string, unknown>): void {
  const type = msg.type
  if (type === 'ping') {
    sendTo(ctx, { type: 'pong' })
    return
  }
  if (type === 'auth') return handleAuth(ctx, ip, msg)
  if (!ctx.authed) {
    sendTo(ctx, { type: 'error', message: 'auth required' })
    return
  }
  if (type === 'list') {
    sendTo(ctx, { type: 'sessions', sessions: listSummaries() })
    return
  }
  if (type === 'attach' || type === 'detach') {
    const id = typeof msg.id === 'string' ? msg.id : ''
    if (!id) return
    if (type === 'detach') {
      ctx.attached.delete(id)
      return
    }
    ctx.attached.add(id)
    sendTo(ctx, { type: 'conv_snapshot', id, messages: getMessages(id) })
    const st = getStatus(id)
    if (st) sendTo(ctx, { type: 'status', id, status: st })
    return
  }
  if (type === 'input') {
    const id = typeof msg.id === 'string' ? msg.id : ''
    const data = typeof msg.data === 'string' ? msg.data : ''
    if (!id || !data) return
    try {
      writeInput(id, data)
    } catch (e) {
      sendTo(ctx, { type: 'error', message: e instanceof Error ? e.message : 'input failed' })
    }
    return
  }
  if (type === 'mode') {
    const id = typeof msg.id === 'string' ? msg.id : ''
    const mode = typeof msg.mode === 'string' ? (msg.mode as PermissionMode) : ''
    if (!id || !mode) return
    setMode(id, mode).catch((e: unknown) => {
      sendTo(ctx, { type: 'error', message: e instanceof Error ? e.message : 'mode switch failed' })
    })
  }
}

function handleAuth(ctx: ClientCtx, ip: string, msg: Record<string, unknown>): void {
  const ban = failLog.get(ip)
  if (ban && ban.until > Date.now()) {
    sendTo(ctx, { type: 'auth_fail', reason: 'banned' })
    ctx.ws.close()
    return
  }
  const auth = loadAuth()
  const name = String(typeof msg.name === 'string' ? msg.name : '').trim().slice(0, 40) || 'Device'
  const token = typeof msg.token === 'string' ? msg.token : ''
  const secret = typeof msg.secret === 'string' ? msg.secret : ''
  const ok = token
    ? auth.devices.some((d) => d.tokenHash === sha256(token))
    : secret && sha256(secret) === auth.secretHash
  if (!ok) {
    // Internet exposure invites scanners: keep the per-IP failure map bounded
    const now = Date.now()
    if (failLog.size > 200) {
      for (const [k, v] of failLog) {
        if (v.until < now && now - v.at > FAIL_BAN_MS) failLog.delete(k)
      }
    }
    const rec = failLog.get(ip) ?? { n: 0, until: 0, at: now }
    rec.n++
    rec.at = now
    if (rec.n >= MAX_FAILS) {
      rec.until = Date.now() + FAIL_BAN_MS
      rec.n = 0
    }
    failLog.set(ip, rec)
    sendTo(ctx, { type: 'auth_fail', reason: token ? 'bad_token' : 'bad_secret' })
    ctx.ws.close()
    return
  }
  failLog.delete(ip)
  if (authedCount() >= MAX_CLIENTS) {
    sendTo(ctx, { type: 'auth_fail', reason: 'too_many_clients' })
    ctx.ws.close()
    return
  }
  if (ctx.authTimer) clearTimeout(ctx.authTimer)
  ctx.authed = true
  let issued = ''
  if (!token) {
    // First pairing: mint a device token for reconnects
    issued = crypto.randomBytes(32).toString('hex')
    ctx.tokenHash = sha256(issued)
    auth.devices.push({ tokenHash: ctx.tokenHash, name, addedAt: Date.now(), lastSeen: Date.now() })
    saveAuth(auth)
    notifyWindows('remote:event', { kind: 'paired', name })
  } else {
    ctx.tokenHash = sha256(token)
    const dev = auth.devices.find((d) => d.tokenHash === ctx.tokenHash)
    if (dev) {
      dev.lastSeen = Date.now()
      saveAuth(auth)
    }
  }
  sendTo(ctx, { type: 'auth_ok', token: issued, fp: remoteFingerprint() })
  notifyWindows('remote:clients', { count: authedCount() })
}
