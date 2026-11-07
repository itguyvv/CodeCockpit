import { clipboard, contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

type Unsubscribe = () => void

function on(channel: string, cb: (payload: unknown) => void): Unsubscribe {
  const handler = (_e: IpcRendererEvent, payload: unknown): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api = {
  getAppInfo: (): Promise<{
    claudeBin: string
    claudeVersion: string
    gitBash: string
    dataDir: string
    appRoot: string
    home: string
    appVersion: string
    lastCwd: string
  }> => ipcRenderer.invoke('app:info'),
  createSession: (opts: {
    cwd?: string
    mode: string
    resumeId?: string
    title?: string
    model?: string
    cols?: number
    rows?: number
  }): Promise<{ id: string }> => ipcRenderer.invoke('session:create', opts),
  pickDir: (): Promise<string> => ipcRenderer.invoke('dialog:pickDir'),
  getSettings: (): Promise<{
    lastCwd?: string
    recentCwds?: string[]
    defaultMode?: string
    defaultModel?: string
    locale?: string
  }> => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: { defaultMode?: string; defaultModel?: string; locale?: string }): Promise<{
    lastCwd?: string
    recentCwds?: string[]
    defaultMode?: string
    defaultModel?: string
    locale?: string
  }> => ipcRenderer.invoke('settings:set', patch),
  input: (id: string, data: string): void => ipcRenderer.send('session:input', { id, data }),
  resize: (id: string, cols: number, rows: number): Promise<void> =>
    ipcRenderer.invoke('session:resize', { id, cols, rows }),
  kill: (id: string): Promise<void> => ipcRenderer.invoke('session:kill', { id }),
  setMode: (id: string, mode: string): Promise<void> => ipcRenderer.invoke('session:setMode', { id, mode }),
  changeDir: (id: string, cwd: string): Promise<void> => ipcRenderer.invoke('session:changeDir', { id, cwd }),
  getStatus: (
    id: string
  ): Promise<{
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
  } | null> => ipcRenderer.invoke('session:getStatus', id),
  listNativeSessions: (): Promise<
    Array<{
      sessionId: string
      cwd: string
      title: string
      permissionMode: string
      lastTs: number
      sizeBytes: number
      projectEncoded: string
      custom?: boolean
    }>
  > => ipcRenderer.invoke('sessions:native'),
  renameSession: (claudeSessionId: string, title: string): Promise<void> =>
    ipcRenderer.invoke('session:rename', { claudeSessionId, title }),
  deleteSession: (claudeSessionId: string): Promise<boolean> =>
    ipcRenderer.invoke('session:delete', claudeSessionId),
  getTitles: (): Promise<Record<string, string>> => ipcRenderer.invoke('titles:get'),
  loadWorkspace: (): Promise<
    Array<{ id: string; claudeSessionId: string | null; cwd: string; mode: string; title: string }>
  > => ipcRenderer.invoke('workspace:load'),
  saveWorkspace: (
    list: Array<{ id: string; claudeSessionId: string | null; cwd: string; mode: string; title: string }>
  ): Promise<boolean> => ipcRenderer.invoke('workspace:save', list),
  getHistoryOrder: (): Promise<{ groups?: string[]; items?: Record<string, string[]> }> =>
    ipcRenderer.invoke('history-order:load'),
  saveHistoryOrder: (o: { groups: string[]; items: Record<string, string[]> }): Promise<boolean> =>
    ipcRenderer.invoke('history-order:save', o),
  setDataDir: (custom: string): Promise<string> => ipcRenderer.invoke('data-dir:set', custom),
  mcpList: (): Promise<Array<{ name: string; type: string; command: string; args: string[] }>> =>
    ipcRenderer.invoke('mcp:list'),
  openPath: (p: string): Promise<string> => ipcRenderer.invoke('open:path', p),
  exportData: (): Promise<string> => ipcRenderer.invoke('data:export'),
  importData: (): Promise<string> => ipcRenderer.invoke('data:import'),
  copyText: (text: string): void => ipcRenderer.send('clip:write', text),
  readText: (): Promise<string> => ipcRenderer.invoke('clip:read'),
  clipboardHasImage: (): boolean => ipcRenderer.sendSync('clip:has-image'),
  debugInfo: (): string =>
    JSON.stringify({ sandboxed: process.sandboxed, hasClipboard: !!clipboard }),
  onData: (cb: (id: string, data: string) => void): Unsubscribe =>
    on('pty:data', (p) => {
      const { id, data } = p as { id: string; data: string }
      cb(id, data)
    }),
  onExit: (cb: (id: string, exitCode: number) => void): Unsubscribe =>
    on('pty:exit', (p) => {
      const { id, exitCode } = p as { id: string; exitCode: number }
      cb(id, exitCode)
    }),
  onSessionId: (cb: (id: string, claudeSessionId: string) => void): Unsubscribe =>
    on('pty:session-id', (p) => {
      const { id, claudeSessionId } = p as { id: string; claudeSessionId: string }
      cb(id, claudeSessionId)
    }),
  onBusy: (cb: (id: string, busy: boolean) => void): Unsubscribe =>
    on('pty:busy', (p) => {
      const { id, busy } = p as { id: string; busy: boolean }
      cb(id, busy)
    }),
  onStatus: (cb: (id: string, status: unknown) => void): Unsubscribe =>
    on('pty:status', (p) => {
      const { id, status } = p as { id: string; status: unknown }
      cb(id, status)
    })
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
