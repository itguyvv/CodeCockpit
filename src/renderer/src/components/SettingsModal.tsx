import { useEffect, useState, type JSX } from 'react'
import { MODES } from '../types'
import type {
  AppInfo,
  AppSettings,
  EngineId,
  EngineInfo,
  McpServerInfo,
  ProviderListResult,
  ProviderProfile,
  ProviderTestResult
} from '../api'
import { useT } from '../i18n'
import { LOCALE_LIST, type LocaleCode } from '../../../locales'
import logoUrl from '../assets/logo.png'

interface Props {
  appInfo: AppInfo | null
  locale: LocaleCode
  onSetLocale: (l: LocaleCode) => void
  /** Live sync of settings changes to the main window (sidebar tabs, terminal scrollback etc.) */
  onSettingsChanged: (patch: Partial<AppSettings>) => void
  onClose: () => void
  onNotify: (msg: string) => void
}

const BUILTIN_ID = 'builtin-default'

type SettingsTab = 'general' | 'engines' | 'providers' | 'claude' | 'about'

type Draft = Omit<ProviderProfile, 'id'> & { id?: string }

function emptyDraft(engine: EngineId): Draft {
  return { name: '', engine, baseUrl: '', apiKey: '', providerId: '', modelId: '', npmPackage: '', modelMap: {} }
}

