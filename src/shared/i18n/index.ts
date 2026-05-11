import { type LocaleKey, STRINGS } from './strings';
import type { LocaleOverride, SubstitutionVars } from './types';

export type { LocaleKey, LocaleOverride, SubstitutionVars } from './types';
export { STRINGS } from './strings';

let localeOverride: LocaleOverride = 'auto';

function activeLocale(): keyof typeof STRINGS {
  if (localeOverride === 'zh_CN') return 'zh_CN';
  if (localeOverride === 'en') return 'en';
  if (typeof chrome !== 'undefined' && chrome.i18n?.getUILanguage) {
    const ui = chrome.i18n.getUILanguage();
    if (ui?.toLowerCase().startsWith('zh')) return 'zh_CN';
  }
  return 'en';
}

function activeBcp47(): string {
  return activeLocale() === 'zh_CN' ? 'zh-CN' : 'en';
}

export function setLocaleOverride(value: LocaleOverride): void {
  localeOverride = value;
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.lang = activeBcp47();
  }
}

export function getLocaleOverride(): LocaleOverride {
  return localeOverride;
}

const PLACEHOLDER = /\{([a-zA-Z0-9_]+)\}/g;

function applySubstitutions(template: string, vars: SubstitutionVars | undefined): string {
  if (!vars) return template;
  return template.replace(PLACEHOLDER, (match, name) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : match,
  );
}

function lookup(key: LocaleKey, locale: keyof typeof STRINGS): string | undefined {
  return STRINGS[locale][key];
}

export function t(key: LocaleKey, vars?: SubstitutionVars): string {
  const locale = activeLocale();
  const template = lookup(key, locale) ?? lookup(key, 'en') ?? key;
  return applySubstitutions(template, vars);
}

/**
 * Walk the DOM and replace `data-i18n="key"` text nodes and
 * `data-i18n-attr="attr1:key1;attr2:key2"` attributes with localized
 * strings. Call once after DOMContentLoaded and again after any locale
 * override change that requires a full re-render.
 */
export function applyI18n(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const key = el.dataset.i18n as LocaleKey | undefined;
    if (key) el.textContent = t(key);
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-attr]')) {
    const spec = el.dataset.i18nAttr;
    if (!spec) continue;
    for (const pair of spec.split(';')) {
      const [attr, key] = pair.split(':').map((s) => s.trim());
      if (!attr || !key) continue;
      el.setAttribute(attr, t(key as LocaleKey));
    }
  }
}
