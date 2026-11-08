import { exec, execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findClaudeBin, getClaudeVersion } from './claude'

/** Supported coding-agent engines. Session data of different engines is never merged. */
export type EngineId = 'claude' | 'opencode'

export const ENGINE_IDS: EngineId[] = ['claude', 'opencode']

export function isEngineId(v: unknown): v is EngineId {
  return v === 'claude' || v === 'opencode'
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

const OPENCODE_COMMON_PATHS = (): string[] => [
  process.env.OPENCODE_BIN || '',
  path.join(os.homedir(), '.opencode', 'bin', 'opencode.exe'),
  path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'),
  path.join(process.env.APPDATA || '', 'npm', 'opencode.cmd'),
  'C:\\Program Files\\nodejs\\node_modules\\opencode-ai\\bin\\opencode.exe',
  'C:\\Program Files\\nodejs\\opencode.cmd'
]

/** Rank a candidate: real .exe > npm .cmd shim > anything else (sh scripts cannot run under CreateProcess) */
function openCodeBinRank(p: string): number {
  const lower = p.toLowerCase()
  return lower.endsWith('.exe') ? 2 : lower.endsWith('.cmd') ? 1 : 0
}

/**
 * Resolve the best spawnable binary among candidates. npm installs "opencode" as an
 * extension-less sh shim (first line of `where` output) which Windows cannot execute
 * (exit code 193); the real binary ships inside the opencode-ai package next to the shim.
 */
function resolveOpenCodeBin(candidates: string[]): string {
  const existing = candidates.filter((p) => p && fs.existsSync(p))
  for (const p of existing) {
    if (openCodeBinRank(p) === 2) return p
  }
  for (const p of existing) {
    const sibling = path.join(path.dirname(p), 'node_modules', 'opencode-ai', 'bin', 'opencode.exe')
    if (fs.existsSync(sibling)) return sibling
  }
  for (const p of existing) {
    if (openCodeBinRank(p) === 1) return p
  }
  return ''
}

export function findOpenCodeBin(): Promise<string> {
  if (cachedOpenCodeBin) return Promise.resolve(cachedOpenCodeBin)
  return new Promise((resolve) => {
    execFile('where', ['opencode'], { timeout: 5000 }, (err, stdout) => {
      const whereLines = err
        ? []
        : stdout
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean)
      const bin = resolveOpenCodeBin([...OPENCODE_COMMON_PATHS(), ...whereLines])
      if (bin) cachedOpenCodeBin = bin
      resolve(bin)
    })
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
  const [claudeBin, openCodeBin] = await Promise.all([findClaudeBin(), findOpenCodeBin()])
  const [claudeVersion, openCodeVersion] = await Promise.all([
    claudeBin ? getClaudeVersion(claudeBin) : Promise.resolve(''),
    openCodeBin ? getOpenCodeVersion(openCodeBin) : Promise.resolve('')
  ])
  return [
    { id: 'claude', bin: claudeBin, version: claudeVersion },
    { id: 'opencode', bin: openCodeBin, version: openCodeVersion }
  ]
}

/** Resolve the CLI binary for one engine ('' = not installed) */
export async function engineBin(engine: EngineId): Promise<string> {
  return engine === 'opencode' ? findOpenCodeBin() : findClaudeBin()
}
