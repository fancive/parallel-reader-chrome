// Typed wrapper around chrome.i18n.getMessage. The key union is hand-
// maintained against _locales/en/messages.json (the source of truth).
//
// The wrapper also supports an explicit per-user override (auto / en / zh_CN)
// so the side panel can switch language without changing Chrome's UI locale.
// Both messages.json files are bundled at build time via static JSON imports.

import enMessages from '../../_locales/en/messages.json';
import zhMessages from '../../_locales/zh_CN/messages.json';

type MessageEntry = { message: string };
type MessageBundle = Record<string, MessageEntry>;

const BUNDLES: Record<'en' | 'zh_CN', MessageBundle> = {
  en: enMessages as MessageBundle,
  zh_CN: zhMessages as MessageBundle,
};

export type LocaleOverride = 'auto' | 'en' | 'zh_CN';
let localeOverride: LocaleOverride = 'auto';

function activeBcp47(): string {
  if (localeOverride === 'zh_CN') return 'zh-CN';
  if (localeOverride === 'en') return 'en';
  if (typeof chrome !== 'undefined' && chrome.i18n?.getUILanguage) {
    return chrome.i18n.getUILanguage();
  }
  return 'en';
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

export type LocaleKey =
  | 'appName'
  | 'appDescription'
  | 'actionDefaultTitle'
  | 'commandAnalyzePage'
  | 'statusAnalyzing'
  | 'statusReanalyzing'
  | 'statusReading'
  | 'statusReadingThisPage'
  | 'statusOrganizing'
  | 'statusReorganizing'
  | 'statusPageLoading'
  | 'statusPageChangedCancel'
  | 'statusPageSwitched'
  | 'statusPageContentChanged'
  | 'statusReadingTitled'
  | 'statusPageContentChangedTitled'
  | 'statusWaiting'
  | 'statusWaitingTitled'
  | 'statusFoundLocating'
  | 'statusRestoredSummary'
  | 'statusCompleteSummary'
  | 'statusCacheClearedCurrent'
  | 'statusCacheClearedAll'
  | 'cardHighlighted'
  | 'cardLocateFailed'
  | 'cardNotFoundInPage'
  | 'cardLocateError'
  | 'errorPrefix'
  | 'errorMissingProviderSettings'
  | 'errorNoActiveTab'
  | 'errorCannotOpenPage'
  | 'pageNotReadable'
  | 'hintRefreshOrSwitch'
  | 'btnAnalyze'
  | 'btnReanalyze'
  | 'btnReanalyzeTitle'
  | 'btnClearAll'
  | 'btnClearAllConfirm'
  | 'historyDeleted'
  | 'historyExportedSingle'
  | 'historyExportedAll'
  | 'historyEmptyExport'
  | 'historyCleared'
  | 'metaCharsCount'
  | 'metaUsedReadability'
  | 'metaUsedRaw'
  | 'settingsInvalid'
  | 'settingsCheckInput'
  | 'settingsSaved'
  | 'cacheStatusNoCache'
  | 'cacheStatusClearedCount'
  | 'menuHighlight'
  | 'menuCopyQuote'
  | 'menuCopiedQuote'
  | 'menuCopySummary'
  | 'menuCopiedSummary'
  | 'historyCardsCount'
  | 'historyOpen'
  | 'historyExportMarkdown'
  | 'historyDelete'
  | 'historyDeleteConfirm'
  | 'historyUnknownTime'
  | 'errorTabNoUrl'
  | 'pageNoReadableText'
  | 'qualityNoTextLabel'
  | 'qualityNoTextDetail'
  | 'qualityShortLabel'
  | 'qualityShortDetail'
  | 'qualityRawLabel'
  | 'qualityRawDetail'
  | 'qualityOkLabel'
  | 'qualityOkDetail'
  | 'pageSupportInvalidUrl'
  | 'pageSupportInternalPage'
  | 'pageSupportPdfNotSupported'
  | 'pageSupportProtocolUnsupported'
  | 'pageSupportFileAccessHint'
  | 'providerErrorMissingApiKey'
  | 'providerErrorMissingBaseUrl'
  | 'providerErrorEmptyResponse'
  | 'providerErrorJsonParse'
  | 'providerErrorSchemaMismatch'
  | 'clipboardWriteDenied'
  | 'clipboardCopyFailed'
  | 'cardHighlightAriaLabel'
  | 'cardCannotLocateAriaLabel'
  | 'cardClickToHighlightTitle'
  | 'cardRightClickActionsTitle'
  | 'badgeLocate'
  | 'settingsAriaLabel'
  | 'settingsTitle'
  | 'shortcutHint'
  | 'settingsLegendAppearance'
  | 'settingsLabelTheme'
  | 'themeOptionPaper'
  | 'themeOptionDark'
  | 'settingsLegendDiagnostics'
  | 'settingsDebugLabel'
  | 'settingsLocalModeNote'
  | 'settingsBtnHistory'
  | 'settingsLabelCards'
  | 'settingsLabelUiLanguage'
  | 'uiLanguageOptionAuto'
  | 'uiLanguageOptionEn'
  | 'uiLanguageOptionZhCn'
  | 'settingsLabelSummaryLanguage'
  | 'summaryLanguageOptionZhCn'
  | 'summaryLanguageOptionEn'
  | 'settingsLabelDensity'
  | 'densityOptionConcise'
  | 'densityOptionNormal'
  | 'densityOptionDetailed'
  | 'settingsLabelMaxDoc'
  | 'settingsLabelCacheTtl'
  | 'btnSettingsSave'
  | 'cacheControlsTitle'
  | 'btnCacheClearCurrent'
  | 'btnCacheClearAllPages'
  | 'cacheConfirmText'
  | 'cacheConfirmAllText'
  | 'cacheConfirmYes'
  | 'cacheConfirmNo'
  | 'staleCacheText'
  | 'btnStaleCacheRerun'
  | 'diagSummary'
  | 'statRawLen'
  | 'statReadLen'
  | 'statRawMatch'
  | 'statReadMatch'
  | 'statDomLocate'
  | 'historyAriaLabel'
  | 'historyHeading'
  | 'btnCloseHistoryAriaLabel'
  | 'btnCloseHistoryTitle'
  | 'btnHistoryExportAllJson'
  | 'cardMenuAriaLabel'
  | 'eyebrowNowReading'
  | 'eyebrowLibrary'
  | 'metaLabelPage'
  | 'metaLabelText'
  | 'metaLabelSource'
  | 'historyEmptyMessage'
  | 'clipboardQuoteLine';

/**
 * Walk the DOM and replace `data-i18n="key"` text nodes and
 * `data-i18n-attr="attr1:key1;attr2:key2"` attributes with localized
 * strings. Call once after DOMContentLoaded.
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

function applySubstitutions(template: string, substitutions: string | readonly string[] | undefined): string {
  if (substitutions === undefined) return template;
  const arr = Array.isArray(substitutions) ? substitutions : [substitutions];
  let out = template;
  for (let i = 0; i < arr.length; i++) {
    out = out.split('$' + (i + 1)).join(String(arr[i]));
  }
  return out;
}

function lookupBundled(key: LocaleKey, locale: 'en' | 'zh_CN'): string | undefined {
  const entry = BUNDLES[locale][key];
  return entry?.message;
}

export function t(key: LocaleKey, substitutions?: string | readonly string[]): string {
  // Explicit user override: bypass chrome.i18n entirely so the side panel
  // can render in a locale that differs from Chrome's UI language.
  if (localeOverride !== 'auto') {
    const template = lookupBundled(key, localeOverride);
    if (template !== undefined) return applySubstitutions(template, substitutions);
  }

  if (typeof chrome === 'undefined' || !chrome.i18n?.getMessage) {
    return key;
  }
  const subs = substitutions === undefined
    ? undefined
    : Array.isArray(substitutions)
      ? [...substitutions]
      : substitutions;
  return chrome.i18n.getMessage(key, subs as string | string[] | undefined) || key;
}
