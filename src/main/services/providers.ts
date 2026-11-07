import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dataFile } from './dataDir'
import type { EngineId } from './engines'

/**
 * cc-switch style API provider profiles.
 * "builtin-default" means "leave the CLI configuration untouched" (no injection).
 * Concrete profiles are injected per session via environment variables and can also
 * be applied globally by rewriting the CLI's own config files.
 */
export interface ProviderProfile {
  id: string
  name: string
  engine: EngineId
  /** API base URL, e.g. https://api.example.com */
  baseUrl: string
  /** API key / auth token */
  apiKey: string
  /** openCode only: provider id inside the generated config (e.g. my-relay) */
  providerId?: string
  /** openCode only: model id passed to -m as providerId/modelId */
  modelId?: string
  /** openCode only: AI SDK package implementing the provider protocol */
  npmPackage?: string
  /** claude only: model name mapping (all four may point at the same model) */
  modelMap?: { main?: string; haiku?: string; sonnet?: string; opus?: string }
  builtin?: boolean
}

export const BUILTIN_PROFILE_ID = 'builtin-default'

export interface ProviderStore {
  profiles: ProviderProfile[]
  /** Profiles used for new sessions when the caller does not pick one; '' = builtin default */
  activeByEngine: Partial<Record<EngineId, string>>
}

function builtinProfile(engine: EngineId): ProviderProfile {
  return {
    id: BUILTIN_PROFILE_ID,
    name: engine === 'opencode' ? 'Default (openCode)' : 'Default (Claude)',
    engine,
    baseUrl: '',
    apiKey: '',
    builtin: true
  }
}

export function builtinFor(engine: EngineId): ProviderProfile {
  return builtinProfile(engine)
}

function storeFile(): string {
  return dataFile('providers.json')
}

function loadStore(): ProviderStore {
  const fallback: ProviderStore = {
    profiles: [builtinProfile('claude'), builtinProfile('opencode')],
    activeByEngine: { claude: BUILTIN_PROFILE_ID, opencode: BUILTIN_PROFILE_ID }
  }
  try {
    const raw = JSON.parse(fs.readFileSync(storeFile(), 'utf-8')) as Partial<ProviderStore>
    const profiles = Array.isArray(raw.profiles) ? raw.profiles : []
    const actives = raw.activeByEngine ?? {}
    return {
      profiles: [...profiles.filter((p) => p && p.id !== BUILTIN_PROFILE_ID), ...fallback.profiles],
      activeByEngine: {
        claude: actives.claude || BUILTIN_PROFILE_ID,
        opencode: actives.opencode || BUILTIN_PROFILE_ID
      }
    }
  } catch {
    return fallback
  }
}

function saveStore(store: ProviderStore): void {
  // Builtins are regenerated, never persisted (their shape may evolve)
  const clean: ProviderStore = {
    profiles: store.profiles.filter((p) => !p.builtin),
    activeByEngine: store.activeByEngine
  }
  fs.writeFileSync(storeFile(), JSON.stringify(clean, null, 2), 'utf-8')
}

export function listProfiles(): ProviderStore {
  return loadStore()
}

/** Create or update a non-builtin profile */
export function saveProfile(profile: ProviderProfile): ProviderStore {
  const store = loadStore()
  const next: ProviderProfile = { ...profile, id: profile.id || randomUUID(), builtin: false }
  const idx = store.profiles.findIndex((p) => p.id === next.id)
  if (idx >= 0) store.profiles[idx] = next
  else store.profiles.push(next)
  saveStore(store)
  return store
}

export function deleteProfile(id: string): ProviderStore {
  const store = loadStore()
  store.profiles = store.profiles.filter((p) => p.id !== id || p.builtin)
  for (const eng of ['claude', 'opencode'] as EngineId[]) {
    if (store.activeByEngine[eng] === id) store.activeByEngine[eng] = BUILTIN_PROFILE_ID
  }
  saveStore(store)
  return store
}

export function setActiveProfile(engine: EngineId, id: string): ProviderStore {
  const store = loadStore()
  store.activeByEngine[engine] = store.profiles.some((p) => p.id === id) ? id : BUILTIN_PROFILE_ID
  saveStore(store)
  return store
}

