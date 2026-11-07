import { execFile } from 'node:child_process'
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
let cachedVersion: string | null = null

export function findClaudeBin(): Promise<string> {
  if (cachedBin) return Promise.resolve(cachedBin)
  return new Promise((resolve) => {
    const envBin = process.env.CLAUDE_BIN
    if (envBin && fs.existsSync(envBin)) {
      cachedBin = envBin
      return resolve(envBin)
    }
    for (const p of COMMON_PATHS()) {
      if (p && fs.existsSync(p)) {
        cachedBin = p
        return resolve(p)
      }
    }
    execFile('where', ['claude'], (err, stdout) => {
      if (!err && stdout.trim()) {
        const first = stdout.split(/\r?\n/)[0].trim()
        if (first && fs.existsSync(first)) {
          cachedBin = first
          return resolve(first)
        }
      }
      resolve('')
    })
  })
}

export function getClaudeVersion(bin: string): Promise<string> {
  if (cachedVersion) return Promise.resolve(cachedVersion)
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: 8000 }, (err, stdout) => {
      const v = err ? '' : stdout.trim()
      if (v) cachedVersion = v
      resolve(v)
    })
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
      'D:\\Program Files\\Git\\bin\\bash.exe',
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
