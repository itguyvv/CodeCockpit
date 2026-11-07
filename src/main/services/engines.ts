import { execFile } from 'node:child_process'
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
let cachedOpenCodeVersion: string | null = null

const OPENCODE_COMMON_PATHS = (): string[] => [
  process.env.OPENCODE_BIN || '',
  path.join(os.homedir(), '.opencode', 'bin', 'opencode.exe'),
  path.join(process.env.APPDATA || '', 'npm', 'opencode.cmd'),
  'C:\\Program Files\\nodejs\\opencode.cmd'
]

export function findOpenCodeBin(): Promise<string> {
  if (cachedOpenCodeBin) return Promise.resolve(cachedOpenCodeBin)
  return new Promise((resolve) => {
    for (const p of OPENCODE_COMMON_PATHS()) {
      if (p && fs.existsSync(p)) {
        cachedOpenCodeBin = p
        return resolve(p)
      }
    }
    execFile('where', ['opencode'], (err, stdout) => {
      if (!err && stdout.trim()) {
        const first = stdout.split(/\r?\n/)[0].trim()
        if (first && fs.existsSync(first)) {
          cachedOpenCodeBin = first
          return resolve(first)
        }
      }
      resolve('')
    })
  })
}

export function getOpenCodeVersion(bin: string): Promise<string> {
  if (cachedOpenCodeVersion) return Promise.resolve(cachedOpenCodeVersion)
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: 10000 }, (err, stdout) => {
      const v = err ? '' : stdout.trim()
      if (v) cachedOpenCodeVersion = v
      resolve(v)
    })
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
