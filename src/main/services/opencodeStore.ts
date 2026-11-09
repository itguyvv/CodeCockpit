import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { emptyStatus, type SessionStatus } from './status'
import { IS_WIN } from './platform'

// openCode storage, two generations:
// - legacy (< 1.18): plain JSON under <root>/storage/ —
//     storage/project/<projectID>.json        { id, worktree, time }
//     storage/session/<projectID>/<ses>.json  { id, title, directory, projectID, time }
//     storage/message/<sesID>/<msgID>.json    { role, tokens, cost, modelID, providerID, time }
//     storage/part/<msgID>/<prtID>.json       message parts incl. tool calls (keyed by message id)
//   The JSON tree is frozen after the engine migrates, but still readable — kept as fallback.
// - current (>= 1.18): SQLite database <root>/opencode.db (WAL mode) with session/message/part
//   tables; JSON payloads inside `data` columns keep the exact same shapes as the legacy files.
//   The DB is the primary source; concurrent read-only connections are safe under WAL.
// - opencode.db on legacy versions is NOT the session store (account rows only) — every DB read
//   must tolerate the old schema being absent (SQL error → drop the connection, fall back to JSON).

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

function dbFile(): string {
  return path.join(openCodeDataRoot(), 'opencode.db')
}

// ── DB access (read-only shared connection; errors drop it so the next call reopens) ──

let readDb: DatabaseSync | null = null

function dbRead(): DatabaseSync | null {
  if (readDb) return readDb
  const file = dbFile()
  if (!fs.existsSync(file)) return null
  try {
    readDb = new DatabaseSync(file, { readOnly: true })
    return readDb
  } catch {
    return null
  }
}

function dropReadDb(): void {
  try {
    readDb?.close()
  } catch {
    // Already closed
  }
  readDb = null
}

/**
 * Whether the installed engine writes to the SQLite DB (a `session` table exists).
 * One generation only is listed per engine: once the DB era begins the legacy JSON tree
 * is abandoned by the CLI itself (its sessions fail to resume with "Session not found"),
 * so mixing both sources would show dead entries.
 */
function hasSessionTable(): boolean {
  const rows = query<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session'"
  )
  return !!rows && rows.length > 0
}

