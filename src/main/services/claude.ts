import { exec, execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { IS_WIN, binRank, homePath, locateOnPath } from './platform'

const COMMON_PATHS = (): string[] => {
  if (IS_WIN) {
    const localAppData = process.env.LOCALAPPDATA || ''
    const appData = process.env.APPDATA || ''
    return [
      path.join(localAppData, 'Microsoft', 'WinGet', 'Links', 'claude.exe'),
      homePath('.local', 'bin', 'claude.exe'),
      path.join(appData, 'npm', 'claude.cmd'),
      'C:\\Program Files\\nodejs\\claude.cmd'
    ]
  }
  return [
    homePath('.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    homePath('.npm-global', 'bin', 'claude')
  ]
}

let cachedBin: string | null = null
/** Version strings keyed by binary path (the resolved path can change after an upgrade) */
const versionCache = new Map<string, string>()

export async function findClaudeBin(): Promise<string> {
  if (cachedBin) return cachedBin
  const envBin = process.env.CLAUDE_BIN
  if (envBin && fs.existsSync(envBin)) {
    cachedBin = envBin
    return envBin
  }
  // Common paths come first so they win ties; `where`/`which` may list several
  // candidates (e.g. an extension-less sh shim) and the rank picks the spawnable one
  const common = COMMON_PATHS().filter((p) => p && fs.existsSync(p))
  const found = await locateOnPath('claude')
  const all = [...common, ...(found ? [found] : [])]
  const best = all.reduce<null | string>(
    (acc, p) => (!acc || binRank(p) > binRank(acc) ? p : acc),
    null
  )
  if (best) cachedBin = best
  return best ?? ''
}

export function getClaudeVersion(bin: string): Promise<string> {
  const hit = versionCache.get(bin)
  if (hit) return Promise.resolve(hit)
  const isCmd = bin.toLowerCase().endsWith('.cmd')
  return new Promise((resolve) => {
    const done = (v: string) => {
      if (v) versionCache.set(bin, v)
      resolve(v)
    }
    if (isCmd) {
      // .cmd shims can only run through cmd.exe
      exec(`"${bin}" --version`, { timeout: 15000 }, (err, stdout) => done(err ? '' : stdout.trim()))
    } else {
      execFile(bin, ['--version'], { timeout: 15000 }, (err, stdout) => done(err ? '' : stdout.trim()))
    }
  })
}

let cachedBash: string | null = null

/** Locate git-bash (required by the claude CLI on Windows only); returns '' if not found */
export function findGitBash(): Promise<string> {
  if (!IS_WIN) return Promise.resolve('')
  if (cachedBash !== null) return Promise.resolve(cachedBash)
  return new Promise((resolve) => {
    const envPath = process.env.CLAUDE_CODE_GIT_BASH_PATH
    if (envPath && fs.existsSync(envPath)) {
      cachedBash = envPath
      return resolve(envPath)
    }
    const candidates = [
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'usr', 'bin', 'bash.exe')
    ]
    for (const c of candidates) {
      if (c && fs.existsSync(c)) {
        cachedBash = c
        return resolve(c)
      }
    }
    // Git installs on any drive; PATH normally carries <root>\cmd\git.exe, so derive
    // bash.exe from the git.exe location instead of hardcoding per-drive paths
    execFile('where', ['git'], (gErr, gOut) => {
      if (!gErr && gOut.trim()) {
        const gitLines = gOut
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean)
        for (const git of gitLines) {
          const root = path.dirname(path.dirname(git)) // <root>\cmd\git.exe → <root>
          for (const rel of ['bin', 'usr\\bin']) {
            const p = path.join(root, rel, 'bash.exe')
            if (fs.existsSync(p)) {
              cachedBash = p
              return resolve(p)
            }
          }
        }
      }
      execFile('where', ['bash'], (err, stdout) => {
        if (!err && stdout.trim()) {
          const lines = stdout
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean)
          const picked =
            lines.find((l) => /\\git\\bin\\bash\.exe$/i.test(l)) ||
            lines.find((l) => /\\git\\usr\\bin\\bash\.exe$/i.test(l)) ||
            ''
          if (picked) {
            cachedBash = picked
            return resolve(picked)
          }
        }
        cachedBash = ''
        resolve('')
      })
    })
  })
}
