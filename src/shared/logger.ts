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
