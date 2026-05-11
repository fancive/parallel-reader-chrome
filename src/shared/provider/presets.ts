import type { ApiFormat, ProviderPreset } from './types';

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    format: 'openai-chat',
    authType: 'bearer',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    format: 'anthropic-messages',
    authType: 'x-api-key',
    baseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-sonnet-4-6',
    extraHeaders: { 'anthropic-version': '2023-06-01' },
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    format: 'google-generative-ai',
    authType: 'x-goog-api-key',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: 'gemini-2.5-pro',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    format: 'openai-chat',
    authType: 'bearer',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: '',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    format: 'openai-chat',
    authType: 'bearer',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
  },
  {
    id: 'volcengine-ark',
    label: 'Volcengine Ark (Doubao)',
    format: 'openai-responses',
    authType: 'bearer',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModel: '',
  },
] as const;

export const CUSTOM_PRESET_ID = 'custom';

export function getPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id);
}

/**
 * Best-effort reverse lookup: map a stored (baseUrl, format) pair back to a
 * preset id so the settings UI can highlight the right option after reload.
 * Returns CUSTOM_PRESET_ID when no preset matches.
 *
 * baseUrl comparison ignores trailing slashes; both stored and preset URLs are
 * normalized before comparing so 'https://api.openai.com/v1/' matches.
 */
export function inferPresetFromUrl(baseUrl: string, format: ApiFormat): string {
  const normalized = baseUrl.replace(/\/+$/, '');
  for (const preset of PROVIDER_PRESETS) {
    if (preset.format !== format) continue;
    if (preset.baseUrl.replace(/\/+$/, '') === normalized) return preset.id;
  }
  return CUSTOM_PRESET_ID;
}
