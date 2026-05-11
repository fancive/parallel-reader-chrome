import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const tmpRoot = join(process.cwd(), '.tmp');
await mkdir(tmpRoot, { recursive: true });
const tempDir = await mkdtemp(join(tmpRoot, 'parallel-reader-diag-log-'));
const out = join(tempDir, 'diag-log.mjs');

await build({
  entryPoints: [join(process.cwd(), 'src', 'shared', 'diag-log.ts')],
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  logLevel: 'silent',
});

const {
  DIAG_LOG_CAPACITY,
  DIAG_LOG_KEY,
  diagAppend,
  diagClear,
  diagSnapshot,
} = await import(pathToFileURL(out));

test.after(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function makeFakeStorage() {
  const store = new Map();
  return {
    store,
    get: async (key) => (store.has(key) ? { [key]: store.get(key) } : {}),
    set: async (obj) => {
      for (const [k, v] of Object.entries(obj)) store.set(k, v);
    },
    remove: async (key) => {
      const keys = Array.isArray(key) ? key : [key];
      for (const k of keys) store.delete(k);
    },
  };
}

test('diagAppend then diagSnapshot returns chronological entries', async () => {
  const storage = makeFakeStorage();
  await diagAppend(storage, { tag: 'a', payload: { x: 1 }, ts: 1 });
  await diagAppend(storage, { tag: 'b', payload: { x: 2 }, ts: 2 });
  await diagAppend(storage, { tag: 'c', payload: { x: 3 }, ts: 3 });
  const all = await diagSnapshot(storage);
  assert.equal(all.length, 3);
  assert.deepEqual(all.map((e) => e.tag), ['a', 'b', 'c']);
});

test('diagSnapshot is empty when no entries written', async () => {
  const storage = makeFakeStorage();
  const all = await diagSnapshot(storage);
  assert.deepEqual(all, []);
});

test('diagAppend wraps at DIAG_LOG_CAPACITY keeping most recent', async () => {
  const storage = makeFakeStorage();
  const N = DIAG_LOG_CAPACITY + 10;
  for (let i = 0; i < N; i += 1) {
    await diagAppend(storage, { tag: `t${i}`, payload: {}, ts: i });
  }
  const all = await diagSnapshot(storage);
  assert.equal(all.length, DIAG_LOG_CAPACITY);
  // oldest 10 should have been dropped
  assert.equal(all[0].tag, `t10`);
  assert.equal(all[all.length - 1].tag, `t${N - 1}`);
});

test('diagClear empties the ring buffer', async () => {
  const storage = makeFakeStorage();
  await diagAppend(storage, { tag: 'a', payload: {}, ts: 1 });
  await diagClear(storage);
  assert.deepEqual(await diagSnapshot(storage), []);
});

test('diagSnapshot returns [] and removes key on malformed payload', async () => {
  const storage = makeFakeStorage();
  storage.store.set(DIAG_LOG_KEY, [{ not: 'a-valid-entry' }]);
  const all = await diagSnapshot(storage);
  assert.deepEqual(all, []);
  assert.equal(storage.store.has(DIAG_LOG_KEY), false);
});

test('storage-less path is a no-op', async () => {
  await diagAppend(null, { tag: 'x', payload: {} });
  const all = await diagSnapshot(null);
  assert.deepEqual(all, []);
  await diagClear(null); // does not throw
});

test('diagAppend auto-fills ts when omitted', async () => {
  const storage = makeFakeStorage();
  const before = Date.now();
  await diagAppend(storage, { tag: 'a', payload: {} });
  const after = Date.now();
  const all = await diagSnapshot(storage);
  assert.equal(all.length, 1);
  assert.ok(all[0].ts >= before && all[0].ts <= after);
});

test('concurrent diagAppend calls all land (no read-modify-write race)', async () => {
  const storage = makeFakeStorage();
  // Fire 20 appends without awaiting; each should land thanks to the
  // module-level promise queue.
  const promises = [];
  for (let i = 0; i < 20; i += 1) {
    promises.push(diagAppend(storage, { tag: `c${i}`, payload: { i }, ts: i + 1 }));
  }
  await Promise.all(promises);
  const all = await diagSnapshot(storage);
  assert.equal(all.length, 20);
  // Order can be non-deterministic across event loop ticks; assert set equality
  // on tags.
  const tags = new Set(all.map((e) => e.tag));
  for (let i = 0; i < 20; i += 1) {
    assert.ok(tags.has(`c${i}`), `missing tag c${i} from serialized appends`);
  }
});
