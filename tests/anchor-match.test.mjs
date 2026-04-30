import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const tmpRoot = join(process.cwd(), '.tmp');
await mkdir(tmpRoot, { recursive: true });
const tempDir = await mkdtemp(join(tmpRoot, 'parallel-reader-anchor-match-'));
const outfile = join(tempDir, 'anchor.mjs');

await build({
  entryPoints: [join(process.cwd(), 'src', 'shared', 'anchor.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  logLevel: 'silent',
});

const { matchAnchor } = await import(pathToFileURL(outfile));

test.after(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test('matchAnchor reports the original source span for whitespace-normalized hits', () => {
  const text = 'Before Gemini\n\n    is not limited to one tab after.';
  const anchor = 'Gemini is not limited to one tab';

  const match = matchAnchor(text, anchor);

  assert.equal(match.hit, true);
  assert.equal(match.strategy, 'normalized');
  assert.equal(text.slice(match.index, match.index + match.matchedLength), 'Gemini\n\n    is not limited to one tab');
});
