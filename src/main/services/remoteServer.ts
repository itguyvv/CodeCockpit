import { BrowserWindow, dialog } from 'electron'
import https from 'node:https'
import type { IncomingMessage } from 'node:http'
import crypto from 'node:crypto'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { WebSocketServer, WebSocket } from 'ws'
import selfsigned from 'selfsigned'
import { dataFile, writeFileAtomic, writeJsonAtomic } from './dataDir'
import { t } from './i18n'
import { IS_WIN } from './platform'
import { getMessages, onMessages, type RemoteMessage } from './conversation'
import {
  createSession,
  deleteHistorySession,
  getStatus,
  killSession,
  listNativeSessions,
  listSummaries,
  onSessionEvent,
  renameSession,
  setMode,
  writeInput,
  type PermissionMode
} from './sessionManager'
import { isEngineId, type EngineId } from './engines'

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

/** Constant-time comparison of two same-purpose hex digests (auth inputs are attacker-visible) */
function digestEq(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf-8')
  const bb = Buffer.from(b, 'utf-8')
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb)
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
    if (c.authed) c.tr.close()
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
    if (c.authed && c.tokenHash === tokenHash) c.tr.close()
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

/**
 * Global unicast (2000::/3) IPv6 addresses, dialable from another network. Excludes
 * link-local (fe80::), ULA fc00::/7 — which also covers Tailscale's fd7a:: range — and ::1.
 * The listener binds :: (dual-stack), so these are reachable on the same port as IPv4.
 */
export function remoteIpv6Info(): Array<{ address: string; iface: string }> {
  const out: Array<{ address: string; iface: string }> = []
  for (const [iface, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv6' || a.internal) continue
      const first = parseInt(a.address.split(':')[0] ?? '', 16)
      if (!(first >= 0x2000 && first <= 0x3fff)) continue
      out.push({ address: a.address, iface })
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

/** The protocol layer only sees this interface; JSON message handling is transport-agnostic */
export interface RemoteTransport {
  /** Stable key for logs and the auth-failure ban map, e.g. 'ws:1.2.3.4' */
  id(): string
  send(data: string): void
  close(): void
  isOpen(): boolean
  onData(cb: (data: string) => void): void
  onClose(cb: () => void): void
}

function wrapWs(ws: WebSocket, ip: string): RemoteTransport {
  return {
    id: () => `ws:${ip}`,
    send: (data) => ws.send(data),
    close: () => ws.close(),
    isOpen: () => ws.readyState === WebSocket.OPEN,
    onData: (cb) => ws.on('message', (data) => cb(String(data))),
    onClose: (cb) => ws.on('close', () => cb())
  }
}

interface ClientCtx {
  tr: RemoteTransport
  authed: boolean
  tokenHash: string
  attached: Set<string>
  authTimer?: NodeJS.Timeout
}

const clients = new Set<ClientCtx>()
/** Auth failures per transport identity: n = fails in the current window, until = ban deadline, at = last fail */
const failLog = new Map<string, { n: number; until: number; at: number }>()

let server: https.Server | null = null
let wss: WebSocketServer | null = null
let runningPort = 0
let unsubConv: (() => void) | null = null
let unsubEvents: (() => void) | null = null

/**
 * Port-taken notice set before the renderer is listening; the renderer pulls it
 * on mount so a startup conflict is not lost, cleared once delivered.
 */
let pendingPortTaken: number | null = null

export function consumePendingPortTaken(): number | null {
  const p = pendingPortTaken
  pendingPortTaken = null
  return p
}

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
  if (c.tr.isOpen()) c.tr.send(JSON.stringify(msg))
}

function sendAttached(sessionId: string, msg: Record<string, unknown>): void {
  for (const c of clients) {
    if (c.authed && c.attached.has(sessionId)) sendTo(c, msg)
  }
}

/** Push the session list to every authed client (create/kill/rename mutate it unseen) */
function broadcastSessions(): void {
  const msg = JSON.stringify({ type: 'sessions', sessions: listSummaries() })
  for (const c of clients) {
    if (c.authed && c.tr.isOpen()) c.tr.send(msg)
  }
}

/** Starts the listener; false = port busy (user-facing toast is pushed from here) */
// ── Stale-instance takeover: when the remote port is held by another copy of
// this very app, offer a one-click kill + retry. Verified by PID + exe name,
// user-confirmed, single retry — never a silent kill. ──

function execCapture(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout)))
  })
}

