export interface AppInfo {
  claudeBin: string
  claudeVersion: string
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
}

export interface McpServerInfo {
  name: string
  type: string
  command: string
  args: string[]
}

export interface AppSettings {
  lastCwd?: string
  recentCwds?: string[]
  defaultMode?: string
  defaultModel?: string
  locale?: string
}

export interface WorkbenchApi {
  getAppInfo: () => Promise<AppInfo>
  createSession: (opts: {
    cwd?: string
    mode: string
    resumeId?: string
    title?: string
    model?: string
    cols?: number
    rows?: number
  }) => Promise<{ id: string }>
  pickDir: () => Promise<string>
  getSettings: () => Promise<AppSettings>
  setSettings: (patch: { defaultMode?: string; defaultModel?: string; locale?: string }) => Promise<AppSettings>
  input: (id: string, data: string) => void
  resize: (id: string, cols: number, rows: number) => Promise<void>
  kill: (id: string) => Promise<void>
  setMode: (id: string, mode: string) => Promise<void>
  changeDir: (id: string, cwd: string) => Promise<void>
  getStatus: (id: string) => Promise<SessionStatus | null>
  listNativeSessions: () => Promise<NativeSessionInfo[]>
  renameSession: (claudeSessionId: string, title: string) => Promise<void>
  deleteSession: (claudeSessionId: string) => Promise<boolean>
  getTitles: () => Promise<Record<string, string>>
  loadWorkspace: () => Promise<RestoredSession[]>
  saveWorkspace: (list: RestoredSession[]) => Promise<boolean>
  getHistoryOrder: () => Promise<{ groups?: string[]; items?: Record<string, string[]> }>
  saveHistoryOrder: (o: { groups: string[]; items: Record<string, string[]> }) => Promise<boolean>
  setDataDir: (custom: string) => Promise<string>
  mcpList: () => Promise<McpServerInfo[]>
  openPath: (p: string) => Promise<string>
  exportData: () => Promise<string>
  importData: () => Promise<string>
  copyText: (text: string) => void
  readText: () => Promise<string>
  clipboardHasImage: () => boolean
  debugInfo: () => string
  onData: (cb: (id: string, data: string) => void) => () => void
  onExit: (cb: (id: string, exitCode: number) => void) => () => void
  onSessionId: (cb: (id: string, claudeSessionId: string) => void) => () => void
  onBusy: (cb: (id: string, busy: boolean) => void) => () => void
  onStatus: (cb: (id: string, status: SessionStatus) => void) => () => void
}

declare global {
  interface Window {
    api: WorkbenchApi
  }
}

export {}
