import {
  ANALYSIS_DONE_MSG,
  AnalysisDoneSchema,
  clearInflight,
  getInflight,
  type InflightEntry,
  inflightStorageKey,
} from './shared/analyze-inflight';
import {
  assessExtractionQuality,
  type ExtractedTextVersion,
  selectExtractedTextVersion,
} from './shared/extraction-quality';
import { computeContentFingerprint } from './shared/fingerprint';
import { applyI18n, setLocaleOverride, t } from './shared/i18n';
import { contentScriptInjectionHint } from './shared/page-support';
import {
  type AnalyzeResponse,
  type Card,
  type ExtractResponse,
  type LocateResponse,
  PENDING_ANALYZE_KEY,
  PENDING_ANALYZE_MSG,
  PENDING_ANALYZE_TTL_MS,
  type PendingAnalyzeAck,
  type PendingAnalyzeRequest,
  PendingAnalyzeRequestSchema,
  type ProviderSettings,
} from './shared/types';
import { renderCard, setActiveCard } from './sidepanel/card-view';
import { debounce, runWithConcurrency } from './sidepanel/concurrency';
import { $, errorMessage } from './sidepanel/dom';
import {
  clearAllHistory,
  deleteHistoryEntry,
  entriesToJson,
  entryToMarkdown,
  type HistoryEntry,
  listHistoryEntries,
  sanitizeFilename,
} from './sidepanel/history';
import { renderHistoryList, triggerDownload } from './sidepanel/history-view';
import { selectIdleStatus } from './sidepanel/idle-status';
import { closeCardMenu, showCardMenu } from './sidepanel/menu';
import {
  buildPageState,
  type CardResult,
  clearAllPageStates,
  clearPageState,
  loadPageState as loadStoredPageState,
  type PageMeta,
  type PageState,
  pageStateStorageKey,
  savePageState as saveStoredPageState,
} from './sidepanel/page-cache';
import { type PageIdentity, pageIdentityFromTab } from './sidepanel/page-identity';
import {
  bindSettingsForm,
  loadSettings,
  saveSettings,
} from './sidepanel/settings-form';

const DEBUG_MODE_KEY = 'parallel-reader-debug-mode';
const THEME_KEY = 'parallel-reader-theme';
const THEMES = ['paper', 'dark', 'cloud'] as const;
type Theme = (typeof THEMES)[number];
const PENDING_NONCE_CAP = 64;
const seenNonces = new Map<string, number>();
const runningPageKeys = new Set<string>();

function boundTabId(): number | null {
  const raw = new URLSearchParams(window.location.search).get('tabId');
  if (!raw) return null;
  const tabId = Number(raw);
  return Number.isInteger(tabId) && tabId >= 0 ? tabId : null;
}

const panelTabId = boundTabId();

async function sendToTab<T>(tabId: number, message: unknown, pageUrl?: string): Promise<T> {
  try {
    return (await chrome.tabs.sendMessage(tabId, message)) as T;
  } catch (error) {
    if (!isMissingContentScriptError(error)) throw error;
    await injectContentScript(tabId, pageUrl);
    return (await chrome.tabs.sendMessage(tabId, message)) as T;
  }
}

function isMissingContentScriptError(error: unknown): boolean {
  const message = errorMessage(error);
  return (
    message.includes('Receiving end does not exist') ||
    message.includes('Could not establish connection')
  );
}

async function injectContentScript(tabId: number, pageUrl = ''): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
  } catch (error) {
    const message = errorMessage(error);
    const hint = pageUrl ? contentScriptInjectionHint(pageUrl) : '';
    throw new Error(
      t('pageNotReadable', {
        hint: hint || t('hintRefreshOrSwitch'),
        detail: message ? ` (${message})` : '',
      }),
    );
  }
}

async function loadDebugMode(): Promise<boolean> {
  const stored = await chrome.storage.local.get(DEBUG_MODE_KEY);
  return Boolean((stored as Record<string, unknown>)[DEBUG_MODE_KEY]);
}