/** Profile used for a new session when none is picked explicitly */
export function activeProfile(engine: EngineId): ProviderProfile | undefined {
  const store = loadStore()
  const id = store.activeByEngine[engine] || BUILTIN_PROFILE_ID
  return store.profiles.find((p) => p.id === id)
}

/** Resolve a profile id (builtin included) to a profile object; undefined if unknown */
export function profileById(id: string | undefined): ProviderProfile | undefined {
  if (!id) return undefined
  if (id === BUILTIN_PROFILE_ID) return undefined // builtin = no injection, handled by caller
  return loadStore().profiles.find((p) => p.id === id)
}

/** Environment variables injected into a spawned CLI process for this profile */
export function providerEnv(profile: ProviderProfile): Record<string, string> {
  if (profile.engine === 'opencode') {
    const providerId = profile.providerId || 'custom'
    const modelId = profile.modelId || ''
    const config = {
      provider: {
        [providerId]: {
          npm: profile.npmPackage || '@ai-sdk/anthropic',
          name: profile.name,
          options: { baseURL: profile.baseUrl, apiKey: profile.apiKey },
          ...(modelId ? { models: { [modelId]: { name: modelId } } } : {})
        }
      },
      ...(modelId ? { model: `${providerId}/${modelId}` } : {})
    }
    return { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) }
  }
  const env: Record<string, string> = { ANTHROPIC_BASE_URL: profile.baseUrl }
  if (profile.apiKey) env.ANTHROPIC_AUTH_TOKEN = profile.apiKey
  const m = profile.modelMap ?? {}
  if (m.main) env.ANTHROPIC_MODEL = m.main
  if (m.haiku) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = m.haiku
  if (m.sonnet) env.ANTHROPIC_DEFAULT_SONNET_MODEL = m.sonnet
  if (m.opus) env.ANTHROPIC_DEFAULT_OPUS_MODEL = m.opus
  return env
}

/** Environment injection for one session: undefined providerId follows the engine's active profile; builtin = no injection */
export function injectionEnv(engine: EngineId, providerId?: string): Record<string, string> {
  const prof = providerId === undefined ? activeProfile(engine) : profileById(providerId)
  if (!prof || prof.builtin) return {}
  return providerEnv(prof)
}

// ── Global apply: rewrite the CLI's own config files (survives outside CodeCockpit) ──

function claudeSettingsFile(): string {
  return path.join(os.homedir(), '.claude', 'settings.json')
}

function openCodeConfigFile(): { file: string; jsonc: boolean } {
  const dir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  const ocDir = path.join(dir, 'opencode')
  fs.mkdirSync(ocDir, { recursive: true })
  const json = path.join(ocDir, 'opencode.json')
  const jsonc = path.join(ocDir, 'opencode.jsonc')
  if (fs.existsSync(jsonc) && !fs.existsSync(json)) return { file: jsonc, jsonc: true }
  return { file: json, jsonc: false }
}

/** Strip comments and trailing commas so a .jsonc still parses */
function lenientParse(text: string): Record<string, unknown> {
  const noComments = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
  const noTrail = noComments.replace(/,(\s*[}\]])/g, '$1')
  return JSON.parse(noTrail) as Record<string, unknown>
}

export function applyGlobalProfile(profile: ProviderProfile): void {
  if (profile.engine === 'opencode') applyOpenCodeGlobal(profile)
  else applyClaudeGlobal(profile)
}

