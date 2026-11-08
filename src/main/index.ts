import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { getAppRoot, getDataDir, setDataDir, dataFile } from './services/dataDir'
import { t, setLocale } from './services/i18n'
import { findGitBash } from './services/claude'
import { discoverEngines, isEngineId, type EngineId } from './services/engines'
import {
  listProfiles,
  saveProfile,
  deleteProfile,
  setActiveProfile,
  applyGlobalProfile,
  globalConfigFile,
  testProvider,
  type ProviderProfile
} from './services/providers'
import {
  createSession,
  writeInput,
  resizeSession,
  killSession,
  setMode,
  changeDir,
  getStatus,
  listNativeSessions,
  deleteHistorySession,
  renameSession,
  shutdownAll,
  runningSessionCount,
  type PermissionMode
} from './services/sessionManager'

interface AppSettings {
  lastCwd?: string
  recentCwds?: string[]
  defaultMode?: PermissionMode
  defaultModel?: string
  locale?: string
  /** Engines shown in the sidebar tab bar; missing = enabled */
  engines?: Partial<Record<EngineId, boolean>>
  /** false = close the window without the running-sessions confirmation */
  confirmExit?: boolean
  /** xterm scrollback lines for new terminals */
  scrollback?: number
}

let win: BrowserWindow | null = null
/** Set after the user confirms exit so the next close event goes through */
let closeArmed = false
let exitDialogOpen = false

// Renderer heap ceiling: a leak safety net, sized far above real usage (scrollback is bounded separately)
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=2048')

function readSettings(): AppSettings {
  try {
    return JSON.parse(fs.readFileSync(dataFile('settings.json'), 'utf-8'))
  } catch {
    return {}
  }
}

function rememberCwd(cwd: string): void {
  const s = readSettings()
  const list = [cwd, ...(s.recentCwds ?? [])].filter(
    (v, i, arr) => v && arr.indexOf(v) === i
  )
  writeSettings({ lastCwd: cwd, recentCwds: list.slice(0, 8) })
}

function writeSettings(patch: Record<string, unknown>): void {
  const next = { ...readSettings(), ...patch }
  fs.writeFileSync(dataFile('settings.json'), JSON.stringify(next, null, 2), 'utf-8')
}