async function saveDebugMode(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [DEBUG_MODE_KEY]: enabled });
}

function applyDebugMode(enabled: boolean): void {
  document.body.classList.toggle('debug-mode', enabled);
  $<HTMLInputElement>('debug-mode').checked = enabled;
  const stats = $<HTMLDetailsElement>('stats');
  if (enabled && !stats.hidden) stats.open = true;
}

async function loadTheme(): Promise<Theme> {
  const stored = await chrome.storage.local.get(THEME_KEY);
  const value = (stored as Record<string, unknown>)[THEME_KEY];
  return THEMES.includes(value as Theme) ? (value as Theme) : 'paper';
}

async function saveTheme(theme: Theme): Promise<void> {
  await chrome.storage.local.set({ [THEME_KEY]: theme });
}

function applyTheme(theme: Theme): void {
  document.body.dataset.theme = theme;
  $<HTMLSelectElement>('theme-select').value = theme;
}

function bindTheme(initial: Theme): void {
  applyTheme(initial);
  $<HTMLSelectElement>('theme-select').addEventListener('change', async (event) => {
    const value = (event.currentTarget as HTMLSelectElement).value;
    const next: Theme = THEMES.includes(value as Theme) ? (value as Theme) : 'paper';
    applyTheme(next);
    await saveTheme(next);
  });
}

function bindDebugMode(initial: boolean): void {
  applyDebugMode(initial);
  $<HTMLInputElement>('debug-mode').addEventListener('change', async (event) => {
    const enabled = (event.currentTarget as HTMLInputElement).checked;
    applyDebugMode(enabled);
    await saveDebugMode(enabled);
  });
}

function setStatus(text: string): void {
  $('status').textContent = text;
}

function showSettings(): void {
  $('settings').hidden = false;
}

let historyOpen = false;

function hideMainView(): void {
  $('action').hidden = true;
  $('cards').hidden = true;
  $('meta').hidden = true;
  $('stats').hidden = true;
  $('analyze-hero').hidden = true;
  $('settings').hidden = true;
}

function showMainView(): void {
  $('action').hidden = false;
  $('cards').hidden = false;
}

async function openHistoryView(): Promise<void> {
  historyOpen = true;
  hideMainView();
  $('history').hidden = false;
  await refreshHistoryList();
}

function closeHistoryView(): void {
  historyOpen = false;
  $('history').hidden = true;
  showMainView();
  updateAnalyzeButton();
  void refreshCurrentPage();
}

async function refreshHistoryList(): Promise<void> {
  const entries = await listHistoryEntries(chrome.storage.local);
  const list = $('history-list');
  const empty = $('history-empty');
  renderHistoryList(list, empty, entries, {
    onOpen: handleHistoryOpen,
    onDelete: handleHistoryDelete,
    onExport: handleHistoryExport,
  });
}

async function handleHistoryOpen(entry: Readonly<HistoryEntry>): Promise<void> {
  try {
    const targetTabId = panelTabId ?? currentPage?.tabId;
    if (typeof targetTabId === 'number') {
      await chrome.tabs.update(targetTabId, { url: entry.url, active: true });
    } else {
      await chrome.tabs.update({ url: entry.url });
    }
    closeHistoryView();
  } catch (error) {
    setStatus(t('errorCannotOpenPage', { error: errorMessage(error) }));
  }
}

async function handleHistoryDelete(entry: Readonly<HistoryEntry>): Promise<void> {
  await deleteHistoryEntry(chrome.storage.local, entry.storageKey);
  setStatus(t('historyDeleted', { name: entry.title || entry.url }));
  await refreshHistoryList();
  if (currentPage && currentPage.url === entry.url) {
    setCurrentHasSavedResults(false);
  }
}

function handleHistoryExport(entry: Readonly<HistoryEntry>): void {
  const filename = `${sanitizeFilename(entry.title || entry.url)}.md`;
  triggerDownload(filename, entryToMarkdown(entry), 'text/markdown;charset=utf-8');
  setStatus(t('historyExportedSingle', { name: filename }));
}

