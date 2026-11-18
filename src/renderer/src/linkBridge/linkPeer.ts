/**
 * Renderer half of the link bridge, mounted in the hidden bridge window
 * (renderer entry branches on ?linkBridge=1). Answers WebRTC offers relayed by
 * the signaling client in main and pipes DataChannel traffic over IPC.
 */

const CHUNK_SIZE = 16384
const DC_LABEL = 'cc'

interface Command {
  kind: string
  cid?: string
  sdp?: unknown
  candidate?: unknown
  data?: string
  iceServers?: unknown
}

interface PeerEntry {
  pc: RTCPeerConnection
  dc: RTCDataChannel | null
  buf: Uint8Array
}

const peers = new Map<string, PeerEntry>()

function send(evt: Record<string, unknown>): void {
  window.api.linkBridgeSend(evt).catch(() => {
    // Main dropped the handler (link disabled mid-negotiation) — teardown follows elsewhere
  })
}

/** Outbound: 4-byte big-endian length header, split into <=16KB DataChannel frames */
function frameChunks(msg: string): Uint8Array<ArrayBuffer>[] {
  const payload = new TextEncoder().encode(msg)
  const full = new Uint8Array(4 + payload.length)
  new DataView(full.buffer).setUint32(0, payload.length, false)
  full.set(payload, 4)
  const chunks: Uint8Array<ArrayBuffer>[] = []
  for (let o = 0; o < full.length; o += CHUNK_SIZE) {
    chunks.push(full.subarray(o, Math.min(o + CHUNK_SIZE, full.length)))
  }
  return chunks
}

/** Inbound reassembly: null while the frame is incomplete */
function feed(buf: Uint8Array, chunk: Uint8Array): { rest: Uint8Array; msg: string | null } {
  const merged = new Uint8Array(buf.length + chunk.length)
  merged.set(buf)
  merged.set(chunk, buf.length)
  if (merged.length < 4) return { rest: merged, msg: null }
  const want = new DataView(merged.buffer, merged.byteOffset, merged.byteLength).getUint32(0, false)
  if (merged.length < 4 + want) return { rest: merged, msg: null }
  const msg = new TextDecoder().decode(merged.subarray(4, 4 + want))
  return { rest: merged.slice(4 + want), msg }
}

function teardown(cid: string): void {
  const entry = peers.get(cid)
  if (!entry) return
  peers.delete(cid)
  try {
    entry.pc.close()
  } catch {
    // already closed
  }
}

function handleOffer(cmd: Command): void {
  const cid = cmd.cid ?? ''
  if (!cid) return
  teardown(cid)
  const pc = new RTCPeerConnection({
    iceServers: Array.isArray(cmd.iceServers) ? (cmd.iceServers as RTCIceServer[]) : []
  })
  const entry: PeerEntry = { pc, dc: null, buf: new Uint8Array(0) }
  peers.set(cid, entry)
  pc.onicecandidate = (ev) => {
    if (ev.candidate) send({ kind: 'ice', cid, candidate: ev.candidate.toJSON() })
  }
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      teardown(cid)
      send({ kind: 'dc-close', cid })
    }
  }
  pc.ondatachannel = (ev) => {
    const dc = ev.channel
    if (dc.label !== DC_LABEL) return
    entry.dc = dc
    dc.binaryType = 'arraybuffer'
    dc.onopen = () => send({ kind: 'dc-open', cid })
    dc.onclose = () => {
      teardown(cid)
      send({ kind: 'dc-close', cid })
    }
    dc.onmessage = (mev) => {
      const cur = peers.get(cid)
      if (!cur) return
      const { rest, msg } = feed(cur.buf, new Uint8Array(mev.data as ArrayBuffer))
      cur.buf = rest
      if (msg) send({ kind: 'dc-data', cid, data: msg })
    }
  }
  void (async () => {
    try {
      await pc.setRemoteDescription(cmd.sdp as RTCSessionDescriptionInit)
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      // Plain object: contextBridge/invoke strips DOM objects to {}
      const desc = pc.localDescription
      if (!desc) throw new Error('no local description')
      send({ kind: 'answer', cid, sdp: { type: desc.type, sdp: desc.sdp } })
    } catch {
      teardown(cid)
      send({ kind: 'dc-close', cid })
    }
  })()
}

async function handleCommand(cmd: Command): Promise<void> {
  const cid = typeof cmd.cid === 'string' ? cmd.cid : ''
  if (cmd.kind === 'offer') {
    handleOffer(cmd)
    return
  }
  if (cmd.kind === 'ice' && cid) {
    const entry = peers.get(cid)
    if (entry && cmd.candidate) {
      try {
        await entry.pc.addIceCandidate(cmd.candidate as RTCIceCandidateInit)
      } catch {
        // candidate for a torn-down transport — ignore
      }
    }
    return
  }
  if (cmd.kind === 'close' && cid) {
    teardown(cid)
    return
  }
  if (cmd.kind === 'dc-send' && cid && typeof cmd.data === 'string') {
    const dc = peers.get(cid)?.dc
    if (dc && dc.readyState === 'open') {
      for (const c of frameChunks(cmd.data)) dc.send(c)
    }
  }
}

export function mountLinkBridge(): void {
  window.api.onLinkBridgeCommand((raw) => {
    void handleCommand(raw as Command)
  })
  send({ kind: 'ready' })
}
