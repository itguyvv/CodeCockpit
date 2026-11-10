import fs from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from './dataDir'
import { t } from './i18n'
import type { NativeSessionInfo } from './jsonl'
import { homePath } from './platform'
import { emptyStatus, type SessionStatus } from './status'

/** Codex home directory (~/.codex by default; CODEX_HOME overrides) */
export function codexHome(): string {
  return process.env.CODEX_HOME || homePath('.codex')
}

function sessionsRoot(): string {
  return path.join(codexHome(), 'sessions')
}

/** All rollout files, newest first (stat only — cheap even for thousands of files) */
function rolloutFiles(): string[] {
  const root = sessionsRoot()
  const out: string[] = []
  let years: string[] = []
  try {
    years = fs.readdirSync(root)
  } catch {
    return out
  }
  for (const y of years) {
    let months: string[] = []
    try {
      months = fs.readdirSync(path.join(root, y))
    } catch {
      continue
    }
    for (const m of months) {
      let days: string[] = []
      try {
        days = fs.readdirSync(path.join(root, y, m))
      } catch {
        continue
      }
      for (const d of days) {
        const dir = path.join(root, y, m, d)
        try {
          for (const f of fs.readdirSync(dir)) {
            if (f.endsWith('.jsonl')) out.push(path.join(dir, f))
          }
        } catch {
          continue
        }
      }
    }
  }
  return out
    .map((p) => ({ p, m: fs.statSync(p).mtimeMs }))
    .sort((a, b) => b.m - a.m)
    .map((x) => x.p)
}

/** thread_name from session_index.jsonl, keyed by session id */
function threadNames(): Map<string, string> {
  const out = new Map<string, string>()
  try {
    const lines = fs.readFileSync(path.join(codexHome(), 'session_index.jsonl'), 'utf-8').split(/\r?\n/)
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const e = JSON.parse(line) as { id?: string; thread_name?: string }
        if (e.id && e.thread_name) out.set(e.id, e.thread_name)
      } catch {
        // Skip malformed index lines
      }
    }
  } catch {
    // No index yet — titles fall back to the first user message
  }
  return out
}

interface RolloutHead {
  id: string
  cwd: string
  /** Best-effort mapping of codex sandbox/approval settings onto our permission modes */
  permissionMode: string
}

function modeFromPolicy(sandbox: string, approval: string): string {
  if (sandbox === 'danger-full-access') return 'bypassPermissions'
  if (sandbox === 'read-only') return 'plan'
  if (approval === 'on-failure' || approval === 'never') return 'acceptEdits'
  return 'default'
}

function readHead(file: string): RolloutHead | null {
  try {
    const buf = Buffer.alloc(128 * 1024)
    const fd = fs.openSync(file, 'r')
    let text = ''
    try {
      const len = fs.readSync(fd, buf, 0, buf.length, 0)
      text = buf.toString('utf-8', 0, len)
    } finally {
      fs.closeSync(fd)
    }
    const lines = text.split(/\r?\n/)
    let head: RolloutHead | null = null
    for (const line of lines) {
      if (!line.trim()) continue
      let ev: Record<string, unknown>
      try {
        ev = JSON.parse(line)
      } catch {
        continue
      }
      if (ev.type === 'session_meta' && !head) {
        const p = ev.payload as { id?: string; cwd?: string } | undefined
        if (!p?.id) return null
        head = { id: p.id, cwd: p.cwd ?? '', permissionMode: 'default' }
      } else if (ev.type === 'turn_context' && head) {
        const p = ev.payload as { approval_policy?: string; sandbox_policy?: { type?: string } } | undefined
        head.permissionMode = modeFromPolicy(p?.sandbox_policy?.type ?? '', p?.approval_policy ?? '')
        break
      }
    }
    return head
  } catch {
    return null
  }
}

