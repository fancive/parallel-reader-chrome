import { z } from 'zod';
import { CardSchema } from './types';

export const INFLIGHT_KEY_PREFIX = 'parallel-reader-inflight:';
export const ANALYSIS_DONE_MSG = 'analysis-done' as const;

export function inflightStorageKey(pageKey: string): string {
  return `${INFLIGHT_KEY_PREFIX}${pageKey}`;
}

const InflightMetaSchema = z.object({
  title: z.string(),
  url: z.string(),
  rawTextLength: z.number().int().nonnegative(),
  readabilityTextLength: z.number().int().nonnegative(),
});

const UsedTextSchema = z.enum(['raw', 'readability']);

const InflightAnalyzingSchema = z.object({
  phase: z.literal('analyzing'),
  pageKey: z.string().min(1),
  tabId: z.number().int().nonnegative(),
  startedAt: z.number().int().nonnegative(),
});

const InflightLocatingSchema = z.object({
  phase: z.literal('locating'),
  pageKey: z.string().min(1),
  tabId: z.number().int().nonnegative(),
  startedAt: z.number().int().nonnegative(),
  cards: z.array(CardSchema),
  usedText: UsedTextSchema,
  meta: InflightMetaSchema,
});

export const InflightEntrySchema = z.discriminatedUnion('phase', [
  InflightAnalyzingSchema,
  InflightLocatingSchema,
]);

export type InflightEntry = z.infer<typeof InflightEntrySchema>;
export type InflightAnalyzing = z.infer<typeof InflightAnalyzingSchema>;
export type InflightLocating = z.infer<typeof InflightLocatingSchema>;
export type InflightMeta = z.infer<typeof InflightMetaSchema>;

export const AnalysisDoneSchema = z.object({
  type: z.literal(ANALYSIS_DONE_MSG),
  pageKey: z.string().min(1),
  tabId: z.number().int().nonnegative(),
});

export type AnalysisDoneMessage = z.infer<typeof AnalysisDoneSchema>;

type StorageRecord = Record<string, unknown>;

export async function setInflight(
  storage: chrome.storage.StorageArea,
  entry: Readonly<InflightEntry>,
): Promise<void> {
  await storage.set({ [inflightStorageKey(entry.pageKey)]: entry });
}

export async function getInflight(
  storage: chrome.storage.StorageArea,
  pageKey: string,
): Promise<InflightEntry | null> {
  const key = inflightStorageKey(pageKey);
  const stored = (await storage.get(key)) as StorageRecord;
  const raw = stored[key];
  if (raw === undefined) return null;
  const parsed = InflightEntrySchema.safeParse(raw);
  if (!parsed.success) {
    await storage.remove(key);
    return null;
  }
  return parsed.data;
}

export async function clearInflight(
  storage: chrome.storage.StorageArea,
  pageKey: string,
): Promise<void> {
  await storage.remove(inflightStorageKey(pageKey));
}
