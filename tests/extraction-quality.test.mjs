import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

const tmpRoot = join(process.cwd(), '.tmp');
await mkdir(tmpRoot, { recursive: true });
const tempDir = await mkdtemp(join(tmpRoot, 'parallel-reader-extraction-quality-'));
const outfile = join(tempDir, 'extraction-quality.mjs');

await build({
  entryPoints: [join(process.cwd(), 'src', 'shared', 'extraction-quality.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  logLevel: 'silent',
});

const { assessExtractionQuality, selectExtractedTextVersion } = await import(pathToFileURL(outfile));

test.after(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test('selectExtractedTextVersion uses readability only after the stable minimum', () => {
  assert.equal(selectExtractedTextVersion(200), 'raw');
  assert.equal(selectExtractedTextVersion(201), 'readability');
});

test('assessExtractionQuality warns on empty selected text', () => {
  const quality = assessExtractionQuality({
    rawTextLength: 0,
    readabilityTextLength: 0,
    usedText: 'raw',
  });

  assert.equal(quality.level, 'warn');
  assert.equal(quality.reason, 'empty');
});

test('assessExtractionQuality warns when the selected text is short', () => {
  const quality = assessExtractionQuality({
    rawTextLength: 5000,
    readabilityTextLength: 800,
    usedText: 'readability',
  });

  assert.equal(quality.level, 'warn');
  assert.equal(quality.reason, 'short-text');
  assert.equal(quality.selectedTextLength, 800);
});

test('assessExtractionQuality warns when analysis falls back to raw text', () => {
  const quality = assessExtractionQuality({
    rawTextLength: 5000,
    readabilityTextLength: 120,
    usedText: 'raw',
  });

  assert.equal(quality.level, 'warn');
  assert.equal(quality.reason, 'raw-fallback');
  assert.equal(quality.selectedTextLength, 5000);
});

test('assessExtractionQuality accepts long readability text', () => {
  const quality = assessExtractionQuality({
    rawTextLength: 6000,
    readabilityTextLength: 2500,
    usedText: 'readability',
  });

  assert.equal(quality.level, 'ok');
  assert.equal(quality.reason, 'ok');
  assert.equal(quality.selectedTextLength, 2500);
});
