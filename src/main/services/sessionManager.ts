import { BrowserWindow, Notification } from 'electron'
import * as pty from '@lydell/node-pty'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dataFile, writeJsonAtomic } from './dataDir'
import { getAlias } from './projectMeta'
import { t } from './i18n'
import { findGitBash } from './claude'
import {
  scanNativeSessions,
  listExistingSessionIds,
  sniffNewSessionFile,
  deleteNativeSession,
  type NativeSessionInfo
} from './jsonl'
import { SessionTailer, resolveSessionFile, sessionFilePath, type SessionStatus } from './jsonlTail'
import { buildEngineArgs, engineBin, isEngineId, type EngineId } from './engines'
import { injectionEnv } from './providers'
import { IS_MAC, IS_WIN } from './platform'
import {
  OpenCodeTailer,
  deleteOpenCodeSession,
  listOpenCodeSessionIds,
  scanOpenCodeSessions,
  sniffNewOpenCodeSession
} from './opencodeStore'
import {
  CodexTailer,
  deleteCodexSession,
  listCodexSessionIds,
  resolveCodexSessionFile,
  scanCodexSessions,
  sniffNewCodexSession
} from './codexStore'

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'

export interface SessionRecord {
  id: string
  /** Engine-native session id (claude UUID / openCode ses_...); null until the CLI reports one */
  claudeSessionId: string | null
  cwd: string
  permissionMode: PermissionMode
  title: string
  status: 'running' | 'exited'
  startedAt: number
  cols?: number
  rows?: number
  /** --model flag passed to the CLI ('' = CLI default; claude only) */
  model?: string
  /** Owning engine; older records on disk default to 'claude' */
  engine: EngineId
  /** API provider profile used for env injection; '' = builtin default, undefined = engine active profile */
  providerId?: string
}

/** Telemetry source shared by both engines (claude jsonl tailer / openCode storage tailer) */
interface StatusTailer {
  getStatus(): SessionStatus
  dispose(): void
  /** Authoritative work-state override (codex): true while a rollout task is in flight */
  busyHint?: () => boolean
}

interface LiveProc {
  pty: pty.IPty
  record: SessionRecord
  stopSniffer?: () => void
  tailer?: StatusTailer
}

const registry = new Map<string, SessionRecord>()
const procs = new Map<string, LiveProc>()

// Busy detection: PTY output within the last 3 seconds = processing (AI streaming / tool execution / animations).
// The claude TUI is completely silent while waiting for input; this distinguishes green(busy) from gray(idle).
const lastDataAt = new Map<string, number>()
const busyStates = new Map<string, boolean>()
const BUSY_WINDOW_MS = 3000

/** Sessions whose process is being deliberately replaced (mode switch / changeDir):
 *  the stale exit event must not mark the session exited in the renderer */
const replacing = new Set<string>()

/** Notification preferences live in settings.json; undefined/false = off (opt-in feature) */
function notifyPrefs(): { notifyOnIdle: boolean; notifyOnFocusSession: boolean } {
  try {
    const s = JSON.parse(fs.readFileSync(dataFile('settings.json'), 'utf-8')) as {
      notifyOnIdle?: boolean
      notifyOnFocusSession?: boolean
    }
    return { notifyOnIdle: s.notifyOnIdle === true, notifyOnFocusSession: s.notifyOnFocusSession === true }
  } catch {
    return { notifyOnIdle: false, notifyOnFocusSession: false }
  }
}

/** Bring the app window up; optionally also switch the renderer to the given session */
function presentWindow(jumpToSessionId?: string): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isMinimized()) w.restore()
    w.show()
    w.focus()
  }
  if (jumpToSessionId) broadcast('pty:focus', { id: jumpToSessionId })
}

