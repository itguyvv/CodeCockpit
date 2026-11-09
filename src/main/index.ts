import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell } from 'electron'
import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { unzipSync, zipSync, type Zippable } from 'fflate'
import { IS_LINUX, IS_MAC, IS_WIN } from './services/platform'
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
      lastCwd: readSettings().lastCwd || '',
      platform: process.platform as 'darwin' | 'win32' | 'linux'
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
  ipcMain.handle('clip:has-image', () => {
    // Electron 45 replaced the sync clipboard module with the W3C-style async API: no readImage,
    // only mime-typed reads. DIB-only sources that skip image/png fall back inside clip:save-image
    return clipboard.has('image/png')
  })
  // Clipboard → attachment payload for engines that attach images by path (the openCode TUI
  // ignores keystroke bridges but detects image paths inside bracketed pastes). Files age out
  // after 24h. Electron 45's async clipboard.read() exposes image bytes natively and file
  // copies as a text/uri-list, so both resolve in-process; PowerShell only covers exotic
  // DIB-only sources the new API cannot convert.
  const readClipboardImagePs = (
    target: string
  ): Promise<{ kind: 'image' | 'file'; path: string } | null> =>
    new Promise((resolve) => {
      const t = target.replace(/'/g, "''")
      const script = [
        "$ErrorActionPreference='SilentlyContinue'",
        'Add-Type -AssemblyName System.Windows.Forms',
        'Add-Type -AssemblyName System.Drawing',
        'if ([System.Windows.Forms.Clipboard]::ContainsImage()) {',
        '  $i = [System.Windows.Forms.Clipboard]::GetImage()',
        `  if ($i) { $i.Save('${t}', [System.Drawing.Imaging.ImageFormat]::Png); Write-Output 'PNG' }`,
        '} elseif ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {',
        '  $f = [System.Windows.Forms.Clipboard]::GetFileDropList()',
        '  if ($f.Count -gt 0) { $p = $f[0]; Write-Output ("FILE:" + [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($p))) }',
        '}'
      ].join('; ')
      execFile(
        'powershell.exe',
        ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { timeout: 5000, windowsHide: true },
        (err, stdout) => {
          const out = String(stdout ?? '').trim()
          if (!err && out === 'PNG') return resolve({ kind: 'image', path: target })
          // The path arrives Base64-encoded: PowerShell 5.1 writes stdout in the legacy OEM
          // code page (GBK etc.), which would mojibake non-ASCII paths if decoded as UTF-8
          if (!err && out.startsWith('FILE:')) {
            try {
              return resolve({
                kind: 'file',
                path: Buffer.from(out.slice(5), 'base64').toString('utf8')
              })
            } catch {
              return resolve(null)
            }
          }
          resolve(null)
        }
      )
    })
  ipcMain.handle('clip:save-image', async () => {
    const dir = path.join(os.tmpdir(), 'codecockpit-images')
    try {
      fs.mkdirSync(dir, { recursive: true })
      const cutoff = Date.now() - 24 * 60 * 60 * 1000
      for (const f of fs.readdirSync(dir)) {
        const full = path.join(dir, f)
        try {
          if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { force: true })
        } catch {
          // Skip
        }
      }
    } catch {
      // Ignore
    }
    const file = path.join(dir, `paste-${Date.now()}.png`)
    try {
      const items = await clipboard.read()
      for (const item of items) {
        if (!item.types.includes('image/png')) continue
        const blob = await item.getType('image/png')
        fs.writeFileSync(file, Buffer.from(await blob.arrayBuffer()))
        return { kind: 'image', path: file }
      }
      // Copied files arrive as a file:// URI list (UTF-8 percent-encoded, quoted)
      for (const item of items) {
        if (!item.types.includes('text/uri-list')) continue
        const blob = await item.getType('text/uri-list')
        const list = Buffer.from(await blob.arrayBuffer()).toString('utf8')
        const line = list.split(/\r?\n/).find((l) => {
          const s = l.trim().replace(/^"|"$/g, '')
          return s && !s.startsWith('#') && s.startsWith('file://')
        })
        if (!line) continue
        let p = decodeURIComponent(line.trim().replace(/^"|"$/g, ''))
        p = p.slice('file://'.length)
        if (IS_WIN) {
          if (p.startsWith('/')) p = p.replace(/^\/+/, '') // file:///C:/ → C:/
          if (p) return { kind: 'file', path: p.replace(/\//g, '\\') }
        } else if (p) {
          return { kind: 'file', path: p }
        }
      }
    } catch {
      // Fall through to the PowerShell bridge (Windows DIB-only sources)
    }
    return IS_WIN ? await readClipboardImagePs(file) : null
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
    // Pure-JS zip (no PowerShell): every data file is small, so in-memory is fine
    const zipped: Zippable = {}
    const walk = (dir: string, rel: string): void => {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name)
        const key = rel ? `${rel}/${name}` : name
        if (fs.statSync(full).isDirectory()) walk(full, key)
        else zipped[key] = new Uint8Array(fs.readFileSync(full))
      }
    }
    walk(dataDir, '')
    fs.writeFileSync(r.filePath, zipSync(zipped))
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
    const zipPath = r.filePaths[0]
    const dataDir = getDataDir()
    const entries = unzipSync(new Uint8Array(fs.readFileSync(zipPath)))
    // Directory entries carry no data; drop them up front
    const files = Object.entries(entries).filter(([name]) => name && !name.endsWith('/'))
    // The zip root may hold bare files or a single wrapped directory
    const tops = new Set(files.map(([name]) => name.split('/')[0]))
    const wrapped = tops.size === 1 && files.every(([name]) => name.includes('/'))
    const prefix = wrapped ? `${[...tops][0]}/` : ''
    // Replace semantics per top-level entry, matching the previous extract-then-copy behavior
    for (const top of tops) {
      fs.rmSync(path.join(dataDir, top), { recursive: true, force: true })
    }
    fs.mkdirSync(dataDir, { recursive: true })
    for (const [name, data] of files) {
      const rel = name.startsWith(prefix) ? name.slice(prefix.length) : name
      const parts = rel.split('/')
      // Zip-slip guard: never write outside the data directory
      if (parts.length === 0 || parts.some((seg) => seg === '..' || seg === '')) continue
      fs.mkdirSync(path.join(dataDir, ...parts.slice(0, -1)), { recursive: true })
      fs.writeFileSync(path.join(dataDir, ...parts), data)
    }
    return t('main.importDone')
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
  // macOS takes the icon from the app bundle (Dock); the BrowserWindow icon option is ignored there
  const iconPath = IS_MAC
    ? undefined
    : app.isPackaged
      ? path.join(process.resourcesPath, IS_LINUX ? 'icon.png' : 'icon.ico')
      : path.join(app.getAppPath(), 'resources', IS_LINUX ? 'icon.png' : 'icon.ico')
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
  // External links (GitHub etc.) always open in the OS default browser, never inside the app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (/^https?:\/\//i.test(url)) {
      e.preventDefault()
      void shell.openExternal(url)
    }
  })
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
  // Drop Electron's implicit default menu: its Edit→Paste accelerator (Ctrl+V) pastes into
  // xterm's hidden helper textarea a second time, duplicating what the renderer pasted.
  // macOS keeps app/window menus (Cmd+Q, Cmd+H) but deliberately gets no Edit role — same
  // duplicate-paste problem. Dev keeps the default menu for the DevTools shortcuts.
  if (app.isPackaged) {
    if (IS_MAC) {
      Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'windowMenu' }]))
    } else {
      Menu.setApplicationMenu(null)
    }
  }
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // macOS convention: stay alive so clicking the Dock icon reopens a window (activate above)
  if (!IS_MAC) app.quit()
})

// will-quit runs only after every window closed for real (a cancelled exit dialog must
// not have killed the PTYs already, which is what before-quit would do)
app.on('will-quit', () => {
  shutdownAll()
})
