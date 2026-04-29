export type AnchorMatch = {
  hit: boolean;
  index: number;
  matchedLength: number;
  strategy: 'exact' | 'trim' | 'prefix' | 'normalized' | 'miss';
};

const PREFIX_LENGTHS = [60, 40, 25, 15] as const;

function normalizeWithMap(s: string): { text: string; map: number[] } {
  const chars: string[] = [];
  const map: number[] = [];
  let pendingWhitespace = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === undefined) continue;
    if (/\s/.test(c)) {
      pendingWhitespace = chars.length > 0;
      continue;
    }
    if (pendingWhitespace) {
      chars.push(' ');
      map.push(i);
      pendingWhitespace = false;
    }
    chars.push(c);
    map.push(i);
  }
  return { text: chars.join(''), map };
}

export function matchAnchor(haystack: string, anchor: string): AnchorMatch {
  if (!anchor) return { hit: false, index: -1, matchedLength: 0, strategy: 'miss' };

  const exactIdx = haystack.indexOf(anchor);
  if (exactIdx >= 0) return { hit: true, index: exactIdx, matchedLength: anchor.length, strategy: 'exact' };

  const trimmed = anchor.trim();
  if (trimmed && trimmed !== anchor) {
    const trimIdx = haystack.indexOf(trimmed);
    if (trimIdx >= 0) return { hit: true, index: trimIdx, matchedLength: trimmed.length, strategy: 'trim' };
  }

  for (const len of PREFIX_LENGTHS) {
    const prefix = trimmed.slice(0, len);
    if (!prefix || prefix.length < 8) continue;
    const idx = haystack.indexOf(prefix);
    if (idx >= 0) return { hit: true, index: idx, matchedLength: prefix.length, strategy: 'prefix' };
  }

  const normHay = normalizeWithMap(haystack);
  const normAnchor = trimmed.replace(/\s+/g, ' ').slice(0, 40);
  if (normAnchor.length < 8) return { hit: false, index: -1, matchedLength: 0, strategy: 'miss' };
  const normIdx = normHay.text.indexOf(normAnchor);
  if (normIdx < 0) return { hit: false, index: -1, matchedLength: 0, strategy: 'miss' };
  const original = normHay.map[normIdx];
  const last = normHay.map[normIdx + normAnchor.length - 1];
  if (original == null || last == null) {
    return { hit: false, index: -1, matchedLength: 0, strategy: 'miss' };
  }
  return { hit: true, index: original, matchedLength: last - original + 1, strategy: 'normalized' };
}
