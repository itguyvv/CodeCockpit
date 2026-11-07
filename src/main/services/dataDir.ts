import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

let cached: string | null = null

export function getAppRoot(): string {
  // Packaged = directory containing the exe (portable mode); dev = project root
  if (app.isPackaged) return path.dirname(app.getPath('exe'))
  return path.resolve(app.getAppPath())
}

export function getDataDir(): string {
  if (cached) return cached
  const root = getAppRoot()
  let dir = path.join(root, 'data')
  try {
    const pointer = path.join(root, 'data-dir.txt')
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
  const root = getAppRoot()
  fs.writeFileSync(path.join(root, 'data-dir.txt'), custom, 'utf-8')
  cached = null
  return getDataDir()
}

export function dataFile(...names: string[]): string {
  return path.join(getDataDir(), ...names)
}
