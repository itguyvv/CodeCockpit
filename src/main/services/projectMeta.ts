import fs from 'node:fs'
import { dataFile, writeJsonAtomic } from './dataDir'
import { IS_WIN } from './platform'

/** Canonical key for a project directory: trailing separators stripped, case-folded on
 *  Windows. Note: this does not unify 8.3 short names or UNC vs mapped-drive spellings. */
export function normalizeCwd(p: string): string {
  let norm = p.trim().replace(/[\\/]+$/, '')
  if (IS_WIN) norm = norm.toLowerCase()
  return norm
}

export function loadAliases(): Record<string, string> {
  try {
    const raw = JSON.parse(fs.readFileSync(dataFile('aliases.json'), 'utf-8'))
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

/** Display note for a directory (empty when none was set) */
export function getAlias(cwd: string): string {
  return loadAliases()[normalizeCwd(cwd)] ?? ''
}

/** Set (or, when blank, clear) the display note for a directory. Returns the full map. */
export function setAlias(cwd: string, alias: string): Record<string, string> {
  const aliases = loadAliases()
  const key = normalizeCwd(cwd)
  const trimmed = alias.trim()
  if (trimmed) aliases[key] = trimmed
  else delete aliases[key]
  writeJsonAtomic(dataFile('aliases.json'), aliases)
  return aliases
}

export interface ProjectEntry {
  /** Normalized key (case-folded on Windows) */
  cwd: string
  /** Original spelling as last used (what the UI fills back into inputs) */
  path: string
  addedAt: number
  lastUsedAt: number
  pinned: boolean
}

export function loadProjects(): ProjectEntry[] {
  try {
    const raw = JSON.parse(fs.readFileSync(dataFile('projects.json'), 'utf-8')) as { projects?: unknown }
    const arr = Array.isArray(raw.projects) ? raw.projects : []
    return arr.filter(
      (p): p is ProjectEntry =>
        !!p && typeof (p as ProjectEntry).cwd === 'string' && typeof (p as ProjectEntry).path === 'string'
    )
  } catch {
    return []
  }
}

function saveProjects(list: ProjectEntry[]): void {
  writeJsonAtomic(dataFile('projects.json'), { projects: list })
}

/** Register/refresh a project when a session is created (keeps its pinned state) */
export function touchProject(cwd: string): ProjectEntry[] {
  const key = normalizeCwd(cwd)
  if (!key) return loadProjects()
  const list = loadProjects()
  const now = Date.now()
  const found = list.find((p) => p.cwd === key)
  if (found) {
    found.path = cwd.trim().replace(/[\\/]+$/, '')
    found.lastUsedAt = now
  } else {
    list.push({ cwd: key, path: cwd.trim().replace(/[\\/]+$/, ''), addedAt: now, lastUsedAt: now, pinned: false })
  }
  saveProjects(list)
  return list
}

export function setProjectPinned(cwd: string, pinned: boolean): ProjectEntry[] {
  const key = normalizeCwd(cwd)
  if (!key) return loadProjects()
  const list = loadProjects()
  const found = list.find((p) => p.cwd === key)
  if (found) {
    found.pinned = pinned
  } else {
    // Pinning a directory that never had a session registers it
    if (!pinned) return list
    list.push({
      cwd: key,
      path: cwd.trim().replace(/[\\/]+$/, ''),
      addedAt: Date.now(),
      lastUsedAt: Date.now(),
      pinned: true
    })
  }
  saveProjects(list)
  return list
}