const busyTimer = setInterval(() => {
  const now = Date.now()
  for (const [id, live] of procs) {
    const last = lastDataAt.get(id) ?? 0
    const ptyActive = now - last < BUSY_WINDOW_MS
    // Background shells keep a session active even while the TUI waits silently for input
    const bg = statusBySession.get(id)?.backgroundTasks ?? 0
    // codex's full-screen TUI repaints on every scroll, so PTY output is not a reliable
    // work signal there — the rollout's task_started/task_complete pair is authoritative
    const active =
      live.record.engine === 'codex' ? (live.tailer?.busyHint?.() ?? ptyActive) : ptyActive
    const busy = active || bg > 0
    if (busyStates.get(id) !== busy) {
      const prev = busyStates.get(id)
      busyStates.set(id, busy)
      broadcast('pty:busy', { id, busy: active, bg })
      // busy → idle: system notification (opt-in; 5s minimum so a single
      // stray output burst doesn't fire while the user is still typing)
      if (prev === true && !busy) {
        const startedAt = busyStartAt.get(id) ?? 0
        const prefs = notifyPrefs()
        if (
          now - startedAt > 5_000 &&
          !notifySuppressed.has(id) &&
          Notification.isSupported() &&
          prefs.notifyOnIdle
        ) {
          const rec = registry.get(id)
          const notification = new Notification({
            title: t('main.notifyTitle'),
            body: rec
              ? t('main.notifyIdleBody', {
                  name: rec.title || getAlias(rec.cwd) || path.basename(rec.cwd)
                })
              : t('main.notifyIdleBodyPlain')
          })
          notification.on('click', () => presentWindow(id))
          notification.show()
          // One notification per user request: re-armed by the next real input (writeInput).
          // Without this, the auto-jump's attach/resize redraws read as new output and re-notify.
          notifySuppressed.add(id)
          // Opt-in: at notification time also surface the window and switch to that session
          if (prefs.notifyOnFocusSession) presentWindow(id)
        }
      }
      if (busy && prev !== true) busyStartAt.set(id, now)
    }
  }
}, 1000)

// ── jsonl-mirrored status: tailer aggregation → throttled pty:status broadcast ──
const statusBySession = new Map<string, SessionStatus>()
const dirtyStatus = new Set<string>()
const busyStartAt = new Map<string, number>()
/** Sessions that already fired their idle notification; cleared on user input */
const notifySuppressed = new Set<string>()
/** Until this timestamp PTY output is not counted as activity: after a resize the
 *  TUI redraws its whole screen, which must not read as the AI working */
const resizeGraceUntil = new Map<string, number>()

const statusTimer = setInterval(() => {
  if (dirtyStatus.size === 0) return
  for (const id of dirtyStatus) {
    const st = statusBySession.get(id)
    if (st) broadcast('pty:status', { id, status: st })
  }
  dirtyStatus.clear()
}, 800)

function ensureTailer(live: LiveProc): void {
  if (live.tailer || !live.record.claudeSessionId) return
  const id = live.record.claudeSessionId
  const emit = (): void => {
    statusBySession.set(live.record.id, live.tailer!.getStatus())
    dirtyStatus.add(live.record.id)
  }
  // openCode aggregates from its own JSON storage, codex from its rollout jsonl
  live.tailer =
    live.record.engine === 'opencode'
      ? new OpenCodeTailer(id, emit)
      : live.record.engine === 'codex'
        ? new CodexTailer(id, emit)
        : new SessionTailer(resolveSessionFile(id) ?? sessionFilePath(live.record.cwd, id), emit)
  // Broadcast an initial snapshot right after tailing (resumed sessions get full stats immediately)
  statusBySession.set(live.record.id, live.tailer!.getStatus())
  dirtyStatus.add(live.record.id)
}

export function getStatus(id: string): SessionStatus | null {
  const live = procs.get(id)
  if (live?.tailer) return live.tailer.getStatus()
  return statusBySession.get(id) ?? null
}

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send(channel, payload)
  }
}

