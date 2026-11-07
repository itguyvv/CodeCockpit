import { useEffect, useState, type JSX } from 'react'
import { MODES, MODELS } from '../types'
import { useT } from '../i18n'

interface Props {
  onClose: () => void
  onStart: (opts: { cwd: string; mode: string; model: string }) => void
}

export default function NewSessionModal({ onClose, onStart }: Props): JSX.Element {
  const t = useT()
  const [cwd, setCwd] = useState('')
  const [mode, setMode] = useState('default')
  const [model, setModel] = useState('')
  const [recents, setRecents] = useState<string[]>([])
  const [err, setErr] = useState('')

  useEffect(() => {
    void window.api.getSettings().then((s) => {
      setRecents(s.recentCwds ?? [])
      if (s.lastCwd) setCwd(s.lastCwd)
      setMode(s.defaultMode || 'default')
      setModel(s.defaultModel || '')
    })
  }, [])

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
    onStart({ cwd: dir, mode, model })
  }

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal new-session">
        <h3>{t('new.title')}</h3>
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
            {MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {t(m.key)}
              </option>
            ))}
          </select>
          {mode === 'bypassPermissions' && <p className="warn-line">{t('new.bypassWarn')}</p>}
        </div>
        <div className="form-row">
          <label>{t('new.model')}</label>
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            {MODELS.map((m) => (
              <option key={m.value} value={m.value}>
                {t(m.key)}
              </option>
            ))}
          </select>
        </div>
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
