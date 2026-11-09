import { useEffect, useState, type JSX } from 'react'
import type { RuleFile, RuleRef } from '../api'
import { useT } from '../i18n'

type TabId = 'claude-global' | 'opencode-global' | 'project-claude' | 'project-opencode'

interface Props {
  /** When set, per-project tabs (CLAUDE.md / AGENTS.md of that directory) are shown */
  projectCwd?: string
  onClose: () => void
  onNotify: (msg: string) => void
}

type LoadedRule = RuleFile & { savedContent: string }

export default function RulesModal({ projectCwd, onClose, onNotify }: Props): JSX.Element {
  const t = useT()
  const [active, setActive] = useState<TabId>(projectCwd ? 'project-claude' : 'claude-global')
  const [files, setFiles] = useState<Partial<Record<TabId, LoadedRule>>>({})

  const refFor = (tab: TabId): RuleRef =>
    tab === 'claude-global'
      ? { scope: 'claude-global' }
      : tab === 'opencode-global'
        ? { scope: 'opencode-global' }
        : tab === 'project-claude'
          ? { scope: 'project', engine: 'claude', cwd: projectCwd }
          : { scope: 'project', engine: 'opencode', cwd: projectCwd }

  const tabs: Array<{ id: TabId; label: string }> = [
    { id: 'claude-global', label: `🌐 ${t('rules.tabGlobalClaude')}` },
    { id: 'opencode-global', label: `🌐 ${t('rules.tabGlobalOpencode')}` },
    ...(projectCwd
      ? [
          { id: 'project-claude' as TabId, label: `📁 ${t('rules.tabProjectClaude')}` },
          { id: 'project-opencode' as TabId, label: `📁 ${t('rules.tabProjectOpencode')}` }
        ]
      : [])
  ]

  // Lazy-load the file behind a tab on first visit
  useEffect(() => {
    if (files[active]) return
    void window.api
      .rulesRead(refFor(active))
      .then((f) => setFiles((prev) => ({ ...prev, [active]: { ...f, savedContent: f.content } })))
      .catch((err) => onNotify(t('rules.readFail', { err: String(err) })))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  const file = files[active]
  const dirty = !!file && file.content !== file.savedContent

  const save = (): void => {
    const f = files[active]
    if (!f || f.content === f.savedContent) return
    window.api
      .rulesWrite(refFor(active), f.content, f.crlf)
      .then((path) => {
        setFiles((prev) => ({ ...prev, [active]: { ...f, path, exists: true, savedContent: f.content } }))
        onNotify(t('rules.saved'))
      })
      .catch((err) => onNotify(t('rules.writeFail', { err: String(err) })))
  }

  // Ctrl+S / Cmd+S saves the active tab even when the textarea lost focus
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, files])

  const isDirty = (id: TabId): boolean => {
    const f = files[id]
    return !!f && f.content !== f.savedContent
  }

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal rules-modal">
        <div className="rules-head">
          <h3>{t('rules.title')}</h3>
          <button className="icon-btn" onClick={onClose} title={t('common.close')}>
            ✕
          </button>
        </div>
        <div className="rules-tabs">
          {tabs.map((tb) => (
            <button
              key={tb.id}
              className={`rules-tab ${tb.id === active ? 'on' : ''}`}
              onClick={() => setActive(tb.id)}
            >
              {isDirty(tb.id) && <span className="rules-dirty">●</span>}
              {tb.label}
            </button>
          ))}
        </div>
        <div className="rules-body">
          {file ? (
            <>
              <div className="rules-path" title={file.path}>
                {file.path}
                {!file.exists && <span className="rules-new-hint"> · {t('rules.notCreated')}</span>}
              </div>
              <textarea
                className="rules-editor"
                value={file.content}
                onChange={(e) =>
                  setFiles((prev) =>
                    prev[active] ? { ...prev, [active]: { ...prev[active]!, content: e.target.value } } : prev
                  )
                }
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                    e.preventDefault()
                    save()
                  }
                }}
                spellCheck={false}
              />
            </>
          ) : (
            <div className="rules-loading">…</div>
          )}
        </div>
        <div className="modal-actions rules-actions">
          <span className="rules-dirty-hint">{dirty ? t('rules.dirty') : ''}</span>
          <button className="ghost" onClick={onClose}>
            {t('common.close')}
          </button>
          <button className="primary" onClick={save} disabled={!dirty}>
            {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