/** Run a read query against the shared connection; null on any error (caller falls back) */
function query<T>(sql: string, ...params: (string | number)[]): T[] | null {
  const db = dbRead()
  if (!db) return null
  try {
    return db.prepare(sql).all(...params) as T[]
  } catch {
    // Missing table / old schema / unreadable file — reopen next time and let the caller fall back
    dropReadDb()
    return null
  }
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

interface DbSessionRow {
  id: string
  title: string | null
  directory: string | null
  project_id: string | null
  time_updated: number | bigint
  bytes: number | bigint
}

/** List openCode sessions across all projects, newest first (DB or legacy JSON — one generation) */
export function scanOpenCodeSessions(limit = 60): OpenCodeSessionInfo[] {
  if (hasSessionTable()) {
    const dbRows = scanDbSessions(limit)
    if (dbRows.length) return dbRows
    // DB era but no rows yet: show legacy only if the DB genuinely has nothing AND the
    // frozen tree does (a migrated engine normally leaves the tree behind unread)
    if (!scanLegacySessions(1).length) return []
  }
  return scanLegacySessions(limit)
}

function scanDbSessions(limit: number): OpenCodeSessionInfo[] {
  const found: OpenCodeSessionInfo[] = []
  const rows = query<DbSessionRow>(
    `SELECT s.id, s.title, s.directory, s.project_id, s.time_updated,
       (SELECT COALESCE(SUM(LENGTH(m.data)), 0) FROM message m WHERE m.session_id = s.id)
     + (SELECT COALESCE(SUM(LENGTH(p.data)), 0) FROM part p WHERE p.session_id = s.id) AS bytes
     FROM session s WHERE s.parent_id IS NULL
     ORDER BY s.time_updated DESC LIMIT ?`,
    limit
  )
  for (const r of rows ?? []) {
    if (!r.id) continue
    found.push({
      sessionId: r.id,
      cwd: r.directory || projectWorktree(r.project_id || ''),
      title: r.title || '',
      projectID: r.project_id || '',
      lastTs: Number(r.time_updated) || 0,
      sizeBytes: Number(r.bytes) || 0
    })
  }
  return found
}

function scanLegacySessions(limit: number): OpenCodeSessionInfo[] {
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

/** All known session ids across projects (snapshot used before spawning to detect the new one) */
export function listOpenCodeSessionIds(): Set<string> {
  const out = new Set<string>()
  for (const row of query<{ id: string }>('SELECT id FROM session') ?? []) {
    if (row.id) out.add(row.id)
  }
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
  if (IS_WIN) {
    return a.replace(/[\\/]+/g, '\\').toLowerCase().endsWith(b.replace(/[\\/]+/g, '\\').toLowerCase())
  }
  const norm = (p: string): string => p.replace(/\/+$/, '').replace(/\\/g, '/')
  return norm(a).endsWith(norm(b))
}

/** Poll storage for a newly created session started from cwd (excluding pre-spawn ids) */
export function sniffNewOpenCodeSession(
  cwd: string,
  knownIds: Set<string>,
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
    // One generation per install, re-evaluated per tick so a fresh DB-era install
    // (db created on CLI startup) is picked up even if the DB lagged at spawn time
    if (hasSessionTable()) {
      const rows = query<{ id: string; directory: string | null; parent_id: string | null }>(
        'SELECT id, directory, parent_id FROM session ORDER BY time_created DESC LIMIT 30'
      )
      for (const row of rows ?? []) {
        if (!row.id || knownIds.has(row.id) || row.parent_id) continue
        if (row.directory && sameDir(row.directory, cwd)) {
          stopped = true
          clearInterval(timer)
          onFound(row.id)
          return
        }
      }
      return // DB era: never sniff the frozen legacy tree
    }
    // Legacy generation: JSON files under storage/session
    const sessionRoot = path.join(storageRoot(), 'session')
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

/** Permanently delete an openCode session (DB rows and/or legacy JSON files) */
export function deleteOpenCodeSession(sessionId: string): boolean {
  let deleted = deleteLegacySession(sessionId)
  const file = dbFile()
  if (!fs.existsSync(file)) return deleted
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(file)
    db.exec('PRAGMA busy_timeout = 3000')
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as unknown as Array<{ name: string }>
    db.exec('BEGIN')
    for (const { name } of tables) {
      if (name === 'session') continue
      const quoted = '"' + name.replace(/"/g, '""') + '"'
      const cols = db.prepare(`PRAGMA table_info(${quoted})`).all() as unknown as Array<{
        name: string
      }>
      if (!cols.some((c) => c.name === 'session_id')) continue
      const res = db.prepare(`DELETE FROM ${quoted} WHERE session_id = ?`).run(sessionId)
      if (Number(res.changes) > 0) deleted = true
    }
    const res = db.prepare('DELETE FROM session WHERE id = ?').run(sessionId)
    if (Number(res.changes) > 0) deleted = true
    db.exec('COMMIT')
  } catch {
    try {
      db?.exec('ROLLBACK')
    } catch {
      // Nothing to roll back
    }
  } finally {
    try {
      db?.close()
    } catch {
      // Already closed
    }
  }
  return deleted
}

function deleteLegacySession(sessionId: string): boolean {
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
  let msgFiles: string[] = []
  try {
    if (fs.existsSync(msgDir)) {
      // Collect names BEFORE deleting: the directory is gone afterwards
      msgFiles = fs.readdirSync(msgDir)
      fs.rmSync(msgDir, { recursive: true, force: true })
      deleted = true
    }
  } catch {
    // Skip
  }
  // part/ is keyed by message id — remove the parts of this session's messages individually
  for (const msgFile of msgFiles) {
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
  return deleted
}

// ── Telemetry: aggregate message/part payloads into the same SessionStatus shape as claude ──

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
  /** Change key of the source row (mtime of a legacy file / updated+size of a DB row) */
  stamp: string
  tokensIn: number
  tokensOut: number
  cacheRead: number
  cacheWrite: number
  costUsd: number
  durationMs: number
  isUserTurn: boolean
  model: string
  eventCount: number
  tool?: string
  toolDetail?: string
}

function contributionOfMessage(data: string): Contribution | null {
  let doc: MessageDoc
  try {
    doc = JSON.parse(data) as MessageDoc
  } catch {
    return null
  }
  const t = doc.tokens ?? {}
  const created = toTs(doc.time?.created)
  const completed = toTs(doc.time?.completed)
  return {
    kind: 'msg',
    stamp: '',
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

function contributionOfPart(data: string): Contribution {
  const c: Contribution = {
    kind: 'part',
    stamp: '',
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
  try {
    const doc = JSON.parse(data) as { type?: string; tool?: string; state?: { input?: unknown } }
    if (doc?.type === 'tool' && doc.tool) {
      c.tool = doc.tool
      c.toolDetail = toolDetailOf(doc.state?.input)
    }
  } catch {
    // Unparseable part — keep the zero contribution
  }
  return c
}

function toolDetailOf(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  const raw = o.command ?? o.file_path ?? o.filePath ?? o.path ?? o.pattern ?? o.url ?? o.query ?? ''
  const s = typeof raw === 'string' ? raw : JSON.stringify(raw)
  const s1 = s.replace(/\s+/g, ' ').trim()
  return s1.length > 80 ? s1.slice(0, 80) + '…' : s1
}

const POLL_MS = 1000

/**
 * Aggregate openCode storage into SessionStatus.
 * Primary backend: the SQLite DB (rows appended/updated in place, polled by id+stamp).
 * Fallback: the legacy JSON tree (per-file mtime tracking), for pre-1.18 engines.
 */
export class OpenCodeTailer {
  readonly sessionId: string
  private readonly onDirty: () => void
  private contrib = new Map<string, Contribution>()
  private lastTool: string | null = null
  private lastToolDetail = ''
  private status = emptyStatus()
  private stopped = false
  private timer: NodeJS.Timeout
  private readonly useDb: boolean

  constructor(sessionId: string, onDirty: () => void) {
    this.sessionId = sessionId
    this.onDirty = onDirty
    // One generation per install: the engine either writes the DB or the legacy tree
    this.useDb = hasSessionTable()
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
    if (this.useDb) this.pollDb()
    else this.pollLegacy()
  }

  /** Poll message/part rows for this session from the DB */
  private pollDb(): void {
    let changed = false
    const seen = new Set<string>()
    const msgs = query<{ id: string; time_updated: number | bigint; data: string }>(
      'SELECT id, time_updated, data FROM message WHERE session_id = ?',
      this.sessionId
    )
    for (const row of msgs ?? []) {
      changed =
        this.track('m:' + row.id, `${row.time_updated}:${row.data.length}`, () => contributionOfMessage(row.data), seen) ||
        changed
    }
    const parts = query<{ id: string; time_updated: number | bigint; data: string }>(
      'SELECT id, time_updated, data FROM part WHERE session_id = ?',
      this.sessionId
    )
    for (const row of parts ?? []) {
      changed =
        this.track('p:' + row.id, `${row.time_updated}:${row.data.length}`, () => contributionOfPart(row.data), seen) ||
        changed
    }
    changed = this.prune(seen) || changed
    if (changed) {
      this.recompute()
      this.onDirty()
    }
  }

  /** Poll the legacy JSON tree (message/<ses>/<msg>.json + part/<msgID>/*) */
  private pollLegacy(): void {
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
      const msgPath = path.join(msgDir, msgFile)
      changed =
        this.track(msgPath, String(mtimeOf(msgPath)), () => contributionOfLegacyFile(msgPath, 'msg'), seen) || changed
      const partDir = path.join(storageRoot(), 'part', msgFile.replace(/\.json$/, ''))
      let parts: string[] = []
      try {
        parts = fs.readdirSync(partDir)
      } catch {
        continue
      }
      for (const p of parts) {
        const partPath = path.join(partDir, p)
        changed =
          this.track(partPath, String(mtimeOf(partPath)), () => contributionOfLegacyFile(partPath, 'part'), seen) ||
          changed
      }
    }
    changed = this.prune(seen) || changed
    if (changed) {
      this.recompute()
      this.onDirty()
    }
  }

  /** Track one source; returns true when it is new or changed */
  private track(key: string, stamp: string, make: () => Contribution | null, seen: Set<string>): boolean {
    seen.add(key)
    const old = this.contrib.get(key)
    if (old && old.stamp === stamp) return false
    const c = make()
    if (!c) return false
    c.stamp = stamp
    this.contrib.set(key, c)
    this.status.lastActivity = Date.now()
    return true
  }

  /** Drop contributions whose source disappeared (rows deleted / files removed) */
  private prune(seen: Set<string>): boolean {
    if (seen.size === this.contrib.size) return false
    let changed = false
    for (const key of [...this.contrib.keys()]) {
      if (!seen.has(key)) {
        this.contrib.delete(key)
        changed = true
      }
    }
    return changed
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
    let toolCalls = 0
    const counts: Record<string, number> = {}
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
      if (c.tool) {
        counts[c.tool] = (counts[c.tool] ?? 0) + 1
        toolCalls++
        this.lastTool = c.tool
        this.lastToolDetail = c.toolDetail ?? ''
      }
    }
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
      toolCalls,
      toolCounts: counts,
      tool: this.lastTool,
      toolDetail: this.lastToolDetail,
      eventCount
    }
  }
}

function contributionOfLegacyFile(file: string, kind: 'msg' | 'part'): Contribution | null {
  const doc = readJson<MessageDoc>(file)
  if (!doc) return null
  const data = JSON.stringify(doc)
  return kind === 'part' ? contributionOfPart(data) : contributionOfMessage(data)
}

function mtimeOf(file: string): number {
  try {
    return fs.statSync(file).mtimeMs
  } catch {
    return -1
  }
}
