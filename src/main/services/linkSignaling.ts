import { WebSocket } from 'ws'
import type { IncomingMessage } from 'node:http'

export type LinkSignalState = 'off' | 'connecting' | 'online' | 'offline'

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
  onState: (s: LinkSignalState) => void
  /** 409 id_taken: this ID is claimed under a different registration key */
  onIdTaken: () => void
}

const MAX_BACKOFF_MS = 30_000
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

function scheduleReconnect(): void {
  if (stopped) return
  const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt)
  attempt++
  opts?.onState('offline')
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, delay)
}

function connect(): void {
  if (stopped || !opts) return
  clearTimers()
  const o = opts
  opts?.onState('connecting')
  let sock: WebSocket
  try {
    sock = new WebSocket(wsUrl(o))
  } catch {
    scheduleReconnect()
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
      opts?.onState('online')
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
      opts?.onIdTaken()
      return
    }
    try {
      sock.terminate()
    } catch {
      // already dead
    }
  })
  sock.on('error', () => {
    // close follows
  })
  sock.on('close', (code) => {
    console.log('[sig] ws close', code)
    if (ws === sock) ws = null
    scheduleReconnect()
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
  opts?.onState('off')
  opts = null
}

export function sendLinkFrame(f: LinkSignalFrame): boolean {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false
  ws.send(JSON.stringify(f))
  return true
}
