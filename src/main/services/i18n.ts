import fs from 'node:fs'
import { dataFile } from './dataDir'
import { translate, type LocaleCode, type TranslationKey, type TranslateParams } from '../../locales'

let cachedLocale: LocaleCode | null = null

/** Locale for main-process strings (dialogs, notifications, terminal banners). */
export function getLocale(): LocaleCode {
  if (cachedLocale) return cachedLocale
  try {
    const raw = JSON.parse(fs.readFileSync(dataFile('settings.json'), 'utf-8'))
    if (raw && typeof raw.locale === 'string') cachedLocale = raw.locale as LocaleCode
  } catch {
    // No settings yet — fall back to English until the renderer saves one
  }
  return cachedLocale ?? 'en'
}

export function setLocale(locale: string): void {
  cachedLocale = locale as LocaleCode
}

export function t(key: TranslationKey, params?: TranslateParams): string {
  return translate(getLocale(), key, params)
}