function registerIpc(): void {
  ipcMain.handle('app:info', async () => {
    const engines = await discoverEngines()
    const claude = engines.find((e) => e.id === 'claude')
    const opencode = engines.find((e) => e.id === 'opencode')
    const gitBash = await findGitBash()
    return {
      claudeBin: claude?.bin ?? '',
      claudeVersion: claude?.version ?? '',
      opencodeBin: opencode?.bin ?? '',
      opencodeVersion: opencode?.version ?? '',
      gitBash,
      dataDir: getDataDir(),
      appRoot: getAppRoot(),
      home: os.homedir(),
      appVersion: app.getVersion(),
      lastCwd: readSettings().lastCwd || ''
    }
  })

  ipcMain.handle('engines:discover', () => discoverEngines())

  ipcMain.handle('session:create', async (
    _e,
    opts: {
      cwd?: string
      mode: PermissionMode
      resumeId?: string
      title?: string
      model?: string
      cols?: number
      rows?: number
      engine?: EngineId
      providerId?: string
    }
  ) => {
    let cwd = (opts.cwd || '').trim()
    if (!cwd || !fs.existsSync(cwd)) {
      cwd = readSettings().lastCwd || getAppRoot()
    }
    rememberCwd(cwd)
    const s = readSettings()
    return createSession({
      cwd,
      mode: opts.mode || s.defaultMode || 'default',
      resumeId: opts.resumeId,
      title: opts.title,
      model: opts.model || s.defaultModel || '',
      cols: opts.cols,
      rows: opts.rows,
      engine: isEngineId(opts.engine) ? opts.engine : 'claude',
      providerId: opts.providerId
    })
  })

  ipcMain.handle('dialog:pickDir', async () => {
    if (!win) return ''
    const r = await dialog.showOpenDialog(win, {
      title: t('main.pickDirTitle'),
      properties: ['openDirectory']
    })
    return r.canceled || r.filePaths.length === 0 ? '' : r.filePaths[0]
  })

  ipcMain.on('session:input', (_e, p: { id: string; data: string }) => writeInput(p.id, p.data))
  ipcMain.handle('session:resize', (_e, p: { id: string; cols: number; rows: number }) =>
    resizeSession(p.id, p.cols, p.rows)
  )
  ipcMain.handle('session:kill', (_e, p: { id: string }) => killSession(p.id))
  ipcMain.handle('session:setMode', (_e, p: { id: string; mode: PermissionMode }) => setMode(p.id, p.mode))
  ipcMain.handle('session:changeDir', (_e, p: { id: string; cwd: string }) => changeDir(p.id, p.cwd))
  ipcMain.handle('session:getStatus', (_e, id: string) => getStatus(id))
  ipcMain.handle('sessions:native', (_e, engine: EngineId) => listNativeSessions(isEngineId(engine) ? engine : 'claude'))
  ipcMain.handle('session:rename', (_e, p: { claudeSessionId: string; title: string }) =>
    renameSession(p.claudeSessionId, p.title)
  )
  ipcMain.handle('session:delete', (_e, claudeSessionId: string) => deleteHistorySession(claudeSessionId))

  // ── API provider profiles (cc-switch style) ──
  ipcMain.handle('providers:list', () => ({
    ...listProfiles(),
    configFiles: {
      claude: globalConfigFile('claude'),
      opencode: globalConfigFile('opencode')
    }
  }))
  ipcMain.handle('providers:save', (_e, profile: ProviderProfile) => saveProfile(profile))
  ipcMain.handle('providers:test', (_e, profile: ProviderProfile) => testProvider(profile))
  ipcMain.handle('providers:delete', (_e, id: string) => deleteProfile(id))
  ipcMain.handle('providers:setActive', (_e, p: { engine: EngineId; id: string }) =>
    setActiveProfile(isEngineId(p.engine) ? p.engine : 'claude', p.id)
  )
  ipcMain.handle('providers:applyGlobal', (_e, p: { engine: EngineId; id: string }) => {
    const engine = isEngineId(p.engine) ? p.engine : 'claude'
    const store = listProfiles()
    const profile = store.profiles.find((x) => x.id === (p.id || 'builtin-default'))
    if (!profile) throw new Error('profile not found: ' + p.id)
    applyGlobalProfile(profile)
    return globalConfigFile(engine)
  })
  ipcMain.handle('titles:get', () => {
    // Custom title map for renderer initialization
    try {
      return JSON.parse(fs.readFileSync(dataFile('titles.json'), 'utf-8'))
    } catch {
      return {}
    }
  })
  ipcMain.handle('settings:get', () => readSettings())
  ipcMain.handle('settings:set', (_e, patch: Partial<AppSettings>) => {
    writeSettings(patch)
    if (patch.locale) setLocale(patch.locale)
    return readSettings()
  })
  ipcMain.handle('data-dir:set', (_e, custom: string) => setDataDir(custom))

  // Clipboard goes through the main process: sandboxed preloads have no clipboard module, the main process always does
  ipcMain.on('clip:write', (_e, text: string) => {
    clipboard.writeText(String(text ?? ''))
  })
  ipcMain.handle('clip:read', () => clipboard.readText())
  ipcMain.on('clip:has-image', (e) => {
    // availableFormats is missing in some Electron binaries (crashes on 45.2.3); readImage().isEmpty() is reliable
    try {
      const img = (clipboard as unknown as { readImage(): { isEmpty(): boolean } }).readImage()
      e.returnValue = !img.isEmpty()
    } catch {
      e.returnValue = false
    }
  })

  // View user-level Claude configuration: MCP server list
  ipcMain.handle('mcp:list', () => {
    const file = path.join(os.homedir(), '.claude.json')
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8'))
      const servers = raw.mcpServers ?? {}
      return Object.entries(servers).map(([name, cfg]) => {
        const o = (cfg ?? {}) as Record<string, unknown>
        return {
          name,
          type: o.type === 'http' || o.type === 'sse' ? 'http' : 'stdio',
          command: typeof o.command === 'string' ? o.command : (typeof o.url === 'string' ? o.url : ''),
          args: Array.isArray(o.args) ? o.args.map(String) : []
        }
      })
    } catch {
      return []
    }
  })

  // Open files / folders with the system default app (CLAUDE.md, settings, skills, ...)
  ipcMain.handle('open:path', (_e, p: string) => {
    if (!p) return t('main.pathEmpty')
    return shell.openPath(p)
  })

  // Export data: zip the whole data directory (machine migration / backup)
  ipcMain.handle('data:export', async () => {
    if (!win) return ''
    const dataDir = getDataDir()
    const stamp = new Date().toISOString().slice(0, 10)
    const r = await dialog.showSaveDialog(win, {
      title: t('main.exportTitle'),
      defaultPath: `codecockpit-data-${stamp}.zip`,
      filters: [{ name: 'ZIP', extensions: ['zip'] }]
    })
    if (r.canceled || !r.filePath) return ''
    await new Promise<void>((resolve, reject) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-Command', `Compress-Archive -Path (Join-Path '${dataDir.replace(/'/g, "''")}' '*') -DestinationPath '${r.filePath.replace(/'/g, "''")}' -Force`],
        (err) => (err ? reject(err) : resolve())
      )
    })
    return r.filePath
  })

  // Import data: extract a zip and replace the current data directory (restart recommended afterwards)
  ipcMain.handle('data:import', async () => {
    if (!win) return t('main.cancelled')
    const r = await dialog.showOpenDialog(win, {
      title: t('main.importTitle'),
      filters: [{ name: 'ZIP', extensions: ['zip'] }],
      properties: ['openFile']
    })
    if (r.canceled || r.filePaths.length === 0) return t('main.cancelled')
    const zip = r.filePaths[0]
    const dataDir = getDataDir()
    const tmp = path.join(os.tmpdir(), 'codecockpit-import-' + Date.now())
    try {
      await new Promise<void>((resolve, reject) => {
        execFile(
          'powershell.exe',
          ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${tmp.replace(/'/g, "''")}' -Force`],
          (err) => (err ? reject(err) : resolve())
        )
      })
      // The zip root may hold bare files or a single wrapped directory
      let srcDir = tmp
      const entries = fs.readdirSync(tmp)
      if (entries.length === 1 && fs.statSync(path.join(tmp, entries[0])).isDirectory()) {
        srcDir = path.join(tmp, entries[0])
      }
      fs.mkdirSync(dataDir, { recursive: true })
      for (const name of fs.readdirSync(srcDir)) {
        const from = path.join(srcDir, name)
        const to = path.join(dataDir, name)
        fs.rmSync(to, { recursive: true, force: true })
        fs.cpSync(from, to, { recursive: true })
      }
      return t('main.importDone')
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  // Persistence for this window's active session list (restored as-is on restart until manually removed)
  ipcMain.handle('workspace:load', () => {
    try {
      const raw = JSON.parse(fs.readFileSync(dataFile('active-sessions.json'), 'utf-8'))
      return Array.isArray(raw) ? raw : []
    } catch {
      return []
    }
  })
  ipcMain.handle('workspace:save', (_e, list: Array<Record<string, unknown>>) => {
    try {
      fs.writeFileSync(dataFile('active-sessions.json'), JSON.stringify(list, null, 2), 'utf-8')
      return true
    } catch {
      return false
    }
  })

  // Manual ordering of history sessions (group order + item order within groups)
  ipcMain.handle('history-order:load', () => {
    try {
      const raw = JSON.parse(fs.readFileSync(dataFile('history-order.json'), 'utf-8'))
      return raw && typeof raw === 'object' ? raw : {}
    } catch {
      return {}
    }
  })
  ipcMain.handle('history-order:save', (_e, obj: { groups: string[]; items: Record<string, string[]> }) => {
    try {
      fs.writeFileSync(dataFile('history-order.json'), JSON.stringify(obj, null, 2), 'utf-8')
      return true
    } catch {
      return false
    }
  })
}

function createWindow(): void {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.ico')
    : path.join(app.getAppPath(), 'resources', 'icon.ico')
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#15161b',
    autoHideMenuBar: true,
    title: t('app.name'),
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false
    }
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
  // Diagnostics: renderer console + startup self-check, written to the temp dir to debug packaged builds
  const diagLog = (line: string): void => {
    try {
      fs.appendFileSync(path.join(os.tmpdir(), 'codecockpit-renderer.log'), `[${new Date().toISOString()}] ${line}\n`)
    } catch {
      // Ignore
    }
  }
  win.webContents.on('console-message', (...args: unknown[]) => {
    const ev = args[1] as { message?: string } | number
    const msg =
      ev && typeof ev === 'object' && 'message' in ev
        ? (ev as { message: string }).message
        : String(args[2] ?? '')
    diagLog(`[console] ${msg}`)
  })
  win.webContents.on('did-finish-load', () => {
    void win?.webContents
      .executeJavaScript(
        'JSON.stringify({ hasApi: "api" in window, secure: window.isSecureContext, href: location.href, preload: typeof window.api?.readText, dbg: window.api?.debugInfo?.() })'
      )
      .then((r) => diagLog(`[selfcheck] ${r}`))
      .catch((e) => diagLog(`[selfcheck-fail] ${String(e)}`))
  })
  win.on('closed', () => {
    win = null
  })

  // Confirm before exiting (skip once armed or opted out); message adapts to running sessions
  win.on('close', (e) => {
    if (closeArmed || readSettings().confirmExit === false) return
    e.preventDefault()
    if (exitDialogOpen) return // dialog already showing; keep vetoing repeated close attempts
    const running = runningSessionCount()
    exitDialogOpen = true
    void dialog
      .showMessageBox(win!, {
        type: 'warning',
        title: t('confirm.exitTitle'),
        message:
          running > 0 ? t('confirm.exitMessage', { n: running }) : t('confirm.exitPlain'),
        detail: t('confirm.exitDetail'),
        buttons: [t('confirm.exitOk'), t('common.cancel')],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        checkboxLabel: t('confirm.exitDontAsk'),
        checkboxChecked: false
      })
      .then(({ response, checkboxChecked }) => {
        exitDialogOpen = false
        if (response !== 0) return
        if (checkboxChecked) writeSettings({ confirmExit: false })
        closeArmed = true
        win?.close()
      })
  })
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})

// will-quit runs only after every window closed for real (a cancelled exit dialog must
// not have killed the PTYs already, which is what before-quit would do)
app.on('will-quit', () => {
  shutdownAll()
})
