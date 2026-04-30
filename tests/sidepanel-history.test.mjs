import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const tmpRoot = join(process.cwd(), '.tmp');
await mkdir(tmpRoot, { recursive: true });
const tempDir = await mkdtemp(join(tmpRoot, 'parallel-reader-history-'));
const outfile = join(tempDir, 'history.mjs');

await build({
  entryPoints: [join(process.cwd(), 'src', 'sidepanel', 'history.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  logLevel: 'silent',
  define: {
    document: 'undefined',
    window: 'undefined',
  },
});

const {
  clearAllHistory,
  deleteHistoryEntry,
  entriesToJson,
  entryToMarkdown,
  formatAnalyzedAt,
  listHistoryEntries,
  parseHistoryEntry,
  sanitizeFilename,
  truncateUrl,
} = await import(pathToFileURL(outfile));

test.after(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

const PREFIX = 'parallel-reader-page:';

function makeCard(overrides = {}) {
  return {
    title: 'Card title',
    anchor: 'verbatim quote',
    gist: 'short summary',
    bullets: ['point a', 'point b'],
    ...overrides,
  };
}

function makeEntry(url, options = {}) {
  return {
    page: { url, title: options.title ?? '', key: url },
    meta: { title: options.metaTitle ?? options.title ?? url, url },
    usedText: 'readability',
    results: (options.cards ?? [makeCard()]).map((card) => ({
      card,
      locate: { rawHit: true, readabilityHit: true, domRange: true, rawIndex: 0, readabilityIndex: 0 },
    })),
    analyzedAt: options.analyzedAt ?? 1_700_000_000_000,
  };
}

function makeStorage(initial) {
  const data = new Map(Object.entries(initial));
  return {
    storage: {
      async get(keys) {
        if (keys === null || keys === undefined) {
          return Object.fromEntries(data.entries());
        }
        if (typeof keys === 'string') {
          return data.has(keys) ? { [keys]: data.get(keys) } : {};
        }
        if (Array.isArray(keys)) {
          const out = {};
          for (const key of keys) {
            if (data.has(key)) out[key] = data.get(key);
          }
          return out;
        }
        return Object.fromEntries(data.entries());
      },
      async remove(keys) {
        const arr = Array.isArray(keys) ? keys : [keys];
        for (const key of arr) data.delete(key);
      },
    },
    data,
  };
}

test('listHistoryEntries returns N entries from storage prefixed keys', async () => {
  const { storage } = makeStorage({
    [`${PREFIX}https://a.example/`]: makeEntry('https://a.example/', { title: 'A', analyzedAt: 1000 }),
    [`${PREFIX}https://b.example/`]: makeEntry('https://b.example/', { title: 'B', analyzedAt: 3000 }),
    [`${PREFIX}https://c.example/`]: makeEntry('https://c.example/', { title: 'C', analyzedAt: 2000 }),
    'parallel-reader-settings': { apiKey: 'secret' },
  });

  const entries = await listHistoryEntries(storage);
  assert.equal(entries.length, 3);
  assert.deepEqual(
    entries.map((e) => e.title),
    ['B', 'C', 'A'],
    'expected entries sorted by analyzedAt desc',
  );
});

test('listHistoryEntries skips non-history keys and unparseable values', async () => {
  const { storage } = makeStorage({
    [`${PREFIX}https://ok.example/`]: makeEntry('https://ok.example/', { title: 'OK' }),
    [`${PREFIX}broken`]: 'not-an-object',
    [`${PREFIX}empty`]: { meta: {}, page: {} },
    'unrelated-key': { foo: 'bar' },
  });

  const entries = await listHistoryEntries(storage);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].title, 'OK');
});

test('deleteHistoryEntry removes that entry and re-list shrinks', async () => {
  const { storage, data } = makeStorage({
    [`${PREFIX}https://a/`]: makeEntry('https://a/', { title: 'A', analyzedAt: 1 }),
    [`${PREFIX}https://b/`]: makeEntry('https://b/', { title: 'B', analyzedAt: 2 }),
  });

  let entries = await listHistoryEntries(storage);
  assert.equal(entries.length, 2);

  await deleteHistoryEntry(storage, `${PREFIX}https://a/`);
  assert.equal(data.has(`${PREFIX}https://a/`), false);

  entries = await listHistoryEntries(storage);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].title, 'B');
});

test('clearAllHistory removes only history-prefixed keys', async () => {
  const { storage, data } = makeStorage({
    [`${PREFIX}https://a/`]: makeEntry('https://a/'),
    [`${PREFIX}https://b/`]: makeEntry('https://b/'),
    'parallel-reader-settings': { apiKey: 'keep' },
  });

  await clearAllHistory(storage);
  assert.equal(data.has(`${PREFIX}https://a/`), false);
  assert.equal(data.has(`${PREFIX}https://b/`), false);
  assert.equal(data.get('parallel-reader-settings').apiKey, 'keep');
});

