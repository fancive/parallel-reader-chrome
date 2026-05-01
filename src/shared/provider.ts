import { repairCardAnchors } from './anchor-repair';
import { t } from './i18n';
import { extractJsonObject } from './json-extract';
import { buildPrompts } from './prompt';
import { type Card, CardsResponseSchema, type ProviderSettings } from './types';

type OpenAIChoice = {
  message?: { content?: string };
};
type OpenAIResp = {
  choices?: readonly OpenAIChoice[];
  error?: { message?: string };
};

const REQUEST_TIMEOUT_MS = 60_000;

export async function callProvider(
  content: string,
  settings: Readonly<ProviderSettings>,
): Promise<readonly Card[]> {
  if (!settings.apiKey) throw new Error(t('providerErrorMissingApiKey'));
  if (!settings.baseUrl) throw new Error(t('providerErrorMissingBaseUrl'));

  const { system, user } = buildPrompts(content, settings);
  const url = `${settings.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const body = JSON.stringify({
    model: settings.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.3,
    stream: false,
  });

  const resp = await sendChatRequest(url, settings.apiKey, body);
  if (!resp.ok) await throwHttpError(resp);

  const json = (await resp.json()) as OpenAIResp;
  if (json.error?.message) throw new Error(json.error.message);

  const choice = json.choices?.[0]?.message?.content ?? '';
  if (!choice) throw new Error(t('providerErrorEmptyResponse'));

  const obj = extractJsonObject(choice);
  if (obj === undefined) throw new Error(t('providerErrorJsonParse', [choice.slice(0, 200)]));

  const parsed = CardsResponseSchema.safeParse(obj);
  if (!parsed.success) {
    throw new Error(
      t('providerErrorSchemaMismatch', [parsed.error.message.slice(0, 200)]),
    );
  }
  return repairCardAnchors(content, parsed.data.cards);
}

async function sendChatRequest(url: string, apiKey: string, body: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body,
      signal: controller.signal,
    });
  } catch (error: unknown) {
    if (controller.signal.aborted) {
      throw new Error(t('providerErrorTimeout', [String(Math.round(REQUEST_TIMEOUT_MS / 1000))]));
    }
    if (error instanceof TypeError) {
      throw new Error(t('providerErrorNetwork'));
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function throwHttpError(resp: Response): Promise<never> {
  const status = resp.status;
  if (status === 401) throw new Error(t('providerErrorUnauthorized'));
  if (status === 403) throw new Error(t('providerErrorForbidden'));
  if (status === 429) {
    const retry = resp.headers.get('retry-after');
    const hint = retry ? t('providerErrorRetryAfter', [retry]) : '';
    throw new Error(t('providerErrorRateLimited', [hint]));
  }
  if (status === 408 || status === 504) {
    throw new Error(t('providerErrorTimeout', [String(Math.round(REQUEST_TIMEOUT_MS / 1000))]));
  }
  if (status >= 500) throw new Error(t('providerErrorServer', [String(status)]));
  const text = await resp.text().catch(() => '');
  throw new Error(t('providerErrorHttp', [String(status), text.slice(0, 200)]));
}
