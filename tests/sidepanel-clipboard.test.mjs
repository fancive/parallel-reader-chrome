import assert from 'node:assert/strict';
import './helpers/i18n-mock.mjs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const tmpRoot = join(process.cwd(), '.tmp');
await mkdir(tmpRoot, { recursive: true });
const tempDir = await mkdtemp(join(tmpRoot, 'parallel-reader-clipboard-'));
const outfile = join(tempDir, 'menu.mjs');

await build({
  entryPoints: [join(process.cwd(), 'src', 'sidepanel', 'menu.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  logLevel: 'silent',
  // Stub browser globals so the module-level code doesn't crash at import time
  define: {
    'document': 'undefined',
    'window': 'undefined',
  },
});

const { cardSummaryText } = await import(pathToFileURL(outfile));

test.after(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test('cardSummaryText starts with 1-based index and title', () => {
  const card = { title: 'My Title', anchor: 'some anchor text', gist: 'Summary here', bullets: ['Point A', 'Point B'] };
  const text = cardSummaryText(card, 0);
  assert.ok(text.startsWith('1. My Title'), `Expected to start with "1. My Title", got: ${text}`);
});

test('cardSummaryText includes Quote line with anchor', () => {
  const card = { title: 'Title', anchor: 'the anchor', gist: 'Gist', bullets: [] };
  const text = cardSummaryText(card, 2);
  assert.ok(text.includes('Quote: the anchor'), `Expected Quote line, got: ${text}`);
});

test('cardSummaryText has blank line between title and Quote', () => {
  const card = { title: 'T', anchor: 'A', gist: 'G', bullets: [] };
  const text = cardSummaryText(card, 0);
  const lines = text.split('\n');
  assert.equal(lines[1], '', `Expected blank second line, got: ${JSON.stringify(lines[1])}`);
});

test('cardSummaryText prefixes bullets with "- "', () => {
  const card = { title: 'T', anchor: 'A', gist: 'G', bullets: ['First', 'Second'] };
  const text = cardSummaryText(card, 0);
  assert.ok(text.includes('- First'), 'Expected "- First" in output');
  assert.ok(text.includes('- Second'), 'Expected "- Second" in output');
});

test('cardSummaryText includes gist text', () => {
  const card = { title: 'T', anchor: 'A', gist: 'The main point', bullets: [] };
  const text = cardSummaryText(card, 0);
  assert.ok(text.includes('The main point'), 'Expected gist in output');
});

test('cardSummaryText uses correct 1-based index for any position', () => {
  const card = { title: 'Z', anchor: 'A', gist: 'G', bullets: [] };
  const text5 = cardSummaryText(card, 4);
  assert.ok(text5.startsWith('5. Z'), `Expected "5. Z", got: ${text5}`);
});
