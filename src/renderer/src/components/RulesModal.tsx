import { useEffect, useState, type JSX } from 'react'
import type { EngineId, RuleFile, RuleRef } from '../api'
import { useT } from '../i18n'

type TabId = 'global' | 'project'

interface Props {
  /** Rule files follow the engine of the current context (claude → CLAUDE.md, opencode → AGENTS.md) */
  engine: EngineId
  /** When set, the per-project tab (rules file of that directory) is shown */
  projectCwd?: string
  onClose: () => void
  onNotify: (msg: string) => void
}

type LoadedRule = RuleFile & { savedContent: string }

export default function RulesModal({ engine, projectCwd, onClose, onNotify }: Props): JSX.Element {
  const t = useT()
  const [active, setActive] = useState<TabId>(projectCwd ? 'project' : 'global')
  const [files, setFiles] = useState<Partial<Record<TabId, LoadedRule>>>({})

  const refFor = (tab: TabId): RuleRef =>
    tab === 'global'
      ? engine === 'opencode'
        ? { scope: 'opencode-global' }
        : { scope: 'claude-global' }
      : { scope: 'project', engine, cwd: projectCwd }

  const tabs: Array<{ id: TabId; label: string }> = [
    {
      id: 'global',
      label: `🌐 ${engine === 'opencode' ? t('rules.tabGlobalOpencode') : t('rules.tabGlobalClaude')}`
    },
    ...(projectCwd
      ? [
          {
            id: 'project' as TabId,
            label: `📁 ${engine === 'opencode' ? t('rules.tabProjectOpencode') : t('rules.tabProjectClaude')}`
          }
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
                className={`rules-editor ${file.exists ? '' : 'empty'}`}
                value={file.content}
                placeholder={file.exists ? '' : t('rules.emptyPlaceholder')}
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
