import { useEffect, useState, type JSX } from 'react'
import { modesForEngine } from '../types'
import type { EngineId, EngineInfo, NativeSessionInfo, ProjectEntry, ProviderProfile } from '../api'
import { useT } from '../i18n'
import { normalizeCwd } from '../paths'

function basename(p: string): string {
  const norm = p.replace(/[\\/]+$/, '')
  const i = Math.max(norm.lastIndexOf('\\'), norm.lastIndexOf('/'))
  return i >= 0 ? norm.slice(i + 1) : norm
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return '<1m'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d`
  return new Date(ts).toLocaleDateString()
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
  /** Display notes per project directory, keyed by normalized cwd */
  aliases: Record<string, string>
  isWin: boolean
  onClose: () => void
  onStart: (opts: NewSessionOpts) => void
  /** Resume a history session of a pinned project (closes the modal) */
  onResume?: (ns: NativeSessionInfo) => void
  onPinProject: (cwd: string, pinned: boolean) => void
}

export default function NewSessionModal({
  engines,
  aliases,
  isWin,
  onClose,
  onStart,
  onResume,
  onPinProject
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
  const [expandedCwd, setExpandedCwd] = useState('')
  const [projectSessions, setProjectSessions] = useState<Record<string, NativeSessionInfo[]>>({})
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
    setExpandedCwd('')
    setProjectSessions({})
  }

  const toggleProject = (p: ProjectEntry): void => {
    if (expandedCwd === p.cwd) {
      setExpandedCwd('')
      return
    }
    setExpandedCwd(p.cwd)
    void window.api
      .listNativeSessions(engine)
      .then((list) =>
        setProjectSessions((prev) => ({
          ...prev,
          [p.cwd]: list.filter((s) => normalizeCwd(s.cwd, isWin) === p.cwd)
        }))
      )
  }

  const unpin = (key: string): void => {
    void window.api.projectsSetPinned(key, false).then((list) => {
      setProjects(list)
      if (expandedCwd === key) setExpandedCwd('')
    })
  }

  const pinCurrent = (): void => {
    const dir = cwd.trim()
    if (!dir) return
    void window.api.projectsSetPinned(dir, !currentPinned).then(setProjects)
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
            <select value={engine} onChange={(e) => pickEngine(e.target.value as EngineId)}>
              {engines.map((e) => (
                <option key={e.id} value={e.id} disabled={!e.bin}>
                  {e.id === 'opencode' ? t('engine.opencode') : t('engine.claude')}
                  {!e.bin ? ` — ${t('new.engineMissing')}` : ''}
                </option>
              ))}
            </select>
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
                const name = alias || basename(p.path)
                return (
                  <div key={p.cwd} className="project-wrap">
                    <div className={`project-row ${normalizeCwd(cwd, isWin) === p.cwd ? 'sel' : ''}`}>
                      <button
                        className="project-expand"
                        onClick={() => toggleProject(p)}
                        title={t('new.projectHistory')}
                      >
                        {expandedCwd === p.cwd ? '▾' : '▸'}
                      </button>
                      <button className="project-main" onClick={() => setCwd(p.path)} title={p.path}>
                        {name}
                        {alias && <span className="project-orig">{basename(p.path)}</span>}
                      </button>
                      <button
                        className="project-unpin"
                        onClick={() => unpin(p.cwd)}
                        title={t('ctx.unpinProject')}
                      >
                        ★
                      </button>
                    </div>
                    {expandedCwd === p.cwd && (
                      <div className="project-sessions">
                        {(projectSessions[p.cwd] ?? []).map((ns) => (
                          <button
                            key={ns.sessionId}
                            className="project-session"
                            onClick={() => {
                              onResume?.(ns)
                              onClose()
                            }}
                          >
                            <span className="ps-title">
                              {ns.title} · {ns.sessionId.slice(0, 8)}
                            </span>
                            <span className="ps-time">{relativeTime(ns.lastTs)}</span>
                          </button>
                        ))}
                        {(projectSessions[p.cwd] ?? []).length === 0 && (
                          <div className="project-none">{t('new.projectNoSessions')}</div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
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
    </div>
  )
}
