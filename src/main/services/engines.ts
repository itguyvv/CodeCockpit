import { exec, execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { findClaudeBin, getClaudeVersion } from './claude'
import { IS_WIN, binRank, homePath, locateOnPath } from './platform'

/** Supported coding-agent engines. Session data of different engines is never merged. */
export type EngineId = 'claude' | 'codex' | 'opencode'

export const ENGINE_IDS: EngineId[] = ['claude', 'codex', 'opencode']

export function isEngineId(v: unknown): v is EngineId {
  return v === 'claude' || v === 'codex' || v === 'opencode'
}

export interface EngineInfo {
  id: EngineId
  /** Absolute path of the CLI executable, '' = not found */
  bin: string
  /** Version string reported by the CLI, '' = unknown */
  version: string
}

/** Engine spawn argument contract */
export interface SpawnOpts {
  resumeId?: string
  model?: string
  mode: string
}

/** Build CLI arguments for one engine (resume / model / permission mode) */
export function buildEngineArgs(engine: EngineId, opts: SpawnOpts): string[] {
  if (engine === 'opencode') {
    const args: string[] = []
    if (opts.resumeId) args.push('-s', opts.resumeId)
    if (opts.model) args.push('-m', opts.model)
    if (opts.mode === 'bypassPermissions') args.push('--auto')
    return args
  }
  if (engine === 'codex') {
    // Model comes from codex's own config.toml; sessions resume by uuid.
    // Mode mapping (codex 0.167): acceptEdits → approve-for-me (workspace-write with automatic
    // approvals; the old --full-auto flag no longer exists), plan → read-only sandbox,
    // bypass → no sandbox + no approvals. Codex default is workspace-write + on-request.
    const args: string[] = []
    if (opts.resumeId) args.push('resume', opts.resumeId)
    if (opts.mode === 'bypassPermissions') args.push('--dangerously-bypass-approvals-and-sandbox')
    else if (opts.mode === 'acceptEdits') args.push('--approve-for-me')
    else if (opts.mode === 'plan') args.push('--sandbox', 'read-only')
    return args
  }
  const args: string[] = []
  if (opts.resumeId) args.push('--resume', opts.resumeId)
  if (opts.model && opts.model !== 'default') args.push('--model', opts.model)
  if (opts.mode === 'bypassPermissions') args.push('--dangerously-skip-permissions')
  else args.push('--permission-mode', opts.mode)
  return args
}

/** Permission modes an engine supports (renderers filter their mode selects with this) */
export function supportedModes(engine: EngineId): string[] {
  if (engine === 'opencode') return ['default', 'bypassPermissions']
  return ['default', 'acceptEdits', 'plan', 'bypassPermissions']
}

let cachedOpenCodeBin: string | null = null
/** Version strings keyed by binary path (the resolved path can change after an upgrade) */
const openCodeVersionCache = new Map<string, string>()

const OPENCODE_COMMON_PATHS = (): string[] => {
  if (IS_WIN) {
    return [
      process.env.OPENCODE_BIN || '',
      homePath('.opencode', 'bin', 'opencode.exe'),
      path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'),
      path.join(process.env.APPDATA || '', 'npm', 'opencode.cmd'),
      'C:\\Program Files\\nodejs\\node_modules\\opencode-ai\\bin\\opencode.exe',
      'C:\\Program Files\\nodejs\\opencode.cmd'
    ]
  }
  return [
    process.env.OPENCODE_BIN || '',
    homePath('.opencode', 'bin', 'opencode'),
    '/usr/local/bin/opencode',
    '/opt/homebrew/bin/opencode',
    homePath('.local', 'bin', 'opencode')
  ]
}

/**
 * Resolve the best spawnable binary among candidates. On Windows npm installs
 * "opencode" as an extension-less sh shim (first line of `where` output) which
 * CreateProcess cannot execute (exit code 193); the real binary ships inside the
 * opencode-ai package next to the shim.
 */
function resolveOpenCodeBin(candidates: string[]): string {
  const existing = candidates.filter((p) => p && fs.existsSync(p))
  for (const p of existing) {
    if (binRank(p) === 2) return p
  }
  if (IS_WIN) {
    for (const p of existing) {
      const sibling = path.join(path.dirname(p), 'node_modules', 'opencode-ai', 'bin', 'opencode.exe')
      if (fs.existsSync(sibling)) return sibling
    }
  }
  for (const p of existing) {
    if (binRank(p) === 1) return p
  }
  return ''
}

export async function findOpenCodeBin(): Promise<string> {
  if (cachedOpenCodeBin) return cachedOpenCodeBin
  const found = await locateOnPath('opencode')
  const bin = resolveOpenCodeBin([...OPENCODE_COMMON_PATHS(), ...(found ? [found] : [])])
  if (bin) cachedOpenCodeBin = bin
  return bin
}

let cachedCodexBin: string | null = null
const codexVersionCache = new Map<string, string>()

const CODEX_COMMON_PATHS = (): string[] => {
  if (IS_WIN) {
    return [
      process.env.CODEX_BIN || '',
      path.join(process.env.APPDATA || '', 'npm', 'codex.cmd'),
      'C:\\Program Files\\nodejs\\codex.cmd'
    ]
  }
  return [
    process.env.CODEX_BIN || '',
    '/usr/local/bin/codex',
    '/opt/homebrew/bin/codex',
    homePath('.local', 'bin', 'codex')
  ]
}

export async function findCodexBin(): Promise<string> {
  if (cachedCodexBin) return cachedCodexBin
  const found = await locateOnPath('codex')
  const candidates = [...CODEX_COMMON_PATHS(), ...(found ? [found] : [])]
  const existing = candidates.filter((p) => p && fs.existsSync(p))
  // Prefer real executables over shell/cmd shims; shims still work (spawnFor routes them)
  const bin = existing.find((p) => binRank(p) === 2) ?? existing.find((p) => binRank(p) === 1) ?? ''
  if (bin) cachedCodexBin = bin
  return bin
}

export function getCodexVersion(bin: string): Promise<string> {
  const hit = codexVersionCache.get(bin)
  if (hit) return Promise.resolve(hit)
  const isCmd = bin.toLowerCase().endsWith('.cmd')
  return new Promise((resolve) => {
    const done = (v: string) => {
      if (v) codexVersionCache.set(bin, v)
      resolve(v)
    }
    if (isCmd) {
      exec(`"${bin}" --version`, { timeout: 15000 }, (err, stdout) => done(err ? '' : stdout.trim()))
    } else {
      execFile(bin, ['--version'], { timeout: 15000 }, (err, stdout) => done(err ? '' : stdout.trim()))
    }
  })
}

export function getOpenCodeVersion(bin: string): Promise<string> {
  const hit = openCodeVersionCache.get(bin)
  if (hit) return Promise.resolve(hit)
  const isCmd = bin.toLowerCase().endsWith('.cmd')
  return new Promise((resolve) => {
    const done = (v: string) => {
      if (v) openCodeVersionCache.set(bin, v)
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

/** Detect all engines in parallel; missing CLIs return bin='' instead of throwing */
export async function discoverEngines(): Promise<EngineInfo[]> {
  const [claudeBin, codexBin, openCodeBin] = await Promise.all([findClaudeBin(), findCodexBin(), findOpenCodeBin()])
  const [claudeVersion, codexVersion, openCodeVersion] = await Promise.all([
    claudeBin ? getClaudeVersion(claudeBin) : Promise.resolve(''),
    codexBin ? getCodexVersion(codexBin) : Promise.resolve(''),
    openCodeBin ? getOpenCodeVersion(openCodeBin) : Promise.resolve('')
  ])
  return [
    { id: 'claude', bin: claudeBin, version: claudeVersion },
    { id: 'codex', bin: codexBin, version: codexVersion },
    { id: 'opencode', bin: openCodeBin, version: openCodeVersion }
  ]
}

/** Resolve the CLI binary for one engine ('' = not installed) */
export async function engineBin(engine: EngineId): Promise<string> {
  if (engine === 'opencode') return findOpenCodeBin()
  if (engine === 'codex') return findCodexBin()
  return findClaudeBin()
}
