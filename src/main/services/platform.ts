import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

export const IS_WIN = process.platform === 'win32'
export const IS_MAC = process.platform === 'darwin'
export const IS_LINUX = process.platform === 'linux'

/** Platform-appropriate PATH lookup command ("where" on Windows, "which" elsewhere) */
export function whichCommand(): string {
  return IS_WIN ? 'where' : 'which'
}

/**
 * Preference rank for candidate CLI binaries discovered on PATH or in common
 * install locations: higher wins. On Windows a real .exe is preferred over a
 * .cmd shim (cmd.exe wrapper adds a console layer); elsewhere any executable
 * is equally fine, so discovery order in the candidate array is the authority.
 */
export function binRank(p: string): number {
  if (IS_WIN) {
    const lower = p.toLowerCase()
    if (lower.endsWith('.exe')) return 2
    if (lower.endsWith('.cmd') || lower.endsWith('.bat')) return 1
    return 0
  }
  return 1
}

/** Home-relative path with the platform's native separator */
export function homePath(...segs: string[]): string {
  return path.join(os.homedir(), ...segs)
}

/** Locate a command on PATH via where/which (empty string when not found) */
export function locateOnPath(name: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(whichCommand(), [name], (err, stdout) => {
      const lines = String(stdout ?? '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
      if (err || lines.length === 0) return resolve('')
      let best = lines[0]
      for (const line of lines) if (binRank(line) > binRank(best)) best = line
      resolve(best)
    })
  })
}
