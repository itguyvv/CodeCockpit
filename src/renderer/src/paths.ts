/** Canonical key for a project directory: trailing separators stripped, case-folded on
 *  Windows. Mirror of the main-process normalizeCwd (services/projectMeta.ts) — keep the
 *  two in sync. Does not unify 8.3 short names or UNC vs mapped-drive spellings. */
export function normalizeCwd(p: string, isWin: boolean): string {
  let norm = p.trim().replace(/[\\/]+$/, '')
  if (isWin) norm = norm.toLowerCase()
  return norm
}
