import { matchAnchor } from './anchor';
import type { Card } from './types';

export type AnchorRepair = {
  anchor: string;
  repaired: boolean;
  hit: boolean;
  strategy: 'existing-match' | 'word-sequence' | 'miss';
};

type Token = {
  value: string;
  start: number;
  end: number;
};

const WORD_RE = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)?/gu;
const MIN_WORD_SEQUENCE = 5;
const MAX_WORD_SEQUENCE = 14;

function normalizeToken(token: string): string {
  return token
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐‑‒–—]/g, '-');
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  WORD_RE.lastIndex = 0;
  while (true) {
    const match = WORD_RE.exec(text);
    if (match === null) break;
    const raw = match[0];
    tokens.push({
      value: normalizeToken(raw),
      start: match.index,
      end: match.index + raw.length,
    });
  }
  return tokens;
}

function cleanCandidate(candidate: string): string {
  return candidate
    .replace(/^[\s,.;:!?()[\]{}"']+/, '')
    .replace(/[\s,.;:!?()[\]{}"']+$/, '');
}

function existingMatch(text: string, anchor: string): string | null {
  const match = matchAnchor(text, anchor);
  if (!match.hit || match.index < 0 || match.matchedLength <= 0) return null;
  const candidate = cleanCandidate(text.slice(match.index, match.index + match.matchedLength));
  return candidate.length >= 8 ? candidate : null;
}

function wordSequenceRepair(text: string, anchor: string): string | null {
  const textTokens = tokenize(text);
  const anchorTokens = tokenize(anchor);
  if (textTokens.length === 0 || anchorTokens.length < MIN_WORD_SEQUENCE) return null;

  const maxLen = Math.min(MAX_WORD_SEQUENCE, anchorTokens.length);
  for (let len = maxLen; len >= MIN_WORD_SEQUENCE; len--) {
    for (let anchorStart = 0; anchorStart <= anchorTokens.length - len; anchorStart++) {
      const needle = anchorTokens
        .slice(anchorStart, anchorStart + len)
        .map((token) => token.value)
        .join('\u0000');

      for (let textStart = 0; textStart <= textTokens.length - len; textStart++) {
        const hay = textTokens
          .slice(textStart, textStart + len)
          .map((token) => token.value)
          .join('\u0000');
        if (hay !== needle) continue;

        const first = textTokens[textStart];
        const last = textTokens[textStart + len - 1];
        if (!first || !last) continue;
        const candidate = cleanCandidate(text.slice(first.start, last.end));
        if (candidate.length >= 24) return candidate;
      }
    }
  }

  return null;
}

export function repairAnchor(text: string, anchor: string): AnchorRepair {
  const matched = existingMatch(text, anchor);
  if (matched) {
    return {
      anchor: matched,
      repaired: matched !== anchor,
      hit: true,
      strategy: 'existing-match',
    };
  }

  const repaired = wordSequenceRepair(text, anchor);
  if (repaired) {
    return {
      anchor: repaired,
      repaired: repaired !== anchor,
      hit: true,
      strategy: 'word-sequence',
    };
  }

  return { anchor, repaired: false, hit: false, strategy: 'miss' };
}

export function repairCardAnchors(text: string, cards: readonly Card[]): readonly Card[] {
  return cards.map((card) => {
    const repaired = repairAnchor(text, card.anchor);
    if (!repaired.hit || repaired.anchor === card.anchor) return card;
    return { ...card, anchor: repaired.anchor };
  });
}