function saveRegistry(): void {
  try {
    const list = [...registry.values()]
    writeJsonAtomic(dataFile('sessions.json'), list)
  } catch {
    // Non-fatal if the save fails
  }
}

function loadRegistry(): void {
  try {
    const raw = fs.readFileSync(dataFile('sessions.json'), 'utf-8')
    const list: SessionRecord[] = JSON.parse(raw)
    for (const r of list) {
      registry.set(r.id, { ...r, engine: r.engine ?? 'claude' }) // older records predate engines
    }
  } catch {
    // No file on first launch
  }
}

let spawnEnvCache: Record<string, string> | null = null

async function buildSpawnEnv(record: SessionRecord): Promise<Record<string, string>> {
  let env = spawnEnvCache
  if (!env) {
    env = { ...process.env } as Record<string, string>
    // CLI Bash tools capture child output through pipes and decode it as UTF-8, but on
    // Windows Python encodes pipe output in the ANSI codepage (GBK on zh-CN systems)
    // and MSYS bash shows non-ASCII paths as byte escapes when LANG is unset — either
    // way Chinese tool output arrives as replacement characters. Inject UTF-8 defaults
    // only when the user has not set them (an explicit PYTHONUTF8=0 or LC_ALL wins).
    if (!env.PYTHONUTF8) env.PYTHONUTF8 = '1'
    if (!env.LANG && !env.LC_ALL) env.LANG = 'en_US.UTF-8'
    if (IS_WIN) {
      // git-bash is only a claude CLI requirement on Windows. Resolved unconditionally
      // there: the first session may be openCode but later claude ones need bash too
      const bash = await findGitBash()
      if (bash) env.CLAUDE_CODE_GIT_BASH_PATH = bash
    }
    spawnEnvCache = env
  }
  // Provider injection is resolved per spawn (the active profile may change between sessions)
  const extra = injectionEnv(record.engine, record.providerId)
  return { ...env, ...extra }
}

/** Single-quote a POSIX argument (embedded quotes closed and re-opened) */
function posixQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** Login+interactive shell of the user's session; the fallback covers GUI launches where SHELL is unset */
function userShell(): string {
  return process.env.SHELL || (IS_MAC ? '/bin/zsh' : '/bin/bash')
}

async function spawnFor(record: SessionRecord, bin: string): Promise<pty.IPty> {
  const args = buildEngineArgs(record.engine, {
    resumeId: record.claudeSessionId ?? undefined,
    model: record.model,
    mode: record.permissionMode
  })
  // CreateProcess cannot execute .cmd shims directly — route them through cmd.exe
  const isCmd = bin.toLowerCase().endsWith('.cmd')
  // Normalize spawn dims so resizeSession can dedup no-op resizes against them
  record.cols ??= 110
  record.rows ??= 30
  // On macOS/Linux a GUI-launched app inherits launchd's minimal environment — the shell
  // profile (API keys, PATH additions, proxies) that makes the CLI work in a terminal is
  // missing, which surfaced as "Not logged in" while the same CLI worked in Terminal.app.
  // Spawn through the user's login+interactive shell and exec the CLI inside it, so the
  // session environment matches a real terminal. exec keeps the pid, so kill/exit
  // semantics stay attached to the CLI process itself.
  const shell = IS_WIN ? '' : userShell()
  const haveShell = shell && fs.existsSync(shell)
  const file = isCmd ? 'cmd.exe' : haveShell ? shell : bin
  const spawnArgs = isCmd
    ? ['/d', '/s', '/c', bin, ...args]
    : haveShell
      ? ['-l', '-i', '-c', `exec ${[bin, ...args].map(posixQuote).join(' ')}`]
      : args
  const p = pty.spawn(file, spawnArgs, {
    name: 'xterm-256color',
    cols: record.cols,
    rows: record.rows,
    cwd: record.cwd,
    env: await buildSpawnEnv(record)
  })
  p.onData((data) => {
    // Inside the resize grace window the TUI is merely redrawing — stay idle
    if (Date.now() >= (resizeGraceUntil.get(record.id) ?? 0)) lastDataAt.set(record.id, Date.now())
    broadcast('pty:data', { id: record.id, data })
  })
  p.onExit(({ exitCode }) => {
    const live = procs.get(record.id)
    // A respawned process already owns this session: this exit is from a replaced process
    if (live && live.pty !== p) return
    // Deliberate restart (mode switch / changeDir): the renderer keeps the session alive
    if (replacing.has(record.id)) return
    if (live) {
      live.stopSniffer?.()
      live.tailer?.dispose()
      procs.delete(record.id)
    }
    record.status = 'exited'
    registry.set(record.id, record)
    saveRegistry()
    broadcast('pty:exit', { id: record.id, exitCode })
  })
  procs.set(record.id, { pty: p, record })
  ensureTailer(procs.get(record.id)!)
  return p
}

