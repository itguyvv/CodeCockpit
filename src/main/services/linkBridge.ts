import { BrowserWindow, ipcMain } from 'electron'
import path from 'node:path'
import crypto from 'node:crypto'
import { attachLinkClient, getRemoteSecret, remoteRunning, type RemoteTransport } from './remoteServer'
import {
  sendLinkFrame,
  startLinkSignaling,
  stopLinkSignaling,
  type LinkSignalFrame,
  type LinkSignalState
} from './linkSignaling'

/**
 * Link mode bridge: main owns signaling + a hidden window that runs the WebRTC
 * answerer. Each DataChannel becomes a RemoteTransport handed to remoteServer,
 * so the existing JSON remote protocol runs unchanged over link mode.
 */

const REG_SALT = 'cc-link-reg-v1'
const ICE_CACHE_MS = 3600_000

interface LinkCmd {
  kind: string
  cid?: string
  sdp?: unknown
  candidate?: unknown
  data?: string
  iceServers?: unknown
}

interface LinkChannel {
  feed(data: string): void
  peerClosed(): void
  send(data: string): void
  shutdown(): void
  open(): boolean
}

let enabled = false
let cfg: { server: string; secret: string; linkId: string; rotateId: (taken: string) => string } | null = null
let sigState: LinkSignalState = 'off'
let bridgeWin: BrowserWindow | null = null
const channels = new Map<string, LinkChannel>()
let iceCache: { at: number; servers: unknown } | null = null

function notifyState(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue
    w.webContents.send('remote:link', { state: sigState, linkId: cfg?.linkId ?? '', enabled })
  }
}

export function linkStatus(): { enabled: boolean; online: boolean; state: LinkSignalState; linkId: string } {
  return { enabled, online: sigState === 'online', state: sigState, linkId: cfg?.linkId ?? '' }
}

/** Registration key derived from the pairing secret: the raw secret never reaches the signaling server */
export function deriveRegKey(secret: string): string {
  return crypto.createHash('sha256').update(secret + REG_SALT, 'utf-8').digest('hex')
}

function cmdToRenderer(cmd: LinkCmd): void {
  if (bridgeWin && !bridgeWin.isDestroyed()) bridgeWin.webContents.send('link-bridge:cmd', cmd)
}

function dropAllChannels(): void {
  for (const ch of channels.values()) ch.peerClosed()
  channels.clear()
}

function ensureWindow(): void {
  if (bridgeWin && !bridgeWin.isDestroyed()) return
  bridgeWin = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false
    }
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    void bridgeWin.loadURL(process.env.ELECTRON_RENDERER_URL + '/?linkBridge=1')
  } else {
    void bridgeWin.loadFile(path.join(__dirname, '../renderer/index.html'), { search: 'linkBridge=1' })
  }
  bridgeWin.webContents.on('render-process-gone', () => {
    // Renderer death kills every DataChannel; the phone side sees the DC close and
    // re-negotiates through signaling once the replacement window is up.
    dropAllChannels()
    if (enabled) ensureWindow()
  })
}

async function iceServers(): Promise<unknown> {
  if (iceCache && Date.now() - iceCache.at < ICE_CACHE_MS) return iceCache.servers
  try {
    const res = await fetch(new URL('/ice', cfg?.server).toString(), { signal: AbortSignal.timeout(5000) })
    const body = (await res.json()) as { iceServers?: unknown }
    const servers = body.iceServers ?? []
    iceCache = { at: Date.now(), servers }
    return servers
  } catch {
    // STUN-less answer still works on LAN-like paths; TURN config is a bonus
    return []
  }
}

