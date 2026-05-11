import { t } from './i18n';

const RESTRICTED_PROTOCOLS = new Set([
  'about:',
  'chrome:',
  'chrome-extension:',
  'devtools:',
  'edge:',
  'view-source:',
]);

export function unsupportedPageReason(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return t('pageSupportInvalidUrl');
  }

  if (RESTRICTED_PROTOCOLS.has(parsed.protocol)) {
    return t('pageSupportInternalPage');
  }

  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    if (parsed.pathname.toLowerCase().endsWith('.pdf')) {
      return t('pageSupportPdfNotSupported');
    }
    return null;
  }

  if (parsed.protocol === 'file:') return null;

  return t('pageSupportProtocolUnsupported', { protocol: parsed.protocol });
}

export function contentScriptInjectionHint(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return '';
  }

  if (parsed.protocol === 'file:') {
    return t('pageSupportFileAccessHint');
  }

  return '';
}
