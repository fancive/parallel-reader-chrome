import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

const tmpRoot = join(process.cwd(), '.tmp');
await mkdir(tmpRoot, { recursive: true });
const tempDir = await mkdtemp(join(tmpRoot, 'parallel-reader-concurrency-'));
const outfile = join(tempDir, 'concurrency.mjs');

await build({
  entryPoints: [join(process.cwd(), 'src', 'sidepanel', 'concurrency.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  logLevel: 'silent',
});

const { runWithConcurrency, debounce } = await import(pathToFileURL(outfile));

test.after(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test('runWithConcurrency preserves original order', async () => {
  const items = [1, 2, 3, 4, 5];
  const results = await runWithConcurrency(items, 2, async (x) => x * 10);
  const values = results.map((r) => r.value);
  assert.deepEqual(values, [10, 20, 30, 40, 50]);
});

test('runWithConcurrency never exceeds concurrency limit', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const items = [1, 2, 3, 4, 5, 6, 7, 8];
  const concurrency = 3;

  await runWithConcurrency(items, concurrency, async (x) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight--;
    return x;
  });

  assert.ok(maxInFlight <= concurrency, `Max in-flight (${maxInFlight}) exceeded concurrency (${concurrency})`);
});

test('runWithConcurrency reports failures without cancelling others', async () => {
  const items = [1, 2, 3];
  const results = await runWithConcurrency(items, 2, async (x) => {
    if (x === 2) throw new Error('item 2 failed');
    return x * 10;
  });

  assert.equal(results[0]?.status, 'fulfilled');
  assert.equal(results[0]?.value, 10);
  assert.equal(results[1]?.status, 'rejected');
  assert.match(results[1]?.reason?.message ?? '', /item 2 failed/);
  assert.equal(results[2]?.status, 'fulfilled');
  assert.equal(results[2]?.value, 30);
});

test('runWithConcurrency handles empty input', async () => {
  const results = await runWithConcurrency([], 4, async (x) => x);
  assert.deepEqual(results, []);
});

test('debounce coalesces rapid calls and fires once', async () => {
  let callCount = 0;
  const fn = debounce(() => { callCount++; }, 30);

  fn();
  fn();
  fn();

  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(callCount, 1, `Expected 1 call, got ${callCount}`);
});

test('debounce fires again after quiet period', async () => {
  let callCount = 0;
  const fn = debounce(() => { callCount++; }, 20);

  fn();
  await new Promise((resolve) => setTimeout(resolve, 60));
  fn();
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(callCount, 2, `Expected 2 calls, got ${callCount}`);
});
