import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

const tmpRoot = join(process.cwd(), '.tmp');
await mkdir(tmpRoot, { recursive: true });
const tempDir = await mkdtemp(join(tmpRoot, 'parallel-reader-settings-schema-'));
const outfile = join(tempDir, 'types.mjs');

await build({
  entryPoints: [join(process.cwd(), 'src', 'shared', 'types.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  logLevel: 'silent',
});

const { ProviderSettingsSchema } = await import(pathToFileURL(outfile));

test.after(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test('provider settings schema supplies usable defaults', () => {
  const settings = ProviderSettingsSchema.parse({});

  assert.equal(settings.baseUrl, 'https://api.deepseek.com/v1');
  assert.equal(settings.model, 'deepseek-chat');
  assert.equal(settings.minCards, 4);
  assert.equal(settings.maxCards, 10);
  assert.equal(settings.maxDocChars, 20000);
  assert.equal(settings.summaryLanguage, 'zh-CN');
  assert.equal(settings.cardDensity, 'normal');
});

test('provider settings schema rejects an inverted card range', () => {
  const parsed = ProviderSettingsSchema.safeParse({
    minCards: 8,
    maxCards: 4,
  });

  assert.equal(parsed.success, false);
  assert.deepEqual(parsed.error.issues[0]?.path, ['maxCards']);
  assert.match(parsed.error.issues[0]?.message ?? '', /greater than or equal/);
});

test('provider settings schema accepts explicit OpenAI-compatible provider config', () => {
  const settings = ProviderSettingsSchema.parse({
    apiKey: 'sk-test',
    baseUrl: 'https://dashscope.example.test/compatible-mode/v1',
    model: 'qwen3-coder-plus',
    minCards: 3,
    maxCards: 6,
    summaryLanguage: 'en',
    cardDensity: 'detailed',
    maxDocChars: 12000,
  });

  assert.equal(settings.apiKey, 'sk-test');
  assert.equal(settings.baseUrl, 'https://dashscope.example.test/compatible-mode/v1');
  assert.equal(settings.model, 'qwen3-coder-plus');
  assert.equal(settings.minCards, 3);
  assert.equal(settings.maxCards, 6);
  assert.equal(settings.summaryLanguage, 'en');
  assert.equal(settings.cardDensity, 'detailed');
  assert.equal(settings.maxDocChars, 12000);
});
