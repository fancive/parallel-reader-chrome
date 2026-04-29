import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

const tmpRoot = join(process.cwd(), '.tmp');
await mkdir(tmpRoot, { recursive: true });
const tempDir = await mkdtemp(join(tmpRoot, 'parallel-reader-prompt-'));
const outfile = join(tempDir, 'prompt.mjs');

await build({
  entryPoints: [join(process.cwd(), 'src', 'shared', 'prompt.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  logLevel: 'silent',
});

const { buildPrompts } = await import(pathToFileURL(outfile));

test.after(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

const baseSettings = {
  apiKey: 'sk-test',
  baseUrl: 'https://example.test/v1',
  model: 'test-model',
  minCards: 4,
  maxCards: 8,
  maxDocChars: 20000,
  summaryLanguage: 'zh-CN',
  cardDensity: 'normal',
};

test('buildPrompts defaults to Chinese summaries and normal density', () => {
  const { system } = buildPrompts('Example article body', baseSettings);

  assert.match(system, /title\/gist\/bullets 必须使用简体中文/);
  assert.match(system, /每张卡 3-6 条 bullet/);
});

test('buildPrompts supports English summaries deliberately', () => {
  const { system } = buildPrompts('Example article body', {
    ...baseSettings,
    summaryLanguage: 'en',
  });

  assert.match(system, /title\/gist\/bullets must be written in English/);
  assert.match(system, /3-8 English words/);
  assert.match(system, /Browser entry point/);
});

test('buildPrompts applies concise and detailed density settings', () => {
  const concise = buildPrompts('Example article body', {
    ...baseSettings,
    cardDensity: 'concise',
  });
  const detailed = buildPrompts('Example article body', {
    ...baseSettings,
    cardDensity: 'detailed',
  });

  assert.match(concise.system, /每张卡 2-4 条 bullet/);
  assert.match(detailed.system, /每张卡 4-8 条 bullet/);
});
