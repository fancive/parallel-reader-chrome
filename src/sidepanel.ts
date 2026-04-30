import {
  assessExtractionQuality,
  type ExtractedTextVersion,
  selectExtractedTextVersion,
} from './shared/extraction-quality';
import { contentScriptInjectionHint } from './shared/page-support';
import {
  type AnalyzeResponse,
  type Card,
  type ExtractResponse,
  type LocateResponse,
  PAGE_STATE_PREFIX,
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
import { closeCardMenu, showCardMenu } from './sidepanel/menu';
import { type PageIdentity, pageIdentityFromTab } from './sidepanel/page-identity';
import { bindSettingsForm, loadSettings, saveSettings } from './sidepanel/settings-form';

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
      `当前页面暂时无法阅读。${hint || '请刷新页面，或切换到普通网页后再试。'}${message ? ` (${message})` : ''}`,
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
    setStatus(`无法打开页面: ${errorMessage(error)}`);
  }
}

async function handleHistoryDelete(entry: Readonly<HistoryEntry>): Promise<void> {
  await deleteHistoryEntry(chrome.storage.local, entry.storageKey);
  setStatus(`已删除 ${entry.title || entry.url}`);
  await refreshHistoryList();
  if (currentPage && currentPage.url === entry.url) {
    setCurrentHasSavedResults(false);
  }
}

function handleHistoryExport(entry: Readonly<HistoryEntry>): void {
  const filename = `${sanitizeFilename(entry.title || entry.url)}.md`;
  triggerDownload(filename, entryToMarkdown(entry), 'text/markdown;charset=utf-8');
  setStatus(`已导出 ${filename}`);
}

async function handleExportAll(): Promise<void> {
  const entries = await listHistoryEntries(chrome.storage.local);
  if (entries.length === 0) {
    setStatus('暂无历史可导出');
    return;
  }
  const filename = `parallel-reader-history-${new Date().toISOString().slice(0, 10)}.json`;
  triggerDownload(filename, entriesToJson(entries), 'application/json;charset=utf-8');
  setStatus(`已导出 ${entries.length} 条历史`);
}

async function handleClearAll(): Promise<void> {
  await clearAllHistory(chrome.storage.local);
  setStatus('历史已清空');
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
      clearBtn.textContent = '清空全部';
      void handleClearAll();
      return;
    }
    clearBtn.dataset.state = 'confirm';
    clearBtn.textContent = '确认清空';
    setTimeout(() => {
      if (clearBtn.dataset.state === 'confirm') {
        clearBtn.dataset.state = 'idle';
        clearBtn.textContent = '清空全部';
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
  setStatus('请先保存 API Key、Base URL 和 Model 后再分析当前页');
  return false;
}

function fmtPct(hits: number, total: number): string {
  if (total === 0) return '—';
  return `${hits}/${total} (${Math.round((hits / total) * 100)}%)`;
}



type CardResult = { card: Card; locate: LocateResponse };


type PageMeta = {
  title: string;
  url: string;
  rawTextLength: number;
  readabilityTextLength: number;
};

type PageState = {
  page: PageIdentity;
  meta: PageMeta;
  usedText: ExtractedTextVersion;
  results: readonly CardResult[];
  analyzedAt: number;
};

const pageStateStorage: chrome.storage.StorageArea = chrome.storage.local;
const pendingAnalyzeStorage: chrome.storage.StorageArea = chrome.storage.session ?? chrome.storage.local;
const legacyPageStateStorage: chrome.storage.StorageArea = chrome.storage.session ?? chrome.storage.local;

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
  if (!tab) throw new Error('找不到活动标签页');
  return pageIdentityFromTab(tab);
}

async function pageFromForcedRequest(
  forced: PendingAnalyzeRequest,
): Promise<PageIdentity | { mismatch: true }> {
  const tab = await chrome.tabs.get(forced.tabId).catch(() => null);
  if (!tab || tab.url !== forced.url) return { mismatch: true };
  return pageIdentityFromTab(tab);
}

function pageStateStorageKey(pageKey: string): string {
  return `${PAGE_STATE_PREFIX}${pageKey}`;
}

function legacyPageStateStorageKey(tabId: number, url: string): string {
  return `${PAGE_STATE_PREFIX}${tabId}:${url}`;
}

async function loadPageState(page: Readonly<PageIdentity>): Promise<PageState | null> {
  const storageKey = pageStateStorageKey(page.key);
  const stored = await pageStateStorage.get(storageKey);
  const state = (stored as Record<string, unknown>)[storageKey] as PageState | undefined;
  if (state) return state;

  const legacyKey = legacyPageStateStorageKey(page.tabId, page.url);
  const legacyStored = await legacyPageStateStorage.get(legacyKey);
  const legacyState = (legacyStored as Record<string, unknown>)[legacyKey] as PageState | undefined;
  if (!legacyState) return null;

  const migrated = { ...legacyState, page };
  await savePageState(migrated);
  return migrated;
}

async function savePageState(state: PageState): Promise<void> {
  await pageStateStorage.set({ [pageStateStorageKey(state.page.key)]: state });
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
      ? '重新分析中...'
      : '分析中...'
    : currentHasSavedResults
      ? '重新分析当前页'
      : '分析当前页';
  button.title =
    currentHasSavedResults && !analyzeBusy ? '重新抽取当前页并替换已保存结果' : '';
  if (heroLabel) heroLabel.textContent = analyzeBusy ? '分析中...' : '分析当前页';
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
    setStatus(`当前页面中没有定位到 #${index + 1}`);
    return;
  }
  const page = await activePage();
  if (currentPage?.key !== page.key) {
    await refreshCurrentPage();
    setStatus('页面已切换，请在当前页重新选择卡片');
    return;
  }
  const r = (await sendToTab(page.tabId, { type: 'highlight', anchor }, page.url)) as {
    ok?: boolean;
  };
  if (r?.ok) {
    setActiveCard(index);
    setStatus(`已高亮 #${index + 1}`);
  } else {
    setStatus(`定位失败 #${index + 1}`);
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
  $('meta-raw-len').textContent = `${meta.rawTextLength} 字`;
  $('meta-read-len').textContent = `${meta.readabilityTextLength} 字`;
  $('meta-used').textContent = used === 'readability' ? '正文' : '原文';
  $('meta-selected-len').textContent = `${quality.selectedTextLength} 字`;
  qualityEl.hidden = false;
  qualityEl.className = `meta-quality ${quality.level}`;
  qualityEl.textContent = `${quality.label}: ${quality.detail}`;
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
    `已恢复当前页结果 · ${state.results.length} 张卡片 · ${countDomHits(state.results)} 处可定位 · ${analyzedAt}`,
  );
}

