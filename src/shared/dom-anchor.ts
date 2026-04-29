type FlatText = {
  flat: string;
  nodes: readonly Text[];
  starts: readonly number[];
};

function buildFlatText(root: ParentNode = document.body): FlatText {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
      const style = window.getComputedStyle(parent);
      if (style.visibility === 'hidden' || style.display === 'none') return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes: Text[] = [];
  const starts: number[] = [];
  let flat = '';
  let cur: Node | null = walker.nextNode();
  while (cur) {
    const text = (cur as Text).nodeValue ?? '';
    if (text.length > 0) {
      nodes.push(cur as Text);
      starts.push(flat.length);
      flat += text;
    }
    cur = walker.nextNode();
  }
  return { flat, nodes, starts };
}

function findNodeForOffset(flat: FlatText, offset: number): { node: Text; local: number } | null {
  const { nodes, starts } = flat;
  if (nodes.length === 0) return null;
  let lo = 0;
  let hi = nodes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if ((starts[mid] ?? 0) <= offset) lo = mid;
    else hi = mid - 1;
  }
  const node = nodes[lo];
  const start = starts[lo];
  if (!node || start === undefined) return null;
  const local = offset - start;
  if (local < 0 || local > node.length) return null;
  return { node, local };
}

function normalizeWithMap(s: string): { text: string; map: number[] } {
  const chars: string[] = [];
  const map: number[] = [];
  let pendingWhitespace: number | null = null;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === undefined) continue;
    if (/\s/.test(c)) {
      if (chars.length > 0 && pendingWhitespace === null) pendingWhitespace = i;
      continue;
    }
    if (pendingWhitespace !== null) {
      chars.push(' ');
      map.push(pendingWhitespace);
      pendingWhitespace = null;
    }
    chars.push(c);
    map.push(i);
  }

  return { text: chars.join(''), map };
}

function normalizedHit(
  flat: string,
  anchor: string,
  maxLen?: number,
): { index: number; length: number } | null {
  const normalizedFlat = normalizeWithMap(flat);
  const normalizedAnchor = anchor.trim().replace(/\s+/g, ' ');
  const needle = maxLen === undefined ? normalizedAnchor : normalizedAnchor.slice(0, maxLen);
  if (needle.length < 8) return null;

  const idx = normalizedFlat.text.indexOf(needle);
  if (idx < 0) return null;

  const start = normalizedFlat.map[idx];
  const last = normalizedFlat.map[idx + needle.length - 1];
  if (start === undefined || last === undefined) return null;

  return { index: start, length: last - start + 1 };
}

function findFlatOffset(flat: string, anchor: string): { index: number; length: number } | null {
  if (!anchor) return null;
  const exact = flat.indexOf(anchor);
  if (exact >= 0) return { index: exact, length: anchor.length };
  const trimmed = anchor.trim();
  if (trimmed && trimmed !== anchor) {
    const idx = flat.indexOf(trimmed);
    if (idx >= 0) return { index: idx, length: trimmed.length };
  }
  for (const len of [80, 60, 40, 25, 15] as const) {
    const prefix = trimmed.slice(0, len);
    if (prefix.length < 8) continue;
    const idx = flat.indexOf(prefix);
    if (idx >= 0) return { index: idx, length: prefix.length };
  }
  const normalized = normalizedHit(flat, trimmed);
  if (normalized) return normalized;
  for (const len of [80, 60, 40, 25, 15] as const) {
    const normalizedPrefix = normalizedHit(flat, trimmed, len);
    if (normalizedPrefix) return normalizedPrefix;
  }
  return null;
}

export function locateRangeForText(needle: string, root: ParentNode = document.body): Range | null {
  const flat = buildFlatText(root);
  const hit = findFlatOffset(flat.flat, needle);
  if (!hit) return null;
  const start = findNodeForOffset(flat, hit.index);
  const end = findNodeForOffset(flat, hit.index + hit.length);
  if (!start || !end) return null;
  try {
    const range = document.createRange();
    range.setStart(start.node, start.local);
    range.setEnd(end.node, end.local);
    return range;
  } catch {
    return null;
  }
}

export function canLocateAnchor(anchor: string, root: ParentNode = document.body): boolean {
  return locateRangeForText(anchor, root) !== null;
}
