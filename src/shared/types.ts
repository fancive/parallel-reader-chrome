import { z } from 'zod';

export const CardSchema = z.object({
  title: z.string().min(1),
  anchor: z.string().min(1),
  gist: z.string().min(1),
  bullets: z.array(z.string()).default([]),
});

export const CardsResponseSchema = z.object({
  cards: z.array(CardSchema),
});

export type Card = z.infer<typeof CardSchema>;

export const SummaryLanguageSchema = z.enum(['zh-CN', 'en']);
export type SummaryLanguage = z.infer<typeof SummaryLanguageSchema>;

export const CardDensitySchema = z.enum(['concise', 'normal', 'detailed']);
export type CardDensity = z.infer<typeof CardDensitySchema>;

export const CACHE_TTL_DAYS_DEFAULT = 7;
export const CACHE_TTL_DAYS_MIN = 1;
export const CACHE_TTL_DAYS_MAX = 90;

export const ProviderSettingsSchema = z.object({
  apiKey: z.string().default(''),
  baseUrl: z.string().default('https://api.deepseek.com/v1'),
  model: z.string().default('deepseek-chat'),
  minCards: z.number().int().min(1).default(4),
  maxCards: z.number().int().min(1).default(10),
  maxDocChars: z.number().int().min(500).default(20000),
  summaryLanguage: SummaryLanguageSchema.default('zh-CN'),
  cardDensity: CardDensitySchema.default('normal'),
  cacheTtlDays: z
    .number()
    .int()
    .min(CACHE_TTL_DAYS_MIN)
    .max(CACHE_TTL_DAYS_MAX)
    .default(CACHE_TTL_DAYS_DEFAULT),
}).superRefine((settings, ctx) => {
  if (settings.maxCards < settings.minCards) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['maxCards'],
      message: 'maxCards must be greater than or equal to minCards',
    });
  }
});

export type ProviderSettings = z.infer<typeof ProviderSettingsSchema>;

export const SETTINGS_KEY = 'parallel-reader-settings';
export const PAGE_STATE_PREFIX = 'parallel-reader-page:';
export const CACHE_SCHEMA_VERSION = 2;

export const PENDING_ANALYZE_KEY = 'parallel-reader-pending-analyze';
export const PENDING_ANALYZE_MSG = 'pending-analyze' as const;
export const PENDING_ANALYZE_TTL_MS = 5_000;

export const PendingAnalyzeRequestSchema = z.object({
  tabId: z.number().int().nonnegative(),
  url: z.string().min(1),
  nonce: z.string().min(1),
  ts: z.number().int().nonnegative(),
});

export type PendingAnalyzeRequest = z.infer<typeof PendingAnalyzeRequestSchema>;

export type PendingAnalyzeMessage = Readonly<{
  type: typeof PENDING_ANALYZE_MSG;
  request: PendingAnalyzeRequest;
}>;

export type PendingAnalyzeAck = Readonly<{ ok: true } | { ok: false; error: string }>;

export type AnalyzeRequest = {
  type: 'analyze';
  rawText: string;
  readabilityText: string;
};

export type AnalyzeResponse =
  | { ok: true; cards: readonly Card[]; usedText: 'raw' | 'readability' }
  | { ok: false; error: string };

export type LocateRequest = {
  type: 'locate';
  anchor: string;
};

export type LocateResponse = {
  rawHit: boolean;
  readabilityHit: boolean;
  domRange: boolean;
  rawIndex: number;
  readabilityIndex: number;
};

export type HighlightRequest = {
  type: 'highlight';
  anchor: string;
};

export type ExtractRequest = {
  type: 'extract';
};

export type ExtractResponse = {
  rawText: string;
  readabilityText: string;
  url: string;
  title: string;
};
