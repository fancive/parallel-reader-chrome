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
  | 'metaUsedRaw';

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
