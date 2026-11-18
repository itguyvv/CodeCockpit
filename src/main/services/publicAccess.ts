import { BrowserWindow } from 'electron'
import { randomBytes } from 'node:crypto'
import dgram from 'node:dgram'
import NatAPI from '@silentbot1/nat-api'

// ── Public reachability: publish the remote server on the local router ──
//
// UPnP/NAT-PMP opens an inbound TCP mapping for the remote port; STUN discovers
// the reflexive public IP for display and diagnosis (CGNAT / double NAT). The
// mapping lives entirely on the user's own router — no server-side infra, and
// the same TLS + auth stack guards the now internet-exposed endpoint.

export type PublicState = 'off' | 'discovering' | 'mapped' | 'failed'
export type PublicMethod = 'upnp' | 'natpmp' | 'manual-forward' | 'unavailable'

export interface PublicStatus {
  enabled: boolean
  state: PublicState
  method: PublicMethod
  publicIp: string
  publicPort: number
  /** External IP reported by the gateway, when UPnP/NAT-PMP answered */
  gatewayIp: string
  /** Public IP seen by the STUN server (the outermost NAT) */
  reflexiveIp: string
  cgnat: boolean
  /** Machine-readable failure key for the UI: '' | cgnat | double_nat | no_upnp | error */
  reason: string
}

// Two complementary public STUN servers, named in the settings UI so users know
// who sees the probe: Cloudflare (anycast, global) and Xiaomi (stable in China).
// Queries go out only while Any-network access is enabled.
const STUN_SERVERS = ['stun.cloudflare.com:3478', 'stun.miwifi.com:3478']
const STUN_TIMEOUT_MS = 4_000
const MAP_TIMEOUT_MS = 8_000
const MAP_TTL_S = 1_800
/** Public ports to try when the preferred one is taken on the router */
const PORT_ATTEMPTS = 6
const VERIFY_INTERVAL_MS = 20 * 60_000

// RFC 1918 + loopback + link-local + CGNAT (100.64/10) — an "external" IP in any
// of these ranges means there is no real public IP behind it
const NON_PUBLIC_IPV4 =
  /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/

function isPrivateIp(ip: string): boolean {
  return NON_PUBLIC_IPV4.test(ip)
}

interface MappingAttempt {
  client: NatAPI
  method: 'upnp' | 'natpmp'
  gatewayIp: string
  publicPort: number
  privatePort: number
}

let status: PublicStatus = {
  enabled: false,
  state: 'off',
  method: 'unavailable',
  publicIp: '',
  publicPort: 0,
  gatewayIp: '',
  reflexiveIp: '',
  cgnat: false,
  reason: ''
}

/** Invalidates in-flight enable/refresh work when stop or a new enable lands */
let generation = 0
let active: MappingAttempt | null = null
let verifyFails = 0
let verifyTimer: NodeJS.Timeout | null = null

function notifyWindows(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send(channel, payload)
  }
}

