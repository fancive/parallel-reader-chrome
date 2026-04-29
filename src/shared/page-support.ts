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
    return '当前页面 URL 无法解析，暂时无法阅读。';
  }

  if (RESTRICTED_PROTOCOLS.has(parsed.protocol)) {
    return '当前页面是浏览器内部页或扩展页，无法阅读。请切换到普通网页后再试。';
  }

  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    if (parsed.pathname.toLowerCase().endsWith('.pdf')) {
      return '暂不支持浏览器 PDF 阅读器。请打开网页正文或可复制文本版本。';
    }
    return null;
  }

  if (parsed.protocol === 'file:') return null;

  return `当前页面协议 ${parsed.protocol} 暂不支持内容脚本抽取。`;
}

export function contentScriptInjectionHint(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return '';
  }

  if (parsed.protocol === 'file:') {
    return '请先在 chrome://extensions 为该扩展开启“允许访问文件网址”，或改用本地 HTTP 页面。';
  }

  return '';
}
