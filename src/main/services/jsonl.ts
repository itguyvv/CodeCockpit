import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { t } from './i18n'
import { IS_WIN } from './platform'

export interface NativeSessionInfo {
  sessionId: string
  cwd: string
  title: string
  permissionMode: string
  lastTs: number
  sizeBytes: number
  projectEncoded: string
  /** title is a user-defined name (takes priority over the auto title) */
  custom?: boolean
}

export function projectsRoot(): string {
  return path.join(os.homedir(), '.claude', 'projects')
}

export function encodeProjectDir(dir: string): string {
  return dir.replace(/[^A-Za-z0-9]/g, '-')
}

interface HeadInfo {
  title: string
  cwd: string
  permissionMode: string
}

function readHead(jsonlPath: string): HeadInfo {
  const info: HeadInfo = { title: '', cwd: '', permissionMode: '' }
  try {
    const raw = fs.readFileSync(jsonlPath, { encoding: 'utf-8', flag: 'r' })
    const lines = raw.split(/\r?\n/)
    const cap = Math.min(lines.length, 200)
    for (let i = 0; i < cap; i++) {
      const line = lines[i].trim()
      if (!line) continue
      let ev: Record<string, unknown>
      try {
        ev = JSON.parse(line)
      } catch {
        continue
      }
      const t = ev.type
      if (t === 'permission-mode' && !info.permissionMode) {
        info.permissionMode = String(ev.permissionMode || '')
      }
      if (!info.cwd && typeof ev.cwd === 'string' && ev.cwd) info.cwd = ev.cwd
      if (t === 'user' && !ev.isSidechain && !ev.isMeta && !info.title) {
        const msg = ev.message as { content?: unknown } | undefined
        const c = msg?.content ?? ev.content
        let text = ''
        if (typeof c === 'string') text = c
        else if (Array.isArray(c)) {
          text = c
            .map((b) => (b && typeof b === 'object' && (b as { type?: string }).type === 'text' ? String((b as { text?: string }).text || '') : ''))
            .join('\n')
        }
        text = text.trim()
        if (text && !text.startsWith('<')) {
          info.title = text.slice(0, 40) + (text.length > 40 ? '…' : '')
          if (info.cwd && info.permissionMode) break
        }
      }
    }
  } catch {
    // Skip unreadable files
  }
  return info
}

export function scanNativeSessions(limit = 60): NativeSessionInfo[] {
  const root = projectsRoot()
  if (!fs.existsSync(root)) return []
  const found: NativeSessionInfo[] = []
  let encodedDirs: string[] = []
  try {
    encodedDirs = fs.readdirSync(root)
  } catch {
    return []
  }
  for (const encoded of encodedDirs) {
    const dir = path.join(root, encoded)
    try {
      if (!fs.statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    let names: string[] = []
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'))
    } catch {
      continue
    }
    for (const name of names) {
      const full = path.join(dir, name)
      try {
        const st = fs.statSync(full)
        found.push({
          sessionId: name.slice(0, -'.jsonl'.length),
          cwd: '',
          title: '',
          permissionMode: '',
          lastTs: Math.round(st.mtimeMs),
          sizeBytes: st.size,
          projectEncoded: encoded
        })
      } catch {
        continue
      }
    }
  }
  found.sort((a, b) => b.lastTs - a.lastTs)
  const top = found.slice(0, limit)
  for (const item of top) {
    const head = readHead(path.join(projectsRoot(), item.projectEncoded, item.sessionId + '.jsonl'))
    item.title = head.title || t('history.noTitle')
    item.cwd = head.cwd || decodeEncodedDir(item.projectEncoded)
    item.permissionMode = head.permissionMode || 'default'
  }
  return top
}

function decodeEncodedDir(encoded: string): string {
  // Lossy reconstruction, display fallback only; the real cwd comes from the jsonl cwd field
  return encoded.replace(/-/g, IS_WIN ? '\\' : '/')
}

/** Permanently delete a session history (removes the jsonl under ~/.claude/projects) */
export function deleteNativeSession(claudeSessionId: string): boolean {
  const root = projectsRoot()
  const target = claudeSessionId + '.jsonl'
  let dirs: string[] = []
  try {
    dirs = fs.readdirSync(root)
  } catch {
    return false
  }
  let deleted = false
  for (const encoded of dirs) {
    const full = path.join(root, encoded, target)
    try {
      if (fs.existsSync(full)) {
        fs.rmSync(full, { force: true })
        deleted = true
      }
    } catch {
      // Skip files that cannot be deleted
    }
  }
  return deleted
}

/** List existing session jsonl ids in a working directory (used to snapshot before spawn) */
export function listExistingSessionIds(cwd: string): Set<string> {
  const dir = path.join(projectsRoot(), encodeProjectDir(cwd))
  const out = new Set<string>()
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.jsonl')) out.add(name.slice(0, -'.jsonl'.length))
    }
  } catch {
    // Directory missing = no prior sessions
  }
  return out
}

/** Watch a working directory for a newly created session jsonl to sniff the new session id (excluding pre-spawn files) */
export function sniffNewSessionFile(
  cwd: string,
  knownSessionIds: Set<string>,
  onFound: (sessionId: string) => void,
  timeoutMs = 120_000
): () => void {
  const dir = path.join(projectsRoot(), encodeProjectDir(cwd))
  let stopped = false
  const startedAt = Date.now()
  const timer = setInterval(() => {
    if (stopped) return
    if (Date.now() - startedAt > timeoutMs) {
      stop()
      return
    }
    try {
      if (!fs.existsSync(dir)) return
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.jsonl')) continue
        const sessionId = name.slice(0, -'.jsonl'.length)
        if (knownSessionIds.has(sessionId)) continue
        stopped = true
        clearInterval(timer)
        onFound(sessionId)
        return
      }
    } catch {
      // Directory not created yet; check again next tick
    }
  }, 600)
  const stop = () => {
    stopped = true
    clearInterval(timer)
  }
  return stop
}
