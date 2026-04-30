import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

const tmpRoot = join(process.cwd(), '.tmp');
await mkdir(tmpRoot, { recursive: true });
const tempDir = await mkdtemp(join(tmpRoot, 'parallel-reader-pending-analyze-'));
const helperOut = join(tempDir, 'pending-analyze.mjs');
const typesOut = join(tempDir, 'types.mjs');

await build({
  entryPoints: [join(process.cwd(), 'src', 'shared', 'pending-analyze.ts')],
  outfile: helperOut,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  logLevel: 'silent',
});

await build({
  entryPoints: [join(process.cwd(), 'src', 'shared', 'types.ts')],
  outfile: typesOut,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  logLevel: 'silent',
});

const { buildPendingAnalyzeRequest } = await import(pathToFileURL(helperOut));
const { PendingAnalyzeRequestSchema } = await import(pathToFileURL(typesOut));

test.after(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test('buildPendingAnalyzeRequest returns request for normal tab', () => {
  const req = buildPendingAnalyzeRequest(
    { id: 42, url: 'https://example.com/article' },
    'nonce-1',
    1700000000000,
  );
  assert.ok(req);
  assert.equal(req.tabId, 42);
  assert.equal(req.url, 'https://example.com/article');
  assert.equal(req.nonce, 'nonce-1');
  assert.equal(req.ts, 1700000000000);
});

test('buildPendingAnalyzeRequest rejects missing tab id', () => {
  const req = buildPendingAnalyzeRequest({ url: 'https://example.com' }, 'n', 1);
  assert.equal(req, null);
});

test('buildPendingAnalyzeRequest rejects missing url', () => {
  const req = buildPendingAnalyzeRequest({ id: 1 }, 'n', 1);
  assert.equal(req, null);
});

test('buildPendingAnalyzeRequest rejects chrome:// urls', () => {
  const req = buildPendingAnalyzeRequest(
    { id: 1, url: 'chrome://extensions' },
    'n',
    1,
  );
  assert.equal(req, null);
});

test('buildPendingAnalyzeRequest auto-generates a fresh nonce', () => {
  const a = buildPendingAnalyzeRequest({ id: 1, url: 'https://a.test/' });
  const b = buildPendingAnalyzeRequest({ id: 1, url: 'https://a.test/' });
  assert.ok(a && b);
  assert.notEqual(a.nonce, b.nonce, 'two calls must generate different nonces');
  assert.match(a.nonce, /^[0-9a-f-]{36}$/i);
});

test('PendingAnalyzeRequestSchema accepts a well-formed payload', () => {
  const result = PendingAnalyzeRequestSchema.safeParse({
    tabId: 1,
    url: 'https://example.com/',
    nonce: 'x',
    ts: 1,
  });
  assert.equal(result.success, true);
});

test('PendingAnalyzeRequestSchema rejects missing fields', () => {
  const cases = [
    { url: 'https://x', nonce: 'x', ts: 1 },
    { tabId: 1, nonce: 'x', ts: 1 },
    { tabId: 1, url: 'https://x', ts: 1 },
    { tabId: 1, url: 'https://x', nonce: 'x' },
  ];
  for (const c of cases) {
    assert.equal(PendingAnalyzeRequestSchema.safeParse(c).success, false);
  }
});

test('PendingAnalyzeRequestSchema rejects legacy numeric storage value', () => {
  assert.equal(PendingAnalyzeRequestSchema.safeParse(1700000000000).success, false);
});
