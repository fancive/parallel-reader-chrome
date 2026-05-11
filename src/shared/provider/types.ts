import { z } from 'zod';

export const ApiFormatSchema = z.enum([
  'openai-chat',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
]);
export type ApiFormat = z.infer<typeof ApiFormatSchema>;

export type AuthType = 'bearer' | 'x-api-key' | 'x-goog-api-key' | 'none';

export interface ProviderPreset {
  readonly id: string;
  readonly label: string;
  readonly format: ApiFormat;
  readonly authType: AuthType;
  readonly baseUrl: string;
  readonly defaultModel: string;
  readonly extraHeaders?: Readonly<Record<string, string>>;
}
