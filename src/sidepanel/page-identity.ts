import { t } from '../shared/i18n';
import { unsupportedPageReason } from '../shared/page-support';

export type PageIdentity = {
  tabId: number;
  url: string;
  title: string;
  key: string;
};

export function buildPageKey(url: string): string {
  return url;
}

export function pageIdentityFromTab(tab: chrome.tabs.Tab): PageIdentity {
  if (typeof tab.id !== 'number') throw new Error(t('errorNoActiveTab'));
  if (!tab.url) throw new Error(t('errorTabNoUrl'));
  const reason = unsupportedPageReason(tab.url);
  if (reason) throw new Error(reason);
  return {
    tabId: tab.id,
    url: tab.url,
    title: tab.title ?? '',
    key: buildPageKey(tab.url),
  };
}
