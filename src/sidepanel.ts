import {
  type AnalyzeResponse,
  type Card,
  type ExtractResponse,
  type LocateResponse,
  ProviderSettingsSchema,
  type ProviderSettings,
  PAGE_STATE_PREFIX,
  SETTINGS_KEY,
} from './shared/types';
import {
  assessExtractionQuality,
  selectExtractedTextVersion,
  type ExtractedTextVersion,
} from './shared/extraction-quality';
import { contentScriptInjectionHint, unsupportedPageReason } from './shared/page-support';

const DEBUG_MODE_KEY = 'parallel-reader-debug-mode';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`element #${id} not found`);
  return el as T;
};

async function sendToTab<T>(tabId: number, message: unknown, pageUrl?: string): Promise<T> {
  try {
    return (await chrome.tabs.sendMessage(tabId, message)) as T;
  } catch (error) {
    if (!isMissingContentScriptError(error)) throw error;
    await injectContentScript(tabId, pageUrl);
    return (await chrome.tabs.sendMessage(tabId, message)) as T;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

async function loadSettings(): Promise<ProviderSettings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const raw = (stored as Record<string, unknown>)[SETTINGS_KEY];
  const parsed = ProviderSettingsSchema.safeParse(raw ?? {});
  if (parsed.success) return parsed.data;
  console.warn('[parallel-reader] invalid stored settings; using defaults', parsed.error);
  return ProviderSettingsSchema.parse({});
}

async function saveSettings(settings: ProviderSettings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
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

function bindDebugMode(initial: boolean): void {
  applyDebugMode(initial);
  $<HTMLInputElement>('debug-mode').addEventListener('change', async (event) => {
    const enabled = (event.currentTarget as HTMLInputElement).checked;
    applyDebugMode(enabled);
    await saveDebugMode(enabled);
  });
}

function bindSettingsForm(initial: Readonly<ProviderSettings>): void {
  $<HTMLInputElement>('api-key').value = initial.apiKey;
  $<HTMLInputElement>('base-url').value = initial.baseUrl;
  $<HTMLInputElement>('model').value = initial.model;
  $<HTMLInputElement>('min-cards').value = String(initial.minCards);
  $<HTMLInputElement>('max-cards').value = String(initial.maxCards);
  $<HTMLSelectElement>('summary-language').value = initial.summaryLanguage;
  $<HTMLSelectElement>('card-density').value = initial.cardDensity;
  $<HTMLInputElement>('max-doc').value = String(initial.maxDocChars);

  $('settings-toggle').addEventListener('click', () => {
    const s = $('settings');
    s.hidden = !s.hidden;
  });

  $('settings-save').addEventListener('click', async () => {
    const parsed = ProviderSettingsSchema.safeParse({
      apiKey: $<HTMLInputElement>('api-key').value.trim(),
      baseUrl: $<HTMLInputElement>('base-url').value.trim(),
      model: $<HTMLInputElement>('model').value.trim(),
      minCards: Number($<HTMLInputElement>('min-cards').value),
      maxCards: Number($<HTMLInputElement>('max-cards').value),
      summaryLanguage: $<HTMLSelectElement>('summary-language').value,
      cardDensity: $<HTMLSelectElement>('card-density').value,
      maxDocChars: Number($<HTMLInputElement>('max-doc').value),
    });
    if (!parsed.success) {
      setStatus(`设置无效: ${parsed.error.issues[0]?.message ?? '请检查输入'}`);
      return;
    }
    await saveSettings(parsed.data);
    setStatus('设置已保存');
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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fallbackCopyText(text: string): void {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const ok = document.execCommand('copy');
  textarea.remove();
  if (!ok) throw new Error('浏览器拒绝写入剪贴板');
}

async function copyText(text: string, okStatus: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      fallbackCopyText(text);
    }
    setStatus(okStatus);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'unknown error';
    setStatus(`复制失败: ${msg}`);
  }
}

function cardSummaryText(card: Readonly<Card>, index: number): string {
  const bullets = card.bullets.map((bullet) => `- ${bullet}`);
  return [
    `${index + 1}. ${card.title}`,
    '',
    `Quote: ${card.anchor}`,
    '',
    card.gist,
    ...bullets,
  ].join('\n').trim();
}

function closeCardMenu(): void {
  const menu = $('card-menu');
  menu.hidden = true;
  menu.textContent = '';
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
  button.disabled = analyzeBusy;
  button.textContent = analyzeBusy
    ? currentHasSavedResults
      ? '重新分析中...'
      : '分析中...'
    : currentHasSavedResults
      ? '重新分析当前页'
      : '分析当前页';
  button.title =
    currentHasSavedResults && !analyzeBusy ? '重新抽取当前页并替换已保存结果' : '';
}

function setCurrentHasSavedResults(hasSavedResults: boolean): void {
  currentHasSavedResults = hasSavedResults;
  updateAnalyzeButton();
}

function setAnalyzeBusy(busy: boolean): void {
  analyzeBusy = busy;
  updateAnalyzeButton();
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
  setStatus(r?.ok ? `已高亮 #${index + 1}` : `定位失败 #${index + 1}`);
}

function appendMenuButton(
  menu: HTMLElement,
  label: string,
  disabled: boolean,
  onClick: () => void | Promise<void>,
): void {
  const button = document.createElement('button');
  button.type = 'button';
  button.role = 'menuitem';
  button.textContent = label;
  button.disabled = disabled;
  button.addEventListener('click', () => {
    void onClick();
  });
  menu.appendChild(button);
}

function positionCardMenu(menu: HTMLElement, clientX: number, clientY: number): void {
  menu.style.left = '0px';
  menu.style.top = '0px';
  menu.hidden = false;
  const margin = 8;
  const rect = menu.getBoundingClientRect();
  const left = Math.min(Math.max(margin, clientX), window.innerWidth - rect.width - margin);
  const top = Math.min(Math.max(margin, clientY), window.innerHeight - rect.height - margin);
  menu.style.left = `${Math.max(margin, left)}px`;
  menu.style.top = `${Math.max(margin, top)}px`;
}

function showCardMenu(
  result: Readonly<CardResult>,
  index: number,
  clientX: number,
  clientY: number,
): void {
  const { card, locate } = result;
  const canHighlight = locate.domRange;
  const menu = $('card-menu');
  menu.textContent = '';

  const title = document.createElement('div');
  title.className = 'card-menu-title';
  title.textContent = `#${index + 1}`;
  menu.appendChild(title);

  appendMenuButton(menu, '高亮定位', !canHighlight, () =>
    highlightCardAnchor(card.anchor, index, canHighlight),
  );
  appendMenuButton(menu, '复制引用', false, async () => {
    closeCardMenu();
    await copyText(card.anchor, `已复制引用 #${index + 1}`);
  });
  appendMenuButton(menu, '复制摘要', false, async () => {
    closeCardMenu();
    await copyText(cardSummaryText(card, index), `已复制摘要 #${index + 1}`);
  });

  positionCardMenu(menu, clientX, clientY);
  menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
}

function renderCard(result: CardResult, index: number): HTMLElement {
  const { card, locate } = result;
  const canHighlight = locate.domRange;
  const el = document.createElement('div');
  el.className = `card${canHighlight ? '' : ' miss'}`;
  el.tabIndex = 0;
  el.role = 'button';
  el.ariaLabel = canHighlight
    ? `高亮定位第 ${index + 1} 张卡片`
    : `第 ${index + 1} 张卡片暂时无法定位`;
  el.title = canHighlight ? '点击高亮定位，右键查看更多操作' : '右键查看更多操作';

  const bullets = card.bullets
    .map((b) => `<li>${escapeHtml(b)}</li>`)
    .join('');

  const badge = (label: string, hit: boolean) =>
    `<span class="badge ${hit ? 'hit' : 'miss'}">${label} ${hit ? '✓' : '✗'}</span>`;

  el.innerHTML = `
    <div class="card-head">
      <div class="card-title">${index + 1}. ${escapeHtml(card.title)}</div>
      <div class="card-badges debug-only">
        ${badge('原文', locate.rawHit)}
        ${badge('正文', locate.readabilityHit)}
        ${badge('定位', locate.domRange)}
      </div>
    </div>
    <div class="card-anchor">${escapeHtml(card.anchor)}</div>
    <div class="card-gist">${escapeHtml(card.gist)}</div>
    <ul class="card-bullets">${bullets}</ul>
  `;

  el.addEventListener('click', () => {
    void highlightCardAnchor(card.anchor, index, canHighlight);
  });

  el.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    showCardMenu(result, index, event.clientX, event.clientY);
  });

  el.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      void highlightCardAnchor(card.anchor, index, canHighlight);
      return;
    }
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      showCardMenu(result, index, rect.left + 28, rect.top + 28);
    }
  });

  return el;
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
  state.results.forEach((r, i) => {
    container.appendChild(renderCard(r, i));
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

async function locateAll(
  page: Readonly<PageIdentity>,
  cards: readonly Card[],
): Promise<readonly CardResult[]> {
  const results: CardResult[] = [];
  for (const card of cards) {
    const locate = (await sendToTab(page.tabId, {
      type: 'locate',
      anchor: card.anchor,
    }, page.url)) as LocateResponse;
    results.push({ card, locate });
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

async function init(): Promise<void> {
  const [settings, debugMode] = await Promise.all([loadSettings(), loadDebugMode()]);
  bindSettingsForm(settings);
  bindDebugMode(debugMode);
  updateAnalyzeButton();
  $('analyze').addEventListener('click', () => {
    void runAnalysis();
  });
  chrome.tabs.onActivated.addListener(() => {
    void refreshCurrentPage();
  });
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (currentPage?.tabId !== tabId) return;
    if (changeInfo.url || changeInfo.status === 'complete') {
      void refreshCurrentPage();
    }
    if (changeInfo.status === 'loading') {
      clearRenderedPage();
      setStatus('页面加载中...');
    }
  });
  chrome.windows.onFocusChanged.addListener(() => {
    void refreshCurrentPage();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void refreshCurrentPage();
  });
  document.addEventListener('click', (event) => {
    if ($('card-menu').contains(event.target as Node)) return;
    closeCardMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeCardMenu();
  });
  await refreshCurrentPage();
}

void init();
