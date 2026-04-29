import { Readability } from '@mozilla/readability';
import { locateRangeForText } from '../src/shared/dom-anchor';
import type { ExtractResponse } from '../src/shared/types';

export function extract(): ExtractResponse {
  let readabilityText = '';
  try {
    const cloned = document.cloneNode(true) as Document;
    const article = new Readability(cloned).parse();
    readabilityText = (article?.textContent ?? '').replace(/ /g, ' ').trim();
  } catch {
    readabilityText = '';
  }

  return {
    rawText: (document.body?.innerText ?? '').trim(),
    readabilityText,
    url: location.href,
    title: document.title,
  };
}

export function locate(anchor: string): { domRange: boolean; rectCount: number } {
  const range = locateRangeForText(anchor);
  if (!range) return { domRange: false, rectCount: 0 };
  const rectCount = Array.from(range.getClientRects()).filter(
    (rect) => rect.width >= 1 && rect.height >= 1,
  ).length;
  return { domRange: true, rectCount };
}