function makeLinkTransport(cid: string): RemoteTransport {
  const dataCbs = new Set<(d: string) => void>()
  const closeCbs = new Set<() => void>()
  let open = true
  channels.set(cid, {
    feed: (d) => {
      if (open) for (const cb of dataCbs) cb(d)
    },
    peerClosed: () => {
      if (open) {
        open = false
        for (const cb of closeCbs) cb()
      }
    },
    send: (d) => {
      if (open) cmdToRenderer({ kind: 'dc-send', cid, data: d })
    },
    shutdown: () => {
      open = false
    },
    open: () => open
  })
  return {
    id: () => `link:${cid}`,
    send: (d) => channels.get(cid)?.send(d),
    close: () => {
      const ch = channels.get(cid)
      if (ch) {
        ch.shutdown()
        ch.peerClosed()
        channels.delete(cid)
      }
      cmdToRenderer({ kind: 'close', cid })
    },
    isOpen: () => channels.get(cid)?.open() ?? false,
    onData: (cb) => {
      dataCbs.add(cb)
    },
    onClose: (cb) => {
      closeCbs.add(cb)
      if (!open) cb()
    }
  }
}

async function onSignalFrame(f: LinkSignalFrame): Promise<void> {
  if (!f.cid) return
  if (f.t === 'offer') {
    ensureWindow()
    cmdToRenderer({ kind: 'offer', cid: f.cid, sdp: f.data, iceServers: await iceServers() })
  } else if (f.t === 'ice') {
    cmdToRenderer({ kind: 'ice', cid: f.cid, candidate: f.data })
  } else if (f.t === 'close' || f.t === 'client-gone') {
    const ch = channels.get(f.cid)
    if (ch) {
      ch.peerClosed()
      channels.delete(f.cid)
    }
    cmdToRenderer({ kind: 'close', cid: f.cid })
  }
  // 'join' needs no action: the phone follows up with its offer
}

function onRendererEvent(evt: unknown): void {
  const e = evt as LinkCmd
  if (!e || typeof e.kind !== 'string') return
  const cid = typeof e.cid === 'string' ? e.cid : ''
  if (e.kind === 'answer' && cid) {
    sendLinkFrame({ t: 'answer', data: e.sdp, cid })
  } else if (e.kind === 'ice' && cid) {
    sendLinkFrame({ t: 'ice', data: e.candidate, cid })
  } else if (e.kind === 'dc-open' && cid) {
    if (!remoteRunning()) {
      cmdToRenderer({ kind: 'close', cid })
      return
    }
    attachLinkClient(makeLinkTransport(cid))
  } else if (e.kind === 'dc-data' && cid && typeof e.data === 'string') {
    channels.get(cid)?.feed(e.data)
  } else if (e.kind === 'dc-close' && cid) {
    const ch = channels.get(cid)
    if (ch) {
      ch.peerClosed()
      channels.delete(cid)
    }
  }
}

function startSignaling(): void {
  if (!cfg) return
  const c = cfg
  let rotations = 0
  const register = (linkId: string): void => {
    startLinkSignaling({
      server: c.server,
      linkId,
      regKey: deriveRegKey(c.secret),
      onFrame: (f) => void onSignalFrame(f),
      onState: (s) => {
        sigState = s
        notifyState()
      },
      onIdTaken: () => {
        if (++rotations > 3) {
          sigState = 'offline'
          notifyState()
          return
        }
        const next = c.rotateId(c.linkId)
        c.linkId = next
        register(next)
      }
    })
  }
  register(c.linkId)
}

export function enableLink(o: { server: string; secret: string; linkId: string; rotateId: (taken: string) => string }): void {
  disableLink()
  enabled = true
  cfg = { server: o.server.replace(/\/+$/, ''), secret: o.secret, linkId: o.linkId, rotateId: o.rotateId }
  ipcMain.handle('link-bridge:evt', (_e, evt: unknown) => onRendererEvent(evt))
  ensureWindow()
  startSignaling()
}

export function disableLink(): void {
  if (!enabled) return
  enabled = false
  stopLinkSignaling()
  sigState = 'off'
  dropAllChannels()
  ipcMain.removeHandler('link-bridge:evt')
  if (bridgeWin && !bridgeWin.isDestroyed()) bridgeWin.destroy()
  bridgeWin = null
  cfg = null
  notifyState()
}

/** Re-register after the pairing secret changed (registration key is derived from it) */
export function restartLinkWith(o: { server: string; secret: string; linkId: string; rotateId: (taken: string) => string }): void {
  if (enabled) enableLink(o)
}
