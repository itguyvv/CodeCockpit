import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { emptyStatus, type SessionStatus } from './status'

// openCode stores all session data as plain JSON under its data root (opencode.db is legacy):
//   storage/project/<projectID>.json        { id, worktree, time }
//   storage/session/<projectID>/<ses>.json  { id, title, directory, projectID, time: { created, updated } }
//   storage/message/<sesID>/<msgID>.json    { role, tokens: { input, output, reasoning, cache: { read, write } }, cost, modelID, providerID, time }
//   storage/part/<msgID>/<prtID>.json       message parts incl. tool calls { type: 'tool', tool, ... } (keyed by message id!)

export interface OpenCodeSessionInfo {
  sessionId: string
  cwd: string
  title: string
  projectID: string
  lastTs: number
  sizeBytes: number
}

export function openCodeDataRoot(): string {
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')
  return path.join(base, 'opencode')
}

function storageRoot(): string {
  return path.join(openCodeDataRoot(), 'storage')
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T
  } catch {
    return null
  }
}

interface SessionDoc {
  id?: string
  title?: string
  directory?: string
  projectID?: string
  time?: { created?: number | string; updated?: number | string }
}

function toTs(v: number | string | undefined): number {
  if (typeof v === 'number') return v < 1e12 ? Math.round(v * 1000) : Math.round(v)
  if (typeof v === 'string') {
    const n = Date.parse(v)
    return Number.isNaN(n) ? 0 : n
  }
  return 0
}

/** List openCode sessions across all projects, newest first */
export function scanOpenCodeSessions(limit = 60): OpenCodeSessionInfo[] {
  const sessionRoot = path.join(storageRoot(), 'session')
  let projectDirs: string[] = []
  try {
    projectDirs = fs.readdirSync(sessionRoot)
  } catch {
    return []
  }
  const found: OpenCodeSessionInfo[] = []
  for (const pid of projectDirs) {
    const pdir = path.join(sessionRoot, pid)
    let names: string[] = []
    try {
      names = fs.readdirSync(pdir).filter((n) => n.endsWith('.json'))
    } catch {
      continue
    }
    for (const name of names) {
      const full = path.join(pdir, name)
      try {
        const st = fs.statSync(full)
        const doc = readJson<SessionDoc>(full)
        if (!doc?.id) continue
        found.push({
          sessionId: doc.id,
          cwd: doc.directory || projectWorktree(doc.projectID || pid),
          title: doc.title || '',
          projectID: doc.projectID || pid,
          lastTs: toTs(doc.time?.updated) || Math.round(st.mtimeMs),
          sizeBytes: st.size
        })
      } catch {
        continue
      }
    }
  }
  found.sort((a, b) => b.lastTs - a.lastTs)
  return found.slice(0, limit)
}

function projectWorktree(projectID: string): string {
  const doc = readJson<{ worktree?: string }>(path.join(storageRoot(), 'project', projectID + '.json'))
  return doc?.worktree || ''
}

/** Permanently delete an openCode session (session + messages + parts) */
export function deleteOpenCodeSession(sessionId: string): boolean {
  const root = storageRoot()
  const sessionRoot = path.join(root, 'session')
  let deleted = false
  let projectDirs: string[] = []
  try {
    projectDirs = fs.readdirSync(sessionRoot)
  } catch {
    return false
  }
  for (const pid of projectDirs) {
    const file = path.join(sessionRoot, pid, sessionId + '.json')
    try {
      if (fs.existsSync(file)) {
        fs.rmSync(file, { force: true })
        deleted = true
        break
      }
    } catch {
      // Skip unreadable project dirs
    }
  }
  const msgDir = path.join(root, 'message', sessionId)
  try {
    if (fs.existsSync(msgDir)) {
      fs.rmSync(msgDir, { recursive: true, force: true })
      deleted = true
    }
  } catch {
    // Skip
  }
  // part/ is keyed by message id — remove the parts of this session's messages individually
  try {
    for (const msgFile of fs.readdirSync(msgDir)) {
      const dir = path.join(root, 'part', msgFile.replace(/\.json$/, ''))
      try {
        if (fs.existsSync(dir)) {
          fs.rmSync(dir, { recursive: true, force: true })
          deleted = true
        }
      } catch {
        // Skip
      }
    }
  } catch {
    // No message storage for this session
  }
  return deleted
}

