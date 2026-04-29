import { Readability } from '@mozilla/readability';
import { matchAnchor } from './shared/anchor';
import { locateRangeForText } from './shared/dom-anchor';
import type {
  ExtractRequest,
  ExtractResponse,
  HighlightRequest,
  LocateRequest,
  LocateResponse,
} from './shared/types';

const HIGHLIGHT_STYLE_ID = 'parallel-reader-highlight-style';
const OVERLAY_ID = 'parallel-reader-overlay-spike';

type ExtractCache = {
  signature: string;
  response: ExtractResponse;
};

let extractCache: ExtractCache | null = null;
let activeHighlightRange: Range | null = null;
let highlightTimer = 0;
let highlightFrame = 0;
let documentDirty = true;

function extractRawText(): string {
  return (document.body?.innerText ?? '').trim();
}

function extractReadabilityText(): string {
  try {
    const cloned = document.cloneNode(true) as Document;
    const article = new Readability(cloned).parse();
    if (!article) return '';
    const textContent = article.textContent ?? '';
    return textContent.replace(/ /g, ' ').trim();
  } catch (error) {
    console.warn('[parallel-reader] Readability failed', error);
    return '';
  }
}

function hashText(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function extractSignature(rawText: string): string {
  return [location.href, document.title, rawText.length, hashText(rawText)].join('\n');
}

function getExtracted(): ExtractResponse {
  if (
    extractCache &&
    !documentDirty &&
    extractCache.response.url === location.href &&
    extractCache.response.title === document.title
  ) {
    return extractCache.response;
  }

  const rawText = extractRawText();
  const signature = extractSignature(rawText);
  if (extractCache?.signature === signature) {
    documentDirty = false;
    return extractCache.response;
  }

  const response: ExtractResponse = {
    rawText,
    readabilityText: extractReadabilityText(),
    url: location.href,
    title: document.title,
  };
  extractCache = { signature, response };
  documentDirty = false;
  return response;
}

function ensureOverlayContainer(): HTMLDivElement {
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) return existing as HTMLDivElement;
  const container = document.createElement('div');
  container.id = OVERLAY_ID;
  container.style.cssText =
    'position:fixed;top:0;left:0;width:0;height:0;pointer-events:none;z-index:2147483647;';
  document.documentElement.appendChild(container);
  return container;
}

function clearHighlightBoxes(): void {
  const container = document.getElementById(OVERLAY_ID);
  if (container) container.textContent = '';
}

function clearHighlights(): void {
  if (highlightTimer) window.clearTimeout(highlightTimer);
  if (highlightFrame) window.cancelAnimationFrame(highlightFrame);
  highlightTimer = 0;
  highlightFrame = 0;
  activeHighlightRange = null;
  clearHighlightBoxes();
}

function ensureHighlightStyle(): void {
  if (document.getElementById(HIGHLIGHT_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = HIGHLIGHT_STYLE_ID;
  style.textContent = `@keyframes parallel-reader-fade { 0% { opacity: 0; } 20% { opacity: 1; } 100% { opacity: 1; } }`;
  document.head.appendChild(style);
}

function renderHighlightBoxes(range: Range): void {
  const container = ensureOverlayContainer();
  container.textContent = '';
  const rects = Array.from(range.getClientRects());
  for (const rect of rects) {
    if (rect.width < 1 || rect.height < 1) continue;
    const box = document.createElement('div');
    box.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;background:rgba(255,243,122,0.55);outline:2px solid #f5b400;border-radius:2px;animation:parallel-reader-fade 2s ease;`;
    container.appendChild(box);
  }
}

function trackHighlightDuringScroll(range: Range, startedAt: number): void {
  renderHighlightBoxes(range);
  if (performance.now() - startedAt > 1200) {
    highlightFrame = 0;
    return;
  }
  highlightFrame = window.requestAnimationFrame(() => trackHighlightDuringScroll(range, startedAt));
}

function refreshActiveHighlight(): void {
  if (activeHighlightRange) renderHighlightBoxes(activeHighlightRange);
}

function highlightRange(range: Range): void {
  clearHighlights();
  ensureHighlightStyle();
  activeHighlightRange = range;

  const first = Array.from(range.getClientRects()).find(
    (rect) => rect.width >= 1 && rect.height >= 1,
  );
  if (first) {
    window.scrollTo({
      top: window.scrollY + first.top - window.innerHeight / 2 + first.height / 2,
      behavior: 'smooth',
    });
  }
  trackHighlightDuringScroll(range, performance.now());
  highlightTimer = window.setTimeout(clearHighlights, 4000);
}

function handleExtract(): ExtractResponse {
  return getExtracted();
}

function handleLocate(req: LocateRequest): LocateResponse {
  const extracted = getExtracted();
  const rawMatch = matchAnchor(extracted.rawText, req.anchor);
  const readMatch = matchAnchor(extracted.readabilityText, req.anchor);
  const range = locateRangeForText(req.anchor);
  return {
    rawHit: rawMatch.hit,
    readabilityHit: readMatch.hit,
    domRange: range !== null,
    rawIndex: rawMatch.index,
    readabilityIndex: readMatch.index,
  };
}

window.addEventListener('scroll', refreshActiveHighlight, { passive: true });
window.addEventListener('resize', refreshActiveHighlight, { passive: true });

const observerRoot = document.documentElement;
if (observerRoot) {
  new MutationObserver((mutations) => {
    const onlyHighlightChanges = mutations.every((mutation) => {
      const target = mutation.target;
      return target instanceof Element && target.closest(`#${OVERLAY_ID}`);
    });
    if (!onlyHighlightChanges) documentDirty = true;
  }).observe(observerRoot, {
    childList: true,
    characterData: true,
    subtree: true,
  });
}

function handleHighlight(req: HighlightRequest): { ok: boolean } {
  const range = locateRangeForText(req.anchor);
  if (!range) return { ok: false };
  highlightRange(range);
  return { ok: true };
}

type IncomingMessage = ExtractRequest | LocateRequest | HighlightRequest;

chrome.runtime.onMessage.addListener((message: IncomingMessage, _sender, sendResponse) => {
  try {
    if (message.type === 'extract') {
      sendResponse(handleExtract());
      return false;
    }
    if (message.type === 'locate') {
      sendResponse(handleLocate(message));
      return false;
    }
    if (message.type === 'highlight') {
      sendResponse(handleHighlight(message));
      return false;
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'unknown error';
    sendResponse({ error: msg });
  }
  return false;
});
