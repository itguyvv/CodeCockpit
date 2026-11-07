import en, { type Translation, type TranslationKey } from './en'
import zhCN from './zh-CN'
import zhTW from './zh-TW'
import ja from './ja'
import ko from './ko'
import de from './de'
import fr from './fr'
import es from './es'
import ptBR from './pt-BR'
import ru from './ru'

export type { TranslationKey, Translation }

/** Locale registry — add a new language by creating a file and registering it here. */
export const locales = {
  en,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  ja,
  ko,
  de,
  fr,
  es,
  'pt-BR': ptBR,
  ru
} satisfies Record<string, Translation>

export type LocaleCode = keyof typeof locales

/** Native display names for the language picker. */
export const LOCALE_LIST: Array<{ code: LocaleCode; label: string }> = [
  { code: 'en', label: 'English' },
  { code: 'zh-CN', label: '简体中文' },
  { code: 'zh-TW', label: '繁體中文' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'de', label: 'Deutsch' },
  { code: 'fr', label: 'Français' },
  { code: 'es', label: 'Español' },
  { code: 'pt-BR', label: 'Português (Brasil)' },
  { code: 'ru', label: 'Русский' }
]

export type TranslateParams = Record<string, string | number>
export type TFn = (key: TranslationKey, params?: TranslateParams) => string

function interpolate(s: string, params?: TranslateParams): string {
  if (!params) return s
  return s.replace(/\{(\w+)\}/g, (m, name: string) =>
    name in params ? String(params[name]) : m
  )
}

export function translate(code: string, key: TranslationKey, params?: TranslateParams): string {
  const dict = (locales as Record<string, Translation>)[code] ?? en
  const s = dict[key] ?? en[key] ?? key
  return interpolate(s, params)
}

/** Map a BCP-47 tag (navigator.language / app.getLocale()) to a supported locale. */
export function normalizeLocale(tag: string): LocaleCode {
  const t = (tag || '').toLowerCase()
  if (t.startsWith('zh')) {
    if (t.includes('tw') || t.includes('hk') || t.includes('mo') || t.includes('hant')) return 'zh-TW'
    return 'zh-CN'
  }
  for (const c of ['ja', 'ko', 'de', 'fr', 'es', 'ru'] as const) {
    if (t.startsWith(c)) return c
  }
  if (t.startsWith('pt')) return 'pt-BR'
  return 'en'
}