/** First real user prompt (environment boilerplate excluded) as a title fallback */
function firstUserTitle(file: string): string {
  try {
    const buf = Buffer.alloc(128 * 1024)
    const fd = fs.openSync(file, 'r')
    let text = ''
    try {
      const len = fs.readSync(fd, buf, 0, buf.length, 0)
      text = buf.toString('utf-8', 0, len)
    } finally {
      fs.closeSync(fd)
    }
    for (const line of text.split(/\r?\n/)) {
      if (!line.includes('"message"')) continue
      let ev: Record<string, unknown>
      try {
        ev = JSON.parse(line)
      } catch {
        continue
      }
      const p = ev.payload as
        | { type?: string; role?: string; content?: Array<{ text?: string }> }
        | undefined
      if (ev.type !== 'response_item' || p?.type !== 'message' || p.role !== 'user') continue
      const text0 = p.content?.[0]?.text ?? ''
      if (!text0 || text0.startsWith('<')) continue
      return text0.replace(/\s+/g, ' ').trim().slice(0, 80)
    }
  } catch {
    // Fall through
  }
  return ''
}

/** List codex native sessions (rollout jsonl), newest first */
export function scanCodexSessions(limit = 60): NativeSessionInfo[] {
  const names = threadNames()
  const out: NativeSessionInfo[] = []
  for (const file of rolloutFiles()) {
    if (out.length >= limit) break
    const head = readHead(file)
    if (!head) continue
    const st = fs.statSync(file)
    const title = names.get(head.id) || firstUserTitle(file) || t('history.noTitle')
    out.push({
      sessionId: head.id,
      cwd: head.cwd,
      title,
      permissionMode: head.permissionMode,
      lastTs: st.mtimeMs,
      sizeBytes: st.size,
      projectEncoded: 'codex'
    })
  }
  return out
}

/** Locate the rollout file of one session uuid; '' when not (yet) on disk */
export function resolveCodexSessionFile(sessionId: string): string {
  const suffix = `-${sessionId}.jsonl`
  for (const file of rolloutFiles()) {
    if (file.endsWith(suffix)) return file
  }
  return ''
}

/** Session ids known before spawning (sniffer baseline) */
export function listCodexSessionIds(): Set<string> {
  return new Set(threadNames().keys())
}

function sameDir(a: string, b: string): boolean {
  return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()
}

/** Watch the sessions tree for a new rollout whose session_meta.cwd matches the spawn cwd */
export function sniffNewCodexSession(
  cwd: string,
  knownSessionIds: Set<string>,
  onFound: (sessionId: string) => void,
  timeoutMs = 120_000
): () => void {
  let stopped = false
  const startedAt = Date.now()
  const timer = setInterval(() => {
    if (stopped) return
    if (Date.now() - startedAt > timeoutMs) {
      stop()
      return
    }
    for (const file of rolloutFiles().slice(0, 30)) {
      const head = readHead(file)
      if (!head || knownSessionIds.has(head.id)) continue
      if (!head.cwd || !sameDir(head.cwd, cwd)) continue
      stopped = true
      clearInterval(timer)
      onFound(head.id)
      return
    }
  }, 600)
  const stop = () => {
    stopped = true
    clearInterval(timer)
  }
  return stop
}

/** Permanently delete a codex session: remove the rollout file and the index entry */
export function deleteCodexSession(sessionId: string): boolean {
  const file = resolveCodexSessionFile(sessionId)
  let deleted = false
  if (file) {
    try {
      fs.rmSync(file, { force: true })
      deleted = true
    } catch {
      return false
    }
  }
  try {
    const indexPath = path.join(codexHome(), 'session_index.jsonl')
    const kept = fs
      .readFileSync(indexPath, 'utf-8')
      .split(/\r?\n/)
      .filter((line) => {
        if (!line.trim()) return false
        try {
          return (JSON.parse(line) as { id?: string }).id !== sessionId
        } catch {
          return true
        }
      })
    writeFileAtomic(indexPath, kept.join('\n') + '\n')
    deleted = true
  } catch {
    // Index missing — the file removal above is enough
  }
  return deleted
}

// ── Live telemetry: tail the rollout jsonl of the running session ──

