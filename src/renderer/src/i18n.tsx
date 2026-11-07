import { createContext, useContext, useMemo, type JSX } from 'react'
import {
  normalizeLocale,
  translate,
  type LocaleCode,
  type TFn,
  type TranslationKey,
  type TranslateParams
} from '../../locales'

interface I18nValue {
  locale: LocaleCode
  t: TFn
  setLocale: (l: LocaleCode) => void
}

const I18nContext = createContext<I18nValue>({
  locale: 'en',
  t: (k, p) => translate('en', k, p),
  setLocale: () => undefined
})

interface ProviderProps {
  locale: LocaleCode
  onSetLocale: (l: LocaleCode) => void
  children: React.ReactNode
}

export function I18nProvider({ locale, onSetLocale, children }: ProviderProps): JSX.Element {
  const value = useMemo<I18nValue>(
    () => ({
      locale,
      t: (key: TranslationKey, params?: TranslateParams) => translate(locale, key, params),
      setLocale: onSetLocale
    }),
    [locale, onSetLocale]
  )
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nValue {
  return useContext(I18nContext)
}

export function useT(): TFn {
  return useContext(I18nContext).t
}

/** Best-effort detection from the browser locale (used on first launch, then persisted). */
export function detectLocale(): LocaleCode {
  const langs = typeof navigator !== 'undefined' ? navigator.languages ?? [navigator.language] : []
  for (const l of langs) {
    const n = normalizeLocale(l)
    if (n) return n
  }
  return 'en'
}
