import { useEffect, useState, type JSX } from 'react'
import { modesForEngine } from '../types'
import type { EngineId, EngineInfo, ProjectEntry, ProviderProfile } from '../api'
import { useT } from '../i18n'
import { normalizeCwd } from '../paths'

function basename(p: string): string {
  const norm = p.replace(/[\\/]+$/, '')
  const i = Math.max(norm.lastIndexOf('\\'), norm.lastIndexOf('/'))
  return i >= 0 ? norm.slice(i + 1) : norm
}

export interface NewSessionOpts {
  cwd: string
  mode: string
  model: string
  engine: EngineId
  providerId: string
}

interface Props {
  engines: EngineInfo[]
  /** Display notes per project directory, keyed by normalized cwd (shared with the sidebar) */
  aliases: Record<string, string>
  isWin: boolean
  /** Engine tab currently selected in the main window — the friendly default here */
  defaultEngine: EngineId
  onClose: () => void
  onStart: (opts: NewSessionOpts) => void
  onPinProject: (cwd: string, pinned: boolean) => void
  onSetAlias: (cwd: string, alias: string) => void
}

interface RowMenu {
  x: number
  y: number
  entry: ProjectEntry
}

export default function NewSessionModal({
  engines,
  aliases,
  isWin,
  defaultEngine,
  onClose,
  onStart,
  onPinProject,
  onSetAlias
}: Props): JSX.Element {
  const t = useT()
  const [cwd, setCwd] = useState('')
  const [mode, setMode] = useState('default')
  const [model, setModel] = useState('')
  const [engine, setEngine] = useState<EngineId>(engines[0]?.id ?? 'claude')
  const [providers, setProviders] = useState<ProviderProfile[]>([])
  const [activeByEngine, setActiveByEngine] = useState<Record<string, string>>({})
  const [providerId, setProviderId] = useState('')
  const [recents, setRecents] = useState<string[]>([])
  const [projects, setProjects] = useState<ProjectEntry[]>([])
  const [menu, setMenu] = useState<RowMenu | null>(null)
  const [aliasEdit, setAliasEdit] = useState<null | { cwd: string; text: string }>(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    void window.api.getSettings().then((s) => {
      setRecents(s.recentCwds ?? [])
      if (s.lastCwd) setCwd(s.lastCwd)
      setMode(s.defaultMode || 'default')
      setModel(s.defaultModel || '')
    })
    void window.api.providersList().then((r) => {
      setProviders(r.profiles)
      setActiveByEngine(r.activeByEngine)
    })
    void window.api.projectsLoad().then(setProjects)
  }, [])

  // Follow the main window's engine tab unless that engine is missing its CLI
  useEffect(() => {
    const match = engines.find((e) => e.id === defaultEngine)
    if (match && match.bin) setEngine(defaultEngine)
  }, [defaultEngine, engines])

  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [menu])

  const engineProviders = providers.filter((p) => p.engine === engine)
  const activeId = activeByEngine[engine] || 'builtin-default'

  const pinnedProjects = projects.filter((p) => p.pinned).sort((a, b) => b.lastUsedAt - a.lastUsedAt)
  const currentPinned = cwd.trim()
    ? projects.find((p) => p.cwd === normalizeCwd(cwd, isWin))?.pinned ?? false
    : false

  const pickEngine = (e: EngineId): void => {
    setEngine(e)
    setProviderId('')
    setMode('default')
  }

  const unpin = (key: string): void => {
    void window.api.projectsSetPinned(key, false).then(setProjects)
  }

  const pinCurrent = (): void => {
    const dir = cwd.trim()
    if (!dir) return
    void window.api.projectsSetPinned(dir, !currentPinned).then(setProjects)
  }

  const submitAlias = (): void => {
    if (aliasEdit) onSetAlias(aliasEdit.cwd, aliasEdit.text.trim())
    setAliasEdit(null)
  }

  const browse = (): void => {
    void window.api.pickDir().then((dir) => {
      if (dir) setCwd(dir)
    })
  }

  const submit = (): void => {
    const dir = cwd.trim()
    if (!dir) {
      setErr(t('new.errCwd'))
      return
    }
    onStart({
      cwd: dir,
      mode,
      model: engine === 'claude' ? model : '',
      engine,
      providerId: providerId || activeId
    })
  }

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal new-session">
        <h3>{t('new.title')}</h3>
        {engines.length > 1 && (
          <div className="form-row">
            <label>{t('new.engine')}</label>
            <div className="seg">
              {engines.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  className={`seg-btn ${engine === e.id ? 'on' : ''}`}
                  disabled={!e.bin}
                  onClick={() => pickEngine(e.id)}
                  title={!e.bin ? t('new.engineMissing') : ''}
                >
                  {e.id === 'opencode' ? t('engine.opencode') : t('engine.claude')}
                </button>
              ))}
            </div>
          </div>
        )}
        {engineProviders.length > 1 && (
          <div className="form-row">
            <label>{t('new.provider')}</label>
            <select value={providerId || activeId} onChange={(e) => setProviderId(e.target.value)}>
              {engineProviders.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="form-row">
          <label>{t('new.cwd')}</label>
          <div className="cwd-row">
            <input
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder={t('new.cwdPlaceholder')}
              spellCheck={false}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
            <button onClick={browse}>{t('new.browse')}</button>
            <button
              className={`star-btn ${currentPinned ? 'on' : ''}`}
              onClick={pinCurrent}
              disabled={!cwd.trim()}
              title={currentPinned ? t('ctx.unpinProject') : t('ctx.pinProject')}
            >
              {currentPinned ? '★' : '☆'}
            </button>
          </div>
          {pinnedProjects.length > 0 && (
            <div className="projects">
              <div className="projects-head">{t('new.projectsTitle')}</div>
              {pinnedProjects.map((p) => {
                const alias = aliases[p.cwd] ?? ''
                if (aliasEdit?.cwd === p.cwd) {
                  return (
                    <div key={p.cwd} className="project-alias-edit">
                      <input
                        autoFocus
                        value={aliasEdit.text}
                        placeholder={t('alias.placeholder')}
                        onChange={(e) => setAliasEdit({ cwd: p.cwd, text: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') submitAlias()
                          if (e.key === 'Escape') setAliasEdit(null)
                        }}
                        spellCheck={false}
                      />
                      <button className="primary" onClick={submitAlias}>
                        ✓
                      </button>
                    </div>
                  )
                }
                return (
                  <div
                    key={p.cwd}
                    className={`project-row ${normalizeCwd(cwd, isWin) === p.cwd ? 'sel' : ''}`}
                    onClick={() => setCwd(p.path)}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      setMenu({ x: e.clientX, y: e.clientY, entry: p })
                    }}
                    title={p.path}
                  >
                    <span className="project-main">
                      {alias || basename(p.path)}
                      {alias && <span className="project-orig">{basename(p.path)}</span>}
                    </span>
                  </div>
                )
              })}
              <div className="projects-tip">{t('new.projectTip')}</div>
            </div>
          )}
          {recents.length > 0 && (
            <div className="recents">
              {recents.map((r) => {
                const alias = aliases[normalizeCwd(r, isWin)] ?? ''
                return (
                  <button
                    key={r}
                    className={`recent-chip ${r === cwd ? 'sel' : ''}`}
                    onClick={() => setCwd(r)}
                    title={r}
                  >
                    {alias ? `${alias} — ${r}` : r}
                  </button>
                )
              })}
            </div>
          )}
        </div>
        <div className="form-row">
          <label>{t('new.mode')}</label>
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            {modesForEngine(engine).map((m) => (
              <option key={m.value} value={m.value}>
                {t(m.key)}
              </option>
            ))}
          </select>
          {mode === 'bypassPermissions' && <p className="warn-line">{t('new.bypassWarn')}</p>}
        </div>
        {engine === 'claude' && (
          <div className="form-row">
            <label>{t('new.model')}</label>
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">{t('model.follow')}</option>
              <option value="sonnet">{t('model.sonnet')}</option>
              <option value="opus">{t('model.opus')}</option>
              <option value="haiku">{t('model.haiku')}</option>
            </select>
          </div>
        )}
        {err && <p className="err-line">{err}</p>}
        <div className="modal-actions">
          <button className="ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="primary" onClick={submit}>
            {t('new.start')}
          </button>
        </div>
      </div>

      {menu && (
        <div className="ctx-menu" style={{ left: menu.x, top: menu.y }} onMouseDown={(e) => e.stopPropagation()}>
          <button
            className="ctx-item"
            onClick={() => {
              setAliasEdit({ cwd: menu.entry.cwd, text: aliases[menu.entry.cwd] ?? '' })
              setMenu(null)
            }}
          >
            {t('ctx.setAlias')}
          </button>
          {(aliases[menu.entry.cwd] ?? '') !== '' && (
            <button
              className="ctx-item"
              onClick={() => {
                onSetAlias(menu.entry.cwd, '')
                setMenu(null)
              }}
            >
              {t('ctx.clearAlias')}
            </button>
          )}
          <button
            className="ctx-item"
            onClick={() => {
              unpin(menu.entry.cwd)
              setMenu(null)
            }}
          >
            {t('ctx.unpinProject')}
          </button>
        </div>
      )}
    </div>
  )
}
