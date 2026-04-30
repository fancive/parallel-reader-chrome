import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const tmpRoot = join(process.cwd(), '.tmp');
await mkdir(tmpRoot, { recursive: true });
const tempDir = await mkdtemp(join(tmpRoot, 'parallel-reader-fingerprint-'));
const outfile = join(tempDir, 'fingerprint.mjs');

await build({
  entryPoints: [join(process.cwd(), 'src', 'shared', 'fingerprint.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  logLevel: 'silent',
});

const { computeContentFingerprint } = await import(pathToFileURL(outfile));

test.after(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test('computeContentFingerprint returns a 16-char hex string', async () => {
  const fp = await computeContentFingerprint('Some article body.');
  assert.match(fp, /^[0-9a-f]{16}$/);
});

test('computeContentFingerprint is stable for identical input', async () => {
  const a = await computeContentFingerprint('The quick brown fox.');
  const b = await computeContentFingerprint('The quick brown fox.');
  assert.equal(a, b);
});

test('computeContentFingerprint is whitespace-tolerant', async () => {
  const a = await computeContentFingerprint('Hello  world');
  const b = await computeContentFingerprint('Hello world');
  const c = await computeContentFingerprint('  Hello\nworld\t');
  assert.equal(a, b);
  assert.equal(a, c);
});

test('computeContentFingerprint differs when content actually changes', async () => {
  const a = await computeContentFingerprint('Article version one.');
  const b = await computeContentFingerprint('Article version two.');
  assert.notEqual(a, b);
});
