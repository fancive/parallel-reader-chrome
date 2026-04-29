import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

const tempDir = await mkdtemp(join(tmpdir(), 'parallel-reader-anchor-repair-'));
const outfile = join(tempDir, 'anchor-repair.mjs');

await build({
  entryPoints: [join(process.cwd(), 'src', 'shared', 'anchor-repair.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  logLevel: 'silent',
});

const { repairAnchor, repairCardAnchors } = await import(pathToFileURL(outfile));

test.after(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test('repairAnchor returns exact source substring for punctuation-normalized English anchors', () => {
  const text = 'Google says it’s also using AI to shore up Chrome’s security. Gemini tools can identify scams.';
  const anchor = "Google says it's also using AI to shore up Chrome's security.";

  const repaired = repairAnchor(text, anchor);

  assert.equal(repaired.hit, true);
  assert.equal(repaired.strategy, 'word-sequence');
  assert.equal(repaired.anchor, 'Google says it’s also using AI to shore up Chrome’s security');
  assert.ok(text.includes(repaired.anchor));
});

test('repairAnchor can recover a long shared word sequence from a drifted anchor', () => {
  const text = 'Gemini isn’t limited to your current tab. It can summarize a page and help compare open tabs.';
  const anchor = "Gemini isn't limited to your current tab. Google aims to make it possible to interact with other apps.";

  const repaired = repairAnchor(text, anchor);

  assert.equal(repaired.hit, true);
  assert.equal(repaired.anchor, 'Gemini isn’t limited to your current tab');
  assert.ok(text.includes(repaired.anchor));
});

test('repairCardAnchors leaves unrecoverable anchors explicit for UI miss handling', () => {
  const text = 'The article starts with a concrete observation about browsers and assistants.';
  const cards = [
    {
      title: 'Bad anchor',
      anchor: 'This sentence is not present anywhere in the source document.',
      gist: 'Anchor cannot be repaired',
      bullets: [],
    },
  ];

  const repaired = repairCardAnchors(text, cards);

  assert.equal(repaired[0].anchor, cards[0].anchor);
});
