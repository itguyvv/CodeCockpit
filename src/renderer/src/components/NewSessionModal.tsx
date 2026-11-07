import { useEffect, useState, type JSX } from 'react'
import { modesForEngine } from '../types'
import type { EngineId, EngineInfo, ProviderProfile } from '../api'
import { useT } from '../i18n'

export interface NewSessionOpts {
  cwd: string
  mode: string
  model: string
  engine: EngineId
  providerId: string
}

interface Props {
  engines: EngineInfo[]
  onClose: () => void
  onStart: (opts: NewSessionOpts) => void
}

export default function NewSessionModal({ engines, onClose, onStart }: Props): JSX.Element {
  const t = useT()
  const [cwd, setCwd] = useState('')
  const [mode, setMode] = useState('default')
  const [model, setModel] = useState('')
  const [engine, setEngine] = useState<EngineId>(engines[0]?.id ?? 'claude')
  const [providers, setProviders] = useState<ProviderProfile[]>([])
  const [activeByEngine, setActiveByEngine] = useState<Record<string, string>>({})
  const [providerId, setProviderId] = useState('')
  const [recents, setRecents] = useState<string[]>([])
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
  }, [])

  const engineProviders = providers.filter((p) => p.engine === engine)
  const activeId = activeByEngine[engine] || 'builtin-default'

  const pickEngine = (e: EngineId): void => {
    setEngine(e)
    setProviderId('')
    setMode('default')
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
          </div>
          {recents.length > 0 && (
            <div className="recents">
              {recents.map((r) => (
                <button
                  key={r}
                  className={`recent-chip ${r === cwd ? 'sel' : ''}`}
                  onClick={() => setCwd(r)}
                  title={r}
                >
                  {r}
                </button>
              ))}
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