function setStatus(patch: Partial<PublicStatus>): void {
  status = { ...status, ...patch }
  notifyWindows('remote:public', status)
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out`)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e: unknown) => {
        clearTimeout(t)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    )
  })
}

// ── Minimal STUN client (RFC 5389) ──
// The npm `stun` package bundles its internals under src/node_modules and
// require()s them by bare name — electron-builder strips that from the asar,
// so the packaged app crashed on startup. We only need one exchange: send a
// Binding Request, read XOR-MAPPED-ADDRESS from the reply.

const MAGIC_COOKIE = 0x2112a44b

function parseXorMappedAddress(buf: Buffer, txid: Buffer): string | null {
  if (buf.length < 20 || buf.readUInt16BE(0) !== 0x0101) return null // Binding success response
  if (!buf.subarray(8, 20).equals(txid)) return null
  let off = 20
  const end = Math.min(20 + buf.readUInt16BE(2), buf.length)
  while (off + 4 <= end) {
    const attr = buf.readUInt16BE(off)
    const alen = buf.readUInt16BE(off + 2)
    if (attr === 0x0020 && alen >= 8 && buf[off + 5] === 0x01) {
      // XOR-MAPPED-ADDRESS, family IPv4: address is XORed with the magic cookie
      const ip = buf.readUInt32BE(off + 8) ^ MAGIC_COOKIE
      return `${(ip >>> 24) & 0xff}.${(ip >>> 16) & 0xff}.${(ip >>> 8) & 0xff}.${ip & 0xff}`
    }
    off += 4 + ((alen + 3) & ~3)
  }
  return null
}

function stunQuery(server: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const idx = server.lastIndexOf(':')
    const host = idx > 0 ? server.slice(0, idx) : server
    const port = idx > 0 ? Number(server.slice(idx + 1)) : 3478
    const txid = randomBytes(12)
    const msg = Buffer.alloc(20)
    msg.writeUInt16BE(0x0001, 0) // Binding Request
    msg.writeUInt32BE(MAGIC_COOKIE, 4)
    txid.copy(msg, 8)

    const sock = dgram.createSocket('udp4')
    let settled = false
    const finish = (err: Error | null, ip?: string): void => {
      if (settled) return
      settled = true
      try {
        sock.close(() => {})
      } catch {
        // Already closed
      }
      if (err) reject(err)
      else resolve(ip as string)
    }
    const timer = setTimeout(() => finish(new Error('stun timeout')), timeoutMs)
    sock.once('error', (e) => {
      clearTimeout(timer)
      finish(e)
    })
    sock.once('message', (buf) => {
      const ip = parseXorMappedAddress(buf, txid)
      if (ip) {
        clearTimeout(timer)
        finish(null, ip)
      }
    })
    sock.send(msg, port, host, (e) => {
      if (e) {
        clearTimeout(timer)
        finish(e)
      }
    })
  })
}

/** Reflexive public IP via the first STUN server to answer; '' when none do */
async function stunReflexiveIp(): Promise<string> {
  try {
    return await Promise.any(STUN_SERVERS.map((s) => stunQuery(s, STUN_TIMEOUT_MS)))
  } catch {
    return ''
  }
}

/**
 * One NAT protocol, end to end. NAT-PMP is a direct UDP exchange with the
 * gateway (fails fast without one); UPnP needs SSDP discovery, the step most
 * likely to hang on broken networks — hence the hard timeout and destroy().
 */
async function attemptMap(port: number, enablePMP: boolean): Promise<MappingAttempt> {
  const client = new NatAPI({
    enablePMP,
    enableUPNP: !enablePMP,
    upnpPermanentFallback: true,
    ttl: MAP_TTL_S,
    autoUpdate: true
  })
  let mapped = false
  try {
    const gatewayIp = await withTimeout(client.externalIp(), MAP_TIMEOUT_MS, 'external ip')
    let lastErr: unknown = null
    for (let p = port; p < port + PORT_ATTEMPTS; p++) {
      try {
        await withTimeout(
          client.map({ publicPort: p, privatePort: port, protocol: 'TCP' }),
          MAP_TIMEOUT_MS,
          'map'
        )
        mapped = true
        return { client, method: enablePMP ? 'natpmp' : 'upnp', gatewayIp, publicPort: p, privatePort: port }
      } catch (e) {
        lastErr = e // Port taken on the router — try the next one
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('no available public port')
  } finally {
    if (!mapped) client.destroy().catch(() => {}) // Release the SSDP socket + autoUpdate timer
  }
}

async function mapPort(port: number): Promise<MappingAttempt> {
  let lastErr: unknown = null
  for (const enablePMP of [true, false]) {
    try {
      return await attemptMap(port, enablePMP)
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('port mapping failed')
}

async function unmapAttempt(attempt: MappingAttempt | null): Promise<void> {
  if (!attempt) return
  try {
    await withTimeout(
      attempt.client.unmap({ publicPort: attempt.publicPort, privatePort: attempt.privatePort, protocol: 'TCP' }),
      3_000,
      'unmap'
    )
  } catch {
    // The lease expires on its own; never block on it
  }
  try {
    await withTimeout(attempt.client.destroy(), 3_000, 'destroy')
  } catch {
    // Ignore
  }
}

export function publicStatus(): PublicStatus {
  return status
}

/** Enable: discover, map, classify. Fire-and-forget; watch `remote:public` or poll publicStatus() */
export async function startPublicAccess(port: number): Promise<void> {
  if (status.enabled && status.state === 'mapped' && status.publicPort === port) return
  await stopPublicAccess(true)
  const gen = ++generation
  setStatus({
    enabled: true,
    state: 'discovering',
    method: 'unavailable',
    publicIp: '',
    publicPort: port,
    gatewayIp: '',
    reflexiveIp: '',
    cgnat: false,
    reason: ''
  })

  const reflexiveIp = await stunReflexiveIp()
  if (gen !== generation) return

  let attempt: MappingAttempt | null = null
  try {
    attempt = await mapPort(port)
    if (gen !== generation) {
      await unmapAttempt(attempt)
      return
    }
    active = attempt
    verifyFails = 0
  } catch {
    attempt = null
  }

  const gatewayIp = attempt?.gatewayIp ?? ''
  const reflexivePublic = !!reflexiveIp && !isPrivateIp(reflexiveIp)
  const gatewayPublic = !!gatewayIp && !isPrivateIp(gatewayIp)

  if (attempt && gatewayPublic && reflexivePublic && gatewayIp !== reflexiveIp) {
    // The router accepted the mapping, but an outer NAT (typically ISP CGNAT)
    // sits in front — inbound from the internet cannot reach it either way
    await unmapAttempt(attempt)
    if (gen !== generation) return
    active = null
    setStatus({
      state: 'failed',
      method: 'unavailable',
      gatewayIp,
      reflexiveIp,
      reason: 'double_nat'
    })
    scheduleVerify()
    return
  }

  if (attempt) {
    setStatus({
      state: 'mapped',
      method: attempt.method,
      publicIp: gatewayIp,
      publicPort: attempt.publicPort,
      gatewayIp,
      reflexiveIp,
      cgnat: !gatewayPublic,
      reason: ''
    })
    scheduleVerify()
    return
  }

  if (reflexivePublic) {
    // Router refused automation, but the machine still has a public IP — the
    // user can forward the port by hand and use the reflexive address
    setStatus({
      state: 'failed',
      method: 'manual-forward',
      publicIp: reflexiveIp,
      publicPort: port,
      reflexiveIp,
      reason: 'no_upnp'
    })
    return
  }

  const cgnat = (!!gatewayIp && isPrivateIp(gatewayIp)) || (!!reflexiveIp && isPrivateIp(reflexiveIp))
  setStatus({
    state: 'failed',
    method: 'unavailable',
    publicPort: port,
    reason: cgnat ? 'cgnat' : 'error'
  })
}

/** Disable: unmap + destroy, never throws. `unmap=false` for quit-time best effort */
export async function stopPublicAccess(unmap = true): Promise<void> {
  generation++
  if (verifyTimer) {
    clearTimeout(verifyTimer)
    verifyTimer = null
  }
  const attempt = active
  active = null
  verifyFails = 0
  if (attempt && unmap) {
    try {
      await withTimeout(
        attempt.client.unmap({
          publicPort: attempt.publicPort,
          privatePort: attempt.privatePort,
          protocol: 'TCP'
        }),
        3_000,
        'unmap'
      )
    } catch {
      // The lease expires on its own
    }
  }
  if (attempt) {
    try {
      await withTimeout(attempt.client.destroy(), 3_000, 'destroy')
    } catch {
      // Ignore
    }
  }
  setStatus({
    enabled: false,
    state: 'off',
    method: 'unavailable',
    publicIp: '',
    publicPort: 0,
    gatewayIp: '',
    reflexiveIp: '',
    cgnat: false,
    reason: ''
  })
}

function scheduleVerify(): void {
  if (verifyTimer) clearTimeout(verifyTimer)
  verifyTimer = setTimeout(verifyLoop, VERIFY_INTERVAL_MS)
}

/**
 * nat-api's autoUpdate renews the lease; this loop catches public-IP changes
 * and dead routers. Two consecutive dead verifies flip to failed.
 */
async function verifyLoop(): Promise<void> {
  verifyTimer = null
  if (!status.enabled || !active) return
  const gen = generation
  try {
    const gatewayIp = await withTimeout(active.client.externalIp(), MAP_TIMEOUT_MS, 'external ip')
    const reflexiveIp = await stunReflexiveIp()
    if (gen !== generation || !active) return
    verifyFails = 0
    const publicIp = gatewayIp && !isPrivateIp(gatewayIp) ? gatewayIp : status.publicIp
    if (publicIp !== status.publicIp || reflexiveIp !== status.reflexiveIp || status.state !== 'mapped') {
      setStatus({ publicIp, gatewayIp, reflexiveIp, state: 'mapped', reason: '' })
    }
  } catch {
    verifyFails++
    if (verifyFails >= 2) setStatus({ state: 'failed', reason: 'error' })
  }
  if (status.enabled && generation === gen) scheduleVerify()
}
