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

export async function callProvider(
  content: string,
  settings: Readonly<ProviderSettings>,
): Promise<readonly Card[]> {
  if (!settings.apiKey) throw new Error(t('providerErrorMissingApiKey'));
  if (!settings.baseUrl) throw new Error(t('providerErrorMissingBaseUrl'));

  const { system, user } = buildPrompts(content, settings);
  const url = `${settings.baseUrl.replace(/\/$/, '')}/chat/completions`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({
      model: settings.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3,
      stream: false,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }

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