/** PID of the process listening on the port, or null */
async function findListenerPid(port: number): Promise<number | null> {
  if (!IS_WIN) return null
  const out = await execCapture('netstat', ['-ano', '-p', 'TCP'])
  for (const line of out.split('\n')) {
    const cols = line.trim().split(/\s+/)
    // TCP  0.0.0.0:47315  0.0.0.0:0  LISTENING  1234
    if (cols.length >= 5 && cols[3] === 'LISTENING' && cols[1].endsWith(`:${port}`)) {
      const pid = parseInt(cols[cols.length - 1], 10)
      if (Number.isInteger(pid) && pid > 0) return pid
    }
  }
  return null
}

async function processImagePath(pid: number): Promise<string> {
  return (await execCapture('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).Path`])).trim()
}

/** Port busy → if the holder is another copy of this app, ask to kill it and retry */
async function offerStaleKill(port: number): Promise<boolean> {
  if (!IS_WIN) return false
  const pid = await findListenerPid(port)
  if (pid == null) return false
  const img = path.basename(await processImagePath(pid)).toLowerCase()
  const mine = path.basename(process.execPath).toLowerCase()
  console.log(`[remote] port ${port} held by pid ${pid} (${img}); this exe: ${mine}`)
  if (!img || img !== mine) return false
  const { response } = await dialog.showMessageBox({
    type: 'question',
    title: t('remote.staleTitle'),
    message: t('remote.staleMessage', { port, pid }),
    buttons: [t('remote.staleKill'), t('common.cancel')],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  })
  if (response !== 0) return false
  const killed = await execCapture('taskkill', ['/PID', String(pid), '/F'])
  console.log(`[remote] taskkill ${pid}: ${killed.trim() || 'no output'}`)
  // One retry without re-offering so a second failure falls back to the toast
  return startRemote(port, { offerKill: false })
}

/** Starts the listener; false = port busy (user-facing toast is pushed from here) */
export async function startRemote(
  port = DEFAULT_REMOTE_PORT,
  opts: { offerKill?: boolean } = {}
): Promise<boolean> {
  if (server) return true
  loadAuth() // Materialize the secret before anything can connect
  const { key, cert } = await ensureCert()
  const srv = https.createServer({ key, cert })
  const pool = new WebSocketServer({ server: srv, maxPayload: 1024 * 1024 })
  pool.on('connection', (ws, req) => onConnection(ws, req))
  // ws re-emits the HTTP server's 'error' on the pool; without a consumer the
  // EventEmitter throws synchronously and the app crashes on port conflicts
  pool.on('error', () => {})
  srv.on('error', () => {
    // Port taken / listener dropped — surface as stopped; the settings tab polls remoteState
    stopRemote()
  })
  // Await the bind so callers can tell "running" from "port taken" before linking
  const bound = await new Promise<boolean>((resolve) => {
    const onUp = (): void => {
      srv.off('error', onErr)
      runningPort = (srv.address() as { port: number }).port
      resolve(true)
    }
    const onErr = (): void => {
      srv.off('listening', onUp)
      console.log(`[remote] bind failed on port ${port}`)
      try {
        srv.close()
      } catch {
        // handle already gone
      }
      // Offer to kill a leftover instance of ourselves; otherwise surface a toast
      void (opts.offerKill === false ? Promise.resolve(false) : offerStaleKill(port)).then((restarted) => {
        if (!restarted) {
          pendingPortTaken = port
          notifyWindows('remote:event', { kind: 'port_taken', name: String(port) })
        }
      })
      resolve(false)
    }
    srv.once('listening', onUp)
    srv.once('error', onErr)
    srv.listen(port, '0.0.0.0')
  })
  if (!bound) return false
  server = srv
  wss = pool
  cachedFp = ''
  console.log(`[remote] listening on port ${runningPort}`)
  // Conversation stream: every recorded batch goes to clients attached to that session
  unsubConv = onMessages((sessionId, msgs) => {
    sendAttached(sessionId, { type: 'conv_append', id: sessionId, messages: msgs })
  })
  // Session events mirror the renderer broadcasts
  unsubEvents = onSessionEvent((channel, payload) => {
    const p = payload as Record<string, unknown>
    const id = typeof p.id === 'string' ? p.id : ''
    if (!id) return
    if (channel === 'pty:busy') {
      sendAttached(id, { type: 'busy', id, busy: p.busy === true, bg: p.bg ?? 0 })
      // Busy flips are low-frequency; refreshing the list keeps every client's
      // sidebar state (dots + badges) in sync without waiting for a re-list
      broadcastSessions()
    }
    else if (channel === 'pty:status') sendAttached(id, { type: 'status', id, status: p.status })
    else if (channel === 'pty:exit') {
      sendAttached(id, { type: 'exit', id, code: p.exitCode })
      for (const c of clients) c.attached.delete(id)
      broadcastSessions()
    } else if (channel === 'pty:session-id') sendAttached(id, { type: 'session_id', id, claudeSessionId: p.claudeSessionId })
  })
  return true
}

export function stopRemote(): void {
  unsubConv?.()
  unsubEvents?.()
  unsubConv = null
  unsubEvents = null
  for (const c of clients) c.tr.close()
  clients.clear()
  wss?.close()
  server?.close()
  wss = null
  server = null
  runningPort = 0
  notifyWindows('remote:clients', { count: 0 })
}

function addClient(tr: RemoteTransport): void {
  const ctx: ClientCtx = { tr, authed: false, tokenHash: '', attached: new Set() }
  clients.add(ctx)
  ctx.authTimer = setTimeout(() => {
    tr.close() // Never authenticated within the window — drop the connection
  }, AUTH_WINDOW_MS)
  tr.onData((data) => {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(data) as Record<string, unknown>
    } catch {
      return
    }
    try {
      handleMessage(ctx, msg)
    } catch {
      sendTo(ctx, { type: 'error', message: 'internal error' })
    }
  })
  tr.onClose(() => {
    if (ctx.authTimer) clearTimeout(ctx.authTimer)
    clients.delete(ctx)
    if (ctx.authed) notifyWindows('remote:clients', { count: authedCount() })
  })
}

function onConnection(ws: WebSocket, req: IncomingMessage): void {
  addClient(wrapWs(ws, req.socket.remoteAddress ?? ''))
}

function handleMessage(ctx: ClientCtx, msg: Record<string, unknown>): void {
  const type = msg.type
  if (type === 'ping') {
    sendTo(ctx, { type: 'pong' })
    return
  }
  if (type === 'auth') return handleAuth(ctx, msg)
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
      // A TUI classifies one large chunk ending in \r as a pasted multi-line insert,
      // so the Enter never submits (observed on claude). Real keyboards emit Enter as
      // its own chunk — split it off to match that shape.
      if (data.length > 1 && data.endsWith('\r')) {
        writeInput(id, data.slice(0, -1))
        setTimeout(() => writeInput(id, '\r'), 30)
      } else {
        writeInput(id, data)
      }
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
    return
  }
  if (type === 'create') {
    void handleCreate(ctx, msg)
    return
  }
  if (type === 'kill') {
    const id = typeof msg.id === 'string' ? msg.id : ''
    if (id) {
      killSession(id)
      broadcastSessions()
    }
    return
  }
  if (type === 'rename') {
    const id = typeof msg.id === 'string' ? msg.id : ''
    const title = typeof msg.title === 'string' ? msg.title : ''
    if (!id || !title.trim()) return
    // renameSession keys on the engine-native id, not the desktop session id
    const native = listSummaries().find((s) => s.id === id)?.claudeSessionId
    if (!native) {
      sendTo(ctx, { type: 'error', message: 'unknown session' })
      return
    }
    renameSession(native, title)
    broadcastSessions()
    return
  }
  if (type === 'history') {
    const engine: EngineId = isEngineId(msg.engine) ? msg.engine : 'claude'
    const limit = typeof msg.limit === 'number' ? msg.limit : 100
    sendTo(ctx, { type: 'history', engine, sessions: listNativeSessions(engine, limit) })
    return
  }
  if (type === 'delete_history') {
    const id = typeof msg.id === 'string' ? msg.id : ''
    if (!id) return
    const engine: EngineId = isEngineId(msg.engine) ? msg.engine : 'claude'
    deleteHistorySession(id)
    sendTo(ctx, { type: 'history', engine, sessions: listNativeSessions(engine, 100) })
    return
  }
}

