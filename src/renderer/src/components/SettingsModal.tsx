import { useEffect, useState, type JSX } from 'react'
import { MODES } from '../types'
import type {
  AppInfo,
  EngineId,
  EngineInfo,
  McpServerInfo,
  ProviderListResult,
  ProviderProfile
} from '../api'
import { useT } from '../i18n'
import { LOCALE_LIST, type LocaleCode } from '../../../locales'

interface Props {
  appInfo: AppInfo | null
  locale: LocaleCode
  onSetLocale: (l: LocaleCode) => void
  onClose: () => void
  onNotify: (msg: string) => void
}

const BUILTIN_ID = 'builtin-default'

type Draft = Omit<ProviderProfile, 'id'> & { id?: string }

function emptyDraft(engine: EngineId): Draft {
  return { name: '', engine, baseUrl: '', apiKey: '', providerId: '', modelId: '', npmPackage: '' }
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
  const [engineInfos, setEngineInfos] = useState<EngineInfo[]>([])
  const [enginesEnabled, setEnginesEnabled] = useState<Partial<Record<EngineId, boolean>>>({})
  const [providers, setProviders] = useState<ProviderListResult | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [confirmBox, setConfirmBox] = useState<null | { text: string; onOk: () => void }>(null)

  useEffect(() => {
    void window.api.getSettings().then((s) => {
      setDefaultMode(s.defaultMode || 'default')
      setDefaultModel(s.defaultModel || '')
      setEnginesEnabled(s.engines ?? {})
    })
    void window.api.mcpList().then(setMcp)
    void window.api.enginesDiscover().then(setEngineInfos)
    void window.api.providersList().then(setProviders)
  }, [])

  const refreshProviders = (): Promise<void> =>
    window.api.providersList().then((r) => {
      setProviders(r)
    })

  const engineName = (e: EngineId): string => (e === 'opencode' ? t('engine.opencode') : t('engine.claude'))

  const setEngineEnabled = (id: EngineId, on: boolean): void => {
    const next = { ...enginesEnabled, [id]: on }
    setEnginesEnabled(next)
    void window.api.setSettings({ engines: next })
    onNotify(t('settings.enginesSaved'))
  }

  const saveDefaults = (): void => {
    void window.api.setSettings({ defaultMode, defaultModel }).then(() => {
      onNotify(t('settings.defaultsSaved'))
    })
  }

  const submitDraft = async (): Promise<void> => {
    if (!draft) return
    if (!draft.name.trim() || (!draft.builtin && !draft.baseUrl.trim())) {
      onNotify(t('provider.nameRequired'))
      return
    }
    await window.api.providersSave(draft as ProviderProfile)
    await refreshProviders()
    setDraft(null)
    onNotify(t('provider.saved'))
  }

  const doDelete = (p: ProviderProfile): void => {
    setConfirmBox({
      text: t('provider.confirmDelete', { name: p.name }),
      onOk: () => {
        void window.api.providersDelete(p.id).then(() => refreshProviders()).then(() => onNotify(t('provider.deleted')))
      }
    })
  }

  const doSetActive = (p: ProviderProfile): void => {
    void window.api.providersSetActive(p.engine, p.id).then(() => refreshProviders())
    onNotify(t('provider.activeSet', { engine: engineName(p.engine), name: p.name }))
  }

  const doApplyGlobal = (p: ProviderProfile): void => {
    const file = providers?.configFiles[p.engine] ?? ''
    setConfirmBox({
      text: t('provider.confirmApplyGlobal', { file, name: p.name, engine: engineName(p.engine) }),
      onOk: () => {
        setBusy(t('provider.applying'))
        window.api
          .providersApplyGlobal(p.engine, p.id)
          .then((path) => {
            setBusy('')
            onNotify(t('provider.appliedGlobal', { engine: engineName(p.engine), file: path }))
          })
          .catch((e) => {
            setBusy('')
            onNotify(t('provider.applyFailed', { err: String((e as Error).message || e) }))
          })
      }
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
          <div className="settings-title">{t('settings.sectionEngines')}</div>
          {engineInfos.map((info) => {
            const on = info.id === 'claude' ? true : enginesEnabled[info.id] ?? Boolean(info.bin)
            return (
              <div key={info.id} className="settings-row">
                <label>{engineName(info.id)}</label>
                <span className="engine-info" title={info.bin || t('settings.engineMissing')}>
                  {info.bin
                    ? `${info.version || '?'} · ${info.bin}`
                    : t('settings.engineMissing')}
                </span>
                <label className="engine-toggle">
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={!info.bin || info.id === 'claude'}
                    onChange={(e) => setEngineEnabled(info.id, e.target.checked)}
                  />
                  {on ? t('settings.engineEnabled') : t('settings.engineDisabled')}
                </label>
              </div>
            )
          })}
          <p className="settings-hint">{t('settings.enginesHint')}</p>
        </div>

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
              <option value="">{t('model.follow')}</option>
              <option value="sonnet">{t('model.sonnet')}</option>
              <option value="opus">{t('model.opus')}</option>
              <option value="haiku">{t('model.haiku')}</option>
            </select>
          </div>
          <div className="settings-actions">
            <button className="primary" onClick={saveDefaults}>
              {t('settings.saveDefaults')}
            </button>
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-title">{t('settings.sectionProviders')}</div>
          <p className="settings-hint">{t('settings.providersHint')}</p>
          <div className="provider-list">
            {(providers?.profiles ?? [])
              .slice()
              .sort((a, b) => (a.engine === b.engine ? 0 : a.engine === 'claude' ? -1 : 1))
              .map((p) => {
                const active = (providers?.activeByEngine[p.engine] ?? BUILTIN_ID) === p.id
                return (
                  <div key={p.id} className={`provider-item ${p.builtin ? 'builtin' : ''}`}>
                    <span className="provider-name">
                      {p.name}
                      {p.builtin && <em className="provider-tag">{t('provider.builtin')}</em>}
                      {active && <em className="provider-tag active">{t('provider.active')}</em>}
                    </span>
                    <span className="provider-detail" title={p.apiKey ? '••••••••' : ''}>
                      {p.engine === 'opencode' ? t('engine.opencode') : t('engine.claude')}
                      {p.baseUrl ? ` · ${p.baseUrl}` : ''}
                      {p.modelId ? ` · ${p.providerId}/${p.modelId}` : ''}
                    </span>
                    <span className="provider-actions">
                      {!p.builtin && (
                        <>
                          <button onClick={() => doSetActive(p)}>{t('provider.useForNew')}</button>
                          <button onClick={() => doApplyGlobal(p)}>{t('provider.applyGlobal')}</button>
                          <button onClick={() => setDraft({ ...p })}>{t('provider.edit')}</button>
                          <button className="danger" onClick={() => doDelete(p)}>
                            {t('provider.delete')}
                          </button>
                        </>
                      )}
                      {p.builtin && p.engine === 'claude' && (
                        <button onClick={() => doApplyGlobal(p)}>{t('provider.applyGlobal')}</button>
                      )}
                    </span>
                  </div>
                )
              })}
          </div>
          <div className="settings-actions">
            <button className="primary" onClick={() => setDraft(emptyDraft('claude'))}>
              {t('provider.add')}
            </button>
          </div>
        </div>

        {draft && (
          <div className="settings-section provider-editor">
            <div className="settings-title">{draft.id ? t('provider.edit') : t('provider.add')}</div>
            <div className="provider-form">
              <label>{t('provider.name')}</label>
              <input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                spellCheck={false}
              />
              <label>{t('provider.engineLabel')}</label>
              <select
                value={draft.engine}
                onChange={(e) => setDraft({ ...draft, engine: e.target.value as EngineId })}
              >
                <option value="claude">{t('engine.claude')}</option>
                <option value="opencode">{t('engine.opencode')}</option>
              </select>
              <label>{t('provider.baseUrl')}</label>
              <input
                value={draft.baseUrl}
                onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
                placeholder="https://api.example.com"
                spellCheck={false}
              />
              <label>{t('provider.apiKey')}</label>
              <input
                value={draft.apiKey}
                onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
                type="password"
                spellCheck={false}
              />
              {draft.engine === 'opencode' && (
                <>
                  <label>{t('provider.providerId')}</label>
                  <input
                    value={draft.providerId ?? ''}
                    onChange={(e) => setDraft({ ...draft, providerId: e.target.value })}
                    placeholder={t('provider.providerIdPlaceholder')}
                    spellCheck={false}
                  />
                  <label>{t('provider.modelId')}</label>
                  <input
                    value={draft.modelId ?? ''}
                    onChange={(e) => setDraft({ ...draft, modelId: e.target.value })}
                    placeholder={t('provider.modelIdPlaceholder')}
                    spellCheck={false}
                  />
                  <label>{t('provider.npmPackage')}</label>
                  <input
                    value={draft.npmPackage ?? ''}
                    onChange={(e) => setDraft({ ...draft, npmPackage: e.target.value })}
                    placeholder="@ai-sdk/anthropic"
                    spellCheck={false}
                  />
                </>
              )}
            </div>
            <div className="settings-actions">
              <button className="ghost" onClick={() => setDraft(null)}>
                {t('common.cancel')}
              </button>
              <button className="primary" onClick={() => void submitDraft()}>
                {t('common.save')}
              </button>
            </div>
          </div>
        )}

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

      {confirmBox && (
        <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && setConfirmBox(null)}>
          <div className="modal">
            <h3>{t('confirm.title')}</h3>
            <p>{confirmBox.text}</p>
            <div className="modal-actions">
              <button className="ghost" onClick={() => setConfirmBox(null)}>
                {t('common.cancel')}
              </button>
              <button
                className="danger"
                onClick={() => {
                  const ok = confirmBox.onOk
                  setConfirmBox(null)
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