export interface CreateOpts {
  cwd: string
  mode: PermissionMode
  resumeId?: string
  title?: string
  model?: string
  cols?: number
  rows?: number
  /** Target engine; defaults to claude */
  engine?: EngineId
  /** API provider profile id ('' = builtin default); omitted = engine active profile */
  providerId?: string
}

export async function createSession(opts: CreateOpts): Promise<{ id: string }> {
  const engine: EngineId = isEngineId(opts.engine) ? opts.engine : 'claude'
  const bin = await engineBin(engine)
  if (!bin)
    throw new Error(t(engine === 'opencode' ? 'main.noOcCli' : engine === 'codex' ? 'main.noCodexCli' : 'main.noCli'))
  const record: SessionRecord = {
    id: randomUUID(),
    claudeSessionId: opts.resumeId ?? null,
    cwd: opts.cwd,
    permissionMode: opts.mode,
    title: opts.title ?? '',
    status: 'running',
    startedAt: Date.now(),
    cols: opts.cols,
    rows: opts.rows,
    model: engine === 'claude' ? opts.model ?? '' : '',
    engine,
    providerId: opts.providerId
  }
  registry.set(record.id, record)
  saveRegistry()
  // Snapshot before spawn: the new session's id is guaranteed to be absent from this snapshot
  const knownIds =
    engine === 'opencode'
      ? listOpenCodeSessionIds()
      : engine === 'codex'
        ? listCodexSessionIds()
        : listExistingSessionIds(record.cwd)
  try {
    await spawnFor(record, bin)
  } catch (e) {
    // No orphan record with status 'running' may survive a failed spawn
    registry.delete(record.id)
    saveRegistry()
    throw e
  }
  if (!record.claudeSessionId) {
    const live = procs.get(record.id)
    if (live) {
      live.stopSniffer =
        engine === 'opencode'
          ? sniffNewOpenCodeSession(record.cwd, knownIds, (sessionId) => assignSessionId(record, sessionId, live))
          : engine === 'codex'
            ? sniffNewCodexSession(record.cwd, knownIds, (sessionId) => assignSessionId(record, sessionId, live))
            : sniffNewSessionFile(record.cwd, knownIds, (sessionId) => assignSessionId(record, sessionId, live))
    }
  }
  return { id: record.id }
}

function assignSessionId(record: SessionRecord, sessionId: string, live: LiveProc): void {
  record.claudeSessionId = sessionId
  registry.set(record.id, record)
  saveRegistry()
  broadcast('pty:session-id', { id: record.id, claudeSessionId: sessionId })
  ensureTailer(live)
}

const lastInputAt = new Map<string, { data: string; at: number }>()

/** Duplicate-paste diagnostics: an identical paste-sized write twice within 150 ms means a
 *  double-dispatched key event. Log-only (to the packaged-build debug log), never drops input. */