function renderCompletedPageState(state: PageState): void {
  renderPageState(state);
  setStatus(`完成 · ${state.results.length} 张卡片 · ${countDomHits(state.results)} 处可定位`);
}

async function refreshCurrentPage(): Promise<void> {
  if (historyOpen) return;
  const version = ++refreshVersion;
  try {
    const page = await activePage();
    currentPage = page;
    const cached = await loadPageState(page);
    if (version !== refreshVersion) return;
    if (cached) {
      renderPageState(cached);
      return;
    }
    clearRenderedPage();
    if (runningPageKeys.has(page.key)) {
      setStatus(page.title ? `分析中：${page.title}` : '分析中...');
      return;
    }
    setStatus(page.title ? `当前页未分析：${page.title}` : '当前页未分析');
  } catch (error: unknown) {
    if (version !== refreshVersion) return;
    currentPage = null;
    clearRenderedPage();
    const msg = error instanceof Error ? error.message : 'unknown error';
    setStatus(`错误: ${msg}`);
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
      throw new Error(`定位第 ${index + 1} 张卡片失败: ${errorMessage(result.reason)}`);
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
    setStatus('页面已变更，已取消分析');
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
      setStatus(replacingExistingResults ? '重新抽取页面内容...' : '抽取页面内容...');
    }
    const extracted = (await sendToTab(page.tabId, { type: 'extract' }, page.url)) as ExtractResponse;
    const meta = pageMetaFromExtracted(extracted);
    if (canRenderAnalysis(version, page)) {
      renderMeta(meta, selectExtractedTextVersion(meta.readabilityTextLength));
      setStatus('调用 LLM...');
    }

    const resp = (await chrome.runtime.sendMessage({
      type: 'analyze',
      rawText: extracted.rawText,
      readabilityText: extracted.readabilityText,
    })) as AnalyzeResponse;

    if (!resp.ok) {
      if (canRenderAnalysis(version, page)) setStatus(`错误: ${resp.error}`);
      return;
    }

    if (canRenderAnalysis(version, page)) {
      renderMeta(meta, resp.usedText);
      setStatus(`生成 ${resp.cards.length} 张卡片，定位中...`);
    }

    const results = await locateAll(page, resp.cards);
    const state: PageState = {
      page,
      meta,
      usedText: resp.usedText,
      results,
      analyzedAt: Date.now(),
    };
    await savePageState(state);
    if (canRenderAnalysis(version, page)) {
      renderCompletedPageState(state);
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'unknown error';
    if (!page || canRenderAnalysis(version, page)) setStatus(`错误: ${msg}`);
  } finally {
    if (page) setPageBusy(page.key, false);
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
  bindSettingsForm(settings, { setStatus, saveSettings });
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
    return false;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session' && area !== 'local') return;
    if (PENDING_ANALYZE_KEY in changes && changes[PENDING_ANALYZE_KEY]?.newValue !== undefined) {
      void consumePendingAnalyze().then((req) => {
        if (req) void runAnalysis(req);
      });
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
      setStatus('页面加载中...');
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
