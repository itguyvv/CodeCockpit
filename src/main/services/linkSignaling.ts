import { WebSocket } from 'ws'
import type { IncomingMessage } from 'node:http'

export type LinkSignalState = 'off' | 'connecting' | 'online' | 'offline'

/** Why the last attempt failed and when the next one fires (epoch ms, 0 = unknown) */
export interface LinkSignalInfo {
  error: 'network' | 'rate_limited' | 'id_taken' | ''
  retryAt: number
}

/** Signaling relay frame; `data` carries SDP/ICE payloads verbatim */
export interface LinkSignalFrame {
  t: string
  cid?: string
  data?: unknown
}

interface LinkSignalingOpts {
  /** HTTP(S) base of the signaling worker, e.g. https://signal.example.dev */
  server: string
  linkId: string
  regKey: string
  onFrame: (f: LinkSignalFrame) => void
  onState: (s: LinkSignalState, info: LinkSignalInfo) => void
  /** 409 id_taken: this ID is claimed under a different registration key */
  onIdTaken: () => void
}

// The relay allows only a handful of device registrations per IP per window:
// a flapping link must back off far enough to stay inside that budget.
const MAX_BACKOFF_MS = 120_000
const RATE_LIMIT_BACKOFF_MS = 180_000
const PING_INTERVAL_MS = 25_000

let opts: LinkSignalingOpts | null = null
let ws: WebSocket | null = null
let stopped = true
let attempt = 0
let pingTimer: NodeJS.Timeout | null = null
let reconnectTimer: NodeJS.Timeout | null = null

function wsUrl(o: { server: string; linkId: string; regKey: string }): string {
  const base = o.server.replace(/\/+$/, '').replace(/^http/, 'ws')
  return `${base}/ws?role=device&id=${encodeURIComponent(o.linkId)}&k=${encodeURIComponent(o.regKey)}`
}

function clearTimers(): void {
  if (pingTimer) {
    clearInterval(pingTimer)
    pingTimer = null
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

/** Protocol-level pings keep the NAT mapping alive without waking hibernated DOs */
function startPings(): void {
  clearTimers()
  pingTimer = setInterval(() => {
    try {
      ws?.ping()
    } catch {
      // close handler schedules the reconnect
    }
  }, PING_INTERVAL_MS)
}

function scheduleReconnect(delayMs: number, info: LinkSignalInfo): void {
  if (stopped) return
  opts?.onState('offline', info)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, delayMs)
}

/** Exponential backoff with jitter so a fleet of clients doesn't sync its retries */
function backoffDelay(): number {
  const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt)
  attempt++
  return Math.round(base * (0.8 + Math.random() * 0.4))
}

function connect(): void {
  if (stopped || !opts) return
  clearTimers()
  const o = opts
  opts?.onState('connecting', { error: '', retryAt: 0 })
  let sock: WebSocket
  try {
    // A black-holed route can hang the upgrade forever without a timeout —
    // the retry loop must keep moving to converge on a working window.
    sock = new WebSocket(wsUrl(o), { handshakeTimeout: 10_000 })
  } catch {
    scheduleReconnect(backoffDelay(), { error: 'network', retryAt: Date.now() })
    return
  }
  ws = sock
  sock.on('open', () => {
    console.log('[sig] ws open, registering', o.linkId)
    startPings()
  })
  sock.on('message', (data) => {
    let f: LinkSignalFrame
    try {
      f = JSON.parse(String(data)) as LinkSignalFrame
    } catch {
      return
    }
    if (f.t === 'registered') {
      attempt = 0
      console.log('[sig] registered', o.linkId)
      opts?.onState('online', { error: '', retryAt: 0 })
      return
    }
    opts?.onFrame(f)
  })
  sock.on('unexpected-response', (_req: unknown, res: IncomingMessage) => {
    // A 409 means another registration holds this ID under a different key:
    // stop retrying and let the owner rotate the ID.
    if (res.statusCode === 409) {
      stopped = true
      clearTimers()
      opts?.onState('offline', { error: 'id_taken', retryAt: 0 })
      opts?.onIdTaken()
      return
    }
    try {
      sock.terminate()
    } catch {
      // already dead
    }
    if (res.statusCode === 429) {
      // The relay's per-IP register budget is tight; hammering it only
      // extends the lockout. Honor Retry-After, otherwise wait it out.
      const ra = Number(res.headers['retry-after'])
      const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra, 600) * 1000 : RATE_LIMIT_BACKOFF_MS
      console.log('[sig] rate limited, retry in', Math.round(wait / 1000), 's')
      scheduleReconnect(wait, { error: 'rate_limited', retryAt: Date.now() + wait })
      return
    }
    scheduleReconnect(backoffDelay(), { error: 'network', retryAt: Date.now() })
  })
  sock.on('error', () => {
    // close follows
  })
  sock.on('close', (code) => {
    console.log('[sig] ws close', code)
    if (ws === sock) ws = null
    if (stopped) return
    scheduleReconnect(backoffDelay(), { error: 'network', retryAt: Date.now() })
  })
}

export function startLinkSignaling(o: LinkSignalingOpts): void {
  stopLinkSignaling()
  opts = o
  stopped = false
  attempt = 0
  connect()
}

export function stopLinkSignaling(): void {
  stopped = true
  clearTimers()
  const sock = ws
  ws = null
  if (sock) {
    try {
      sock.close()
    } catch {
      // already closed
    }
  }
  opts?.onState('off', { error: '', retryAt: 0 })
  opts = null
}

export function sendLinkFrame(f: LinkSignalFrame): boolean {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false
  ws.send(JSON.stringify(f))
  return true
}
