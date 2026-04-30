import { callProvider } from './shared/provider';
import { selectExtractedTextVersion } from './shared/extraction-quality';
import {
  type AnalyzeRequest,
  type AnalyzeResponse,
  ProviderSettingsSchema,
  PAGE_STATE_PREFIX,
  PENDING_ANALYZE_KEY,
  PENDING_ANALYZE_MSG,
  type PendingAnalyzeAck,
  type PendingAnalyzeRequest,
  SETTINGS_KEY,
} from './shared/types';
import { logWarn } from './shared/logger';
import { buildPendingAnalyzeRequest } from './shared/pending-analyze';

const pageStorage: chrome.storage.StorageArea = chrome.storage.session ?? chrome.storage.local;

const SIDE_PANEL_PATH = 'sidepanel.html';
const BADGE_CLEAR_MS = 5_000;

try {
  void chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: false })
    .catch((error) => logWarn('reset sidePanel behavior', error));
} catch (error) {
  logWarn('setPanelBehavior unavailable', error);
}

async function loadSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const raw = (stored as Record<string, unknown>)[SETTINGS_KEY];
  const parsed = ProviderSettingsSchema.safeParse(raw ?? {});
  if (parsed.success) return parsed.data;
  logWarn('invalid stored settings; using defaults', parsed.error);
  return ProviderSettingsSchema.parse({});
}

async function enablePanelForTab(tabId: number): Promise<void> {
  await chrome.sidePanel.setOptions({ tabId, path: SIDE_PANEL_PATH, enabled: true });
}

function notifyOpenFailure(tabId: number): void {
  try {
    void chrome.action.setBadgeBackgroundColor?.({ color: '#c33', tabId });
    void chrome.action.setBadgeText?.({ text: '!', tabId });
    setTimeout(() => {
      void chrome.action.setBadgeText?.({ text: '', tabId });
    }, BADGE_CLEAR_MS);
  } catch (error) {
    logWarn('notify open failure', error);
  }
}

async function dispatchPendingAnalyze(request: PendingAnalyzeRequest): Promise<void> {
  try {
    const ack = (await chrome.runtime.sendMessage({
      type: PENDING_ANALYZE_MSG,
      request,
    })) as PendingAnalyzeAck | undefined;
    if (ack && ack.ok === false) logWarn('pending-analyze rejected', ack.error);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes('Receiving end does not exist') ||
      message.includes('Could not establish connection')
    ) {
      await pageStorage.set({ [PENDING_ANALYZE_KEY]: request });
      return;
    }
    logWarn('dispatch pending-analyze', error);
    notifyOpenFailure(request.tabId);
  }
}

async function openSidePanelForTab(tabId: number): Promise<void> {
  try {
    await enablePanelForTab(tabId);
    await chrome.sidePanel.open({ tabId });
  } catch (error) {
    logWarn('open side panel', error);
    notifyOpenFailure(tabId);
    throw error;
  }
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

function safeAddListener<T extends (...args: never[]) => unknown>(
  event: chrome.events.Event<T> | undefined,
  listener: T,
  label: string,
): void {
  try {
    event?.addListener(listener);
  } catch (error) {
    logWarn(`addListener failed for ${label}`, error);
  }
}

safeAddListener(
  chrome.action?.onClicked,
  (tab: chrome.tabs.Tab) => {
    if (typeof tab.id !== 'number') return;
    void openSidePanelForTab(tab.id).catch(() => {
      // already logged + badged in openSidePanelForTab
    });
  },
  'action.onClicked',
);

safeAddListener(
  chrome.tabs?.onRemoved,
  (tabId: number) => {
    void removePageStatesForTab(tabId).catch((error) => {
      logWarn('failed to cleanup page state', error);
    });
  },
  'tabs.onRemoved',
);

safeAddListener(
  chrome.tabs?.onZoomChange,
  ({ tabId, newZoomFactor }: chrome.tabs.ZoomChangeInfo) => {
    chrome.runtime
      .sendMessage({ type: 'zoom-change', tabId, zoomFactor: newZoomFactor })
      .catch(() => {
        // side panel may be closed; ignore
      });
  },
  'tabs.onZoomChange',
);

safeAddListener(
  chrome.commands?.onCommand,
  (command: string, tab?: chrome.tabs.Tab) => {
    if (command !== 'analyze-current-page' || !tab) return;
    const request = buildPendingAnalyzeRequest(tab);
    if (!request) return;
    void (async () => {
      try {
        await openSidePanelForTab(request.tabId);
      } catch {
        return;
      }
      await dispatchPendingAnalyze(request);
    })();
  },
  'commands.onCommand',
);
