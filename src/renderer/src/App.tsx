import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import TerminalHost, { type TerminalHandle } from './components/TerminalHost'
import Sidebar from './components/Sidebar'
import NewSessionModal, { type NewSessionOpts } from './components/NewSessionModal'
import Dashboard from './components/Dashboard'
import SettingsModal from './components/SettingsModal'
import { modeLabel, modelLabel, modesForEngine, type SessionState } from './types'
import type { AppInfo, AppSettings, EngineId, EngineInfo, NativeSessionInfo, SessionStatus } from './api'
import { I18nProvider, detectLocale, useI18n } from './i18n'
import { LOCALE_LIST, type LocaleCode } from '../../locales'
import logoUrl from './assets/logo.png'

function fmtK(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

function AppInner(): JSX.Element {
  const { t, locale, setLocale } = useI18n()
  const [sessions, setSessions] = useState<SessionState[]>([])
  const [activeId, setActiveId] = useState<string>('')
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [showNew, setShowNew] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showDash, setShowDash] = useState(false)
  const [statuses, setStatuses] = useState<Record<string, SessionStatus>>({})
  const [confirm, setConfirm] = useState<null | { text: string; onOk: () => void }>(null)
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')
  const [customTitles, setCustomTitles] = useState<Record<string, string>>({})
  const [aliases, setAliases] = useState<Record<string, string>>({})
  const [historyVer, setHistoryVer] = useState(0)
  const [wsLoaded, setWsLoaded] = useState(false)
  const [engineTab, setEngineTab] = useState<EngineId>('claude')
  const [engineInfos, setEngineInfos] = useState<EngineInfo[]>([])
  const [enginesOn, setEnginesOn] = useState<Partial<Record<EngineId, boolean>>>({})
  const [scrollback, setScrollback] = useState(2000)
  const termRef = useRef<TerminalHandle>(null)

  const active = sessions.find((s) => s.id === activeId) ?? null
  const activeStatus = active ? statuses[active.id] ?? null : null

  // Engines whose CLI was found and that are enabled in settings (default = enabled)
  const enabledEngines = engineInfos.filter(
    (e) => e.bin && (enginesOn[e.id] ?? true)
  )

  // Follow the tab when the current engine disappears (CLI removed / disabled in settings)
  useEffect(() => {
    if (enabledEngines.length > 0 && !enabledEngines.some((e) => e.id === engineTab)) {
      setEngineTab(enabledEngines[0].id)
    }
  }, [enabledEngines, engineTab])

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(''), 4000)
  }, [])

  // Settings saved inside the modal apply immediately (engine tabs, new-terminal scrollback)
  const handleSettingsChanged = useCallback((patch: Partial<AppSettings>) => {
    if (patch.engines) setEnginesOn(patch.engines)
    if (patch.scrollback !== undefined) setScrollback(patch.scrollback)
  }, [])

  useEffect(() => {
    void window.api.getAppInfo().then(setAppInfo)
    void window.api.enginesDiscover().then(setEngineInfos)
    void window.api.getSettings().then((s) => {
      setEnginesOn(s.engines ?? {})
      setScrollback(Math.max(200, Math.min(50_000, s.scrollback ?? 2000)))
    })
    void window.api.getTitles().then(setCustomTitles)
    void window.api.aliasesLoad().then(setAliases)
    // Restore the active session list from the previous window (processes are gone; a click relaunches with --resume)
    void window.api
      .loadWorkspace()
      .then((list) => {
        setSessions(
          list.map((r) => ({
            id: r.id,
            claudeSessionId: r.claudeSessionId,
            cwd: r.cwd,
            mode: r.mode,
            status: 'exited' as const,
            title: r.title,
            busy: false,
            bgTasks: 0,
            model: r.model ?? '',
            engine: r.engine ?? 'claude',
            providerId: r.providerId ?? ''
          }))
        )
      })
      .finally(() => setWsLoaded(true))
  }, [])

  // Active list changes (add/remove/reorder/rename) → debounced persistence
  useEffect(() => {
    if (!wsLoaded) return
    const timer = setTimeout(() => {
      void window.api.saveWorkspace(
        sessions.map((s) => ({
          id: s.id,
          claudeSessionId: s.claudeSessionId,
          cwd: s.cwd,
          mode: s.mode,
          title: s.title,
          model: s.model ?? '',
          engine: s.engine,
          providerId: s.providerId ?? ''
        }))
      )
    }, 300)
    return () => clearTimeout(timer)
  }, [sessions, wsLoaded])

  const updateSession = useCallback((id: string, patch: Partial<SessionState>) => {
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)))
  }, [])

  useEffect(() => {
    const offExit = window.api.onExit((id, code) => {
      updateSession(id, { status: 'exited' })
      termRef.current?.write(id, t('banner.exited', { code }))
    })
    const offSid = window.api.onSessionId((id, sid) => {
      updateSession(id, { claudeSessionId: sid })
      // Pull an initial status as soon as a new session gets its id (history tokens arrive via onStatus)
      void window.api.getStatus(id).then((st) => {
        if (st) setStatuses((prev) => ({ ...prev, [id]: st }))
      })
      // The engine has just written the session record: refresh the history list so the
      // new session shows up in its project group without a manual refresh
      setHistoryVer((v) => v + 1)
    })
    const offBusy = window.api.onBusy((id, busy, bg) => updateSession(id, { busy, bgTasks: bg }))
    const offStatus = window.api.onStatus((id, st) =>
      setStatuses((prev) => ({ ...prev, [id]: st }))
    )
    return () => {
      offExit()
      offSid()
      offBusy()
      offStatus()
    }
  }, [updateSession, t])

  const guardBypass = useCallback(
    (mode: string, onOk: () => void) => {
      if (mode === 'bypassPermissions') {
        setConfirm({ text: t('confirm.bypass'), onOk })
      } else {
        onOk()
      }
    },
    [t]
  )

  const launch = useCallback(
    (opts: {
      cwd: string
      mode: string
      resumeId?: string
      title?: string
      model?: string
      engine: EngineId
      providerId?: string
    }) => {
      setError('')
      guardBypass(opts.mode, () => {
        const dims = termRef.current?.getDims() ?? { cols: 110, rows: 30 }
        window.api
          .createSession({
            cwd: opts.cwd,
            mode: opts.mode,
            resumeId: opts.resumeId,
            title: opts.title,
            model: opts.engine === 'claude' ? opts.model : undefined,
            cols: dims.cols,
            rows: dims.rows,
            engine: opts.engine,
            providerId: opts.providerId
          })
          .then(({ id }) => {
            termRef.current?.renameSlot('__pending', id)
            setSessions((prev) => [
              ...prev,
              {
                id,
                claudeSessionId: opts.resumeId ?? null,
                cwd: opts.cwd,
                mode: opts.mode,
                status: 'running',
                title: opts.title ?? '',
                busy: false,
                bgTasks: 0,
                model: opts.model ?? '',
                engine: opts.engine,
                providerId: opts.providerId ?? ''
              }
            ])
            setActiveId(id)
            setShowNew(false)
            if (opts.resumeId) {
              // Pull the aggregated history stats for a resumed session
              setTimeout(() => {
                void window.api.getStatus(id).then((st) => {
                  if (st) setStatuses((prev) => ({ ...prev, [id]: st }))
                })
              }, 1500)
            }
          })
          .catch((e) => setError(String((e as Error).message || e)))
      })
    },
    [guardBypass]
  )

  const handleNew = useCallback(
    (opts: NewSessionOpts) => {
      launch({
        cwd: opts.cwd,
        mode: opts.mode,
        model: opts.model,
        engine: opts.engine,
        providerId: opts.providerId
      })
    },
    [launch]
  )

  const handleResume = useCallback(
    (ns: NativeSessionInfo) => {
      const engine: EngineId = ns.sessionId.startsWith('ses_') ? 'opencode' : 'claude'
      // A live session in the list → just switch to it, don't spawn a duplicate process
      const existing = sessions.find((s) => s.claudeSessionId === ns.sessionId)
      if (existing && existing.status !== 'exited') {
        setActiveId(existing.id)
        termRef.current?.attach(existing.id)
        return
      }
      if (existing) {
        // The old slot's process is dead → drop the terminal slot and list item, then relaunch with --resume
        termRef.current?.dispose(existing.id)
        setSessions((prev) => prev.filter((x) => x.id !== existing.id))
      }
      launch({
        cwd: ns.cwd || appInfo?.lastCwd || appInfo?.appRoot || '',
        mode: existing?.mode || ns.permissionMode || 'default',
        resumeId: ns.sessionId,
        title: ns.title || existing?.title || undefined,
        engine,
        providerId: existing?.providerId
      })
    },
    [sessions, launch, appInfo]
  )

  const handleSelectActive = useCallback(
    (id: string) => {
      const s = sessions.find((x) => x.id === id)
      if (!s) return
      // Session restored from the previous window (dead process) → a click relaunches it with --resume
      if (s.status === 'exited') {
        termRef.current?.dispose(id)
        setSessions((prev) => prev.filter((x) => x.id !== id))
        launch({
          cwd: s.cwd,
          mode: s.mode,
          resumeId: s.claudeSessionId ?? undefined,
          title: s.title || undefined,
          model: s.model || undefined,
          engine: s.engine,
          providerId: s.providerId || undefined
        })
        return
      }
      setActiveId(id)
      termRef.current?.attach(id)
    },
    [sessions, launch]
  )

  // Reorder within the visible engine tab: Sidebar indices refer to the filtered list
  const handleReorderActive = useCallback(
    (from: number, to: number) => {
      const visible = sessions.filter((s) => s.engine === engineTab)
      if (from === to || from < 0 || to < 0 || from >= visible.length || to >= visible.length) return
      const movingId = visible[from].id
      const targetId = visible[to].id
      setSessions((prev) => {
        const fromG = prev.findIndex((s) => s.id === movingId)
        const toG = prev.findIndex((s) => s.id === targetId)
        if (fromG < 0 || toG < 0) return prev
        const arr = [...prev]
        const [m] = arr.splice(fromG, 1)
        arr.splice(toG, 0, m)
        return arr
      })
    },
    [sessions, engineTab]
  )

  // Directory display note (alias): set/clear from the sidebar group menu
  const handleSetAlias = useCallback((cwd: string, alias: string) => {
    void window.api.aliasesSet(cwd, alias).then(setAliases)
  }, [])

  // Rename (active sessions by internal id; history sessions by claudeSessionId) — same as /rename, persisted to titles.json
  const handleRename = useCallback(
    (key: string, title: string) => {
      // Active rows pass the internal session id; resolve it to the engine-native id first
      const active = sessions.find((x) => x.id === key)
      const nativeId = active ? active.claudeSessionId : key
      if (active && !nativeId) {
        // The engine has not reported a native id yet (the openCode sniffer can lag) and
        // titles.json only overlays native ids — nothing persists until it appears
        showToast(t('toast.renameNotReady'))
        return
      }
      void window.api.renameSession(nativeId!, title)
      setCustomTitles((prev) => {
        const next = { ...prev }
        if (title) next[nativeId!] = title
        else delete next[nativeId!]
        return next
      })
      setSessions((prev) =>
        prev.map((s) =>
          (active ? s.id === active.id : s.claudeSessionId === key) ? { ...s, title } : s
        )
      )
    },
    [sessions, showToast, t]
  )

  // Remove from this window: stop the process and drop it from the active list (history stays, restore from history later)
  const handleRemoveActive = useCallback((id: string) => {
    void window.api.kill(id)
    termRef.current?.dispose(id)
    setSessions((prev) => prev.filter((s) => s.id !== id))
    setActiveId((cur) => (cur === id ? '' : cur))
  }, [])

  // Change the working directory and restart with --resume (after a project moved)
  const handleChangeDir = useCallback(
    (id: string) => {
      void window.api.pickDir().then((dir) => {
        if (!dir) return
        void window.api
          .changeDir(id, dir)
          .then(() => {
            updateSession(id, { cwd: dir })
            showToast(t('toast.dirChanged'))
          })
          .catch((e) => setError(String((e as Error).message || e)))
      })
    },
    [updateSession, showToast, t]
  )

  // Permanently delete a history session (jsonl is unrecoverable); stop it first if it's running here
  const handleDelete = useCallback(
    (claudeSessionId: string) => {
      const victim = sessions.find((s) => s.claudeSessionId === claudeSessionId)
      setConfirm({
        text:
          t('confirm.deleteIntro') +
          (victim ? t('confirm.deleteRunning') : '') +
          t('confirm.deleteAsk'),
        onOk: () => {
          if (victim) handleRemoveActive(victim.id)
          void window.api.renameSession(claudeSessionId, '').then(() => {
            setCustomTitles((prev) => {
              const next = { ...prev }
              delete next[claudeSessionId]
              return next
            })
          })
          void window.api.deleteSession(claudeSessionId).then(() => setHistoryVer((v) => v + 1))
        }
      })
    },
    [sessions, handleRemoveActive, t]
  )

  const changeMode = useCallback(
    (id: string, mode: string) => {
      guardBypass(mode, () => {
        updateSession(id, { mode })
        void window.api.setMode(id, mode)
      })
    },
    [guardBypass, updateSession]
  )

  // Opening the dev URL in a plain browser has no preload bridge; guard against testing features on a fake page
  if (!('api' in window)) {
    return (
      <div className="browser-warn">
        <h2>⚠ {t('browser.warn.title')}</h2>
        <p>{t('browser.warn.body')}</p>
        <p>{t('browser.warn.hint')}</p>
      </div>
    )
  }

  return (
    <div className="app">
      <div className="toolbar">
        <button className="icon-btn" onClick={() => setSidebarOpen((v) => !v)} title={t('toolbar.toggleSidebar')}>
          ☰
        </button>
        <img className="logo-img" src={logoUrl} alt="logo" />
        <span className="logo">{t('app.name')}</span>
        <button className="primary" onClick={() => setShowNew(true)}>
          {t('toolbar.new')}
        </button>
        <button className="ghost" onClick={() => setShowSettings(true)} title={t('settings.title')}>
          {t('toolbar.settings')}
        </button>
        <div className="toolbar-space" />
      </div>

      <div className="body">
        {sidebarOpen && (
          <Sidebar
            engines={enabledEngines.map((e) => e.id)}
            engine={engineTab}
            onEngineChange={setEngineTab}
            activeSessions={sessions.filter((s) => s.engine === engineTab)}
            activeId={activeId}
            customTitles={customTitles}
            aliases={aliases}
            isWin={appInfo?.platform === 'win32'}
            historyVersion={historyVer}
            onSelectActive={handleSelectActive}
            onResume={handleResume}
            onRename={handleRename}
            onSetAlias={handleSetAlias}
            onDelete={handleDelete}
            onRemoveActive={handleRemoveActive}
            onReorderActive={handleReorderActive}
            onChangeDir={handleChangeDir}
            onToggle={() => setSidebarOpen(false)}
          />
        )}
        <div className="main">
          {active && (
            <div className="session-bar">
              <span className={`dot ${active.status}`} />
              <span className="session-title">
                {active.title || `${active.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop()} · ${active.id.slice(0, 6)}`}
              </span>
              {active.claudeSessionId && (
                <span className="session-sid" title={active.claudeSessionId}>
                  {active.claudeSessionId.slice(0, 8)}…
                </span>
              )}
              <span className="session-cwd" title={active.cwd}>
                {active.cwd}
              </span>
              {activeStatus && (
                <span
                  className="session-stat"
                  title={t('sessionbar.statTip', {
                    tin: activeStatus.tokensIn,
                    tout: activeStatus.tokensOut,
                    turns: activeStatus.turns
                  })}
                >
                  {modelLabel(activeStatus.model, t)} · ↑{fmtK(activeStatus.tokensIn)} ↓
                  {fmtK(activeStatus.tokensOut)} · ${activeStatus.costUsd.toFixed(3)}
                  {active.busy && activeStatus.tool ? (
                    <span className="session-tool"> · {activeStatus.tool}</span>
                  ) : null}
                </span>
              )}
              <button
                className={`dash-toggle ${showDash ? 'on' : ''}`}
                onClick={() => setShowDash((v) => !v)}
                title={t('sessionbar.dash')}
              >
                📊
              </button>
              <select
                className="mode-select"
                value={active.mode}
                onChange={(e) => changeMode(active.id, e.target.value)}
                title={t('sessionbar.modeSelect')}
              >
                {modesForEngine(active.engine).map((m) => (
                  <option key={m.value} value={m.value}>
                    {t(m.key)}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="term-area">
            <TerminalHost
              ref={termRef}
              scrollback={scrollback}
              engineOf={(id) => sessions.find((s) => s.id === id)?.engine ?? 'claude'}
            />
            {!active && (
              <div className="welcome">
                <img className="welcome-logo" src={logoUrl} alt="CodeCockpit logo" />
                <h1>{t('app.name')}</h1>
                <p>{t('welcome.hint')}</p>
                <p className="muted">{t('welcome.features')}</p>
                {/* Language switcher right on the home page: recovery if the app ever opens in a language the user cannot read */}
                <div className="welcome-lang">
                  <select
                    value={locale}
                    onChange={(e) => setLocale(e.target.value as LocaleCode)}
                    aria-label={t('welcome.language')}
                    title={t('welcome.language')}
                  >
                    {LOCALE_LIST.map((l) => (
                      <option key={l.code} value={l.code}>
                        {l.label}
                      </option>
                    ))}
                  </select>
                </div>
                <p className="welcome-credit">
                  {t('welcome.credit', { name: 'ITGuyVV' })} ·{' '}
                  <a href="https://github.com/ITGuyVV" target="_blank" rel="noreferrer">
                    github.com/ITGuyVV
                  </a>
                </p>
              </div>
            )}
          </div>
          {showDash && active && (
            <Dashboard session={active} status={activeStatus} onClose={() => setShowDash(false)} />
          )}
        </div>
      </div>

      <div className="statusbar">
        <span className="status-version">v{appInfo?.appVersion ?? '…'}</span>
        {engineTab === 'claude' ? (
          <span className={appInfo?.claudeBin ? '' : 'status-error'} title={appInfo?.claudeBin}>
            {appInfo?.claudeBin
              ? t('statusbar.cli', { bin: `claude ${appInfo.claudeVersion || ''}` })
              : t('statusbar.cliMissing')}
          </span>
        ) : (
          <span className={appInfo?.opencodeBin ? '' : 'status-error'} title={appInfo?.opencodeBin}>
            {appInfo?.opencodeBin
              ? t('statusbar.opencodeCli', { ver: appInfo.opencodeVersion || '?' })
              : t('statusbar.opencodeMissing')}
          </span>
        )}
        {engineTab === 'claude' &&
          appInfo?.platform === 'win32' &&
          !appInfo.gitBash &&
          (enginesOn.claude ?? true) && (
            <span className="status-error" title={t('statusbar.gitBashMissingTip')}>
              ⚠ {t('statusbar.gitBashMissing')}
            </span>
          )}
        <span title={appInfo?.dataDir}>{t('statusbar.data', { dir: appInfo?.dataDir ?? '' })}</span>
        <span>{t('statusbar.sessions', { n: sessions.length })}</span>
        {active && <span>{t('statusbar.mode', { mode: modeLabel(active.mode, t) })}</span>}
        <span className="status-hint">
          {appInfo?.platform === 'darwin' ? t('statusbar.hint').replace(/Ctrl\+/g, 'Cmd+') : t('statusbar.hint')}
        </span>
        {error && <span className="status-error">{error}</span>}
      </div>

      {showNew && (
        <NewSessionModal
          engines={enabledEngines}
          aliases={aliases}
          isWin={appInfo?.platform === 'win32'}
          onClose={() => setShowNew(false)}
          onStart={handleNew}
        />
      )}

      {showSettings && (
        <SettingsModal
          appInfo={appInfo}
          locale={locale}
          onSetLocale={setLocale}
          onSettingsChanged={handleSettingsChanged}
          onClose={() => setShowSettings(false)}
          onNotify={showToast}
        />
      )}

      {toast && <div className="toast">{toast}</div>}

      {confirm && (
        <div className="modal-mask">
          <div className="modal">
            <h3>{t('confirm.title')}</h3>
            <p>{confirm.text}</p>
            <div className="modal-actions">
              <button
                className="ghost"
                onClick={() => {
                  setConfirm(null)
                }}
              >
                {t('common.cancel')}
              </button>
              <button
                className="danger"
                onClick={() => {
                  const ok = confirm.onOk
                  setConfirm(null)
                  ok()
                }}
              >
                {t('common.continue')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default function App(): JSX.Element {
  const [locale, setLocaleState] = useState<LocaleCode>('en')

  useEffect(() => {
    void window.api.getSettings().then((s) => {
      // First launch: follow the OS language; an unknown persisted value also falls back to detection
      const saved = s.locale as LocaleCode | undefined
      const next = saved && LOCALE_LIST.some((l) => l.code === saved) ? saved : detectLocale()
      setLocaleState(next)
      if (!saved || saved !== next) void window.api.setSettings({ locale: next })
    })
  }, [])

  const setLocale = useCallback((l: LocaleCode) => {
    setLocaleState(l)
    void window.api.setSettings({ locale: l })
  }, [])

  return (
    <I18nProvider locale={locale} onSetLocale={setLocale}>
      <AppInner />
    </I18nProvider>
  )
}
