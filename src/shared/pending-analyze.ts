import { unsupportedPageReason } from './page-support';
import type { PendingAnalyzeRequest } from './types';

export function buildPendingAnalyzeRequest(
  tab: chrome.tabs.Tab,
  nonce: string = crypto.randomUUID(),
  ts: number = Date.now(),
): PendingAnalyzeRequest | null {
  if (typeof tab.id !== 'number' || !tab.url) return null;
  if (unsupportedPageReason(tab.url)) return null;
  return { tabId: tab.id, url: tab.url, nonce, ts };
}
