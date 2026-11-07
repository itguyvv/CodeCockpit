import { useEffect, useState, type JSX } from 'react'
import { MODES, MODELS } from '../types'
import type { AppInfo, McpServerInfo } from '../api'
import { useT } from '../i18n'
import { LOCALE_LIST, type LocaleCode } from '../../../locales'

interface Props {
  appInfo: AppInfo | null
  locale: LocaleCode
  onSetLocale: (l: LocaleCode) => void
  onClose: () => void
  onNotify: (msg: string) => void
}

export default function SettingsModal({
  appInfo,
  locale,
  onSetLocale,
  onClose,
  onNotify
}: Props): JSX.Element {
  const t = useT()
  const [defaultMode, setDefaultMode] = useState('default')
  const [defaultModel, setDefaultModel] = useState('')
  const [mcp, setMcp] = useState<McpServerInfo[]>([])
  const [busy, setBusy] = useState('')

  useEffect(() => {
    void window.api.getSettings().then((s) => {
      setDefaultMode(s.defaultMode || 'default')
      setDefaultModel(s.defaultModel || '')
    })
    void window.api.mcpList().then(setMcp)
  }, [])

  const saveDefaults = (): void => {
    void window.api.setSettings({ defaultMode, defaultModel }).then(() => {
      onNotify(t('settings.defaultsSaved'))
    })
  }

  const changeDataDir = async (): Promise<void> => {
    const dir = await window.api.pickDir()
    if (!dir) return
    setBusy(t('settings.busySwitchDir'))
    const newPath = await window.api.setDataDir(dir)
    setBusy('')
    onNotify(t('settings.dataDirChanged', { path: newPath }))
  }

  const doExport = async (): Promise<void> => {
    setBusy(t('settings.busyExport'))
    try {
      const p = await window.api.exportData()
      setBusy('')
      if (p) onNotify(t('settings.exported', { path: p }))
    } catch (e) {
      setBusy('')
      onNotify(t('settings.exportFailed', { err: String((e as Error).message || e) }))
    }
  }

  const doImport = async (): Promise<void> => {
    setBusy(t('settings.busyImport'))
    try {
      const msg = await window.api.importData()
      setBusy('')
      onNotify(msg)
    } catch (e) {
      setBusy('')
      onNotify(t('settings.importFailed', { err: String((e as Error).message || e) }))
    }
  }

  const open = (p: string, label: string): void => {
    void window.api.openPath(p).then((err) => {
      if (err) onNotify(t('settings.openFail', { label, err }))
    })
  }

  const home = appInfo?.home ?? ''

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal settings-modal">
        <h3>{t('settings.title')}</h3>

        <div className="settings-section">
          <div className="settings-title">{t('settings.sectionDefaults')}</div>
          <div className="settings-row">
            <label>{t('settings.defaultMode')}</label>
            <select value={defaultMode} onChange={(e) => setDefaultMode(e.target.value)}>
              {MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {t(m.key)}
                </option>
              ))}
            </select>
          </div>
          <div className="settings-row">
            <label>{t('settings.defaultModel')}</label>
            <select value={defaultModel} onChange={(e) => setDefaultModel(e.target.value)}>
              {MODELS.map((m) => (
                <option key={m.value} value={m.value}>
                  {t(m.key)}
                </option>
              ))}
            </select>
          </div>
          <div className="settings-actions">
            <button className="primary" onClick={saveDefaults}>
              {t('settings.saveDefaults')}
            </button>
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-title">{t('settings.sectionLanguage')}</div>
          <div className="settings-row">
            <select value={locale} onChange={(e) => onSetLocale(e.target.value as LocaleCode)}>
              {LOCALE_LIST.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
          </div>
          <p className="settings-hint">{t('settings.languageHint')}</p>
        </div>

        <div className="settings-section">
          <div className="settings-title">{t('settings.sectionData')}</div>
          <div className="settings-row">
            <label>{t('settings.dataDir')}</label>
            <span className="settings-path" title={appInfo?.dataDir}>
              {appInfo?.dataDir ?? '—'}
            </span>
          </div>
          <div className="settings-actions">
            <button onClick={changeDataDir}>{t('settings.changeDataDir')}</button>
            <button onClick={doExport}>{t('settings.export')}</button>
            <button onClick={doImport}>{t('settings.import')}</button>
          </div>
          <p className="settings-hint">{t('settings.dataHint')}</p>
        </div>

        <div className="settings-section">
          <div className="settings-title">{t('settings.sectionClaude')}</div>
          <div className="settings-actions">
            <button onClick={() => open(home + '\\.claude', t('label.claudeFolder'))}>
              {t('settings.openClaudeFolder')}
            </button>
            <button onClick={() => open(home + '\\.claude\\CLAUDE.md', t('label.globalMd'))}>
              {t('settings.openGlobalMd')}
            </button>
            <button onClick={() => open(home + '\\.claude\\skills', t('label.skills'))}>
              {t('settings.openSkills')}
            </button>
            <button onClick={() => open(home + '\\.claude\\settings.json', t('label.claudeSettings'))}>
              {t('settings.openClaudeSettings')}
            </button>
          </div>
          <p className="settings-hint">{t('settings.claudeHint')}</p>
        </div>

        <div className="settings-section">
          <div className="settings-title">{t('settings.sectionMcp', { n: mcp.length })}</div>
          {mcp.length === 0 ? (
            <p className="settings-hint">{t('settings.mcpEmpty')}</p>
          ) : (
            <div className="mcp-list">
              {mcp.map((s) => (
                <div key={s.name} className="mcp-item" title={`${s.command} ${s.args.join(' ')}`}>
                  <span className="mcp-name">🔌 {s.name}</span>
                  <span className="mcp-cmd">{s.type === 'http' ? s.command : `${s.command} ${s.args.join(' ')}`}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="settings-actions end">
          <button className="ghost" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
        {busy && <p className="settings-hint">{busy}</p>}
      </div>
    </div>
  )
}