function logDupInput(id: string, data: string): void {
  try {
    fs.appendFileSync(
      path.join(os.tmpdir(), 'codecockpit-renderer.log'),
      `[${new Date().toISOString()}] [dup-input] id=${id} bytes=${data.length}\n`
    )
  } catch {
    // Ignore
  }
}

export function writeInput(id: string, data: string): void {
  const live = procs.get(id)
  if (!live) return
  const now = Date.now()
  const prev = lastInputAt.get(id)
  if (prev && prev.data === data && data.length > 8 && now - prev.at < 150) logDupInput(id, data)
  lastInputAt.set(id, { data, at: now })
  notifySuppressed.delete(id)
  live.pty.write(data)
}

export function resizeSession(id: string, cols: number, rows: number): void {
  const live = procs.get(id)
  if (live) {
    const c = Math.max(2, Math.floor(cols))
    const r = Math.max(2, Math.floor(rows))
    // Skip no-op resizes: node-pty signals the TUI even when the size is unchanged,
    // the redraw counts as fresh output and shows a phantom "Working" on every switch
    if (live.record.cols === c && live.record.rows === r) return
    // Remember the latest size: mode switches relaunch at the same size to avoid TUI corruption
    live.record.cols = c
    live.record.rows = r
    resizeGraceUntil.set(id, Date.now() + 1500)
    try {
      live.pty.resize(c, r)
    } catch {
      // Resizing an already-exited process throws; ignore
    }
  }
}

/** Number of sessions with a live pty (exited sessions are removed from the map) */
export function runningSessionCount(): number {
  return procs.size
}

export function killSession(id: string): void {
  const live = procs.get(id)
  if (!live) return
  live.stopSniffer?.()
  try {
    live.pty.kill()
  } catch {
    // Already exited
  }
}

/** Switch permission mode mid-session: bypass affects spawn args, so always do a seamless restart via --resume */
export async function setMode(id: string, mode: PermissionMode): Promise<void> {
  const live = procs.get(id)
  if (!live) return
  const record = live.record
  if (record.permissionMode === mode) return
  record.permissionMode = mode
  registry.set(id, record)
  saveRegistry()
  const oldStop = live.stopSniffer
  live.stopSniffer = undefined
  const oldPty = live.pty
  replacing.add(id) // the old process's exit must not mark the session exited
  procs.delete(id) // onExit won't find a live entry, so the tailer won't be disposed by mistake
  broadcast('pty:data', {
    id,
    data: t('main.bannerModeChanged', { mode })
  })
  try {
    oldPty.kill()
  } catch {
    // Already exited
  }
  oldStop?.()
  const bin = await engineBin(record.engine)
  if (!bin) {
    replacing.delete(id)
    throw new Error(t('main.noCliShort'))
  }
  // Give the CLI a moment to release the session file lock so --resume doesn't read a half-written state
  await new Promise((r) => setTimeout(r, 600))
  if (procs.has(id)) {
    // Killed or replaced externally in the meantime
    replacing.delete(id)
    return
  }
  try {
    await spawnFor(record, bin)
  } catch (e) {
    replacing.delete(id)
    record.status = 'exited'
    registry.set(id, record)
    saveRegistry()
    throw e
  }
  replacing.delete(id)
  // Keep the original tailer: same session file keeps incremental reads, aggregation is not reset
  const newLive = procs.get(id)
  const oldTailer = live.tailer
  if (newLive) {
    newLive.tailer?.dispose() // spawnFor already created a new tailer for the resumed session; drop it to avoid a leak
    if (oldTailer) {
      newLive.tailer = oldTailer
      statusBySession.set(id, oldTailer.getStatus())
      dirtyStatus.add(id)
    }
  }
}

