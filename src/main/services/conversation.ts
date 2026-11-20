/**
 * Conversation log for the remote (phone) chat view.
 *
 * The three engine tailers (claude jsonl / codex rollout / openCode storage) extract
 * message-level data while they aggregate SessionStatus and feed it in here. A bounded
 * per-session buffer keeps the running session's conversation from the beginning (tailers
 * replay their whole log from offset 0), and subscribers — the remote access server —
 * receive every batch for live streaming to connected clients.
 */

/** One conversation message, normalized across the three engines */
export interface RemoteMessage {
  /** Stable across tailer restarts: clients upsert by id (openCode mutates rows in place) */
  id: string
  ts: number
  role: 'user' | 'assistant' | 'tool'
  /** Chat text (user prompts / assistant replies); absent on tool entries */
  text?: string
  toolName?: string
  /** Full tool arguments, clamped — file-writing tools can carry whole files */
  toolInput?: string
  /** Tool result text, clamped; upserted onto the tool entry once the engine reports the result */
  toolOutput?: string
  /** Per-message usage when the engine reports it */
  tokensIn?: number
  tokensOut?: number
  costUsd?: number
}

/** Tool arguments kept on the wire per entry */
const TOOL_INPUT_CAP = 4000

/** Tool output kept on the wire per entry */
export const TOOL_OUTPUT_CAP = 4000

const BUFFER_CAP = 500

const buffers = new Map<string, RemoteMessage[]>()
const subscribers = new Set<(sessionId: string, msgs: RemoteMessage[]) => void>()

/** Subscribe to recorded message batches; returns the unsubscribe function */
export function onMessages(fn: (sessionId: string, msgs: RemoteMessage[]) => void): () => void {
  subscribers.add(fn)
  return () => subscribers.delete(fn)
}

/** Record a batch: append, or replace in place when the id already exists (streaming upserts) */
export function recordMessages(sessionId: string, msgs: RemoteMessage[]): void {
  if (msgs.length === 0) return
  let buf = buffers.get(sessionId)
  if (!buf) {
    buf = []
    buffers.set(sessionId, buf)
  }
  for (const msg of msgs) {
    let replaced = false
    // Upserts hit the most recent entries — scan from the tail
    for (let i = buf.length - 1; i >= 0; i--) {
      if (buf[i].id === msg.id) {
        buf[i] = msg
        replaced = true
        break
      }
    }
    if (!replaced) buf.push(msg)
  }
  if (buf.length > BUFFER_CAP) buf.splice(0, buf.length - BUFFER_CAP)
  for (const fn of subscribers) fn(sessionId, msgs)
}

/** Full conversation of a session (for a freshly attached remote client) */
export function getMessages(sessionId: string): RemoteMessage[] {
  return [...(buffers.get(sessionId) ?? [])]
}

/** Drop a session's conversation (the process exited; history reading is a future endpoint) */
export function clearMessages(sessionId: string): void {
  buffers.delete(sessionId)
}

/** Stringify tool arguments for the wire, clamped to the cap */
export function clipToolInput(input: unknown): string {
  const s = typeof input === 'string' ? input : JSON.stringify(input ?? '')
  return s.length > TOOL_INPUT_CAP ? s.slice(0, TOOL_INPUT_CAP) + '…' : s
}

/**
 * Normalize a tool result to text for the wire, clamped to the cap.
 * Claude jsonl tool_result content is either a plain string or an array of blocks
 * ({type:'text',text} among them); other engines pass plain strings.
 */
export function clipToolOutput(raw: unknown): string {
  if (raw == null) return ''
  let s: string
  if (Array.isArray(raw)) {
    s = raw
      .map((blk) => (blk && typeof blk === 'object' && typeof (blk as any).text === 'string' ? (blk as any).text : ''))
      .join('\n')
  } else if (typeof raw === 'object' && typeof (raw as any).text === 'string') {
    s = (raw as any).text
  } else {
    s = typeof raw === 'string' ? raw : JSON.stringify(raw)
  }
  return s.length > TOOL_OUTPUT_CAP ? s.slice(0, TOOL_OUTPUT_CAP) + '…' : s
}
