import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const tmpRoot = join(process.cwd(), '.tmp');
await mkdir(tmpRoot, { recursive: true });
const tempDir = await mkdtemp(join(tmpRoot, 'parallel-reader-page-cache-'));
const outfile = join(tempDir, 'page-cache.mjs');

await build({
  entryPoints: [join(process.cwd(), 'src', 'sidepanel', 'page-cache.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  logLevel: 'silent',
});

const {
  buildPageState,
  clearAllPageStates,
  clearPageState,
  fingerprintMatches,
  isExpired,
  loadPageState,
  migrateEntry,
  pageStateStorageKey,
  savePageState,
} = await import(pathToFileURL(outfile));

test.after(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function makeStorage() {
  const data = new Map();
  return {
    data,
    async get(input) {
      if (input === null || input === undefined) {
        return Object.fromEntries(data);
      }
      if (typeof input === 'string') {
        return data.has(input) ? { [input]: data.get(input) } : {};
      }
      if (Array.isArray(input)) {
        const result = {};
        for (const key of input) {
          if (data.has(key)) result[key] = data.get(key);
        }
        return result;
      }
      return {};
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) {
        data.set(key, value);
      }
    },
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const key of list) data.delete(key);
    },
  };
}

const PAGE = { tabId: 1, url: 'https://example.com/a', title: 'A', key: 'https://example.com/a' };
const META = { title: 'A', url: PAGE.url, rawTextLength: 100, readabilityTextLength: 80 };
const RESULTS = [
  {
    card: { title: 'T', anchor: 'q', gist: 'g', bullets: [] },
    locate: { rawHit: true, readabilityHit: true, domRange: true, rawIndex: 0, readabilityIndex: 0 },
  },
];

const NOW = 1_700_000_000_000;
const ONE_DAY = 24 * 60 * 60 * 1000;

test('buildPageState produces a v2 entry with cachedAt and fingerprint', () => {
  const state = buildPageState({
    page: PAGE,
    meta: META,
    usedText: 'readability',
    results: RESULTS,
    fingerprint: 'abc123',
    now: NOW,
  });
  assert.equal(state.schemaVersion, 2);
  assert.equal(state.cachedAt, NOW);
  assert.equal(state.analyzedAt, NOW);
  assert.equal(state.fingerprint, 'abc123');
});

test('migrateEntry forwards a v1 entry by backfilling cachedAt and empty fingerprint', () => {
  const v1 = {
    page: PAGE,
    meta: META,
    usedText: 'readability',
    results: RESULTS,
    analyzedAt: NOW - ONE_DAY,
  };
  const migrated = migrateEntry(v1);
  assert.ok(migrated, 'expected migration to succeed');
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.cachedAt, NOW - ONE_DAY);
  assert.equal(migrated.fingerprint, '');
  assert.deepEqual(migrated.results, RESULTS);
});

test('migrateEntry returns null for unrecoverable shapes', () => {
  assert.equal(migrateEntry(null), null);
  assert.equal(migrateEntry({}), null);
  assert.equal(migrateEntry({ page: PAGE }), null);
  assert.equal(migrateEntry({ schemaVersion: 99, page: PAGE, meta: META, results: [] }), null);
});

test('migrateEntry returns v2 entry untouched', () => {
  const v2 = buildPageState({
    page: PAGE,
    meta: META,
    usedText: 'readability',
    results: RESULTS,
    fingerprint: 'fp',
    now: NOW,
  });
  const migrated = migrateEntry(v2);
  assert.deepEqual(migrated, v2);
});

test('isExpired flags entries older than TTL boundary', () => {
  const fresh = buildPageState({
    page: PAGE,
    meta: META,
    usedText: 'readability',
    results: RESULTS,
    fingerprint: 'fp',
    now: NOW - 6 * ONE_DAY,
  });
  const stale = buildPageState({
    page: PAGE,
    meta: META,
    usedText: 'readability',
    results: RESULTS,
    fingerprint: 'fp',
    now: NOW - 8 * ONE_DAY,
  });
  assert.equal(isExpired(fresh, 7, NOW), false);
  assert.equal(isExpired(stale, 7, NOW), true);
});

test('fingerprintMatches treats empty cached fingerprint as a match', () => {
  const state = { fingerprint: '' };
  assert.equal(fingerprintMatches(state, 'abc'), true);
});

test('fingerprintMatches detects mismatch', () => {
  assert.equal(fingerprintMatches({ fingerprint: 'aaa' }, 'bbb'), false);
  assert.equal(fingerprintMatches({ fingerprint: 'aaa' }, 'aaa'), true);
});

test('loadPageState returns hit for fresh v2 entry', async () => {
  const storage = makeStorage();
  const legacy = makeStorage();
  const state = buildPageState({
    page: PAGE,
    meta: META,
    usedText: 'readability',
    results: RESULTS,
    fingerprint: 'fp',
    now: NOW,
  });
  await savePageState(storage, state);
  const result = await loadPageState(storage, legacy, PAGE, { ttlDays: 7, now: NOW });
  assert.equal(result.status, 'hit');
  assert.equal(result.state.fingerprint, 'fp');
});