export default function SettingsModal({
  appInfo,
  locale,
  onSetLocale,
  onSettingsChanged,
  onClose,
  onNotify
}: Props): JSX.Element {
  const t = useT()
  const [tab, setTab] = useState<SettingsTab>('general')
  const [defaultMode, setDefaultMode] = useState('default')
  const [defaultModel, setDefaultModel] = useState('')
  const [scrollback, setScrollback] = useState(2000)
  const [mcp, setMcp] = useState<McpServerInfo[]>([])
  const [busy, setBusy] = useState('')
  const [engineInfos, setEngineInfos] = useState<EngineInfo[]>([])
  const [enginesEnabled, setEnginesEnabled] = useState<Partial<Record<EngineId, boolean>>>({})
  const [providers, setProviders] = useState<ProviderListResult | null>(null)
  const [providerEngine, setProviderEngine] = useState<EngineId>('claude')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [testResult, setTestResult] = useState<ProviderTestResult | 'testing' | null>(null)
  const [confirmBox, setConfirmBox] = useState<null | { text: string; onOk: () => void }>(null)

  useEffect(() => {
    void window.api.getSettings().then((s) => {
      setDefaultMode(s.defaultMode || 'default')
      setDefaultModel(s.defaultModel || '')
      setScrollback(s.scrollback ?? 2000)
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
    // At least one installed engine must stay enabled, otherwise the window has no sessions at all
    const installed = engineInfos.filter((e) => e.bin)
    const enabledNow = installed.filter((e) => (enginesEnabled[e.id] ?? Boolean(e.bin)))
    if (!on && enabledNow.length === 1 && enabledNow[0].id === id) {
      onNotify(t('settings.engineKeepOne'))
      return
    }
    const next = { ...enginesEnabled, [id]: on }
    setEnginesEnabled(next)
    void window.api.setSettings({ engines: next })
    onSettingsChanged({ engines: next })
    onNotify(t('settings.enginesSaved'))
  }

  const saveDefaults = (): void => {
    void window.api.setSettings({ defaultMode, defaultModel, scrollback }).then(() => {
      onSettingsChanged({ scrollback })
      onNotify(t('settings.defaultsSaved'))
    })
  }

  const openDraft = (d: Draft): void => {
    setDraft(d)
    setTestResult(null)
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

  const runTest = (): void => {
    if (!draft) return
    setTestResult('testing')
    window.api
      .providersTest(draft)
      .then(setTestResult)
      .catch((e) => setTestResult({ ok: false, ms: 0, error: String((e as Error).message || e) }))
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

  const engineProfiles = (providers?.profiles ?? []).filter((p) => p.engine === providerEngine)

  const mapSummary = (p: ProviderProfile): string => {
    if (p.engine === 'opencode') return p.modelId ? ` · ${p.providerId}/${p.modelId}` : ''
    const m = p.modelMap ?? {}
    return m.main ? ` · ${t('provider.modelMain')} → ${m.main}` : ''
  }

  const tabItems: Array<{ id: SettingsTab; label: string }> = [
    { id: 'general', label: t('settings.tabGeneral') },
    { id: 'engines', label: t('settings.tabEngines') },
    { id: 'providers', label: t('settings.tabProviders') },
    { id: 'claude', label: t('settings.tabClaude') },
    { id: 'about', label: t('settings.tabAbout') }
  ]

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal settings-modal">
        <div className="settings-head">
          <h3>{t('settings.title')}</h3>
          <span className="settings-close" onClick={onClose} title={t('common.close')}>
            ×
          </span>
        </div>

        <div className="settings-tabs">
          {tabItems.map((item) => (
            <button
              key={item.id}
              className={`settings-tab ${tab === item.id ? 'on' : ''}`}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="settings-body">
        {tab === 'general' && (
          <>
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
              <div className="settings-row">
                <label title={t('settings.scrollbackHint')}>{t('settings.defaultScrollback')}</label>
                <select value={scrollback} onChange={(e) => setScrollback(Number(e.target.value))}>
                  {[1000, 2000, 5000, 10_000, 20_000].map((n) => (
                    <option key={n} value={n}>
                      {n.toLocaleString()}
                    </option>
                  ))}
                </select>
              </div>
              <p className="settings-hint">{t('settings.scrollbackHint')}</p>
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
          </>
        )}

        {tab === 'engines' && (
          <div className="settings-section">
            <div className="settings-title">{t('settings.sectionEngines')}</div>
            {engineInfos.map((info) => {
              const on = enginesEnabled[info.id] ?? Boolean(info.bin)
              const lastEnabled =
                engineInfos.filter((e) => e.bin && (enginesEnabled[e.id] ?? Boolean(e.bin))).length === 1
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
                      disabled={!info.bin || (!on && lastEnabled)}
                      onChange={(e) => setEngineEnabled(info.id, e.target.checked)}
                    />
                    {on ? t('settings.engineEnabled') : t('settings.engineDisabled')}
                  </label>
                </div>
              )
            })}
            <p className="settings-hint">{t('settings.enginesHint')}</p>
          </div>
        )}

        {tab === 'providers' && (
          <div className="settings-section">
            <div className="settings-title">{t('settings.sectionProviders')}</div>
            <p className="settings-hint">{t('settings.providersHint')}</p>
            <div className="settings-tabs sub">
              {(['claude', 'opencode'] as EngineId[]).map((eng) => (
                <button
                  key={eng}
                  className={`settings-tab ${providerEngine === eng ? 'on' : ''}`}
                  onClick={() => setProviderEngine(eng)}
                >
                  {engineName(eng)}
                </button>
              ))}
            </div>
            <div className="provider-list">
              {engineProfiles.length === 0 && <p className="settings-hint">{t('provider.listEmpty')}</p>}
              {engineProfiles.map((p) => {
                const active = (providers?.activeByEngine[p.engine] ?? BUILTIN_ID) === p.id
                return (
                  <div key={p.id} className={`provider-item ${p.builtin ? 'builtin' : ''}`}>
                    <span className="provider-name">
                      {p.name}
                      {p.builtin && <em className="provider-tag">{t('provider.builtin')}</em>}
                      {active && <em className="provider-tag active">{t('provider.active')}</em>}
                    </span>
                    <span className="provider-detail" title={p.apiKey ? '••••••••' : ''}>
                      {p.baseUrl}
                      {mapSummary(p)}
                    </span>
                    <span className="provider-actions">
                      <button onClick={() => doSetActive(p)}>{t('provider.useForNew')}</button>
                      {!p.builtin && (
                        <>
                          <button onClick={() => doApplyGlobal(p)}>{t('provider.applyGlobal')}</button>
                          <button onClick={() => openDraft({ ...p })}>{t('provider.edit')}</button>
                          <button className="danger" onClick={() => doDelete(p)}>
                            {t('provider.delete')}
                          </button>
                        </>
                      )}
                      {p.builtin && (
                        <button onClick={() => doApplyGlobal(p)}>{t('provider.applyGlobal')}</button>
                      )}
                    </span>
                  </div>
                )
              })}
            </div>
            <div className="settings-actions">
              <button className="primary" onClick={() => openDraft(emptyDraft(providerEngine))}>
                {t('provider.add')}
              </button>
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
                  {draft.engine === 'claude' && (
                    <>
                      <label>{t('provider.modelMap')}</label>
                      <div className="model-map-grid">
                        <div className="model-map-field">
                          <span>{t('provider.modelMain')}</span>
                          <input
                            value={draft.modelMap?.main ?? ''}
                            onChange={(e) =>
                              setDraft({ ...draft, modelMap: { ...draft.modelMap, main: e.target.value } })
                            }
                            placeholder="claude-sonnet-4-5"
                            spellCheck={false}
                          />
                        </div>
                        <div className="model-map-field">
                          <span>{t('provider.modelHaiku')}</span>
                          <input
                            value={draft.modelMap?.haiku ?? ''}
                            onChange={(e) =>
                              setDraft({ ...draft, modelMap: { ...draft.modelMap, haiku: e.target.value } })
                            }
                            placeholder={t('provider.modelMapSame')}
                            spellCheck={false}
                          />
                        </div>
                        <div className="model-map-field">
                          <span>{t('provider.modelSonnet')}</span>
                          <input
                            value={draft.modelMap?.sonnet ?? ''}
                            onChange={(e) =>
                              setDraft({ ...draft, modelMap: { ...draft.modelMap, sonnet: e.target.value } })
                            }
                            placeholder={t('provider.modelMapSame')}
                            spellCheck={false}
                          />
                        </div>
                        <div className="model-map-field">
                          <span>{t('provider.modelOpus')}</span>
                          <input
                            value={draft.modelMap?.opus ?? ''}
                            onChange={(e) =>
                              setDraft({ ...draft, modelMap: { ...draft.modelMap, opus: e.target.value } })
                            }
                            placeholder={t('provider.modelMapSame')}
                            spellCheck={false}
                          />
                        </div>
                      </div>
                    </>
                  )}
                </div>
                {draft.engine === 'claude' && (
                  <p className="settings-hint">{t('provider.modelMapHint')}</p>
                )}
                <div className="settings-actions">
                  {!draft.builtin && (
                    <button onClick={runTest} disabled={testResult === 'testing'}>
                      {testResult === 'testing' ? t('provider.testing') : t('provider.test')}
                    </button>
                  )}
                  <button className="ghost" onClick={() => setDraft(null)}>
                    {t('common.cancel')}
                  </button>
                  <button className="primary" onClick={() => void submitDraft()}>
                    {t('common.save')}
                  </button>
                </div>
                {testResult && testResult !== 'testing' && (
                  <p className={`provider-test-result ${testResult.ok ? 'ok' : 'fail'}`}>
                    {testResult.ok
                      ? t('provider.testOk', { ms: testResult.ms })
                      : t('provider.testFail', { err: testResult.error })}
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {tab === 'claude' && (
          <>
            <div className="settings-section">
              <div className="settings-title">{t('settings.sectionClaude')}</div>
              <div className="settings-actions">
                <button onClick={() => open(home + '/.claude', t('label.claudeFolder'))}>
                  {t('settings.openClaudeFolder')}
                </button>
                <button onClick={() => open(home + '/.claude/CLAUDE.md', t('label.globalMd'))}>
                  {t('settings.openGlobalMd')}
                </button>
                <button onClick={() => open(home + '/.claude/skills', t('label.skills'))}>
                  {t('settings.openSkills')}
                </button>
                <button onClick={() => open(home + '/.claude/settings.json', t('label.claudeSettings'))}>
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
          </>
        )}

        {tab === 'about' && (
          <div className="settings-section">
            <div className="about-head">
              <img src={logoUrl} alt="CodeCockpit" className="about-logo" />
              <div className="about-name">
                CodeCockpit
                <span className="about-version">v{appInfo?.appVersion ?? '?'}</span>
              </div>
            </div>
            <div className="about-links">
              <a href="https://github.com/itguyvv/CodeCockpit" target="_blank" rel="noreferrer">
                github.com/itguyvv/CodeCockpit
              </a>
              <a href="https://github.com/itguyvv/CodeCockpit/issues" target="_blank" rel="noreferrer">
                {t('about.reportIssue')}
              </a>
            </div>
            <p className="settings-hint">{t('about.license')}</p>
          </div>
        )}

        <div className="settings-actions end">
          <button className="ghost" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
        {busy && <p className="settings-hint">{busy}</p>}
        </div>
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
