import { exec, execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const COMMON_PATHS = (): string[] => {
  const localAppData = process.env.LOCALAPPDATA || ''
  const appData = process.env.APPDATA || ''
  return [
    path.join(localAppData, 'Microsoft', 'WinGet', 'Links', 'claude.exe'),
    path.join(os.homedir(), '.local', 'bin', 'claude.exe'),
    path.join(appData, 'npm', 'claude.cmd'),
    'C:\\Program Files\\nodejs\\claude.cmd'
  ]
}

let cachedBin: string | null = null
/** Version strings keyed by binary path (the resolved path can change after an upgrade) */
const versionCache = new Map<string, string>()

/** Rank a candidate: real .exe > npm .cmd shim > anything else (sh scripts cannot run under CreateProcess) */
function claudeBinRank(p: string): number {
  const lower = p.toLowerCase()
  return lower.endsWith('.exe') ? 2 : lower.endsWith('.cmd') ? 1 : 0
}

export function findClaudeBin(): Promise<string> {
  if (cachedBin) return Promise.resolve(cachedBin)
  return new Promise((resolve) => {
    const envBin = process.env.CLAUDE_BIN
    if (envBin && fs.existsSync(envBin)) {
      cachedBin = envBin
      return resolve(envBin)
    }
    const common = COMMON_PATHS().filter((p) => p && fs.existsSync(p))
    execFile('where', ['claude'], { timeout: 5000 }, (err, stdout) => {
      // `where` may list an extension-less sh shim first; rank so the spawnable binary wins
      const whereLines = err
        ? []
        : stdout
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l && fs.existsSync(l))
      const all = [...common, ...whereLines]
      const best =
        all.find((p) => claudeBinRank(p) === 2) ||
        all.find((p) => claudeBinRank(p) === 1) ||
        all[0] ||
        ''
      if (best) cachedBin = best
      resolve(best)
    })
  })
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

/** Locate git-bash (required by the claude CLI on Windows); returns '' if not found */
export function findGitBash(): Promise<string> {
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
}