async function handleExportAll(): Promise<void> {
  const entries = await listHistoryEntries(chrome.storage.local);
  if (entries.length === 0) {
    setStatus(t('historyEmptyExport'));
    return;
  }
  const filename = `parallel-reader-history-${new Date().toISOString().slice(0, 10)}.json`;
  triggerDownload(filename, entriesToJson(entries), 'application/json;charset=utf-8');
  setStatus(t('historyExportedAll', { count: entries.length }));
}

async function handleClearAll(): Promise<void> {
  await clearAllHistory(chrome.storage.local);
  setStatus(t('historyCleared'));
  await refreshHistoryList();
  setCurrentHasSavedResults(false);
}

function bindHistoryView(): void {
  $('history-open').addEventListener('click', () => {
    void openHistoryView();
  });
  $('history-close').addEventListener('click', () => {
    closeHistoryView();
  });
  $('history-export-all').addEventListener('click', () => {
    void handleExportAll();
  });
  const clearBtn = $<HTMLButtonElement>('history-clear-all');
  clearBtn.dataset.state = 'idle';
  clearBtn.addEventListener('click', () => {
    if (clearBtn.dataset.state === 'confirm') {
      clearBtn.dataset.state = 'idle';
      clearBtn.textContent = t('btnClearAll');
      void handleClearAll();
      return;
    }
    clearBtn.dataset.state = 'confirm';
    clearBtn.textContent = t('btnClearAllConfirm');
    setTimeout(() => {
      if (clearBtn.dataset.state === 'confirm') {
        clearBtn.dataset.state = 'idle';
        clearBtn.textContent = t('btnClearAll');
      }
    }, 3000);
  });
}

function providerReady(settings: Readonly<ProviderSettings>): boolean {
  return Boolean(settings.apiKey.trim() && settings.baseUrl.trim() && settings.model.trim());
}

async function ensureProviderReady(): Promise<boolean> {
  const settings = await loadSettings();
  if (providerReady(settings)) return true;
  showSettings();
  setStatus(t('errorMissingProviderSettings'));
  return false;
}

function fmtPct(hits: number, total: number): string {
  if (total === 0) return '—';
  return `${hits}/${total} (${Math.round((hits / total) * 100)}%)`;
}



const pageStateStorage: chrome.storage.StorageArea = chrome.storage.local;
const pendingAnalyzeStorage: chrome.storage.StorageArea = chrome.storage.session ?? chrome.storage.local;
const legacyPageStateStorage: chrome.storage.StorageArea = chrome.storage.session ?? chrome.storage.local;
const inflightStorage: chrome.storage.StorageArea = chrome.storage.session ?? chrome.storage.local;


let currentPage: PageIdentity | null = null;
let currentHasSavedResults = false;
let renderVersion = 0;
let refreshVersion = 0;

