import { repairCardAnchors } from '../anchor-repair';
import { t } from '../i18n';
import { extractJsonObject } from '../json-extract';
import { buildPrompts } from '../prompt';
import { type Card, CardsResponseSchema, type ProviderSettings } from '../types';
import type { ApiFormat, AuthType } from './types';

export type { ApiFormat, AuthType, ProviderPreset } from './types';
export { ApiFormatSchema } from './types';
export {
  CUSTOM_PRESET_ID,
  PROVIDER_PRESETS,
  getPreset,
  inferPresetFromUrl,
} from './presets';

const REQUEST_TIMEOUT_MS = 60_000;

const ANTHROPIC_TOOL_NAME = 'emit_cards';
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_MAX_TOKENS = 4096;
const GEMINI_MAX_TOKENS = 4096;

const CARDS_JSON_SCHEMA = {
  type: 'object',
  properties: {
    cards: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          anchor: { type: 'string' },
          gist: { type: 'string' },
          bullets: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'anchor', 'gist', 'bullets'],
      },
    },
  },
  required: ['cards'],
} as const;

interface CallContext {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

interface FormatHandler {
  build(system: string, user: string, settings: Readonly<ProviderSettings>): CallContext;
  parse(json: unknown, settings: Readonly<ProviderSettings>): unknown;
}

export async function callProvider(
  content: string,
  settings: Readonly<ProviderSettings>,
): Promise<readonly Card[]> {
  if (!settings.apiKey) throw new Error(t('providerErrorMissingApiKey'));
  if (!settings.baseUrl) throw new Error(t('providerErrorMissingBaseUrl'));

  const { system, user } = buildPrompts(content, settings);
  const handler = HANDLERS[settings.apiFormat];
  const ctx = handler.build(system, user, settings);

  const json = await postJson(ctx);
  const cardsPayload = handler.parse(json, settings);

  const parsed = CardsResponseSchema.safeParse(cardsPayload);
  if (!parsed.success) {
    throw new Error(
      t('providerErrorSchemaMismatch', { error: parsed.error.message.slice(0, 200) }),
    );
  }
  return repairCardAnchors(content, parsed.data.cards);
}

/* ---------- Auth & headers ---------- */

function authTypeForFormat(format: ApiFormat): AuthType {
  switch (format) {
    case 'anthropic-messages':
      return 'x-api-key';
    case 'google-generative-ai':
      return 'x-goog-api-key';
    default:
      return 'bearer';
  }
}

function authHeaders(settings: Readonly<ProviderSettings>): Record<string, string> {
  const auth = authTypeForFormat(settings.apiFormat);
  if (auth === 'none') return {};
  if (auth === 'bearer') return { authorization: `Bearer ${settings.apiKey}` };
  if (auth === 'x-api-key') return { 'x-api-key': settings.apiKey };
  return { 'x-goog-api-key': settings.apiKey };
}

function jsonHeaders(settings: Readonly<ProviderSettings>, extra?: Record<string, string>): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...authHeaders(settings),
    ...(extra ?? {}),
  };
}

/* ---------- URL helpers ---------- */

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function appendIfMissing(base: string, suffix: string): string {
  const trimmed = trimTrailingSlash(base);
  return trimmed.endsWith(suffix) ? trimmed : trimmed + suffix;
}

/* ---------- OpenAI chat completions ---------- */

const openAiHandler: FormatHandler = {
  build(system, user, settings) {
    return {
      url: appendIfMissing(settings.baseUrl, '/chat/completions'),
      headers: jsonHeaders(settings),
      body: {
        model: settings.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.3,
        stream: false,
      },
    };
  },
  parse(json) {
    const text = textFromOpenAiChat(json);
    if (!text) throw new Error(t('providerErrorEmptyResponse'));
    const obj = extractJsonObject(text);
    if (obj === undefined) {
      throw new Error(t('providerErrorJsonParse', { excerpt: text.slice(0, 200) }));
    }
    return obj;
  },
};

function textFromOpenAiChat(json: unknown): string {
  if (!isRecord(json)) return '';
  const err = (json as { error?: { message?: string } }).error;
  if (err?.message) throw new Error(err.message);
  const choices = json.choices;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const first = choices[0];
  if (!isRecord(first)) return '';
  const message = first.message;
  if (isRecord(message) && typeof message.content === 'string') return message.content;
  if (typeof first.text === 'string') return first.text;
  return '';
}

/* ---------- OpenAI Responses (also Volcengine Ark) ---------- */

const openAiResponsesHandler: FormatHandler = {
  build(system, user, settings) {
    return {
      url: appendIfMissing(settings.baseUrl, '/responses'),
      headers: jsonHeaders(settings),
      body: {
        model: settings.model,
        input: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        text: { format: { type: 'json_object' } },
        temperature: 0.3,
        stream: false,
      },
    };
  },
  parse(json) {
    const text = textFromOpenAiResponses(json);
    if (!text) throw new Error(t('providerErrorEmptyResponse'));
    const obj = extractJsonObject(text);
    if (obj === undefined) {
      throw new Error(t('providerErrorJsonParse', { excerpt: text.slice(0, 200) }));
    }
    return obj;
  },
};