/** All known session ids across projects (snapshot used before spawning to detect the new one) */
export function listOpenCodeSessionIds(): Set<string> {
  const out = new Set<string>()
  const sessionRoot = path.join(storageRoot(), 'session')
  try {
    for (const pid of fs.readdirSync(sessionRoot)) {
      try {
        for (const name of fs.readdirSync(path.join(sessionRoot, pid))) {
          if (name.endsWith('.json')) out.add(name.slice(0, -'.json'.length))
        }
      } catch {
        // Skip
      }
    }
  } catch {
    // Storage root missing = openCode never ran
  }
  return out
}

function sameDir(a: string, b: string): boolean {
  return a.replace(/[\\/]+/g, '\\').toLowerCase().endsWith(b.replace(/[\\/]+/g, '\\').toLowerCase())
}

/** Poll the session storage for a newly created session started from cwd (excluding pre-spawn ids) */
export function sniffNewOpenCodeSession(
  cwd: string,
  knownIds: Set<string>,
  onFound: (sessionId: string) => void,
  timeoutMs = 120_000
): () => void {
  const sessionRoot = path.join(storageRoot(), 'session')
  let stopped = false
  const startedAt = Date.now()
  const timer = setInterval(() => {
    if (stopped) return
    if (Date.now() - startedAt > timeoutMs) {
      stop()
      return
    }
    try {
      for (const pid of fs.readdirSync(sessionRoot)) {
        const pdir = path.join(sessionRoot, pid)
        for (const name of fs.readdirSync(pdir)) {
          if (!name.endsWith('.json')) continue
          const id = name.slice(0, -'.json'.length)
          if (knownIds.has(id)) continue
          const doc = readJson<SessionDoc>(path.join(pdir, name))
          if (doc?.directory && sameDir(doc.directory, cwd)) {
            stopped = true
            clearInterval(timer)
            onFound(id)
            return
          }
        }
      }
    } catch {
      // Storage not created yet; check again next tick
    }
  }, 800)
  const stop = () => {
    stopped = true
    clearInterval(timer)
  }
  return stop
}

// ── Telemetry: aggregate message jsons into the same SessionStatus shape as claude ──

interface MessageDoc {
  role?: string
  cost?: number
  modelID?: string
  providerID?: string
  time?: { created?: number | string; completed?: number | string }
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cache?: { read?: number; write?: number }
  }
}

interface Contribution {
  kind: 'msg' | 'part'
  mtimeMs: number
  tokensIn: number
  tokensOut: number
  cacheRead: number
  cacheWrite: number
  costUsd: number
  durationMs: number
  isUserTurn: boolean
  model: string
  eventCount: number
}

function contributionOf(file: string, kind: 'msg' | 'part'): Contribution | null {
  const mtime = mtimeOf(file)
  if (kind === 'part') {
    return {
      kind,
      mtimeMs: mtime,
      tokensIn: 0,
      tokensOut: 0,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: 0,
      durationMs: 0,
      isUserTurn: false,
      model: '',
      eventCount: 0
    }
  }
  const doc = readJson<MessageDoc>(file)
  if (!doc) return null
  const t = doc.tokens ?? {}
  const created = toTs(doc.time?.created)
  const completed = toTs(doc.time?.completed)
  return {
    kind,
    mtimeMs: mtime,
    tokensIn: t.input ?? 0,
    tokensOut: (t.output ?? 0) + (t.reasoning ?? 0),
    cacheRead: t.cache?.read ?? 0,
    cacheWrite: t.cache?.write ?? 0,
    costUsd: typeof doc.cost === 'number' ? doc.cost : 0,
    durationMs: created && completed > created ? completed - created : 0,
    isUserTurn: doc.role === 'user',
    model: doc.role === 'assistant' ? doc.modelID || '' : '',
    eventCount: 1
  }
}

function mtimeOf(file: string): number {
  try {
    return fs.statSync(file).mtimeMs
  } catch {
    return -1
  }
}

const POLL_MS = 1000

