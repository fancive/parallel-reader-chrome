import {
  ANALYSIS_DONE_MSG,
  type AnalysisDoneMessage,
  clearInflight,
  type InflightLocating,
  setInflight,
} from './shared/analyze-inflight';
import { selectExtractedTextVersion } from './shared/extraction-quality';
import { t } from './shared/i18n';
import { logWarn } from './shared/logger';
import { buildPendingAnalyzeRequest } from './shared/pending-analyze';
import { callProvider } from './shared/provider';
import {
  type AnalyzeRequest,
  type AnalyzeResponse,
  PENDING_ANALYZE_KEY,
  PENDING_ANALYZE_MSG,
  type PendingAnalyzeAck,
  type PendingAnalyzeRequest,
  ProviderSettingsSchema,
  SETTINGS_KEY,
} from './shared/types';

const pendingAnalyzeStorage: chrome.storage.StorageArea = chrome.storage.session ?? chrome.storage.local;
const inflightStorage: chrome.storage.StorageArea = chrome.storage.session ?? chrome.storage.local;

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

function sidePanelPathForTab(tabId: number): string {
  return `${SIDE_PANEL_PATH}?tabId=${encodeURIComponent(String(tabId))}`;
}

async function enablePanelForTab(tabId: number): Promise<void> {
  await chrome.sidePanel.setOptions({
    tabId,
    path: sidePanelPathForTab(tabId),
    enabled: true,
  });
}

async function disableGlobalPanelFallback(): Promise<void> {
  await chrome.sidePanel.setOptions({ enabled: false });
}

function configureGlobalPanelFallback(): void {
  void disableGlobalPanelFallback().catch((error) =>
    logWarn('disable global side panel fallback', error),
  );
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
      await pendingAnalyzeStorage.set({ [PENDING_ANALYZE_KEY]: request });
      return;
    }
    logWarn('dispatch pending-analyze', error);
    notifyOpenFailure(request.tabId);
  }
}

function openSidePanelForTab(tabId: number): Promise<void> {
  const enablePromise = enablePanelForTab(tabId);
  const openPromise = chrome.sidePanel.open({ tabId });
  return Promise.all([enablePromise, openPromise]).then(
    () => undefined,
    (error: unknown) => {
      logWarn('open side panel', error);
      notifyOpenFailure(tabId);
      throw error;
    },
  );
}

async function broadcastAnalysisDone(pageKey: string, tabId: number): Promise<void> {
  const message: AnalysisDoneMessage = { type: ANALYSIS_DONE_MSG, pageKey, tabId };
  try {
    await chrome.runtime.sendMessage(message);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    if (
      msg.includes('Receiving end does not exist') ||
      msg.includes('Could not establish connection')
    ) {
      return;
    }
    logWarn('broadcast analysis-done', error);
  }
}

async function handleAnalyze(req: AnalyzeRequest): Promise<AnalyzeResponse> {
  const startedAt = Date.now();
  await setInflight(inflightStorage, {
    phase: 'analyzing',
    pageKey: req.pageKey,
    tabId: req.tabId,
    startedAt,
  });
  try {
    const settings = await loadSettings();
    const usedText = selectExtractedTextVersion(req.readabilityText.length);
    const text = usedText === 'readability' ? req.readabilityText : req.rawText;
    if (!text.trim()) {
      await clearInflight(inflightStorage, req.pageKey);
      return { ok: false, error: t('pageNoReadableText') };
    }
    const cards = await callProvider(text, settings);
    const locatingEntry: InflightLocating = {
      phase: 'locating',
      pageKey: req.pageKey,
      tabId: req.tabId,
      startedAt,
      cards: [...cards],
      usedText,
      meta: {
        title: req.title,
        url: req.url,
        rawTextLength: req.rawText.length,
        readabilityTextLength: req.readabilityText.length,
      },
    };
    await setInflight(inflightStorage, locatingEntry);
    void broadcastAnalysisDone(req.pageKey, req.tabId);
    return { ok: true, cards, usedText };
  } catch (error: unknown) {
    await clearInflight(inflightStorage, req.pageKey);
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

configureGlobalPanelFallback();

safeAddListener(
  chrome.action?.onClicked,
  (tab: chrome.tabs.Tab) => {
    if (typeof tab.id !== 'number') return;
    void openSidePanelForTab(tab.id).catch(() => {
      /* swallowed; openSidePanelForTab handled UX */
    });
  },
  'action.onClicked',
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
    // Dispatch chains after the tab-specific panel opens. Failure is already
    // logged + badged.
    const openPromise = openSidePanelForTab(request.tabId);
    void openPromise
      .then(() => dispatchPendingAnalyze(request))
      .catch(() => {
        /* swallowed; openSidePanelForTab handled UX */
      });
  },
  'commands.onCommand',
);