const MODES: readonly string[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions']

/** create from a remote client: unlike the local IPC path, a bad cwd is rejected, not silently replaced */
async function handleCreate(ctx: ClientCtx, msg: Record<string, unknown>): Promise<void> {
  const cwd = typeof msg.cwd === 'string' ? msg.cwd.trim() : ''
  const mode = typeof msg.mode === 'string' && MODES.includes(msg.mode) ? (msg.mode as PermissionMode) : 'default'
  const engine: EngineId = isEngineId(msg.engine) ? msg.engine : 'claude'
  const title = typeof msg.title === 'string' ? msg.title : ''
  const resumeId = typeof msg.resumeId === 'string' && msg.resumeId ? msg.resumeId : undefined
  if (!cwd || !fs.existsSync(cwd)) {
    sendTo(ctx, { type: 'error', message: 'cwd not found' })
    return
  }
  try {
    const { id } = await createSession({ cwd, mode, engine, title, resumeId })
    sendTo(ctx, { type: 'session_created', id })
    broadcastSessions()
  } catch (e) {
    sendTo(ctx, { type: 'error', message: e instanceof Error ? e.message : 'create failed' })
  }
}

function handleAuth(ctx: ClientCtx, msg: Record<string, unknown>): void {
  const peer = ctx.tr.id()
  const ban = failLog.get(peer)
  if (ban && ban.until > Date.now()) {
    sendTo(ctx, { type: 'auth_fail', reason: 'banned' })
    ctx.tr.close()
    return
  }
  const auth = loadAuth()
  const name = String(typeof msg.name === 'string' ? msg.name : '').trim().slice(0, 40) || 'Device'
  const token = typeof msg.token === 'string' ? msg.token : ''
  const secret = typeof msg.secret === 'string' ? msg.secret : ''
  const ok = token
    ? auth.devices.some((d) => digestEq(d.tokenHash, sha256(token)))
    : secret !== '' && digestEq(sha256(secret), auth.secretHash)
  if (!ok) {
    // Internet exposure invites scanners: keep the per-peer failure map bounded
    const now = Date.now()
    if (failLog.size > 200) {
      for (const [k, v] of failLog) {
        if (v.until < now && now - v.at > FAIL_BAN_MS) failLog.delete(k)
      }
    }
    const rec = failLog.get(peer) ?? { n: 0, until: 0, at: now }
    rec.n++
    rec.at = now
    if (rec.n >= MAX_FAILS) {
      rec.until = Date.now() + FAIL_BAN_MS
      rec.n = 0
    }
    failLog.set(peer, rec)
    sendTo(ctx, { type: 'auth_fail', reason: token ? 'bad_token' : 'bad_secret' })
    ctx.tr.close()
    return
  }
  failLog.delete(peer)
  if (authedCount() >= MAX_CLIENTS) {
    sendTo(ctx, { type: 'auth_fail', reason: 'too_many_clients' })
    ctx.tr.close()
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
