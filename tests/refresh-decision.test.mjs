import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const tmpRoot = join(process.cwd(), '.tmp');
await mkdir(tmpRoot, { recursive: true });
const tempDir = await mkdtemp(join(tmpRoot, 'parallel-reader-refresh-decision-'));
const out = join(tempDir, 'refresh-decision.mjs');

await build({
  entryPoints: [join(process.cwd(), 'src', 'sidepanel', 'refresh-decision.ts')],
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  logLevel: 'silent',
});

const { decideRefreshAction } = await import(pathToFileURL(out));

test.after(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function makeCached({ fingerprint = 'fpA' } = {}) {
  return {
    schemaVersion: 2,
    page: { tabId: 1, url: 'https://example.com/', title: 'Doc', key: 'https://example.com/' },
    meta: { title: 'Doc', url: 'https://example.com/', rawTextLength: 100, readabilityTextLength: 80 },
    usedText: 'readability',
    results: [],
    analyzedAt: 1000,
    cachedAt: 1000,
    fingerprint,
  };
}

function makeLocatingInflight({ pageKey = 'p', tabId = 1, cards = [{ title: 'a', anchor: 'a', gist: 'a', bullets: [] }] } = {}) {
  return {
    phase: 'locating',
    pageKey,
    tabId,
    startedAt: 1,
    cards,
    usedText: 'readability',
    meta: { title: 't', url: 'u', rawTextLength: 1, readabilityTextLength: 1 },
  };
}

function makeAnalyzingInflight({ pageKey = 'p', tabId = 1 } = {}) {
  return { phase: 'analyzing', pageKey, tabId, startedAt: 1 };
}

test('cached present with matching fingerprint -> render-cached', () => {
  const cached = makeCached({ fingerprint: 'fpA' });
  const decision = decideRefreshAction({
    cached,
    liveFingerprint: 'fpA',
    inflight: null,
    runningLocally: false,
    currentTabId: 1,
  });
  assert.equal(decision.kind, 'render-cached');
  assert.equal(decision.state, cached);
});

test('cached present with empty fingerprint (sentinel) -> render-cached even with mismatching live', () => {
  const cached = makeCached({ fingerprint: '' });
  const decision = decideRefreshAction({
    cached,
    liveFingerprint: 'fpDifferent',
    inflight: null,
    runningLocally: false,
    currentTabId: 1,
  });
  assert.equal(decision.kind, 'render-cached');
});

test('cached present with null liveFingerprint -> render-cached (skip check)', () => {
  const cached = makeCached({ fingerprint: 'fpA' });
  const decision = decideRefreshAction({
    cached,
    liveFingerprint: null,
    inflight: null,
    runningLocally: false,
    currentTabId: 1,
  });
  assert.equal(decision.kind, 'render-cached');
});

test('cached present + mismatching fingerprint -> show-stale', () => {
  const cached = makeCached({ fingerprint: 'fpA' });
  const decision = decideRefreshAction({
    cached,
    liveFingerprint: 'fpB',
    inflight: null,
    runningLocally: false,
    currentTabId: 1,
  });
  assert.equal(decision.kind, 'show-stale');
  assert.equal(decision.cachedFingerprint, 'fpA');
  assert.equal(decision.liveFingerprint, 'fpB');
});

test('cached present + inflight locating -> cached wins (render-cached, NOT resume)', () => {
  const cached = makeCached();
  const decision = decideRefreshAction({
    cached,
    liveFingerprint: 'fpA',
    inflight: makeLocatingInflight(),
    runningLocally: false,
    currentTabId: 1,
  });
  assert.equal(decision.kind, 'render-cached');
});

test('no cache + locating + not running + matching tabId -> resume-inflight', () => {
  const inflight = makeLocatingInflight({ tabId: 7 });
  const decision = decideRefreshAction({
    cached: null,
    liveFingerprint: null,
    inflight,
    runningLocally: false,
    currentTabId: 7,
  });
  assert.equal(decision.kind, 'resume-inflight');
  assert.equal(decision.entry, inflight);
});

test('no cache + locating + already running -> idle (race guard)', () => {
  const decision = decideRefreshAction({
    cached: null,
    liveFingerprint: null,
    inflight: makeLocatingInflight(),
    runningLocally: true,
    currentTabId: 1,
  });
  assert.equal(decision.kind, 'idle');
});

test('no cache + analyzing inflight -> idle (background still working; not our job to resume)', () => {
  const decision = decideRefreshAction({
    cached: null,
    liveFingerprint: null,
    inflight: makeAnalyzingInflight(),
    runningLocally: false,
    currentTabId: 1,
  });
  assert.equal(decision.kind, 'idle');
});

test('no cache + no inflight -> idle', () => {
  const decision = decideRefreshAction({
    cached: null,
    liveFingerprint: null,
    inflight: null,
    runningLocally: false,
    currentTabId: 1,
  });
  assert.equal(decision.kind, 'idle');
});

test('locating inflight from a different tab is NOT resumed', () => {
  const inflight = makeLocatingInflight({ tabId: 5 });
  const decision = decideRefreshAction({
    cached: null,
    liveFingerprint: null,
    inflight,
    runningLocally: false,
    currentTabId: 99,
  });
  assert.equal(decision.kind, 'idle');
});

test('locating inflight with null currentTabId (unbound panel) is still resumed', () => {
  // Unbound panel: no panelTabId in URL. Resume whatever locating marker
  // exists; the caller will dispatch locate against the currently-active tab.
  const inflight = makeLocatingInflight({ tabId: 5 });
  const decision = decideRefreshAction({
    cached: null,
    liveFingerprint: null,
    inflight,
    runningLocally: false,
    currentTabId: null,
  });
  assert.equal(decision.kind, 'resume-inflight');
});
