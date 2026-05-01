import assert from 'node:assert/strict';
import './helpers/i18n-mock.mjs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const tmpRoot = join(process.cwd(), '.tmp');
await mkdir(tmpRoot, { recursive: true });
const tempDir = await mkdtemp(join(tmpRoot, 'parallel-reader-sidepanel-pending-'));
const outfile = join(tempDir, 'page-identity.mjs');

await build({
  entryPoints: [join(process.cwd(), 'src', 'sidepanel', 'page-identity.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  logLevel: 'silent',
});

const { pageIdentityFromTab, buildPageKey } = await import(pathToFileURL(outfile));

test.after(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test('pageIdentityFromTab returns identity for a normal tab', () => {
  const id = pageIdentityFromTab({
    id: 7,
    url: 'https://example.com/article',
    title: 'Demo',
  });
  assert.equal(id.tabId, 7);
  assert.equal(id.url, 'https://example.com/article');
  assert.equal(id.title, 'Demo');
  assert.equal(id.key, buildPageKey('https://example.com/article'));
});

test('pageIdentityFromTab throws on missing tab id', () => {
  assert.throws(() => pageIdentityFromTab({ url: 'https://x' }), /No active tab/i);
});

test('pageIdentityFromTab throws on missing url', () => {
  assert.throws(() => pageIdentityFromTab({ id: 1 }), /no URL/i);
});

test('pageIdentityFromTab throws on chrome:// urls', () => {
  assert.throws(() => pageIdentityFromTab({ id: 1, url: 'chrome://extensions' }));
});

test('buildPageKey is stable for the same URL across tab ids', () => {
  const first = pageIdentityFromTab({
    id: 1,
    url: 'https://example.com/article',
    title: 'First',
  });
  const second = pageIdentityFromTab({
    id: 2,
    url: 'https://example.com/article',
    title: 'Second',
  });
  assert.equal(first.key, second.key);
  assert.equal(
    buildPageKey('https://example.com/'),
    buildPageKey('https://example.com/'),
  );
  assert.notEqual(
    buildPageKey('https://example.com/a'),
    buildPageKey('https://example.com/b'),
  );
});