/** Change the working directory and restart with --resume (after a project moved): kill → swap cwd → relaunch */
export async function changeDir(id: string, cwd: string): Promise<void> {
  if (!fs.existsSync(cwd)) throw new Error(t('main.dirNotExist', { dir: cwd }))
  const live = procs.get(id)
  if (!live) throw new Error(t('main.sessionNotRunning'))
  const record = live.record
  record.cwd = cwd
  registry.set(id, record)
  saveRegistry()
  broadcast('pty:data', {
    id,
    data: t('main.bannerDirChanged', { dir: cwd })
  })
  const oldPty = live.pty
  const oldTailer = live.tailer
  const oldStop = live.stopSniffer
  live.stopSniffer = undefined
  replacing.add(id) // the old process's exit must not mark the session exited
  procs.delete(id)
  try {
    oldPty.kill()
  } catch {
    // Already exited
  }
  oldStop?.()
  const bin = await engineBin(record.engine)
  if (!bin) {
    replacing.delete(id)
    throw new Error(t('main.noCliShort'))
  }
  await new Promise((r) => setTimeout(r, 600))
  if (procs.has(id)) {
    // Killed or replaced externally in the meantime
    replacing.delete(id)
    return
  }
  try {
    await spawnFor(record, bin)
  } catch (e) {
    replacing.delete(id)
    record.status = 'exited'
    registry.set(id, record)
    saveRegistry()
    throw e
  }
  replacing.delete(id)
  const newLive = procs.get(id)
  if (newLive) {
    newLive.tailer?.dispose()
    if (oldTailer) {
      newLive.tailer = oldTailer
      statusBySession.set(id, oldTailer.getStatus())
      dirtyStatus.add(id)
    }
  }
}

/** History of one engine (claude jsonl mirror / codex rollouts / openCode storage), custom names overlaid */
export function listNativeSessions(engine: EngineId = 'claude', limit?: number): NativeSessionInfo[] {
  const tag = (items: NativeSessionInfo[]): NativeSessionInfo[] =>
    items.map((s) => ({ ...s, engine }))
  const list: NativeSessionInfo[] = tag(
    engine === 'opencode'
      ? scanOpenCodeSessions(limit ?? 60).map((s) => ({
          sessionId: s.sessionId,
          cwd: s.cwd,
          title: s.title || t('history.noTitle'),
          permissionMode: 'default',
          lastTs: s.lastTs,
          sizeBytes: s.sizeBytes,
          projectEncoded: s.projectID,
          engine
        }))
      : engine === 'codex'
        ? scanCodexSessions(limit ?? 60)
        : scanNativeSessions(limit ?? 60)
  )
  const titles = loadTitles()
  for (const item of list) {
    const custom = titles[item.sessionId]
    if (custom) {
      item.title = custom
      item.custom = true
    }
  }
  return list
}

/** Route a history delete by id: openCode ids carry the ses_ prefix; claude and codex ids
 *  are both UUIDs, so codex is detected by its rollout file actually existing on disk */
export function deleteHistorySession(sessionId: string): boolean {
  if (sessionId.startsWith('ses_')) return deleteOpenCodeSession(sessionId)
  if (resolveCodexSessionFile(sessionId)) return deleteCodexSession(sessionId)
  return deleteNativeSession(sessionId)
}

// ── Custom session names (same effect as /rename; local persistence takes display priority) ──

function titlesFile(): string {
  return dataFile('titles.json')
}

function loadTitles(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(titlesFile(), 'utf-8'))
  } catch {
    return {}
  }
}

export function renameSession(claudeSessionId: string, title: string): void {
  const titles = loadTitles()
  if (title.trim()) titles[claudeSessionId] = title.trim()
  else delete titles[claudeSessionId]
  writeJsonAtomic(titlesFile(), titles)
}

export function shutdownAll(): void {
  for (const [id, live] of [...procs.entries()]) {
    live.stopSniffer?.()
    try {
      live.pty.kill()
    } catch {
      // Already exited
    }
    const rec = registry.get(id)
    if (rec) rec.status = 'exited' // sessions.json must not keep claiming 'running' after a quit
    procs.delete(id)
  }
  saveRegistry()
}

loadRegistry()
