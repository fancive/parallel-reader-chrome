import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// Integration test: exercise the storage layer + refresh-decision resolver
// together on a fake chrome.storage shim. Validates that the flow used by
// sidepanel.ts (save / re-mount / refresh / resume) is correct without
// pulling in the DOM-bound sidepanel module itself.

const tmpRoot = join(process.cwd(), '.tmp');
await mkdir(tmpRoot, { recursive: true });
const tempDir = await mkdtemp(join(tmpRoot, 'parallel-reader-lifecycle-'));

async function bundleEsm(entry, basename) {
  const outfile = join(tempDir, `${basename}.mjs`);
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'silent',
  });
  return import(pathToFileURL(outfile));
}

const pageCache = await bundleEsm(join(process.cwd(), 'src', 'sidepanel', 'page-cache.ts'), 'page-cache');
const inflightMod = await bundleEsm(join(process.cwd(), 'src', 'shared', 'analyze-inflight.ts'), 'analyze-inflight');
const decisionMod = await bundleEsm(join(process.cwd(), 'src', 'sidepanel', 'refresh-decision.ts'), 'refresh-decision');

const {
  buildPageState,
  savePageState,
  loadPageState,
  pageStateStorageKey,
} = pageCache;
const {
  setInflight,
  getInflight,
  clearInflight,
  inflightStorageKey,
} = inflightMod;
const { decideRefreshAction } = decisionMod;