test('parseHistoryEntry tolerates entries missing analyzedAt', () => {
  const raw = makeEntry('https://x/', { title: 'X' });
  delete raw.analyzedAt;
  const entry = parseHistoryEntry(`${PREFIX}https://x/`, raw);
  assert.ok(entry);
  assert.equal(entry.analyzedAt, 0);
});

test('parseHistoryEntry falls back to cachedAt when analyzedAt is missing', () => {
  const raw = makeEntry('https://x/', { title: 'X' });
  delete raw.analyzedAt;
  raw.cachedAt = 9_999;
  raw.schemaVersion = 2;
  raw.contentFingerprint = 'abc';
  const entry = parseHistoryEntry(`${PREFIX}https://x/`, raw);
  assert.ok(entry);
  assert.equal(entry.analyzedAt, 9_999);
});

test('parseHistoryEntry returns null for non-history keys', () => {
  const raw = makeEntry('https://x/');
  assert.equal(parseHistoryEntry('some-other-key', raw), null);
});

test('parseHistoryEntry returns null when url is missing everywhere', () => {
  const entry = parseHistoryEntry(`${PREFIX}empty`, { meta: {}, page: {} });
  assert.equal(entry, null);
});

test('formatAnalyzedAt returns 未知时间 for missing or zero timestamp', () => {
  assert.equal(formatAnalyzedAt(0), '未知时间');
  assert.equal(formatAnalyzedAt(undefined), '未知时间');
  assert.equal(formatAnalyzedAt(-1), '未知时间');
});

test('formatAnalyzedAt returns a non-empty stamp for a real timestamp', () => {
  const stamp = formatAnalyzedAt(1_700_000_000_000, 'en-US');
  assert.ok(stamp.length > 0);
  assert.notEqual(stamp, '未知时间');
});

test('truncateUrl shortens long URLs with ellipsis', () => {
  const url = `https://example.com/${'x'.repeat(200)}`;
  const out = truncateUrl(url, 40);
  assert.ok(out.length <= 40);
  assert.ok(out.includes('…'));
});

test('truncateUrl leaves short URLs untouched', () => {
  assert.equal(truncateUrl('https://a.io/', 64), 'https://a.io/');
});

test('sanitizeFilename strips path separators and trims', () => {
  const name = sanitizeFilename('Hello / World :*?"<>|.md');
  assert.ok(!name.includes('/'));
  assert.ok(!name.includes(':'));
  assert.ok(name.length > 0);
});

test('sanitizeFilename returns fallback when input is only invalid chars', () => {
  assert.equal(sanitizeFilename('////', 'fallback'), 'fallback');
});

test('entryToMarkdown formats each card as quote then em-dash summary', () => {
  const entry = {
    storageKey: `${PREFIX}https://x/`,
    pageKey: 'https://x/',
    url: 'https://x/',
    title: 'My Page',
    analyzedAt: 1_700_000_000_000,
    cardCount: 2,
    cards: [
      makeCard({ anchor: 'first quote', gist: 'first summary' }),
      makeCard({ anchor: 'second quote', gist: 'second summary' }),
    ],
  };
  const md = entryToMarkdown(entry);
  assert.ok(md.startsWith('# My Page'));
  assert.ok(md.includes('https://x/'));
  assert.ok(md.includes('> first quote'));
  assert.ok(md.includes('— first summary'));
  assert.ok(md.includes('> second quote'));
  assert.ok(md.includes('— second summary'));
});

test('entryToMarkdown collapses newlines inside anchor', () => {
  const entry = {
    storageKey: `${PREFIX}https://x/`,
    pageKey: 'https://x/',
    url: 'https://x/',
    title: 'P',
    analyzedAt: 1,
    cardCount: 1,
    cards: [makeCard({ anchor: 'line one\nline two', gist: 'g' })],
  };
  const md = entryToMarkdown(entry);
  assert.ok(md.includes('> line one line two'));
  assert.ok(!md.includes('> line one\nline two'));
});

test('entriesToJson exports schemaVersion and entry array', () => {
  const entries = [
    {
      storageKey: `${PREFIX}https://a/`,
      pageKey: 'https://a/',
      url: 'https://a/',
      title: 'A',
      analyzedAt: 1,
      cardCount: 1,
      cards: [makeCard()],
    },
    {
      storageKey: `${PREFIX}https://b/`,
      pageKey: 'https://b/',
      url: 'https://b/',
      title: 'B',
      analyzedAt: 2,
      cardCount: 0,
      cards: [],
    },
  ];
  const json = entriesToJson(entries, 12_345);
  const parsed = JSON.parse(json);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.exportedAt, 12_345);
  assert.equal(parsed.entries.length, 2);
  assert.equal(parsed.entries[0].url, 'https://a/');
  assert.equal(parsed.entries[0].cards.length, 1);
  assert.equal(parsed.entries[1].cardCount, 0);
});

test('entriesToJson is valid JSON even for an empty list', () => {
  const json = entriesToJson([], 0);
  const parsed = JSON.parse(json);
  assert.deepEqual(parsed.entries, []);
});
