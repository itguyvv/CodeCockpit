import fs from 'node:fs'
import { dataFile } from './dataDir'
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
  fs.writeFileSync(dataFile('aliases.json'), JSON.stringify(aliases, null, 2), 'utf-8')
  return aliases
}
