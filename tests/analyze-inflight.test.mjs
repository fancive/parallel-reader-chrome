import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const tmpRoot = join(process.cwd(), '.tmp');
await mkdir(tmpRoot, { recursive: true });
const tempDir = await mkdtemp(join(tmpRoot, 'parallel-reader-inflight-'));
const out = join(tempDir, 'analyze-inflight.mjs');

await build({
  entryPoints: [join(process.cwd(), 'src', 'shared', 'analyze-inflight.ts')],
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  logLevel: 'silent',
});

const {
  ANALYSIS_DONE_MSG,
  AnalysisDoneSchema,
  INFLIGHT_KEY_PREFIX,
  InflightEntrySchema,
  clearInflight,
  getInflight,
  inflightStorageKey,
  setInflight,
} = await import(pathToFileURL(out));

test.after(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function makeFakeStorage() {
  const store = new Map();
  return {
    store,
    get: async (key) => (store.has(key) ? { [key]: store.get(key) } : {}),
    set: async (obj) => {
      for (const [k, v] of Object.entries(obj)) store.set(k, v);
    },
    remove: async (key) => {
      const keys = Array.isArray(key) ? key : [key];
      for (const k of keys) store.delete(k);
    },
  };
}

const sampleCard = {
  title: 'A',
  anchor: 'A anchor',
  gist: 'A gist',
  bullets: [],
};

test('inflightStorageKey prefixes pageKey', () => {
  assert.equal(inflightStorageKey('https://x'), `${INFLIGHT_KEY_PREFIX}https://x`);
});

test('round-trip set/get/clear for analyzing phase', async () => {
  const storage = makeFakeStorage();
  await setInflight(storage, {
    phase: 'analyzing',
    pageKey: 'p1',
    tabId: 7,
    startedAt: 100,
  });
  const got = await getInflight(storage, 'p1');
  assert.deepEqual(got, { phase: 'analyzing', pageKey: 'p1', tabId: 7, startedAt: 100 });
  await clearInflight(storage, 'p1');
  assert.equal(await getInflight(storage, 'p1'), null);
});

test('round-trip set/get for locating phase carries cards + meta', async () => {
  const storage = makeFakeStorage();
  const entry = {
    phase: 'locating',
    pageKey: 'p2',
    tabId: 9,
    startedAt: 200,
    cards: [sampleCard],
    usedText: 'readability',
    meta: { title: 't', url: 'u', rawTextLength: 5, readabilityTextLength: 3 },
  };
  await setInflight(storage, entry);
  const got = await getInflight(storage, 'p2');
  assert.deepEqual(got, entry);
});

test('replacing inflight for same pageKey overwrites', async () => {
  const storage = makeFakeStorage();
  await setInflight(storage, { phase: 'analyzing', pageKey: 'p3', tabId: 1, startedAt: 10 });
  await setInflight(storage, { phase: 'analyzing', pageKey: 'p3', tabId: 1, startedAt: 20 });
  const got = await getInflight(storage, 'p3');
  assert.equal(got.startedAt, 20);
});

test('getInflight returns null and removes entry for malformed payload', async () => {
  const storage = makeFakeStorage();
  storage.store.set(inflightStorageKey('p4'), { phase: 'analyzing', tabId: 'not-a-number' });
  const got = await getInflight(storage, 'p4');
  assert.equal(got, null);
  assert.equal(storage.store.has(inflightStorageKey('p4')), false);
});

test('InflightEntrySchema rejects unknown phase', () => {
  const result = InflightEntrySchema.safeParse({
    phase: 'done',
    pageKey: 'p',
    tabId: 0,
    startedAt: 0,
  });
  assert.equal(result.success, false);
});

test('AnalysisDoneSchema accepts canonical message', () => {
  const result = AnalysisDoneSchema.safeParse({
    type: ANALYSIS_DONE_MSG,
    pageKey: 'p',
    tabId: 1,
  });
  assert.equal(result.success, true);
});

test('AnalysisDoneSchema rejects wrong type', () => {
  const result = AnalysisDoneSchema.safeParse({
    type: 'something-else',
    pageKey: 'p',
    tabId: 1,
  });
  assert.equal(result.success, false);
});
