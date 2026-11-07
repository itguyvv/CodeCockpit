import type { TranslationKey, TFn } from '../../locales'

export interface SessionState {
  id: string
  claudeSessionId: string | null
  cwd: string
  mode: string
  status: 'running' | 'exited'
  title: string
  /** PTY produced output within the last 3 seconds */
  busy: boolean
  /** Model flag passed to the CLI ('' = follow CLI default) */
  model?: string
}

export const MODES: Array<{ value: string; key: TranslationKey }> = [
  { value: 'default', key: 'mode.default' },
  { value: 'acceptEdits', key: 'mode.acceptEdits' },
  { value: 'plan', key: 'mode.plan' },
  { value: 'bypassPermissions', key: 'mode.bypassPermissions' }
]

export function modeLabel(mode: string, t: TFn): string {
  const m = MODES.find((x) => x.value === mode)
  return m ? t(m.key) : mode
}

/** --model choices ('' = follow global settings / CLI default) */
export const MODELS: Array<{ value: string; key: TranslationKey }> = [
  { value: '', key: 'model.follow' },
  { value: 'sonnet', key: 'model.sonnet' },
  { value: 'opus', key: 'model.opus' },
  { value: 'haiku', key: 'model.haiku' }
]

export function modelLabel(model: string, t: TFn): string {
  if (!model || model === 'default') return t('model.default')
  const m = model.toLowerCase()
  if (m.includes('opus')) return 'Opus'
  if (m.includes('haiku')) return 'Haiku'
  if (m.includes('sonnet')) return 'Sonnet'
  return model
}
