import type { ExtractedTextVersion } from '../shared/extraction-quality';
import {
  CACHE_SCHEMA_VERSION,
  type Card,
  type LocateResponse,
  PAGE_STATE_PREFIX,
} from '../shared/types';
import type { PageIdentity } from './page-identity';

export type CardResult = { card: Card; locate: LocateResponse };

export type PageMeta = {
  title: string;
  url: string;
  rawTextLength: number;
  readabilityTextLength: number;
};

export type PageStateV2 = {
  schemaVersion: 2;
  page: PageIdentity;
  meta: PageMeta;
  usedText: ExtractedTextVersion;
  results: readonly CardResult[];
  analyzedAt: number;
  cachedAt: number;
  // Empty string means "no fingerprint recorded yet" (e.g. v1 entries migrated
  // forward in-place — see loadPageState). Mismatch checks are skipped for the
  // empty-fingerprint case; the next save populates it.
  fingerprint: string;
};

export type PageState = PageStateV2;

type StorageRecord = Record<string, unknown>;

export function pageStateStorageKey(pageKey: string): string {
  return `${PAGE_STATE_PREFIX}${pageKey}`;
}

export function legacyPageStateStorageKey(tabId: number, url: string): string {
  return `${PAGE_STATE_PREFIX}${tabId}:${url}`;
}

export function ttlMs(ttlDays: number): number {
  return Math.max(1, ttlDays) * 24 * 60 * 60 * 1000;
}

export function isExpired(state: Readonly<PageState>, ttlDays: number, now: number): boolean {
  const age = now - (state.cachedAt ?? state.analyzedAt ?? 0);
  return age > ttlMs(ttlDays);
}

export function fingerprintMatches(
  state: Readonly<PageState>,
  liveFingerprint: string,
): boolean {
  // Empty fingerprint (e.g. backfilled v1 entry) cannot be validated; treat as
  // a match so users can still see the cached cards once. Next analyze rewrites
  // with a real fingerprint.
  if (!state.fingerprint) return true;
  return state.fingerprint === liveFingerprint;
}

/**
 * Migrate a stored entry (any shape) forward to the current schema, or return
 * null when the entry is unrecoverable. Decision: v1 (no schemaVersion) entries
 * are migrated in-place — we backfill `cachedAt`/`schemaVersion`/`fingerprint`
 * with safe defaults rather than dropping cards the user already paid an LLM
 * call to produce. The empty-fingerprint sentinel suppresses the mismatch
 * check on first read; the next successful analyze writes a real fingerprint.
 */
export function migrateEntry(raw: unknown): PageState | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const entry = raw as Record<string, unknown>;
  if (!entry.page || !entry.meta || !Array.isArray(entry.results)) return null;
  const version = typeof entry.schemaVersion === 'number' ? entry.schemaVersion : 1;
  if (version > CACHE_SCHEMA_VERSION) return null;
  if (version === CACHE_SCHEMA_VERSION) return entry as unknown as PageState;
  // v1 -> v2: backfill cachedAt from analyzedAt, leave fingerprint empty.
  const analyzedAt = typeof entry.analyzedAt === 'number' ? entry.analyzedAt : Date.now();
  const migrated: PageState = {
    ...(entry as unknown as PageState),
    schemaVersion: CACHE_SCHEMA_VERSION,
    cachedAt: analyzedAt,
    fingerprint: '',
  };
  return migrated;
}

export type LoadPageStateOptions = {
  ttlDays: number;
  now: number;
};

export type LoadPageStateResult =
  | { status: 'hit'; state: PageState }
  | { status: 'miss' }
  | { status: 'expired'; key: string }
  | { status: 'invalid'; key: string };

export async function loadPageStateRaw(
  storage: chrome.storage.StorageArea,
  legacyStorage: chrome.storage.StorageArea,
  page: Readonly<PageIdentity>,
): Promise<{ key: string; raw: unknown; legacy: boolean }> {
  const key = pageStateStorageKey(page.key);
  const stored = (await storage.get(key)) as StorageRecord;
  if (stored[key] !== undefined) return { key, raw: stored[key], legacy: false };
  const legacyKey = legacyPageStateStorageKey(page.tabId, page.url);
  const legacyStored = (await legacyStorage.get(legacyKey)) as StorageRecord;
  if (legacyStored[legacyKey] !== undefined) {
    return { key: legacyKey, raw: legacyStored[legacyKey], legacy: true };
  }
  return { key, raw: undefined, legacy: false };
}

export async function loadPageState(
  storage: chrome.storage.StorageArea,
  legacyStorage: chrome.storage.StorageArea,
  page: Readonly<PageIdentity>,
  options: Readonly<LoadPageStateOptions>,
): Promise<LoadPageStateResult> {
  const { key, raw, legacy } = await loadPageStateRaw(storage, legacyStorage, page);
  if (raw === undefined) return { status: 'miss' };
  const migrated = migrateEntry(raw);
  if (!migrated) {
    if (legacy) await legacyStorage.remove(key);
    else await storage.remove(key);
    return { status: 'invalid', key };
  }
  if (isExpired(migrated, options.ttlDays, options.now)) {
    if (legacy) await legacyStorage.remove(key);
    else await storage.remove(key);
    return { status: 'expired', key };
  }
  if (legacy) {
    await legacyStorage.remove(key);
    await savePageState(storage, { ...migrated, page });
  }
  return { status: 'hit', state: migrated };
}

export async function savePageState(
  storage: chrome.storage.StorageArea,
  state: Readonly<PageState>,
): Promise<void> {
  await storage.set({ [pageStateStorageKey(state.page.key)]: state });
}

export async function clearPageState(
  storage: chrome.storage.StorageArea,
  pageKey: string,
): Promise<void> {
  await storage.remove(pageStateStorageKey(pageKey));
}

export async function clearAllPageStates(
  storage: chrome.storage.StorageArea,
): Promise<number> {
  const all = (await storage.get(null)) as StorageRecord;
  const keys = Object.keys(all).filter((k) => k.startsWith(PAGE_STATE_PREFIX));
  if (keys.length > 0) await storage.remove(keys);
  return keys.length;
}

export function buildPageState(input: {
  page: PageIdentity;
  meta: PageMeta;
  usedText: ExtractedTextVersion;
  results: readonly CardResult[];
  fingerprint: string;
  now: number;
}): PageState {
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    page: input.page,
    meta: input.meta,
    usedText: input.usedText,
    results: input.results,
    analyzedAt: input.now,
    cachedAt: input.now,
    fingerprint: input.fingerprint,
  };
}
