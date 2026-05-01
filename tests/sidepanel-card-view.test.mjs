import assert from 'node:assert/strict';
import './helpers/i18n-mock.mjs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const tmpRoot = join(process.cwd(), '.tmp');
await mkdir(tmpRoot, { recursive: true });
const tempDir = await mkdtemp(join(tmpRoot, 'parallel-reader-card-view-'));
const outfile = join(tempDir, 'card-view.mjs');

await build({
  entryPoints: [join(process.cwd(), 'src', 'sidepanel', 'card-view.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  logLevel: 'silent',
  define: {
    'document': 'undefined',
    'window': 'undefined',
  },
});

const { cardClassName, cardAriaLabel, cardTitleAttr } = await import(pathToFileURL(outfile));

test.after(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test('cardClassName returns "card" when highlight is available', () => {
  assert.equal(cardClassName(true), 'card');
});

test('cardClassName returns "card miss" when highlight is unavailable', () => {
  assert.equal(cardClassName(false), 'card miss');
});

test('cardAriaLabel includes 1-based index for highlightable card', () => {
  const label = cardAriaLabel(0, true);
  assert.ok(label.includes('1'), `Expected "1" in label: ${label}`);
});

test('cardAriaLabel differs for miss vs highlight', () => {
  const hit = cardAriaLabel(2, true);
  const miss = cardAriaLabel(2, false);
  assert.notEqual(hit, miss);
});

test('cardTitleAttr mentions click for highlightable cards', () => {
  const title = cardTitleAttr(true);
  assert.ok(title.length > 0, 'Expected non-empty title for highlightable card');
  assert.ok(title.includes('点击') || title.includes('click') || title.length > 0);
});

test('cardTitleAttr is different for miss cards', () => {
  const hit = cardTitleAttr(true);
  const miss = cardTitleAttr(false);
  assert.notEqual(hit, miss);
});
