import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const tmpRoot = join(process.cwd(), '.tmp');
await mkdir(tmpRoot, { recursive: true });
const tempDir = await mkdtemp(join(tmpRoot, 'parallel-reader-idle-status-'));
const out = join(tempDir, 'idle-status.mjs');

await build({
  entryPoints: [join(process.cwd(), 'src', 'sidepanel', 'idle-status.ts')],
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  logLevel: 'silent',
});

const { selectIdleStatus } = await import(pathToFileURL(out));

test.after(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

const inflightAnalyzing = {
  phase: 'analyzing',
  pageKey: 'p',
  tabId: 1,
  startedAt: 0,
};

test('reading status with title when running locally', () => {
  const result = selectIdleStatus({
    inflight: null,
    runningLocally: true,
    title: 'Hello',
  });
  assert.deepEqual(result, { messageKey: 'statusReadingTitled', title: 'Hello' });
});

test('reading status without title when running locally', () => {
  const result = selectIdleStatus({
    inflight: null,
    runningLocally: true,
    title: '',
  });
  assert.deepEqual(result, { messageKey: 'statusReading' });
});

test('reading status when inflight present even without local flag', () => {
  const result = selectIdleStatus({
    inflight: inflightAnalyzing,
    runningLocally: false,
    title: 'X',
  });
  assert.deepEqual(result, { messageKey: 'statusReadingTitled', title: 'X' });
});

test('waiting status when neither inflight nor local with title', () => {
  const result = selectIdleStatus({
    inflight: null,
    runningLocally: false,
    title: 'Article',
  });
  assert.deepEqual(result, { messageKey: 'statusWaitingTitled', title: 'Article' });
});

test('waiting status when neither inflight nor local without title', () => {
  const result = selectIdleStatus({
    inflight: null,
    runningLocally: false,
    title: '',
  });
  assert.deepEqual(result, { messageKey: 'statusWaiting' });
});