/** OpenAI pricing guess (USD per million tokens); codex records carry no cost data */
const CODEX_PRICING = [{ match: 'gpt', in: 2, out: 8, cacheRead: 0.5, cacheWrite: 0 }]

function estimateCodexCost(
  model: string,
  u: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number }
): number {
  const m = model.toLowerCase()
  const r = CODEX_PRICING.find((p) => m.includes(p.match)) ?? CODEX_PRICING[0]
  const cached = u.cached_input_tokens ?? 0
  return (
    ((u.input_tokens ?? 0) - cached) / 1e6 * r.in +
    cached / 1e6 * r.cacheRead +
    (u.output_tokens ?? 0) / 1e6 * r.out
  )
}

function toolDetailOf(raw: unknown): string {
  const s = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '')
  return s.replace(/\s+/g, ' ').trim().slice(0, 80)
}

const POLL_MS = 1000

/** Incrementally tail a codex rollout jsonl and aggregate it into SessionStatus */
export class CodexTailer {
  private offset = 0
  private remainder = ''
  private status = emptyStatus()
  private dirty = true
  private stopped = false
  private timer: NodeJS.Timeout
  /** Timestamp of the running turn's task_started (paired with task_complete for AI time) */
  private turnStartAt = 0

  constructor(
    private readonly sessionId: string,
    private readonly onDirty: () => void
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
    const file = resolveCodexSessionFile(this.sessionId)
    if (!file) return // Rollout not created yet (TUI writes it right after launch)
    let st: fs.Stats
    try {
      st = fs.statSync(file)
    } catch {
      return
    }
    if (st.size <= this.offset) return
    let chunk: string
    try {
      const fd = fs.openSync(file, 'r')
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
    if (this.dirty) {
      this.dirty = false
      this.onDirty()
    }
  }

  private process(ev: Record<string, unknown>): void {
    const type = ev.type
    const ts = typeof ev.timestamp === 'string' ? Date.parse(ev.timestamp) : NaN
    this.dirty = true
    if (type === 'event_msg') {
      const p = ev.payload as
        | {
            type?: string
            thread_settings?: { model?: string }
            info?: {
              total_token_usage?: {
                input_tokens?: number
                cached_input_tokens?: number
                cache_write_input_tokens?: number
                output_tokens?: number
              }
            }
          }
        | undefined
      if (!p?.type) return
      if (p.type === 'task_started') {
        this.status.turns++
        this.turnStartAt = isNaN(ts) ? Date.now() : ts
        this.status.lastActivity = Date.now()
      } else if (p.type === 'task_complete') {
        if (this.turnStartAt) {
          this.status.durationMs += Math.max(0, (isNaN(ts) ? Date.now() : ts) - this.turnStartAt)
          this.turnStartAt = 0
        }
        this.status.lastActivity = Date.now()
      } else if (p.type === 'thread_settings_applied') {
        if (p.thread_settings?.model) this.status.model = p.thread_settings.model
      } else if (p.type === 'token_count') {
        const u = p.info?.total_token_usage
        if (u) {
          const cached = u.cached_input_tokens ?? 0
          // codex counts cached tokens inside input_tokens; report them separately
          this.status.tokensIn = Math.max(0, (u.input_tokens ?? 0) - cached)
          this.status.cacheRead = cached
          this.status.cacheWrite = u.cache_write_input_tokens ?? 0
          this.status.tokensOut = u.output_tokens ?? 0
          this.status.costUsd = estimateCodexCost(this.status.model, u)
        }
        this.status.lastActivity = Date.now()
      }
      return
    }
    if (type === 'response_item') {
      const p = ev.payload as
        | { type?: string; name?: string; arguments?: unknown; input?: unknown }
        | undefined
      if (!p || (p.type !== 'function_call' && p.type !== 'custom_tool_call')) return
      const name = p.name || 'Tool'
      this.status.tool = name
      this.status.toolDetail = toolDetailOf(p.arguments ?? p.input)
      this.status.toolCalls++
      this.status.toolCounts[name] = (this.status.toolCounts[name] ?? 0) + 1
      this.status.lastActivity = Date.now()
    }
  }
}
