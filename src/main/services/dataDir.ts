import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { IS_WIN } from './platform'

let cached: string | null = null

/** Directory a pointer file (data-dir.txt) and, on Windows, the portable data/ live in */
function appRootDir(): string {
  // Dev = project root on every platform
  if (!app.isPackaged) return path.resolve(app.getAppPath())
  // Windows keeps portable mode (everything next to the exe); on POSIX the exe sits
  // inside the .app bundle or /usr/lib, which is useless as a default cwd — use home
  return IS_WIN ? path.dirname(app.getPath('exe')) : os.homedir()
}

export function getAppRoot(): string {
  return appRootDir()
}

function pointerFile(): string {
  if (IS_WIN) return path.join(appRootDir(), 'data-dir.txt')
  return path.join(app.getPath('userData'), 'data-dir.txt')
}

export function getDataDir(): string {
  if (cached) return cached
  let dir = IS_WIN ? path.join(appRootDir(), 'data') : path.join(app.getPath('userData'), 'data')
  try {
    const pointer = pointerFile()
    if (fs.existsSync(pointer)) {
      const custom = fs.readFileSync(pointer, 'utf-8').trim().split(/\r?\n/)[0]
      if (custom) dir = custom
    }
  } catch {
    // Fall back to the default location if the pointer file is unreadable
  }
  fs.mkdirSync(dir, { recursive: true })
  cached = dir
  return dir
}

export function setDataDir(custom: string): string {
  fs.writeFileSync(pointerFile(), custom, 'utf-8')
  cached = null
  return getDataDir()
}

export function dataFile(...names: string[]): string {
  return path.join(getDataDir(), ...names)
}
