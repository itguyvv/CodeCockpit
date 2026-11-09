import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type RuleScope = 'claude-global' | 'opencode-global' | 'project'

export interface RuleRef {
  scope: RuleScope
  engine?: 'claude' | 'opencode'
  cwd?: string
}

export interface RuleFile {
  path: string
  exists: boolean
  content: string
  crlf: boolean
}

/** openCode reads instruction files from its XDG config dir (AGENTS.md). XDG_CONFIG_HOME is
 *  honored when absolute; on Windows the ~/.config fallback follows openCode's own convention. */
export function openCodeConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), '.config')
  return path.join(base, 'opencode')
}

/** Resolve a scope to the concrete file path. The allowlist lives here — the renderer only
 *  ever sends scopes, never paths, so no arbitrary file can be addressed. */
export function resolveRuleFile(ref: RuleRef): string {
  const home = os.homedir()
  if (ref.scope === 'claude-global') return path.join(home, '.claude', 'CLAUDE.md')
  if (ref.scope === 'opencode-global') return path.join(openCodeConfigDir(), 'AGENTS.md')
  if (ref.scope === 'project') {
    const cwd = (ref.cwd ?? '').trim()
    if (!cwd || !fs.existsSync(cwd)) throw new Error('invalid project directory')
    return path.join(cwd, ref.engine === 'opencode' ? 'AGENTS.md' : 'CLAUDE.md')
  }
  throw new Error('unknown rule scope')
}

export function readRuleFile(ref: RuleRef): RuleFile {
  const file = resolveRuleFile(ref)
  let exists = false
  let content = ''
  let crlf = false
  try {
    if (fs.statSync(file).isFile()) {
      exists = true
      content = fs.readFileSync(file, 'utf-8')
      crlf = content.includes('\r\n')
    }
  } catch {
    // missing file — reported as not-created; it appears on first save
  }
  return { path: file, exists, content, crlf }
}

export function writeRuleFile(ref: RuleRef, content: string, crlf: boolean): string {
  const file = resolveRuleFile(ref)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const out = crlf ? content.replace(/\r?\n/g, '\r\n') : content.replace(/\r\n/g, '\n')
  fs.writeFileSync(file, out, 'utf-8')
  return file
}
