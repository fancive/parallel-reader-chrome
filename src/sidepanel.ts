import {
  assessExtractionQuality,
  type ExtractedTextVersion,
  selectExtractedTextVersion,
} from './shared/extraction-quality';
import { contentScriptInjectionHint, unsupportedPageReason } from './shared/page-support';
import {
  type AnalyzeResponse,
  type Card,
  type ExtractResponse,
  type LocateResponse,
  PAGE_STATE_PREFIX,
  type ProviderSettings,
} from './shared/types';
import { renderCard, setActiveCard } from './sidepanel/card-view';
import { debounce, runWithConcurrency } from './sidepanel/concurrency';
import { $, errorMessage } from './sidepanel/dom';
import { closeCardMenu, showCardMenu } from './sidepanel/menu';
import { bindSettingsForm, loadSettings, saveSettings } from './sidepanel/settings-form';

const DEBUG_MODE_KEY = 'parallel-reader-debug-mode';
const THEME_KEY = 'parallel-reader-theme';
const THEMES = ['paper', 'dark', 'cloud'] as const;
type Theme = (typeof THEMES)[number];
const PENDING_ANALYZE_KEY = 'parallel-reader-pending-analyze';
const PENDING_ANALYZE_TTL_MS = 5_000;

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

type PageIdentity = {
  tabId: number;
  url: string;
  title: string;
  key: string;
};

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

const pageStorage: chrome.storage.StorageArea = chrome.storage.session ?? chrome.storage.local;

let currentPage: PageIdentity | null = null;
let currentHasSavedResults = false;
let analyzeBusy = false;
let renderVersion = 0;

function buildPageKey(tabId: number, url: string): string {
  return `${tabId}:${url}`;
}

async function activePage(): Promise<PageIdentity> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error('找不到活动标签页');
  if (!tab.url) throw new Error('当前标签页没有 URL');
  const unsupportedReason = unsupportedPageReason(tab.url);
  if (unsupportedReason) throw new Error(unsupportedReason);
  return {
    tabId: tab.id,
    url: tab.url,
    title: tab.title ?? '',
    key: buildPageKey(tab.id, tab.url),
  };
}

async function loadPageState(pageKey: string): Promise<PageState | null> {
  const storageKey = `${PAGE_STATE_PREFIX}${pageKey}`;
  const stored = await pageStorage.get(storageKey);
  return ((stored as Record<string, unknown>)[storageKey] as PageState | undefined) ?? null;
}

async function savePageState(state: PageState): Promise<void> {
  await pageStorage.set({ [`${PAGE_STATE_PREFIX}${state.page.key}`]: state });
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
  const button = $<HTMLButtonElement>('analyze');
  const hero = $<HTMLButtonElement>('analyze-hero');
  const heroLabel = hero.querySelector<HTMLElement>('.hero-action-label');
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

function setAnalyzeBusy(busy: boolean): void {
  analyzeBusy = busy;
  updateAnalyzeButton();
}

function invalidatePendingRender(): void {
  renderVersion++;
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

async function refreshCurrentPage(): Promise<void> {
  const version = ++renderVersion;
  try {
    const page = await activePage();
    currentPage = page;
    const cached = await loadPageState(page.key);
    if (version !== renderVersion) return;
    if (cached) {
      renderPageState(cached);
      return;
    }
    clearRenderedPage();
    setStatus(page.title ? `当前页未分析：${page.title}` : '当前页未分析');
  } catch (error: unknown) {
    if (version !== renderVersion) return;
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

async function runAnalysis(): Promise<void> {
  const replacingExistingResults = currentHasSavedResults;
  setAnalyzeBusy(true);
  if (!replacingExistingResults) clearRenderedPage();
  const version = ++renderVersion;

  try {
    if (!(await ensureProviderReady())) return;

    setStatus(replacingExistingResults ? '重新抽取页面内容...' : '抽取页面内容...');
    const page = await activePage();
    currentPage = page;
    const extracted = (await sendToTab(page.tabId, { type: 'extract' }, page.url)) as ExtractResponse;
    const meta = pageMetaFromExtracted(extracted);
    renderMeta(meta, selectExtractedTextVersion(meta.readabilityTextLength));

    setStatus('调用 LLM...');
    const resp = (await chrome.runtime.sendMessage({
      type: 'analyze',
      rawText: extracted.rawText,
      readabilityText: extracted.readabilityText,
    })) as AnalyzeResponse;

    if (!resp.ok) {
      setStatus(`错误: ${resp.error}`);
      return;
    }

    renderMeta(meta, resp.usedText);
    setStatus(`生成 ${resp.cards.length} 张卡片，定位中...`);

    const results = await locateAll(page, resp.cards);
    const state: PageState = {
      page,
      meta,
      usedText: resp.usedText,
      results,
      analyzedAt: Date.now(),
    };
    if (version !== renderVersion || currentPage?.key !== page.key) return;
    await savePageState(state);
    if (version === renderVersion && currentPage?.key === page.key) {
      renderPageState(state);
      setStatus(`完成 · ${results.length} 张卡片 · ${countDomHits(results)} 处可定位`);
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'unknown error';
    setStatus(`错误: ${msg}`);
  } finally {
    setAnalyzeBusy(false);
  }
}

function applyZoom(factor: number): void {
  const safe = Number.isFinite(factor) && factor > 0 ? factor : 1;
  document.body.style.setProperty('--page-zoom', String(safe));
}

async function syncZoomFromActiveTab(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (typeof tab?.id !== 'number') return;
    const factor = await chrome.tabs.getZoom(tab.id);
    applyZoom(factor);
  } catch {
    // tab may not be queryable (restricted page); leave zoom at default
  }
}

async function consumePendingAnalyze(): Promise<boolean> {
  const stored = await pageStorage.get(PENDING_ANALYZE_KEY);
  const ts = (stored as Record<string, unknown>)[PENDING_ANALYZE_KEY];
  if (typeof ts !== 'number') return false;
  await pageStorage.remove(PENDING_ANALYZE_KEY);
  return Date.now() - ts <= PENDING_ANALYZE_TTL_MS;
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
  updateAnalyzeButton();
  void syncZoomFromActiveTab();

  const debouncedRefresh = debounce(() => void refreshCurrentPage(), 120);

  $('analyze').addEventListener('click', () => {
    void runAnalysis();
  });
  $('analyze-hero').addEventListener('click', () => {
    void runAnalysis();
  });
  chrome.runtime.onMessage.addListener((message: unknown) => {
    if (typeof message !== 'object' || message === null) return false;
    const m = message as { type?: unknown; zoomFactor?: unknown };
    if (m.type === 'zoom-change' && typeof m.zoomFactor === 'number') {
      applyZoom(m.zoomFactor);
    }
    return false;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session' && area !== 'local') return;
    if (PENDING_ANALYZE_KEY in changes && changes[PENDING_ANALYZE_KEY]?.newValue) {
      void consumePendingAnalyze().then((ready) => {
        if (ready) void runAnalysis();
      });
    }
  });
  chrome.tabs.onActivated.addListener(() => {
    debouncedRefresh();
    void syncZoomFromActiveTab();
  });
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (currentPage?.tabId !== tabId) return;
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
  if (await consumePendingAnalyze()) {
    void runAnalysis();
  }
}

void init();
