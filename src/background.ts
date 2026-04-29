import { callProvider } from './shared/provider';
import { selectExtractedTextVersion } from './shared/extraction-quality';
import {
  type AnalyzeRequest,
  type AnalyzeResponse,
  ProviderSettingsSchema,
  PAGE_STATE_PREFIX,
  SETTINGS_KEY,
} from './shared/types';

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.warn('[parallel-reader] sidePanel setup', error));

const pageStorage: chrome.storage.StorageArea = chrome.storage.session ?? chrome.storage.local;

async function loadSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const raw = (stored as Record<string, unknown>)[SETTINGS_KEY];
  const parsed = ProviderSettingsSchema.safeParse(raw ?? {});
  if (parsed.success) return parsed.data;
  console.warn('[parallel-reader] invalid stored settings; using defaults', parsed.error);
  return ProviderSettingsSchema.parse({});
}

async function removePageStatesForTab(tabId: number): Promise<void> {
  const prefix = `${PAGE_STATE_PREFIX}${tabId}:`;
  const stored = await pageStorage.get(null);
  const keys = Object.keys(stored).filter((key) => key.startsWith(prefix));
  if (keys.length > 0) await pageStorage.remove(keys);
}

async function handleAnalyze(req: AnalyzeRequest): Promise<AnalyzeResponse> {
  try {
    const settings = await loadSettings();
    const usedText = selectExtractedTextVersion(req.readabilityText.length);
    const text = usedText === 'readability' ? req.readabilityText : req.rawText;
    if (!text.trim()) return { ok: false, error: '页面无可读文本' };
    const cards = await callProvider(text, settings);
    return { ok: true, cards, usedText };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'unknown error';
    return { ok: false, error: message };
  }
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === 'analyze'
  ) {
    handleAnalyze(message as AnalyzeRequest).then(sendResponse);
    return true;
  }
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void removePageStatesForTab(tabId).catch((error) => {
    console.warn('[parallel-reader] failed to cleanup page state', error);
  });
});
