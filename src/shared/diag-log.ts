import { z } from 'zod';

export const DIAG_LOG_KEY = 'parallel-reader-diag-log';
export const DIAG_LOG_CAPACITY = 200;

export const DiagEntrySchema = z.object({
  ts: z.number().int().nonnegative(),
  tag: z.string().min(1),
  payload: z.record(z.unknown()).default({}),
});

const DiagBufferSchema = z.array(DiagEntrySchema);

export type DiagEntry = z.infer<typeof DiagEntrySchema>;

type StorageRecord = Record<string, unknown>;

function pickStorage(): chrome.storage.StorageArea | null {
  if (typeof chrome === 'undefined' || !chrome.storage) return null;
  return chrome.storage.session ?? chrome.storage.local ?? null;
}

// Module-level promise chain so concurrent `diagAppend` calls serialize their
// read-modify-write of the ring buffer. Without this, two appends interleave
// (both read the same array, both `set`) and the second one silently drops
// the first — precisely when ring-buffer entries matter most.
let appendChain: Promise<void> = Promise.resolve();

async function appendOne(
  storage: chrome.storage.StorageArea,
  fullEntry: Readonly<DiagEntry>,
): Promise<void> {
  const existing = await diagSnapshot(storage);
  const next = [...existing, fullEntry];
  const trimmed = next.length > DIAG_LOG_CAPACITY
    ? next.slice(next.length - DIAG_LOG_CAPACITY)
    : next;
  await storage.set({ [DIAG_LOG_KEY]: trimmed });
}

export async function diagAppend(
  storage: chrome.storage.StorageArea | null,
  entry: Readonly<Omit<DiagEntry, 'ts'> & { ts?: number }>,
): Promise<void> {
  if (!storage) return;
  const fullEntry: DiagEntry = {
    ts: entry.ts ?? Date.now(),
    tag: entry.tag,
    payload: entry.payload ?? {},
  };
  const next = appendChain.then(() => appendOne(storage, fullEntry), () => appendOne(storage, fullEntry));
  appendChain = next.catch(() => undefined);
  return next;
}

export async function diagSnapshot(
  storage: chrome.storage.StorageArea | null,
): Promise<readonly DiagEntry[]> {
  if (!storage) return [];
  const stored = (await storage.get(DIAG_LOG_KEY)) as StorageRecord;
  const raw = stored[DIAG_LOG_KEY];
  if (raw === undefined) return [];
  const parsed = DiagBufferSchema.safeParse(raw);
  if (!parsed.success) {
    await storage.remove(DIAG_LOG_KEY);
    return [];
  }
  return parsed.data;
}

export async function diagClear(
  storage: chrome.storage.StorageArea | null,
): Promise<void> {
  if (!storage) return;
  await storage.remove(DIAG_LOG_KEY);
}

export function defaultDiagStorage(): chrome.storage.StorageArea | null {
  return pickStorage();
}