async function activePage(): Promise<PageIdentity> {
  if (panelTabId !== null) {
    const tab = await chrome.tabs.get(panelTabId);
    return pageIdentityFromTab(tab);
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error(t('errorNoActiveTab'));
  return pageIdentityFromTab(tab);
}

async function pageFromForcedRequest(
  forced: PendingAnalyzeRequest,
): Promise<PageIdentity | { mismatch: true }> {
  const tab = await chrome.tabs.get(forced.tabId).catch(() => null);
  if (!tab || tab.url !== forced.url) return { mismatch: true };
  return pageIdentityFromTab(tab);
}

async function loadPageState(page: Readonly<PageIdentity>): Promise<PageState | null> {
  const settings = await loadSettings();
  const result = await loadStoredPageState(pageStateStorage, legacyPageStateStorage, page, {
    ttlDays: settings.cacheTtlDays,
    now: Date.now(),
  });
  return result.status === 'hit' ? result.state : null;
}

async function savePageState(state: PageState): Promise<void> {
  await saveStoredPageState(pageStateStorage, state);
}

function clearRenderedPage(): void {
  $('cards').textContent = '';
  $('meta').hidden = true;
  $('meta-quality').hidden = true;
  $('stats').hidden = true;
  setCurrentHasSavedResults(false);
}

function pageMetaFromExtracted(extracted: Readonly<ExtractResponse>): PageMeta {
  return {
    title: extracted.title,
    url: extracted.url,
    rawTextLength: extracted.rawText.length,
    readabilityTextLength: extracted.readabilityText.length,
  };
}

function updateAnalyzeButton(): void {
  if (historyOpen) return;
  const button = $<HTMLButtonElement>('analyze');
  const hero = $<HTMLButtonElement>('analyze-hero');
  const heroLabel = hero.querySelector<HTMLElement>('.hero-action-label');
  const analyzeBusy = currentPage ? runningPageKeys.has(currentPage.key) : false;
  button.disabled = analyzeBusy;
  hero.disabled = analyzeBusy;
  button.textContent = analyzeBusy
    ? currentHasSavedResults
      ? t('statusReanalyzing')
      : t('statusAnalyzing')
    : currentHasSavedResults
      ? t('btnReanalyze')
      : t('btnAnalyze');
  button.title =
    currentHasSavedResults && !analyzeBusy ? t('btnReanalyzeTitle') : '';
  if (heroLabel) heroLabel.textContent = analyzeBusy ? t('statusAnalyzing') : t('btnAnalyze');
  const showHero = !currentHasSavedResults;
  hero.hidden = !showHero;
  button.hidden = showHero;
}

function setCurrentHasSavedResults(hasSavedResults: boolean): void {
  currentHasSavedResults = hasSavedResults;
  updateAnalyzeButton();
}

function setPageBusy(pageKey: string, busy: boolean): void {
  if (busy) runningPageKeys.add(pageKey);
  else runningPageKeys.delete(pageKey);
  if (currentPage?.key === pageKey) updateAnalyzeButton();
}

function invalidatePendingRender(): void {
  renderVersion++;
}

function canRenderAnalysis(version: number, page: Readonly<PageIdentity>): boolean {
  return version === renderVersion && currentPage?.key === page.key;
}

async function highlightCardAnchor(
  anchor: string,
  index: number,
  canHighlight: boolean,
): Promise<void> {
  closeCardMenu();
  if (!canHighlight) {
    setStatus(t('cardNotFoundInPage', { index: index + 1 }));
    return;
  }
  const page = await activePage();
  if (currentPage?.key !== page.key) {
    await refreshCurrentPage();
    setStatus(t('statusPageSwitched'));
    return;
  }
  const r = (await sendToTab(page.tabId, { type: 'highlight', anchor }, page.url)) as {
    ok?: boolean;
  };
  if (r?.ok) {
    setActiveCard(index);
    setStatus(t('cardHighlighted', { index: index + 1 }));
  } else {
    setStatus(t('cardLocateFailed', { index: index + 1 }));
  }
}


function makeCardDeps() {
  return {
    highlightCardAnchor,
    showCardMenu: (
      result: Readonly<CardResult>,
      index: number,
      clientX: number,
      clientY: number,
    ) => showCardMenu(result, index, clientX, clientY, { highlightCardAnchor, setStatus }),
  };
}

function renderMeta(meta: Readonly<PageMeta>, used: ExtractedTextVersion): void {
  const quality = assessExtractionQuality({
    rawTextLength: meta.rawTextLength,
    readabilityTextLength: meta.readabilityTextLength,
    usedText: used,
  });
  const qualityEl = $('meta-quality');

  $('meta').hidden = false;
  $('meta-title').textContent = meta.title;
  $('meta-url').textContent = meta.url;
  $('meta-raw-len').textContent = t('metaCharsCount', { count: meta.rawTextLength });
  $('meta-read-len').textContent = t('metaCharsCount', { count: meta.readabilityTextLength });
  $('meta-used').textContent = used === 'readability' ? t('metaUsedReadability') : t('metaUsedRaw');
  $('meta-selected-len').textContent = t('metaCharsCount', { count: quality.selectedTextLength });
  if (quality.level === 'warn') {
    qualityEl.hidden = false;
    qualityEl.className = `meta-quality ${quality.level}`;
    qualityEl.textContent = `${quality.label}: ${quality.detail}`;
  } else {
    qualityEl.hidden = true;
    qualityEl.textContent = '';
  }
}

function renderStats(results: readonly CardResult[]): void {
  const total = results.length;
  const raw = results.filter((r) => r.locate.rawHit).length;
  const read = results.filter((r) => r.locate.readabilityHit).length;
  const dom = results.filter((r) => r.locate.domRange).length;
  const stats = $<HTMLDetailsElement>('stats');
  stats.hidden = false;
  if (document.body.classList.contains('debug-mode')) stats.open = true;
  $('stat-raw').textContent = fmtPct(raw, total);
  $('stat-read').textContent = fmtPct(read, total);
  $('stat-dom').textContent = fmtPct(dom, total);
}

function countDomHits(results: readonly CardResult[]): number {
  return results.filter((r) => r.locate.domRange).length;
}

function renderPageState(state: PageState): void {
  renderMeta(state.meta, state.usedText);
  const container = $('cards');
  container.textContent = '';
  const cardDeps = makeCardDeps();
  state.results.forEach((r, i) => {
    container.appendChild(renderCard(r, i, cardDeps));
  });
  renderStats(state.results);
  setCurrentHasSavedResults(true);
  const analyzedAt = new Date(state.analyzedAt).toLocaleTimeString();
  setStatus(
    t('statusRestoredSummary', {
      cardCount: state.results.length,
      domHits: countDomHits(state.results),
      analyzedAt,
    }),
  );
}

function renderCompletedPageState(state: PageState): void {
  renderPageState(state);
  setStatus(
    t('statusCompleteSummary', {
      cardCount: state.results.length,
      domHits: countDomHits(state.results),
    }),
  );
}

function fingerprintSourceText(extracted: Readonly<ExtractResponse>): string {
  return extracted.readabilityText.trim().length > 0 ? extracted.readabilityText : extracted.rawText;
}

async function liveFingerprint(page: Readonly<PageIdentity>): Promise<string | null> {
  try {
    const extracted = (await sendToTab(page.tabId, { type: 'extract' }, page.url)) as ExtractResponse;
    return await computeContentFingerprint(fingerprintSourceText(extracted));
  } catch {
    return null;
  }
}

function showStaleCacheBanner(): void {
  $('stale-cache-banner').hidden = false;
}

function hideStaleCacheBanner(): void {
  $('stale-cache-banner').hidden = true;
}

async function refreshCurrentPage(): Promise<void> {
  if (historyOpen) return;
  const version = ++refreshVersion;
  try {
    const page = await activePage();
    currentPage = page;
    hideStaleCacheBanner();
    const cached = await loadPageState(page);
    if (version !== refreshVersion) return;
    if (cached) {
      const live = cached.fingerprint ? await liveFingerprint(page) : null;
      if (version !== refreshVersion) return;
      if (live && live !== cached.fingerprint) {
        clearRenderedPage();
        showStaleCacheBanner();
        setStatus(
          page.title
            ? t('statusPageContentChangedTitled', { title: page.title })
            : t('statusPageContentChanged'),
        );
        return;
      }
      renderPageState(cached);
      return;
    }
    clearRenderedPage();
    const inflight = await getInflight(inflightStorage, page.key);
    if (version !== refreshVersion) return;
    if (inflight?.phase === 'locating' && !runningPageKeys.has(page.key)) {
      // Background completed LLM call but sidepanel was unloaded mid-analyze.
      // Claim the slot synchronously here so a concurrent refresh cannot also
      // enter resumeFromInflight; resumeFromInflight itself will not re-add.
      setPageBusy(page.key, true);
      void resumeFromInflight(page, inflight);
    }
    const idle = selectIdleStatus({
      inflight,
      runningLocally: runningPageKeys.has(page.key),
      title: page.title,
    });
    setStatus(idle.title ? t(idle.messageKey, { title: idle.title }) : t(idle.messageKey));
  } catch (error: unknown) {
    if (version !== refreshVersion) return;
    currentPage = null;
    clearRenderedPage();
    const msg = error instanceof Error ? error.message : 'unknown error';
    setStatus(t('errorPrefix', { error: msg }));
  }
}

const LOCATE_CONCURRENCY = 4;

function isLocateResponse(value: unknown): value is LocateResponse {
  if (typeof value !== 'object' || value === null) return false;
  const locate = value as Partial<LocateResponse>;
  return (
    typeof locate.rawHit === 'boolean' &&
    typeof locate.readabilityHit === 'boolean' &&
    typeof locate.domRange === 'boolean' &&
    typeof locate.rawIndex === 'number' &&
    typeof locate.readabilityIndex === 'number'
  );
}

function invalidLocateMessage(value: unknown): string {
  if (typeof value === 'object' && value !== null && 'error' in value) {
    return errorMessage((value as { error?: unknown }).error);
  }
  return 'content script returned an invalid locate response';
}

async function locateAll(
  page: Readonly<PageIdentity>,
  cards: readonly Card[],
): Promise<readonly CardResult[]> {
  const settled = await runWithConcurrency(cards, LOCATE_CONCURRENCY, async (card) => {
    const locate = await sendToTab<unknown>(page.tabId, {
      type: 'locate',
      anchor: card.anchor,
    }, page.url);
    if (!isLocateResponse(locate)) {
      throw new Error(invalidLocateMessage(locate));
    }
    return { card, locate };
  });

  const results: CardResult[] = [];
  for (const [index, result] of settled.entries()) {
    if (result.status === 'rejected') {
      throw new Error(
        t('cardLocateError', { index: index + 1, error: errorMessage(result.reason) }),
      );
    }
    results.push(result.value);
  }
  return results;
}

async function resolveAnalysisPage(
  forced?: PendingAnalyzeRequest,
): Promise<PageIdentity | null> {
  if (!forced) return await activePage();
  const result = await pageFromForcedRequest(forced);
  if ('mismatch' in result) {
    setStatus(t('statusPageChangedCancel'));
    return null;
  }
  return result;
}

function noteNonce(nonce: string, ts: number): boolean {
  pruneNonces();
  if (seenNonces.has(nonce)) return false;
  if (seenNonces.size >= PENDING_NONCE_CAP) {
    const first = seenNonces.keys().next().value;
    if (first !== undefined) seenNonces.delete(first);
  }
  seenNonces.set(nonce, ts);
  return true;
}

function pruneNonces(): void {
  const cutoff = Date.now() - PENDING_ANALYZE_TTL_MS;
  for (const [nonce, ts] of seenNonces) {
    if (ts < cutoff) seenNonces.delete(nonce);
  }
}

async function runAnalysis(forced?: PendingAnalyzeRequest): Promise<void> {
  if (forced && !noteNonce(forced.nonce, forced.ts)) return;
  const version = ++renderVersion;
  let page: PageIdentity | null = null;
  let savedPageState = false;

  try {
    if (!(await ensureProviderReady())) return;

    const resolved = await resolveAnalysisPage(forced);
    if (!resolved) return;
    page = resolved;
    currentPage = page;
    const replacingExistingResults = Boolean(await loadPageState(page));
    setPageBusy(page.key, true);
    if (!replacingExistingResults) clearRenderedPage();

    if (canRenderAnalysis(version, page)) {
      hideStaleCacheBanner();
      setStatus(replacingExistingResults ? t('statusReorganizing') : t('statusOrganizing'));
    }
    const extracted = (await sendToTab(page.tabId, { type: 'extract' }, page.url)) as ExtractResponse;
    const meta = pageMetaFromExtracted(extracted);
    const fingerprint = await computeContentFingerprint(fingerprintSourceText(extracted));
    if (canRenderAnalysis(version, page)) {
      renderMeta(meta, selectExtractedTextVersion(meta.readabilityTextLength));
      setStatus(t('statusReadingThisPage'));
    }

    const resp = (await chrome.runtime.sendMessage({
      type: 'analyze',
      rawText: extracted.rawText,
      readabilityText: extracted.readabilityText,
      pageKey: page.key,
      tabId: page.tabId,
      title: extracted.title,
      url: extracted.url,
    })) as AnalyzeResponse;

    if (!resp.ok) {
      if (canRenderAnalysis(version, page)) setStatus(t('errorPrefix', { error: resp.error }));
      return;
    }

    if (canRenderAnalysis(version, page)) {
      renderMeta(meta, resp.usedText);
      setStatus(t('statusFoundLocating', { count: resp.cards.length }));
    }

    const results = await locateAll(page, resp.cards);
    const state: PageState = buildPageState({
      page,
      meta,
      usedText: resp.usedText,
      results,
      fingerprint,
      now: Date.now(),
    });
    await savePageState(state);
    savedPageState = true;
    if (canRenderAnalysis(version, page)) {
      renderCompletedPageState(state);
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'unknown error';
    if (!page || canRenderAnalysis(version, page)) setStatus(t('errorPrefix', { error: msg }));
  } finally {
    if (page) {
      setPageBusy(page.key, false);
      // Only clear inflight when this run actually produced a saved PageState.
      // On error we leave the marker so background's own completion (or a
      // future resumeFromInflight) can still drive the recovery path.
      if (savedPageState) await clearInflight(inflightStorage, page.key);
    }
  }
}

async function resumeFromInflight(
  page: Readonly<PageIdentity>,
  inflight: Readonly<InflightEntry>,
): Promise<void> {
  // Caller in refreshCurrentPage already claimed the busy slot synchronously.
  if (inflight.phase !== 'locating') {
    setPageBusy(page.key, false);
    return;
  }
  const version = ++renderVersion;
  let savedPageState = false;
  try {
    if (canRenderAnalysis(version, page)) {
      renderMeta(inflight.meta, inflight.usedText);
      setStatus(t('statusFoundLocating', { count: inflight.cards.length }));
    }
    const results = await locateAll(page, inflight.cards);
    // Fingerprint left empty: content script may not be reachable here and the
    // empty sentinel suppresses the mismatch check until the next full analyze.
    const state: PageState = buildPageState({
      page,
      meta: inflight.meta,
      usedText: inflight.usedText,
      results,
      fingerprint: '',
      now: Date.now(),
    });
    await savePageState(state);
    savedPageState = true;
    if (canRenderAnalysis(version, page)) {
      renderCompletedPageState(state);
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'unknown error';
    if (canRenderAnalysis(version, page)) setStatus(t('errorPrefix', { error: msg }));
  } finally {
    setPageBusy(page.key, false);
    if (savedPageState) await clearInflight(inflightStorage, page.key);
  }
}

function applyZoom(factor: number): void {
  const safe = Number.isFinite(factor) && factor > 0 ? factor : 1;
  document.body.style.setProperty('--page-zoom', String(safe));
}

async function syncZoomFromActiveTab(): Promise<void> {
  try {
    const page = await activePage();
    const factor = await chrome.tabs.getZoom(page.tabId);
    applyZoom(factor);
  } catch {
    // tab may not be queryable (restricted page); leave zoom at default
  }
}

async function consumePendingAnalyze(): Promise<PendingAnalyzeRequest | null> {
  const stored = await pendingAnalyzeStorage.get(PENDING_ANALYZE_KEY);
  const raw = (stored as Record<string, unknown>)[PENDING_ANALYZE_KEY];
  if (raw === undefined) return null;
  const parsed = PendingAnalyzeRequestSchema.safeParse(raw);
  if (!parsed.success) return null;
  if (panelTabId !== null && parsed.data.tabId !== panelTabId) return null;
  await pendingAnalyzeStorage.remove(PENDING_ANALYZE_KEY);
  if (Date.now() - parsed.data.ts > PENDING_ANALYZE_TTL_MS) return null;
  return parsed.data;
}

async function init(): Promise<void> {
  const [settings, debugMode, theme] = await Promise.all([
    loadSettings(),
    loadDebugMode(),
    loadTheme(),
  ]);
  setLocaleOverride(settings.uiLanguage);
  applyI18n();
  bindSettingsForm(settings, {
    setStatus,
    saveSettings,
    clearCurrentPage: async () => {
      if (!currentPage) return false;
      await clearPageState(pageStateStorage, currentPage.key);
      hideStaleCacheBanner();
      clearRenderedPage();
      setStatus(t('statusCacheClearedCurrent'));
      return true;
    },
    clearAllPages: async () => {
      const removed = await clearAllPageStates(pageStateStorage);
      hideStaleCacheBanner();
      clearRenderedPage();
      setStatus(t('statusCacheClearedAll', { count: removed }));
      return removed;
    },
  });
  bindTheme(theme);
  bindDebugMode(debugMode);
  bindHistoryView();
  updateAnalyzeButton();
  void syncZoomFromActiveTab();

  const debouncedRefresh = debounce(() => void refreshCurrentPage(), 120);

  $('analyze').addEventListener('click', () => {
    void runAnalysis();
  });
  $('analyze-hero').addEventListener('click', () => {
    void runAnalysis();
  });
  $('stale-cache-rerun').addEventListener('click', () => {
    hideStaleCacheBanner();
    void runAnalysis();
  });
  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (typeof message !== 'object' || message === null) return false;
    const m = message as { type?: unknown; zoomFactor?: unknown; request?: unknown };
    if (m.type === 'zoom-change' && typeof m.zoomFactor === 'number') {
      applyZoom(m.zoomFactor);
      return false;
    }
    if (m.type === PENDING_ANALYZE_MSG) {
      const parsed = PendingAnalyzeRequestSchema.safeParse(m.request);
      if (!parsed.success) {
        sendResponse({ ok: false, error: parsed.error.message } satisfies PendingAnalyzeAck);
        return false;
      }
      if (panelTabId !== null && parsed.data.tabId !== panelTabId) return false;
      sendResponse({ ok: true } satisfies PendingAnalyzeAck);
      void runAnalysis(parsed.data);
      return false;
    }
    if (m.type === ANALYSIS_DONE_MSG) {
      const parsed = AnalysisDoneSchema.safeParse(m);
      if (!parsed.success) return false;
      if (panelTabId !== null && parsed.data.tabId !== panelTabId) return false;
      if (currentPage && currentPage.key !== parsed.data.pageKey) return false;
      debouncedRefresh();
      return false;
    }
    return false;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session' && area !== 'local') return;
    if (PENDING_ANALYZE_KEY in changes && changes[PENDING_ANALYZE_KEY]?.newValue !== undefined) {
      void consumePendingAnalyze().then((req) => {
        if (req) void runAnalysis(req);
      });
    }
    if (currentPage) {
      const pageStateKey = pageStateStorageKey(currentPage.key);
      const inflightKey = inflightStorageKey(currentPage.key);
      if (pageStateKey in changes || inflightKey in changes) {
        debouncedRefresh();
      }
    }
  });
  chrome.tabs.onActivated.addListener(() => {
    if (panelTabId !== null) return;
    debouncedRefresh();
    void syncZoomFromActiveTab();
  });
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    const trackedTabId = currentPage?.tabId ?? panelTabId;
    if (trackedTabId !== tabId) return;
    if (changeInfo.url || changeInfo.status === 'loading' || changeInfo.status === 'complete') {
      invalidatePendingRender();
    }
    if (changeInfo.url || changeInfo.status === 'complete') {
      debouncedRefresh();
    }
    if (changeInfo.status === 'loading') {
      clearRenderedPage();
      setStatus(t('statusPageLoading'));
    }
  });
  chrome.windows.onFocusChanged.addListener(() => {
    debouncedRefresh();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) debouncedRefresh();
  });
  document.addEventListener('click', (event) => {
    if ($('card-menu').contains(event.target as Node)) return;
    closeCardMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeCardMenu();
  });
  await refreshCurrentPage();
  const pending = await consumePendingAnalyze();
  if (pending) void runAnalysis(pending);
}

void init();
