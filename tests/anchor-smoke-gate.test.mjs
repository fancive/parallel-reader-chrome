import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const tmpRoot = join(process.cwd(), '.tmp');
await mkdir(tmpRoot, { recursive: true });
const tempDir = await mkdtemp(join(tmpRoot, 'parallel-reader-anchor-smoke-gate-'));
const outfile = join(tempDir, 'anchor-smoke-runner.mjs');

await build({
  entryPoints: [join(process.cwd(), 'scripts', 'anchor-smoke-runner.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['esbuild', 'playwright-core'],
  logLevel: 'silent',
});

const { evaluateSmokeGate, main, parseArgs, usage } = await import(pathToFileURL(outfile));

test.after(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test('anchor smoke CLI documents and parses regression thresholds', async () => {
  assert.match(usage(), /--min-dom-hit-rate/);
  assert.match(usage(), /--min-readable-chars/);
  assert.match(usage(), /--gate-report/);

  const opts = await parseArgs([
    '--min-dom-hit-rate',
    '95%',
    '--min-readable-chars',
    '1200',
    'https://example.com/article',
  ]);

  assert.equal(opts.minDomHitRate, 0.95);
  assert.equal(opts.minReadableChars, 1200);
  assert.deepEqual(opts.urls, ['https://example.com/article']);
});

test('anchor smoke gate passes when extraction and DOM hit rate satisfy thresholds', () => {
  const failures = evaluateSmokeGate(
    [
      {
        url: 'https://example.com/pass',
        usedText: 'readability',
        rawTextLength: 800,
        readabilityTextLength: 1800,
        cards: [],
        stats: { total: 4, rawHits: 4, readabilityHits: 4, domRangeHits: 4 },
      },
    ],
    { minDomHitRate: 1, minReadableChars: 1200 },
  );

  assert.deepEqual(failures, []);
});

test('anchor smoke gate reports threshold failures without rerunning the browser', () => {
  const failures = evaluateSmokeGate(
    [
      {
        url: 'https://example.com/fail',
        usedText: 'readability',
        rawTextLength: 600,
        readabilityTextLength: 900,
        cards: [],
        stats: { total: 5, rawHits: 5, readabilityHits: 5, domRangeHits: 3 },
      },
      {
        url: 'https://example.com/error',
        cards: [],
        error: 'Page has no readable text',
      },
    ],
    { minDomHitRate: 0.9, minReadableChars: 1200 },
  );

  assert.deepEqual(
    failures.map((failure) => failure.reason),
    ['readable-chars', 'dom-hit-rate', 'page-error'],
  );
  assert.match(failures[0].message, /below required 1200/);
  assert.match(failures[1].message, /below required 90%/);
  assert.match(failures[2].message, /Page has no readable text/);
});

test('anchor smoke gate report mode sets a non-zero exit code on regression', async () => {
  const reportPath = join(tempDir, 'gate-report.json');
  await writeFile(
    reportPath,
    JSON.stringify({
      pages: [
        {
          url: 'https://example.com/regression',
          usedText: 'readability',
          rawTextLength: 500,
          readabilityTextLength: 800,
          cards: [],
          stats: { total: 4, rawHits: 4, readabilityHits: 4, domRangeHits: 2 },
        },
      ],
    }),
  );

  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  await main(['--gate-report', reportPath, '--min-dom-hit-rate', '90%', '--min-readable-chars', '1200']);
  assert.equal(process.exitCode, 1);
  process.exitCode = previousExitCode;
});