test('loadPageState drops and returns expired for stale entry past TTL', async () => {
  const storage = makeStorage();
  const legacy = makeStorage();
  const stale = buildPageState({
    page: PAGE,
    meta: META,
    usedText: 'readability',
    results: RESULTS,
    fingerprint: 'fp',
    now: NOW - 10 * ONE_DAY,
  });
  await savePageState(storage, stale);
  const result = await loadPageState(storage, legacy, PAGE, { ttlDays: 7, now: NOW });
  assert.equal(result.status, 'expired');
  assert.equal(storage.data.has(pageStateStorageKey(PAGE.key)), false);
});

test('loadPageState migrates v1 entries forward', async () => {
  const storage = makeStorage();
  const legacy = makeStorage();
  const v1 = {
    page: PAGE,
    meta: META,
    usedText: 'readability',
    results: RESULTS,
    analyzedAt: NOW - ONE_DAY,
  };
  await storage.set({ [pageStateStorageKey(PAGE.key)]: v1 });
  const result = await loadPageState(storage, legacy, PAGE, { ttlDays: 7, now: NOW });
  assert.equal(result.status, 'hit');
  assert.equal(result.state.schemaVersion, 2);
  assert.equal(result.state.fingerprint, '');
});

test('loadPageState rejects entries with future schemaVersion', async () => {
  const storage = makeStorage();
  const legacy = makeStorage();
  const future = {
    schemaVersion: 99,
    page: PAGE,
    meta: META,
    results: RESULTS,
    analyzedAt: NOW,
    cachedAt: NOW,
    fingerprint: 'fp',
    usedText: 'readability',
  };
  await storage.set({ [pageStateStorageKey(PAGE.key)]: future });
  const result = await loadPageState(storage, legacy, PAGE, { ttlDays: 7, now: NOW });
  assert.equal(result.status, 'invalid');
  assert.equal(storage.data.size, 0);
});

test('clearPageState removes only the targeted page', async () => {
  const storage = makeStorage();
  const stateA = buildPageState({
    page: PAGE,
    meta: META,
    usedText: 'readability',
    results: RESULTS,
    fingerprint: 'fp',
    now: NOW,
  });
  const otherPage = { ...PAGE, key: 'https://example.com/b', url: 'https://example.com/b' };
  const stateB = buildPageState({
    page: otherPage,
    meta: { ...META, url: otherPage.url },
    usedText: 'readability',
    results: RESULTS,
    fingerprint: 'fp',
    now: NOW,
  });
  await savePageState(storage, stateA);
  await savePageState(storage, stateB);

  await clearPageState(storage, PAGE.key);
  assert.equal(storage.data.has(pageStateStorageKey(PAGE.key)), false);
  assert.equal(storage.data.has(pageStateStorageKey(otherPage.key)), true);
});

test('clearAllPageStates wipes every page-state entry and reports count', async () => {
  const storage = makeStorage();
  const stateA = buildPageState({
    page: PAGE,
    meta: META,
    usedText: 'readability',
    results: RESULTS,
    fingerprint: 'fp',
    now: NOW,
  });
  const otherPage = { ...PAGE, key: 'https://example.com/b', url: 'https://example.com/b' };
  const stateB = buildPageState({
    page: otherPage,
    meta: { ...META, url: otherPage.url },
    usedText: 'readability',
    results: RESULTS,
    fingerprint: 'fp',
    now: NOW,
  });
  await savePageState(storage, stateA);
  await savePageState(storage, stateB);
  // Unrelated key must not be removed.
  await storage.set({ 'parallel-reader-settings': { keep: true } });

  const removed = await clearAllPageStates(storage);
  assert.equal(removed, 2);
  assert.equal(storage.data.has(pageStateStorageKey(PAGE.key)), false);
  assert.equal(storage.data.has(pageStateStorageKey(otherPage.key)), false);
  assert.equal(storage.data.has('parallel-reader-settings'), true);
});

test('loadPageState falls back to and clears legacy session storage entry', async () => {
  const storage = makeStorage();
  const legacy = makeStorage();
  const legacyState = buildPageState({
    page: PAGE,
    meta: META,
    usedText: 'readability',
    results: RESULTS,
    fingerprint: 'legacy-fp',
    now: NOW,
  });
  await legacy.set({ [`parallel-reader-page:${PAGE.tabId}:${PAGE.url}`]: legacyState });
  const result = await loadPageState(storage, legacy, PAGE, { ttlDays: 7, now: NOW });
  assert.equal(result.status, 'hit');
  assert.equal(result.state.fingerprint, 'legacy-fp');
  assert.equal(legacy.data.size, 0);
  assert.equal(storage.data.has(pageStateStorageKey(PAGE.key)), true);
});