test.after(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function makeFakeStorage() {
  const store = new Map();
  const listeners = [];
  const area = {
    store,
    get: async (key) => {
      if (key === null || key === undefined) {
        return Object.fromEntries(store.entries());
      }
      if (Array.isArray(key)) {
        const out = {};
        for (const k of key) if (store.has(k)) out[k] = store.get(k);
        return out;
      }
      return store.has(key) ? { [key]: store.get(key) } : {};
    },
    set: async (obj) => {
      const changes = {};
      for (const [k, v] of Object.entries(obj)) {
        changes[k] = { oldValue: store.get(k), newValue: v };
        store.set(k, v);
      }
      for (const l of listeners) l(changes);
    },
    remove: async (key) => {
      const keys = Array.isArray(key) ? key : [key];
      const changes = {};
      for (const k of keys) {
        if (store.has(k)) {
          changes[k] = { oldValue: store.get(k), newValue: undefined };
          store.delete(k);
        }
      }
      if (Object.keys(changes).length > 0) {
        for (const l of listeners) l(changes);
      }
    },
    addListener: (l) => listeners.push(l),
  };
  return area;
}

function makePage(url = 'https://example.com/article') {
  return { tabId: 7, url, title: 'Article', key: url };
}

function makeCard(suffix = 'a') {
  return { title: `card-${suffix}`, anchor: `anchor-${suffix}`, gist: 'g', bullets: [] };
}

function makeResults(n) {
  return Array.from({ length: n }, (_, i) => ({
    card: makeCard(String(i)),
    locate: { rawHit: true, readabilityHit: true, domRange: true, rawIndex: 0, readabilityIndex: 0 },
  }));
}

async function loadOption({ storage, legacyStorage, page, ttlDays = 7, now }) {
  // Default `now` to slightly after a freshly-cached entry so well-formed
  // states from buildPageState({ now: 1_000_000 }) read as `hit`, not `expired`.
  return loadPageState(storage, legacyStorage, page, { ttlDays, now: now ?? 1_000_500 });
}

test('happy path: save -> remount -> render-cached', async () => {
  const local = makeFakeStorage();
  const session = makeFakeStorage();
  const page = makePage();

  // First "session": run finishes, savePageState writes to local.
  const state = buildPageState({
    page,
    meta: { title: page.title, url: page.url, rawTextLength: 100, readabilityTextLength: 80 },
    usedText: 'readability',
    results: makeResults(2),
    fingerprint: 'fp-alpha',
    now: 1_000_000,
  });
  await savePageState(local, state);

  // Second "session": fresh mount, refreshCurrentPage runs.
  const loadResult = await loadOption({ storage: local, legacyStorage: session, page });
  assert.equal(loadResult.status, 'hit');
  const inflight = await getInflight(session, page.key, 100);
  assert.equal(inflight, null);

  const decision = decideRefreshAction({
    cached: loadResult.state,
    liveFingerprint: 'fp-alpha',
    inflight,
    runningLocally: false,
    currentTabId: null,
  });
  assert.equal(decision.kind, 'render-cached');
  assert.equal(decision.state.results.length, 2);
});

test('resume-from-inflight: background completed before mount; resolver tells caller to resume', async () => {
  const local = makeFakeStorage();
  const session = makeFakeStorage();
  const page = makePage();

  // Background completed analyze and wrote locating marker, then sidepanel
  // unloaded before locate could finish.
  await setInflight(session, {
    phase: 'locating',
    pageKey: page.key,
    tabId: page.tabId,
    startedAt: 1_000_000,
    cards: [makeCard('1'), makeCard('2')],
    usedText: 'readability',
    meta: { title: page.title, url: page.url, rawTextLength: 100, readabilityTextLength: 80 },
  });

  const loadResult = await loadOption({ storage: local, legacyStorage: session, page });
  assert.equal(loadResult.status, 'miss');
  const inflight = await getInflight(session, page.key, 100);
  assert.equal(inflight?.phase, 'locating');

  const decision = decideRefreshAction({
    cached: null,
    liveFingerprint: null,
    inflight,
    runningLocally: false,
    currentTabId: null,
  });
  assert.equal(decision.kind, 'resume-inflight');
  assert.equal(decision.entry.cards.length, 2);
});

test('resume-from-inflight race: second concurrent refresh sees runningLocally=true and stays idle', async () => {
  const session = makeFakeStorage();
  const page = makePage();
  await setInflight(session, {
    phase: 'locating',
    pageKey: page.key,
    tabId: page.tabId,
    startedAt: 1,
    cards: [makeCard()],
    usedText: 'readability',
    meta: { title: 't', url: 'u', rawTextLength: 1, readabilityTextLength: 1 },
  });

  const inflight = await getInflight(session, page.key, 100);
  const first = decideRefreshAction({ cached: null, liveFingerprint: null, inflight, runningLocally: false, currentTabId: null });
  assert.equal(first.kind, 'resume-inflight');

  // Caller synchronously marks running, then second refresh fires.
  const second = decideRefreshAction({ cached: null, liveFingerprint: null, inflight, runningLocally: true, currentTabId: null });
  assert.equal(second.kind, 'idle');
});

test('resume completes: locate-only writes PageState and clears inflight', async () => {
  const local = makeFakeStorage();
  const session = makeFakeStorage();
  const page = makePage();

  await setInflight(session, {
    phase: 'locating',
    pageKey: page.key,
    tabId: page.tabId,
    startedAt: 1,
    cards: [makeCard('x'), makeCard('y')],
    usedText: 'readability',
    meta: { title: page.title, url: page.url, rawTextLength: 100, readabilityTextLength: 80 },
  });

  // Simulate resumeFromInflight body without DOM: save PageState with empty
  // fingerprint sentinel, then clear inflight.
  const inflight = await getInflight(session, page.key, 100);
  const state = buildPageState({
    page,
    meta: inflight.meta,
    usedText: inflight.usedText,
    results: inflight.cards.map((card) => ({
      card,
      locate: { rawHit: true, readabilityHit: true, domRange: true, rawIndex: 0, readabilityIndex: 0 },
    })),
    fingerprint: '',
    now: 2_000_000,
  });
  await savePageState(local, state);
  await clearInflight(session, page.key);

  // Next refresh after resume: render-cached, no inflight remaining.
  const loadResult = await loadOption({ storage: local, legacyStorage: session, page });
  assert.equal(loadResult.status, 'hit');
  assert.equal(loadResult.state.fingerprint, '');
  const inflightAfter = await getInflight(session, page.key);
  assert.equal(inflightAfter, null);
  const decision = decideRefreshAction({
    cached: loadResult.state,
    liveFingerprint: null,
    inflight: inflightAfter,
    runningLocally: false,
    currentTabId: null,
  });
  assert.equal(decision.kind, 'render-cached');
});

test('analyzing-orphan: no cache + analyzing inflight returns idle (does not resume)', async () => {
  const local = makeFakeStorage();
  const session = makeFakeStorage();
  const page = makePage();

  await setInflight(session, {
    phase: 'analyzing',
    pageKey: page.key,
    tabId: page.tabId,
    startedAt: 1,
  });

  const loadResult = await loadOption({ storage: local, legacyStorage: session, page });
  assert.equal(loadResult.status, 'miss');
  const inflight = await getInflight(session, page.key, 100);
  assert.equal(inflight?.phase, 'analyzing');

  const decision = decideRefreshAction({
    cached: null,
    liveFingerprint: null,
    inflight,
    runningLocally: false,
    currentTabId: null,
  });
  assert.equal(decision.kind, 'idle');
});

test('storage.onChanged-style dispatch: PageState write fires listener and resolver returns render-cached', async () => {
  const local = makeFakeStorage();
  const page = makePage();
  let lastChangedKey = null;
  local.addListener((changes) => {
    for (const k of Object.keys(changes)) {
      if (k === pageStateStorageKey(page.key)) lastChangedKey = k;
    }
  });

  const state = buildPageState({
    page,
    meta: { title: page.title, url: page.url, rawTextLength: 1, readabilityTextLength: 1 },
    usedText: 'readability',
    results: [],
    fingerprint: 'fp-beta',
    now: 1,
  });
  await savePageState(local, state);

  assert.equal(lastChangedKey, pageStateStorageKey(page.key));

  // After the listener fires, the caller re-runs decideRefreshAction with the
  // freshly loaded state and sees render-cached.
  const session = makeFakeStorage();
  const loadResult = await loadOption({ storage: local, legacyStorage: session, page });
  const decision = decideRefreshAction({
    cached: loadResult.state,
    liveFingerprint: 'fp-beta',
    inflight: null,
    runningLocally: false,
    currentTabId: null,
  });
  assert.equal(decision.kind, 'render-cached');
});

test('inflight write fires listener with the correct prefix', async () => {
  const session = makeFakeStorage();
  const observed = [];
  session.addListener((changes) => {
    for (const k of Object.keys(changes)) observed.push(k);
  });
  await setInflight(session, {
    phase: 'analyzing',
    pageKey: 'p1',
    tabId: 1,
    startedAt: 1,
  });
  assert.deepEqual(observed, [inflightStorageKey('p1')]);
});

test('TTL expiry: an old PageState is treated as miss and decision falls through to inflight branches', async () => {
  const local = makeFakeStorage();
  const session = makeFakeStorage();
  const page = makePage();
  const state = buildPageState({
    page,
    meta: { title: page.title, url: page.url, rawTextLength: 1, readabilityTextLength: 1 },
    usedText: 'readability',
    results: [],
    fingerprint: 'fp',
    now: 1, // ancient
  });
  await savePageState(local, state);
  const now = 1 + 8 * 24 * 60 * 60 * 1000; // 8 days later, TTL=7
  const loadResult = await loadOption({ storage: local, legacyStorage: session, page, ttlDays: 7, now });
  assert.equal(loadResult.status, 'expired');
  // After expiry, decision input becomes null cached. Inflight is also null -> idle.
  const decision = decideRefreshAction({
    cached: null,
    liveFingerprint: null,
    inflight: await getInflight(session, page.key),
    runningLocally: false,
    currentTabId: null,
  });
  assert.equal(decision.kind, 'idle');
});
