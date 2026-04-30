import { unsupportedPageReason } from '../shared/page-support';

export type PageIdentity = {
  tabId: number;
  url: string;
  title: string;
  key: string;
};

export function buildPageKey(tabId: number, url: string): string {
  return `${tabId}:${url}`;
}

export function pageIdentityFromTab(tab: chrome.tabs.Tab): PageIdentity {
  if (typeof tab.id !== 'number') throw new Error('找不到活动标签页');
  if (!tab.url) throw new Error('当前标签页没有 URL');
  const reason = unsupportedPageReason(tab.url);
  if (reason) throw new Error(reason);
  return {
    tabId: tab.id,
    url: tab.url,
    title: tab.title ?? '',
    key: buildPageKey(tab.id, tab.url),
  };
}
