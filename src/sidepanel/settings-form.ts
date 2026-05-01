import { t } from '../shared/i18n';
import { logWarn } from '../shared/logger';
import { type ProviderSettings, ProviderSettingsSchema, SETTINGS_KEY } from '../shared/types';
import { $ } from './dom';

export async function loadSettings(): Promise<ProviderSettings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const raw = (stored as Record<string, unknown>)[SETTINGS_KEY];
  const parsed = ProviderSettingsSchema.safeParse(raw ?? {});
  if (parsed.success) return parsed.data;
  logWarn('invalid stored settings; using defaults', parsed.error);
  return ProviderSettingsSchema.parse({});
}

export async function saveSettings(settings: ProviderSettings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

export type SettingsFormDeps = {
  setStatus: (text: string) => void;
  saveSettings: (settings: ProviderSettings) => Promise<void>;
  clearCurrentPage?: () => Promise<boolean>;
  clearAllPages?: () => Promise<number>;
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
  $<HTMLInputElement>('cache-ttl-days').value = String(initial.cacheTtlDays);

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
      cacheTtlDays: Number($<HTMLInputElement>('cache-ttl-days').value),
    });
    if (!parsed.success) {
      showSettingsError(
        t('settingsInvalid', [parsed.error.issues[0]?.message ?? t('settingsCheckInput')]),
        deps,
      );
      return;
    }
    clearSettingsError();
    await deps.saveSettings(parsed.data);
    deps.setStatus(t('settingsSaved'));
  });

  bindCacheControls(deps);
}

function setCacheStatus(text: string): void {
  const el = document.getElementById('cache-status');
  if (el) el.textContent = text;
}

function showInlineConfirm(confirmId: string): void {
  const el = document.getElementById(confirmId);
  if (el) el.hidden = false;
}

function hideInlineConfirm(confirmId: string): void {
  const el = document.getElementById(confirmId);
  if (el) el.hidden = true;
}

function bindCacheControls(deps: SettingsFormDeps): void {
  const currentBtn = document.getElementById('cache-clear-current');
  const currentYes = document.getElementById('cache-clear-current-yes');
  const currentNo = document.getElementById('cache-clear-current-no');
  if (currentBtn && currentYes && currentNo) {
    currentBtn.addEventListener('click', () => {
      setCacheStatus('');
      showInlineConfirm('cache-clear-current-confirm');
    });
    currentNo.addEventListener('click', () => {
      hideInlineConfirm('cache-clear-current-confirm');
    });
    currentYes.addEventListener('click', async () => {
      hideInlineConfirm('cache-clear-current-confirm');
      if (!deps.clearCurrentPage) return;
      const cleared = await deps.clearCurrentPage();
      setCacheStatus(cleared ? t('statusCacheClearedCurrent') : t('cacheStatusNoCache'));
    });
  }

  const allBtn = document.getElementById('cache-clear-all');
  const allYes = document.getElementById('cache-clear-all-yes');
  const allNo = document.getElementById('cache-clear-all-no');
  if (allBtn && allYes && allNo) {
    allBtn.addEventListener('click', () => {
      setCacheStatus('');
      showInlineConfirm('cache-clear-all-confirm');
    });
    allNo.addEventListener('click', () => {
      hideInlineConfirm('cache-clear-all-confirm');
    });
    allYes.addEventListener('click', async () => {
      hideInlineConfirm('cache-clear-all-confirm');
      if (!deps.clearAllPages) return;
      const removed = await deps.clearAllPages();
      setCacheStatus(t('cacheStatusClearedCount', [removed.toString()]));
    });
  }
}