function textFromOpenAiResponses(json: unknown): string {
  if (!isRecord(json)) return '';
  const err = (json as { error?: { message?: string } }).error;
  if (err?.message) throw new Error(err.message);
  if (typeof json.output_text === 'string' && json.output_text.length > 0) {
    return json.output_text;
  }
  const output = json.output;
  if (!Array.isArray(output)) return '';
  const parts: string[] = [];
  for (const item of output) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const block of item.content) {
      if (!isRecord(block)) continue;
      if (typeof block.text === 'string') parts.push(block.text);
    }
  }
  return parts.join('').trim();
}

/* ---------- Anthropic Messages ---------- */

const anthropicHandler: FormatHandler = {
  build(system, user, settings) {
    return {
      url: appendIfMissing(settings.baseUrl, '/messages'),
      headers: jsonHeaders(settings, { 'anthropic-version': ANTHROPIC_VERSION }),
      body: {
        model: settings.model,
        max_tokens: ANTHROPIC_MAX_TOKENS,
        system,
        messages: [{ role: 'user', content: user }],
        tools: [
          {
            name: ANTHROPIC_TOOL_NAME,
            description: 'Emit the card list for the article.',
            input_schema: CARDS_JSON_SCHEMA,
          },
        ],
        tool_choice: { type: 'tool', name: ANTHROPIC_TOOL_NAME },
      },
    };
  },
  parse(json) {
    const fromTool = cardsFromAnthropicToolUse(json);
    if (fromTool !== null) return fromTool;
    const text = textFromAnthropicMessages(json);
    if (!text) throw new Error(t('providerErrorEmptyResponse'));
    const obj = extractJsonObject(text);
    if (obj === undefined) {
      throw new Error(t('providerErrorJsonParse', { excerpt: text.slice(0, 200) }));
    }
    return obj;
  },
};

function cardsFromAnthropicToolUse(json: unknown): unknown {
  if (!isRecord(json) || !Array.isArray(json.content)) return null;
  for (const block of json.content) {
    if (!isRecord(block)) continue;
    if (block.type === 'tool_use' && block.name === ANTHROPIC_TOOL_NAME) {
      if (typeof block.input === 'string') {
        return extractJsonObject(block.input) ?? null;
      }
      if (isRecord(block.input)) return block.input;
    }
  }
  return null;
}

function textFromAnthropicMessages(json: unknown): string {
  if (!isRecord(json) || !Array.isArray(json.content)) return '';
  return json.content
    .map((block) => (isRecord(block) && typeof block.text === 'string' ? block.text : ''))
    .join('')
    .trim();
}

/* ---------- Google Gemini ---------- */

const geminiHandler: FormatHandler = {
  build(system, user, settings) {
    const model = encodeURIComponent(settings.model);
    const base = trimTrailingSlash(settings.baseUrl);
    const url = /:generateContent(?:\?|$)/.test(base)
      ? base
      : `${base}/models/${model}:generateContent`;
    return {
      url,
      headers: jsonHeaders(settings),
      body: {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: GEMINI_MAX_TOKENS,
          responseMimeType: 'application/json',
          responseJsonSchema: CARDS_JSON_SCHEMA,
        },
      },
    };
  },
  parse(json) {
    const text = textFromGemini(json);
    if (!text) throw new Error(t('providerErrorEmptyResponse'));
    const obj = extractJsonObject(text);
    if (obj === undefined) {
      throw new Error(t('providerErrorJsonParse', { excerpt: text.slice(0, 200) }));
    }
    return obj;
  },
};

function textFromGemini(json: unknown): string {
  if (!isRecord(json)) return '';
  const candidates = json.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return '';
  const first = candidates[0];
  if (!isRecord(first)) return '';
  const content = first.content;
  if (!isRecord(content) || !Array.isArray(content.parts)) return '';
  return content.parts
    .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
    .join('')
    .trim();
}

/* ---------- Dispatch ---------- */

const HANDLERS: Record<ApiFormat, FormatHandler> = {
  'openai-chat': openAiHandler,
  'openai-responses': openAiResponsesHandler,
  'anthropic-messages': anthropicHandler,
  'google-generative-ai': geminiHandler,
};

/* ---------- HTTP transport ---------- */

async function postJson(ctx: CallContext): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(ctx.url, {
      method: 'POST',
      headers: ctx.headers,
      body: JSON.stringify(ctx.body),
      signal: controller.signal,
    });
  } catch (error: unknown) {
    if (controller.signal.aborted) {
      throw new Error(
        t('providerErrorTimeout', { seconds: Math.round(REQUEST_TIMEOUT_MS / 1000) }),
      );
    }
    if (error instanceof TypeError) throw new Error(t('providerErrorNetwork'));
    throw error;
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) await throwHttpError(resp);
  return (await resp.json()) as unknown;
}

async function throwHttpError(resp: Response): Promise<never> {
  const status = resp.status;
  if (status === 401) throw new Error(t('providerErrorUnauthorized'));
  if (status === 403) throw new Error(t('providerErrorForbidden'));
  if (status === 429) {
    const retry = resp.headers.get('retry-after');
    const hint = retry ? t('providerErrorRetryAfter', { seconds: retry }) : '';
    throw new Error(t('providerErrorRateLimited', { hint }));
  }
  if (status === 408 || status === 504) {
    throw new Error(
      t('providerErrorTimeout', { seconds: Math.round(REQUEST_TIMEOUT_MS / 1000) }),
    );
  }
  if (status >= 500) throw new Error(t('providerErrorServer', { status }));
  const text = await resp.text().catch(() => '');
  throw new Error(t('providerErrorHttp', { status, excerpt: text.slice(0, 200) }));
}

/* ---------- Tiny helpers ---------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