/** Aggregate openCode storage into SessionStatus by tracking per-file contributions (re-read only changed files) */
export class OpenCodeTailer {
  readonly sessionId: string
  private readonly onDirty: () => void
  private contrib = new Map<string, Contribution>()
  private lastTool: string | null = null
  private lastToolDetail = ''
  private status = emptyStatus()
  private stopped = false
  private timer: NodeJS.Timeout

  constructor(sessionId: string, onDirty: () => void) {
    this.sessionId = sessionId
    this.onDirty = onDirty
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
    let changed = false
    const seen = new Set<string>()
    const msgDir = path.join(storageRoot(), 'message', this.sessionId)
    // message/<sesID>/<msgID>.json carries token/cost data; part/<msgID>/ holds the tool parts
    let msgIds: string[] = []
    try {
      msgIds = fs.readdirSync(msgDir)
    } catch {
      return // No message storage for this session (yet)
    }
    for (const msgFile of msgIds) {
      changed = this.track(path.join(msgDir, msgFile), 'msg', seen) || changed
      const partDir = path.join(storageRoot(), 'part', msgFile.replace(/\.json$/, ''))
      let parts: string[] = []
      try {
        parts = fs.readdirSync(partDir)
      } catch {
        continue
      }
      for (const p of parts) changed = this.track(path.join(partDir, p), 'part', seen) || changed
    }
    if (seen.size !== this.contrib.size) {
      for (const key of [...this.contrib.keys()]) {
        if (!seen.has(key)) {
          this.contrib.delete(key)
          changed = true
        }
      }
    }
    if (changed) {
      this.recompute()
      this.onDirty()
    }
  }

  /** Track one file; returns true when it is new or changed */
  private track(file: string, kind: 'msg' | 'part', seen: Set<string>): boolean {
    seen.add(file)
    const mtime = mtimeOf(file)
    const old = this.contrib.get(file)
    if (old && old.mtimeMs === mtime) return false
    const c = contributionOf(file, kind)
    if (!c) return false
    this.contrib.set(file, c)
    this.status.lastActivity = Date.now()
    return true
  }

  private recompute(): void {
    let tokensIn = 0
    let tokensOut = 0
    let cacheRead = 0
    let cacheWrite = 0
    let costUsd = 0
    let durationMs = 0
    let turns = 0
    let eventCount = 0
    let model = ''
    for (const c of this.contrib.values()) {
      tokensIn += c.tokensIn
      tokensOut += c.tokensOut
      cacheRead += c.cacheRead
      cacheWrite += c.cacheWrite
      costUsd += c.costUsd
      durationMs += c.durationMs
      if (c.isUserTurn) turns++
      eventCount += c.eventCount
      if (c.model) model = c.model
    }
    const counts = this.collectTools()
    this.status = {
      ...this.status,
      model,
      tokensIn,
      tokensOut,
      cacheRead,
      cacheWrite,
      costUsd,
      durationMs,
      turns,
      toolCalls: counts.total,
      toolCounts: counts.counts,
      tool: this.lastTool,
      toolDetail: this.lastToolDetail,
      eventCount
    }
  }

  /** Tool calls live in part files; scan contributions for type:'tool' parts */
  private collectTools(): { total: number; counts: Record<string, number> } {
    const counts: Record<string, number> = {}
    let total = 0
    let last: { tool: string; detail: string } | null = null
    for (const key of this.contrib.keys()) {
      if (!key.includes(`${path.sep}part${path.sep}`)) continue
      const doc = readJson<{ type?: string; tool?: string; state?: { input?: unknown } }>(key)
      if (doc?.type !== 'tool' || !doc.tool) continue
      counts[doc.tool] = (counts[doc.tool] ?? 0) + 1
      total++
      last = { tool: doc.tool, detail: toolDetailOf(doc.state?.input) }
    }
    if (last) {
      this.lastTool = last.tool
      this.lastToolDetail = last.detail
    }
    return { total, counts }
  }
}

function toolDetailOf(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  const raw = o.command ?? o.file_path ?? o.filePath ?? o.path ?? o.pattern ?? o.url ?? o.query ?? ''
  const s = typeof raw === 'string' ? raw : JSON.stringify(raw)
  const s1 = s.replace(/\s+/g, ' ').trim()
  return s1.length > 80 ? s1.slice(0, 80) + '…' : s1
}
