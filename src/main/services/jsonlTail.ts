import fs from 'node:fs'
import path from 'node:path'
import { encodeProjectDir, projectsRoot } from './jsonl'
import { emptyStatus, type SessionStatus } from './status'
import { clipToolInput, type RemoteMessage } from './conversation'

export { emptyStatus, type SessionStatus }

/** API pricing table (USD per million tokens), matched by model-name substring */
const PRICING: Array<{ match: string; in: number; out: number; cacheRead: number; cacheWrite: number }> = [
  { match: 'opus', in: 15, out: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  { match: 'haiku', in: 1, out: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  { match: 'sonnet', in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 }
]

function ratesFor(model: string): { in: number; out: number; cacheRead: number; cacheWrite: number } {
  const m = model.toLowerCase()
  for (const p of PRICING) {
    if (m.includes(p.match)) return p
  }
  return PRICING[PRICING.length - 1]
}

function estimateCost(model: string, u: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }): number {
  const r = ratesFor(model)
  const cost =
    ((u.input_tokens ?? 0) / 1e6) * r.in +
    ((u.output_tokens ?? 0) / 1e6) * r.out +
    ((u.cache_read_input_tokens ?? 0) / 1e6) * r.cacheRead +
    ((u.cache_creation_input_tokens ?? 0) / 1e6) * r.cacheWrite
  return cost
}

function toolDetailOf(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  const raw = o.command ?? o.file_path ?? o.path ?? o.pattern ?? o.url ?? o.description ?? o.query ?? ''
  const s = typeof raw === 'string' ? raw : JSON.stringify(raw)
  const s1 = s.replace(/\s+/g, ' ').trim()
  return s1.length > 80 ? s1.slice(0, 80) + '…' : s1
}

/** Event timestamp (ISO string on every message line); poll time as the fallback */
function eventTs(ev: Record<string, unknown>): number {
  const t = Date.parse(typeof ev.timestamp === 'string' ? ev.timestamp : '')
  return isNaN(t) ? Date.now() : t
}

const POLL_MS = 1000

/** Incrementally tail a session jsonl and aggregate it into SessionStatus; waits while the file doesn't exist yet */
export class SessionTailer {
  private offset = 0
  private remainder = ''
  private status = emptyStatus()
  private dirty = true
  private stopped = false
  private timer: NodeJS.Timeout
  /** Background bash task ids announced as running and not yet observed finished/stopped */
  private bgTasks = new Set<string>()
  /** Launches read from the initial history pass must not count: background shells are
   *  children of the CLI process and die with it, so only events observed from the live
   *  process (after the first poll) can mark a task as still running. Otherwise a resume
   *  of a session whose engine never wrote the completion notice shows a stale badge. */
  private livePhase = false

  constructor(
    public readonly filePath: string,
    private readonly onDirty: () => void,
    private readonly onMessages?: (msgs: RemoteMessage[]) => void
  ) {
    this.timer = setInterval(() => this.poll(), POLL_MS)
  }

  getStatus(): SessionStatus {
    return { ...this.status }
  }

  dispose(): void {
    this.stopped = true
    clearInterval(this.timer)
  }

  private poll(): void {
    if (this.stopped) return
    let st: fs.Stats
    try {
      st = fs.statSync(this.filePath)
    } catch {
      return // File not created yet (new session hasn't sent its first message)
    }
    if (st.size <= this.offset) return
    let chunk: string
    try {
      const fd = fs.openSync(this.filePath, 'r')
      try {
        const len = st.size - this.offset
        const buf = Buffer.alloc(len)
        fs.readSync(fd, buf, 0, len, this.offset)
        chunk = buf.toString('utf-8')
      } finally {
        fs.closeSync(fd)
      }
    } catch {
      return
    }
    this.offset = st.size
    const data = this.remainder + chunk
    const lines = data.split(/\r?\n/)
    this.remainder = lines.pop() ?? ''
    this.offset -= Buffer.byteLength(this.remainder, 'utf-8')
    for (const line of lines) {
      const t = line.trim()
      if (!t) continue
      try {
        this.process(JSON.parse(t) as Record<string, unknown>)
      } catch {
        // A single malformed line doesn't break the rest
      }
    }
    this.livePhase = true
    this.dirty = true
    this.onDirty()
  }

  private process(ev: Record<string, unknown>): void {
    const type = ev.type
    this.status.lastActivity = Date.now()
    this.status.eventCount++
    if (type === 'assistant') {
      const msg = ev.message as
        | { model?: string; usage?: Record<string, number>; content?: unknown }
        | undefined
      if (msg?.model) this.status.model = msg.model
      const u = msg?.usage
      let turnCost = 0
      if (u) {
        this.status.tokensIn += u.input_tokens ?? 0
        this.status.tokensOut += u.output_tokens ?? 0
        this.status.cacheRead += u.cache_read_input_tokens ?? 0
        this.status.cacheWrite += u.cache_creation_input_tokens ?? 0
        turnCost = estimateCost(msg?.model ?? this.status.model, u)
        this.status.costUsd += turnCost
      }
      const out: RemoteMessage[] = []
      const ts = eventTs(ev)
      const uuid = typeof ev.uuid === 'string' ? ev.uuid : ''
      const c = msg?.content
      if (Array.isArray(c)) {
        const texts: string[] = []
        for (const b of c) {
          if (!b || typeof b !== 'object') continue
          const blk = b as { type?: string; name?: string; input?: unknown; text?: unknown }
          if (blk.type === 'tool_use') {
            const name = blk.name || 'Tool'
            this.status.tool = name
            this.status.toolDetail = toolDetailOf(blk.input)
            this.status.toolCalls++
            this.status.toolCounts[name] = (this.status.toolCounts[name] ?? 0) + 1
            if (uuid) {
              out.push({
                id: `${uuid}:tool`,
                ts,
                role: 'tool',
                toolName: name,
                toolInput: clipToolInput(blk.input)
              })
            }
          } else if (blk.type === 'text' && typeof blk.text === 'string' && blk.text.trim()) {
            texts.push(blk.text)
          }
        }
        if (uuid && (texts.length > 0 || (u && (u.input_tokens ?? 0) > 0))) {
          out.push({
            id: uuid,
            ts,
            role: 'assistant',
            text: texts.join('\n\n') || undefined,
            tokensIn: u?.input_tokens,
            tokensOut: u?.output_tokens,
            costUsd: turnCost || undefined
          })
        }
      }
      if (out.length) this.onMessages?.(out)
      return
    }
    if (type === 'user' && !ev.isMeta) {
      const c = (ev.message as { content?: unknown } | undefined)?.content ?? ev.content
      let isTurn = false
      let prompt = ''
      if (typeof c === 'string') {
        isTurn = c.trim().length > 0
        prompt = c
      } else if (Array.isArray(c)) {
        const texts: string[] = []
        for (const b of c) {
          if (!b || typeof b !== 'object') continue
          const blk = b as { type?: string; text?: unknown }
          if (blk.type === 'text' && typeof blk.text === 'string') texts.push(blk.text)
          if (blk.type === 'tool_result') {
            this.trackBgResult(b as { content?: unknown })
          }
        }
        prompt = texts.join('\n\n')
        isTurn = texts.some((s) => s.trim().length > 0)
      }
      if (isTurn) this.status.turns++
      const uuid = typeof ev.uuid === 'string' ? ev.uuid : ''
      if (uuid && prompt.trim()) {
        this.onMessages?.([
          { id: uuid, ts: eventTs(ev), role: 'user', text: prompt.trim() }
        ])
      }
      return
    }
    if (type === 'queue-operation' || type === 'attachment') {
      // Completion notices wake the agent through the queue: <task-notification> payloads
      const raw =
        typeof ev.content === 'string'
          ? ev.content
          : String((ev.attachment as { prompt?: unknown } | undefined)?.prompt ?? '')
      this.trackBgNotice(raw)
      return
    }
    if (type === 'system' && ev.subtype === 'turn_duration') {
      const d = ev.durationMs
      if (typeof d === 'number') this.status.durationMs += d
    }
  }

  /** Register / finish background shells from tool_result texts (launch confirmation, TaskOutput, stop) */
  private trackBgResult(b: { content?: unknown }): void {
    const txt = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '')
    const launch = txt.match(/Command running in background with ID: (\w+)/)
    if (launch && this.livePhase) {
      this.bgTasks.add(launch[1])
      this.status.backgroundTasks = this.bgTasks.size
      this.dirty = true
      return
    }
    const stop = txt.match(/Successfully stopped task: (\w+)/)
    if (stop && this.bgTasks.delete(stop[1])) {
      this.status.backgroundTasks = this.bgTasks.size
      this.dirty = true
      return
    }
    this.trackBgNotice(txt)
  }

  /** <task-notification> / TaskOutput payloads: a status other than "running" ends the shell */
  private trackBgNotice(txt: string): void {
    const tid = txt.match(/<(?:task-id|task_id)>(\w+)<\/(?:task-id|task_id)>/)
    if (!tid) return
    const status = txt.match(/<status>(\w+)<\/status>/)
    if (status && status[1] !== 'running' && this.bgTasks.delete(tid[1])) {
      this.dirty = true
      this.status.backgroundTasks = this.bgTasks.size
    }
  }
}

/** Absolute path of a session jsonl (the single source of truth for a session on disk) */
export function sessionFilePath(cwd: string, claudeSessionId: string): string {
  return path.join(projectsRoot(), encodeProjectDir(cwd), claudeSessionId + '.jsonl')
}

/** Locate a session jsonl by id across all project directories (the file stays in the original project after a directory change); null if not found */
export function resolveSessionFile(claudeSessionId: string): string | null {
  const root = projectsRoot()
  const target = claudeSessionId + '.jsonl'
  try {
    for (const dir of fs.readdirSync(root)) {
      const full = path.join(root, dir, target)
      try {
        if (fs.existsSync(full)) return full
      } catch {
        // Skip
      }
    }
  } catch {
    // projects root doesn't exist
  }
  return null
}
