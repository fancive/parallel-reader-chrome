import { type Card, PAGE_STATE_PREFIX } from '../shared/types';

export type HistoryEntry = {
  storageKey: string;
  pageKey: string;
  url: string;
  title: string;
  analyzedAt: number;
  cardCount: number;
  cards: readonly Card[];
};

export type HistoryStorage = Pick<chrome.storage.StorageArea, 'get' | 'remove'>;

type RawCardResult = { card?: unknown };
type RawPageState = {
  page?: { url?: unknown; title?: unknown; key?: unknown };
  meta?: { title?: unknown; url?: unknown };
  results?: unknown;
  analyzedAt?: unknown;
  cachedAt?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function pickString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return '';
}

function pickTimestamp(...values: unknown[]): number {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

function isCard(value: unknown): value is Card {
  if (!isRecord(value)) return false;
  return (
    typeof value.title === 'string' &&
    typeof value.anchor === 'string' &&
    typeof value.gist === 'string' &&
    Array.isArray(value.bullets)
  );
}

function extractCards(rawResults: unknown): Card[] {
  if (!Array.isArray(rawResults)) return [];
  const cards: Card[] = [];
  for (const item of rawResults) {
    const candidate = (item as RawCardResult)?.card;
    if (isCard(candidate)) {
      cards.push({
        title: candidate.title,
        anchor: candidate.anchor,
        gist: candidate.gist,
        bullets: Array.isArray(candidate.bullets)
          ? candidate.bullets.filter((b): b is string => typeof b === 'string')
          : [],
      });
    }
  }
  return cards;
}

export function parseHistoryEntry(storageKey: string, raw: unknown): HistoryEntry | null {
  if (!storageKey.startsWith(PAGE_STATE_PREFIX)) return null;
  if (!isRecord(raw)) return null;
  const state = raw as RawPageState;
  const url = pickString(state.page?.url, state.meta?.url);
  if (!url) return null;
  const title = pickString(state.meta?.title, state.page?.title, url);
  const analyzedAt = pickTimestamp(state.analyzedAt, state.cachedAt);
  const cards = extractCards(state.results);
  const pageKey = storageKey.slice(PAGE_STATE_PREFIX.length);
  return {
    storageKey,
    pageKey,
    url,
    title,
    analyzedAt,
    cardCount: cards.length,
    cards,
  };
}

export async function listHistoryEntries(storage: HistoryStorage): Promise<HistoryEntry[]> {
  const all = (await storage.get(null)) as Record<string, unknown>;
  const entries: HistoryEntry[] = [];
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith(PAGE_STATE_PREFIX)) continue;
    const entry = parseHistoryEntry(key, value);
    if (entry) entries.push(entry);
  }
  entries.sort((a, b) => b.analyzedAt - a.analyzedAt);
  return entries;
}

export async function deleteHistoryEntry(
  storage: HistoryStorage,
  storageKey: string,
): Promise<void> {
  await storage.remove(storageKey);
}

export async function clearAllHistory(storage: HistoryStorage): Promise<void> {
  const all = (await storage.get(null)) as Record<string, unknown>;
  const keys = Object.keys(all).filter((k) => k.startsWith(PAGE_STATE_PREFIX));
  if (keys.length === 0) return;
  await storage.remove(keys);
}

export function formatAnalyzedAt(analyzedAt: number, locale?: string): string {
  if (!analyzedAt || analyzedAt <= 0) return '未知时间';
  const date = new Date(analyzedAt);
  if (Number.isNaN(date.getTime())) return '未知时间';
  return date.toLocaleString(locale);
}

export function truncateUrl(url: string, maxLen = 64): string {
  if (url.length <= maxLen) return url;
  const head = Math.ceil((maxLen - 1) / 2);
  const tail = Math.floor((maxLen - 1) / 2);
  return `${url.slice(0, head)}…${url.slice(url.length - tail)}`;
}

export function sanitizeFilename(name: string, fallback = 'parallel-reader'): string {
  const cleaned = name
    .replace(/[^\p{L}\p{N}._-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned.length > 0 ? cleaned : fallback;
}

export function entryToMarkdown(entry: Readonly<HistoryEntry>): string {
  const lines: string[] = [];
  lines.push(`# ${entry.title}`);
  lines.push('');
  lines.push(entry.url);
  lines.push(formatAnalyzedAt(entry.analyzedAt));
  lines.push('');
  for (const card of entry.cards) {
    lines.push(`> ${card.anchor.replace(/\r?\n/g, ' ').trim()}`);
    lines.push('');
    lines.push(`— ${card.gist.trim()}`);
    lines.push('');
  }
  return lines.join('\n');
}

export type HistoryJsonExport = {
  exportedAt: number;
  schemaVersion: 1;
  entries: ReadonlyArray<{
    pageKey: string;
    url: string;
    title: string;
    analyzedAt: number;
    cardCount: number;
    cards: readonly Card[];
  }>;
};

export function entriesToJson(entries: ReadonlyArray<HistoryEntry>, now = Date.now()): string {
  const payload: HistoryJsonExport = {
    exportedAt: now,
    schemaVersion: 1,
    entries: entries.map((e) => ({
      pageKey: e.pageKey,
      url: e.url,
      title: e.title,
      analyzedAt: e.analyzedAt,
      cardCount: e.cardCount,
      cards: e.cards,
    })),
  };
  return JSON.stringify(payload, null, 2);
}
