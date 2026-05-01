import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import './helpers/i18n-mock.mjs';

const tmpRoot = join(process.cwd(), '.tmp');
await mkdir(tmpRoot, { recursive: true });
const tempDir = await mkdtemp(join(tmpRoot, 'parallel-reader-page-support-'));
const outfile = join(tempDir, 'page-support.mjs');

await build({
  entryPoints: [join(process.cwd(), 'src', 'shared', 'page-support.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  logLevel: 'silent',
});

const { contentScriptInjectionHint, unsupportedPageReason } = await import(pathToFileURL(outfile));

test.after(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test('unsupportedPageReason allows normal article URLs', () => {
  assert.equal(unsupportedPageReason('https://example.com/news/article'), null);
});

test('unsupportedPageReason explains browser internal pages', () => {
  const reason = unsupportedPageReason('chrome://extensions');

  assert.match(reason ?? '', /browser internal page or extension page/i);
  assert.match(reason ?? '', /switch to a regular web page/i);
});

test('unsupportedPageReason explains extension pages', () => {
  const reason = unsupportedPageReason('chrome-extension://abc123/sidepanel.html');

  assert.match(reason ?? '', /extension page/i);
});

test('unsupportedPageReason explains PDF pages', () => {
  const reason = unsupportedPageReason('https://example.com/report.PDF');

  assert.match(reason ?? '', /PDF/);
  assert.match(reason ?? '', /copyable text/i);
});

test('unsupportedPageReason allows file URLs so Chrome file-access settings can decide', () => {
  assert.equal(unsupportedPageReason('file:///Users/example/article.html'), null);
});

test('contentScriptInjectionHint explains file URL requirements after injection failure', () => {
  const hint = contentScriptInjectionHint('file:///Users/example/article.html');

  assert.match(hint, /Allow access to file URLs/i);
});
