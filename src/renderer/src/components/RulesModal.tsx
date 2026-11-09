import { useEffect, useRef, useState, type JSX } from 'react'
import { basicSetup, EditorView } from 'codemirror'
import { EditorState } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
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

marked.setOptions({ gfm: true, breaks: false })

const cmTheme = EditorView.theme(
  {
    '&': { fontSize: '12.5px', backgroundColor: 'transparent', color: 'var(--fg)', height: '100%' },
    '.cm-scroller': { fontFamily: "Consolas, 'Courier New', monospace", lineHeight: '1.6' },
    '.cm-content': { paddingBottom: '12px' },
    '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--fg-dim)', border: 'none' },
    '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.04)' },
    '.cm-activeLineGutter': { backgroundColor: 'rgba(255,255,255,0.06)' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
      backgroundColor: 'rgba(76,194,255,0.25)'
    },
    '.cm-cursor': { borderLeftColor: 'var(--fg)' },
    '.cm-searchMatch': { backgroundColor: 'rgba(245,197,66,0.3)' },
    '.cm-searchMatch-selected': { backgroundColor: 'rgba(245,197,66,0.55)' }
  },
  { dark: true }
)

const mdHighlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.heading1, fontWeight: '700', fontSize: '1.2em', color: '#4cc2ff' },
    { tag: tags.heading2, fontWeight: '700', fontSize: '1.1em', color: '#4cc2ff' },
    { tag: tags.heading3, fontWeight: '700', color: '#4cc2ff' },
    { tag: tags.heading4, fontWeight: '700', color: 'var(--fg)' },
    { tag: tags.strong, fontWeight: '700', color: 'var(--fg)' },
    { tag: tags.emphasis, fontStyle: 'italic' },
    { tag: tags.link, color: '#4cc2ff', textDecoration: 'underline' },
    { tag: tags.monospace, color: '#ce9178' },
    { tag: tags.quote, color: 'var(--fg-dim)', fontStyle: 'italic' },
    { tag: tags.list, color: '#f5c542' }
  ])
)

export default function RulesModal({ engine, projectCwd, onClose, onNotify }: Props): JSX.Element {
  const t = useT()
  const [active, setActive] = useState<TabId>(projectCwd ? 'project' : 'global')
  const [files, setFiles] = useState<Partial<Record<TabId, LoadedRule>>>({})
  const [previewOn, setPreviewOn] = useState(true)
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)

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
      .then((f) => {
        // Normalize to \n inside the editor; the original line ending is restored on save
        const content = f.content.replace(/\r\n/g, '\n')
        setFiles((prev) => ({
          ...prev,
          [active]: { ...f, content, savedContent: content }
        }))
      })
      .catch((err) => onNotify(t('rules.readFail', { err: String(err) })))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  const file = files[active]
  const fileReady = !!file

  // Mount the CodeMirror editor for the active tab (recreated on tab switch)
  useEffect(() => {
    const f = files[active]
    if (!hostRef.current || !f) return
    const view = new EditorView({
      state: EditorState.create({
        doc: f.content,
        extensions: [
          basicSetup,
          markdown({ base: markdownLanguage }),
          EditorView.lineWrapping,
          cmTheme,
          mdHighlight,
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return
            const content = u.state.doc.toString()
            setFiles((prev) =>
              prev[active] ? { ...prev, [active]: { ...prev[active]!, content } } : prev
            )
          })
        ]
      }),
      parent: hostRef.current
    })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, fileReady])

  const dirty = !!file && file.content !== file.savedContent

  const save = (): void => {
    const f = files[active]
    if (!f || !viewRef.current || f.content === f.savedContent) return
    const content = viewRef.current.state.doc.toString()
    window.api
      .rulesWrite(refFor(active), content, f.crlf)
      .then((path) => {
        setFiles((prev) => ({
          ...prev,
          [active]: { ...f, content, path, exists: true, savedContent: content }
        }))
        onNotify(t('rules.saved'))
      })
      .catch((err) => onNotify(t('rules.writeFail', { err: String(err) })))
  }

  // Ctrl+S / Cmd+S saves the active tab even when the editor lost focus
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

  const previewHtml = file
    ? DOMPurify.sanitize(marked.parse(file.content) as string)
    : ''

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal rules-modal ${previewOn ? 'with-preview' : ''}`}>
        <div className="rules-head">
          <h3>{t('rules.title')}</h3>
          <div className="rules-head-actions">
            <button
              className={`rules-preview-toggle ${previewOn ? 'on' : ''}`}
              onClick={() => setPreviewOn((v) => !v)}
              title={t('rules.preview')}
            >
              👁 {t('rules.preview')}
            </button>
            <button className="icon-btn" onClick={onClose} title={t('common.close')}>
              ✕
            </button>
          </div>
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
        <div className={`rules-body ${previewOn ? 'split' : ''}`}>
          {file ? (
            <>
              <div className="rules-edit-pane">
                <div className="rules-path" title={file.path}>
                  {file.path}
                  {!file.exists && <span className="rules-new-hint"> · {t('rules.notCreated')}</span>}
                </div>
                <div className="rules-editor-host" />
              </div>
              {previewOn && (
                <div className="md-preview" dangerouslySetInnerHTML={{ __html: previewHtml }} />
              )}
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
