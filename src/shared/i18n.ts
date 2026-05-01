// Typed wrapper around chrome.i18n.getMessage. The key union is hand-
// maintained against _locales/en/messages.json (the source of truth).

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
  | 'cardMenuAriaLabel';

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

export function t(key: LocaleKey, substitutions?: string | readonly string[]): string {
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
