import { defaultDiagStorage, diagAppend } from './diag-log';

const DEBUG_MODE_KEY = 'parallel-reader-debug-mode';

let debugEnabled = false;

async function initDebugFlag(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(DEBUG_MODE_KEY);
    debugEnabled = Boolean((stored as Record<string, unknown>)[DEBUG_MODE_KEY]);
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && DEBUG_MODE_KEY in changes) {
        debugEnabled = Boolean(changes[DEBUG_MODE_KEY]?.newValue);
      }
    });
  } catch {
    // Storage unavailable (e.g. in tests) — stay silent
  }
}

void initDebugFlag();

export function logWarn(message: string, ...args: unknown[]): void {
  if (debugEnabled) {
    console.warn(`[parallel-reader] ${message}`, ...args);
  }
}

/**
 * Structured trace for diagnosing state-flow issues. Tag is a short scope
 * label like "sidepanel:refresh" or "bg:analyze". Payload is shallow JSON.
 *
 * Mirrors to console when debug mode is on AND to a session-persisted ring
 * buffer (so traces survive sidepanel unloads). Both are no-ops when
 * chrome.storage is unavailable.
 */
export function logTrace(tag: string, payload: Readonly<Record<string, unknown>> = {}): void {
  const ts = Date.now();
  if (debugEnabled) {
    console.log(`[pr:${tag}]`, payload);
  }
  // Fire-and-forget; do not await — callers are hot paths.
  void diagAppend(defaultDiagStorage(), { ts, tag, payload: { ...payload } }).catch(() => {
    /* swallow; diagnostics is best-effort */
  });
}

export function isDebugEnabled(): boolean {
  return debugEnabled;
}