/** cc-switch mechanism: rewrite the env block of ~/.claude/settings.json */
function applyClaudeGlobal(profile: ProviderProfile): void {
  const file = claudeSettingsFile()
  let doc: Record<string, unknown> = {}
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>
  } catch {
    // Missing or broken settings.json: start fresh (cli recreates it)
  }
  const env = { ...(doc.env as Record<string, unknown> | undefined) }
  const isBuiltin = profile.id === BUILTIN_PROFILE_ID
  const MODEL_ENV_KEYS = [
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL'
  ] as const
  if (isBuiltin) {
    delete env.ANTHROPIC_BASE_URL
    delete env.ANTHROPIC_AUTH_TOKEN
    for (const k of MODEL_ENV_KEYS) delete env[k]
  } else {
    env.ANTHROPIC_BASE_URL = profile.baseUrl
    if (profile.apiKey) env.ANTHROPIC_AUTH_TOKEN = profile.apiKey
    else delete env.ANTHROPIC_AUTH_TOKEN
    const m = profile.modelMap ?? {}
    for (const k of MODEL_ENV_KEYS) delete env[k]
    if (m.main) env.ANTHROPIC_MODEL = m.main
    if (m.haiku) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = m.haiku
    if (m.sonnet) env.ANTHROPIC_DEFAULT_SONNET_MODEL = m.sonnet
    if (m.opus) env.ANTHROPIC_DEFAULT_OPUS_MODEL = m.opus
  }
  if (Object.keys(env).length === 0) delete doc.env
  else doc.env = env
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(doc, null, 2), 'utf-8')
}

/** Merge a provider block + default model into ~/.config/opencode/opencode.json(c) */
function applyOpenCodeGlobal(profile: ProviderProfile): void {
  const { file, jsonc } = openCodeConfigFile()
  let doc: Record<string, unknown> = {}
  try {
    doc = jsonc ? lenientParse(fs.readFileSync(file, 'utf-8')) : JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch {
    // Missing or unreadable config: start fresh
  }
  if (profile.id === BUILTIN_PROFILE_ID) {
    // Builtin default cannot be "applied" to global config; nothing to write
    return
  }
  const providerId = profile.providerId || 'custom'
  const providers = { ...((doc.provider as Record<string, unknown>) ?? {}) }
  const modelId = profile.modelId || ''
  providers[providerId] = {
    npm: profile.npmPackage || '@ai-sdk/anthropic',
    name: profile.name,
    options: { baseURL: profile.baseUrl, apiKey: profile.apiKey },
    ...(modelId ? { models: { [modelId]: { name: modelId } } } : {})
  }
  doc.provider = providers
  if (modelId) doc.model = `${providerId}/${modelId}`
  fs.writeFileSync(file, JSON.stringify(doc, null, 2), 'utf-8')
}

/** Config file path per engine (shown to the user in apply-confirmation texts) */
export function globalConfigFile(engine: EngineId): string {
  return engine === 'opencode' ? openCodeConfigFile().file : claudeSettingsFile()
}

// ── Connectivity test ──

export interface ProviderTestResult {
  ok: boolean
  /** Round-trip time of the probe request */
  ms: number
  error: string
}

/**
 * One-token live request against the relay. Protocol follows the engine:
 * claude and anthropic-SDK openCode providers speak Anthropic messages,
 * openai-compatible SDK providers speak chat completions.
 */
export async function testProvider(profile: ProviderProfile): Promise<ProviderTestResult> {
  const started = Date.now()
  const base = profile.baseUrl.replace(/\/+$/, '')
  if (!base) return { ok: false, ms: 0, error: 'empty base URL' }
  const anthropicProtocol = profile.engine === 'claude' || (profile.npmPackage ?? '').includes('anthropic')
  const url = anthropicProtocol ? base + '/v1/messages' : base + '/chat/completions'
  const model =
    (anthropicProtocol ? profile.modelMap?.main : profile.modelId) ||
    (anthropicProtocol ? 'claude-sonnet-4-5' : 'gpt-4o-mini')
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${profile.apiKey}`,
        ...(anthropicProtocol ? { 'x-api-key': profile.apiKey, 'anthropic-version': '2023-06-01' } : {})
      },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(20_000)
    })
    const ms = Date.now() - started
    if (res.ok) return { ok: true, ms, error: '' }
    const text = (await res.text()).replace(/\s+/g, ' ').slice(0, 160)
    // A 400 complaining about the probe model still proves the endpoint + key are accepted
    if (res.status === 400 && /model/i.test(text)) return { ok: true, ms, error: '' }
    return { ok: false, ms, error: `HTTP ${res.status}: ${text}` }
  } catch (e) {
    return { ok: false, ms: Date.now() - started, error: e instanceof Error ? e.message : String(e) }
  }
}
