// Typed wrapper around chrome.i18n.getMessage. The key union grows as
// strings are extracted in subsequent i18n rounds (see _locales/en/messages.json
// for the source of truth).

export type LocaleKey =
  | 'appName'
  | 'appDescription'
  | 'actionDefaultTitle'
  | 'commandAnalyzePage';

export function t(key: LocaleKey, substitutions?: string | readonly string[]): string {
  if (typeof chrome === 'undefined' || !chrome.i18n?.getMessage) {
    return key;
  }
  const subs = substitutions === undefined ? undefined : Array.isArray(substitutions)
    ? [...substitutions]
    : substitutions;
  return chrome.i18n.getMessage(key, subs as string | string[] | undefined) || key;
}
