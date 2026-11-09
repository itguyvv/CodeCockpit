export type EngineId = 'claude' | 'opencode'

export interface EngineInfo {
  id: EngineId
  bin: string
  version: string
}

export interface AppInfo {
  claudeBin: string
  claudeVersion: string
  opencodeBin: string
  opencodeVersion: string
  gitBash: string
  dataDir: string
  appRoot: string
  home: string
  appVersion: string
  lastCwd: string
}

export interface NativeSessionInfo {
  sessionId: string
  cwd: string
  title: string
  permissionMode: string
  lastTs: number
  sizeBytes: number
  projectEncoded: string
  custom?: boolean
}

export interface RestoredSession {
  id: string
  claudeSessionId: string | null
  cwd: string
  mode: string
  title: string
  model?: string
  engine?: EngineId
  providerId?: string
}

export interface SessionStatus {
  model: string
  tool: string | null
  toolDetail: string
  tokensIn: number
  tokensOut: number
  cacheRead: number
  cacheWrite: number
  costUsd: number
  turns: number
  toolCalls: number
  toolCounts: Record<string, number>
  durationMs: number
  lastActivity: number
  eventCount: number
  backgroundTasks: number
}

export interface McpServerInfo {
  name: string
  type: string
  command: string
  args: string[]
}

export interface ProviderProfile {
  id: string
  name: string
  engine: EngineId
  baseUrl: string
  apiKey: string
  /** openCode only: provider id inside the generated config */
  providerId?: string
  /** openCode only: model id (-m providerId/modelId) */
  modelId?: string
  /** openCode only: AI SDK package implementing the provider protocol */
  npmPackage?: string
  /** claude only: model name mapping (all four may point at the same model) */
  modelMap?: { main?: string; haiku?: string; sonnet?: string; opus?: string }
  builtin?: boolean
}

export interface ProviderTestResult {
  ok: boolean
  ms: number
  error: string
}

export interface ProviderListResult {
  profiles: ProviderProfile[]
  activeByEngine: Partial<Record<EngineId, string>>
  configFiles: { claude: string; opencode: string }
}

export interface AppSettings {
  lastCwd?: string
  recentCwds?: string[]
  defaultMode?: string
  defaultModel?: string
  locale?: string
  engines?: Partial<Record<EngineId, boolean>>
  confirmExit?: boolean
  /** xterm scrollback lines for new terminals */
  scrollback?: number
}

export interface WorkbenchApi {
  getAppInfo: () => Promise<AppInfo>
  enginesDiscover: () => Promise<EngineInfo[]>
  createSession: (opts: {
    cwd?: string
    mode: string
    resumeId?: string
    title?: string
    model?: string
    cols?: number
    rows?: number
    engine?: EngineId
    providerId?: string
  }) => Promise<{ id: string }>
  pickDir: () => Promise<string>
  getSettings: () => Promise<AppSettings>
  setSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>
  input: (id: string, data: string) => void
  resize: (id: string, cols: number, rows: number) => Promise<void>
  kill: (id: string) => Promise<void>
  setMode: (id: string, mode: string) => Promise<void>
  changeDir: (id: string, cwd: string) => Promise<void>
  getStatus: (id: string) => Promise<SessionStatus | null>
  listNativeSessions: (engine: EngineId) => Promise<NativeSessionInfo[]>
  renameSession: (claudeSessionId: string, title: string) => Promise<void>
  deleteSession: (claudeSessionId: string) => Promise<boolean>
  getTitles: () => Promise<Record<string, string>>
  loadWorkspace: () => Promise<RestoredSession[]>
  saveWorkspace: (list: RestoredSession[]) => Promise<boolean>
  getHistoryOrder: () => Promise<{ groups?: string[]; items?: Record<string, string[]> }>
  saveHistoryOrder: (o: { groups: string[]; items: Record<string, string[]> }) => Promise<boolean>
  providersList: () => Promise<ProviderListResult>
  providersSave: (profile: ProviderProfile) => Promise<ProviderListResult>
  providersTest: (profile: Partial<ProviderProfile> & Pick<ProviderProfile, 'engine' | 'baseUrl' | 'apiKey'>) => Promise<ProviderTestResult>
  providersDelete: (id: string) => Promise<ProviderListResult>
  providersSetActive: (engine: EngineId, id: string) => Promise<ProviderListResult>
  providersApplyGlobal: (engine: EngineId, id: string) => Promise<string>
  setDataDir: (custom: string) => Promise<string>
  mcpList: () => Promise<McpServerInfo[]>
  openPath: (p: string) => Promise<string>
  exportData: () => Promise<string>
  importData: () => Promise<string>
  copyText: (text: string) => void
  readText: () => Promise<string>
  clipboardHasImage: () => boolean
  saveClipboardImage: () => Promise<string>
  debugInfo: () => string
  onData: (cb: (id: string, data: string) => void) => () => void
  onExit: (cb: (id: string, exitCode: number) => void) => () => void
  onSessionId: (cb: (id: string, claudeSessionId: string) => void) => () => void
  onBusy: (cb: (id: string, busy: boolean, bg: number) => void) => () => void
  onStatus: (cb: (id: string, status: SessionStatus) => void) => () => void
}

declare global {
  interface Window {
    api: WorkbenchApi
  }
}

export {}
