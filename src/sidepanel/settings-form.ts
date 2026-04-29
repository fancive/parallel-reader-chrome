import { ProviderSettingsSchema, type ProviderSettings, SETTINGS_KEY } from '../shared/types';
import { $ } from './dom';

export async function loadSettings(): Promise<ProviderSettings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const raw = (stored as Record<string, unknown>)[SETTINGS_KEY];
  const parsed = ProviderSettingsSchema.safeParse(raw ?? {});
  if (parsed.success) return parsed.data;
  console.warn('[parallel-reader] invalid stored settings; using defaults', parsed.error);
  return ProviderSettingsSchema.parse({});
}

export async function saveSettings(settings: ProviderSettings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

export type SettingsFormDeps = {
  setStatus: (text: string) => void;
  saveSettings: (settings: ProviderSettings) => Promise<void>;
};

function showSettingsError(message: string, deps: SettingsFormDeps): void {
  deps.setStatus(message);
  const errorEl = document.getElementById('settings-error');
  if (errorEl) {
    errorEl.textContent = message;
    errorEl.hidden = false;
  }
}

function clearSettingsError(): void {
  const errorEl = document.getElementById('settings-error');
  if (errorEl) {
    errorEl.textContent = '';
    errorEl.hidden = true;
  }
}

export function bindSettingsForm(
  initial: Readonly<ProviderSettings>,
  deps: SettingsFormDeps,
): void {
  $<HTMLInputElement>('api-key').value = initial.apiKey;
  $<HTMLInputElement>('base-url').value = initial.baseUrl;
  $<HTMLInputElement>('model').value = initial.model;
  $<HTMLInputElement>('min-cards').value = String(initial.minCards);
  $<HTMLInputElement>('max-cards').value = String(initial.maxCards);
  $<HTMLSelectElement>('summary-language').value = initial.summaryLanguage;
  $<HTMLSelectElement>('card-density').value = initial.cardDensity;
  $<HTMLInputElement>('max-doc').value = String(initial.maxDocChars);

  $('settings-toggle').addEventListener('click', () => {
    const s = $('settings');
    s.hidden = !s.hidden;
  });

  $('settings-save').addEventListener('click', async () => {
    const parsed = ProviderSettingsSchema.safeParse({
      apiKey: $<HTMLInputElement>('api-key').value.trim(),
      baseUrl: $<HTMLInputElement>('base-url').value.trim(),
      model: $<HTMLInputElement>('model').value.trim(),
      minCards: Number($<HTMLInputElement>('min-cards').value),
      maxCards: Number($<HTMLInputElement>('max-cards').value),
      summaryLanguage: $<HTMLSelectElement>('summary-language').value,
      cardDensity: $<HTMLSelectElement>('card-density').value,
      maxDocChars: Number($<HTMLInputElement>('max-doc').value),
    });
    if (!parsed.success) {
      showSettingsError(
        `设置无效: ${parsed.error.issues[0]?.message ?? '请检查输入'}`,
        deps,
      );
      return;
    }
    clearSettingsError();
    await deps.saveSettings(parsed.data);
    deps.setStatus('设置已保存');
  });
}
