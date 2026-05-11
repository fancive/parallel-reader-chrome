import { t } from '../shared/i18n';
import { logWarn } from '../shared/logger';
import {
  type ApiFormat,
  CUSTOM_PRESET_ID,
  PROVIDER_PRESETS,
  getPreset,
  inferPresetFromUrl,
} from '../shared/provider';
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

function populatePresetOptions(select: HTMLSelectElement): void {
  select.textContent = '';
  for (const preset of PROVIDER_PRESETS) {
    const opt = document.createElement('option');
    opt.value = preset.id;
    opt.textContent = preset.label;
    select.appendChild(opt);
  }
  const custom = document.createElement('option');
  custom.value = CUSTOM_PRESET_ID;
  custom.textContent = t('apiPresetOptionCustom');
  select.appendChild(custom);
}

function bindPresetSelector(
  presetSelect: HTMLSelectElement,
  formatSelect: HTMLSelectElement,
  baseUrlInput: HTMLInputElement,
  modelInput: HTMLInputElement,
  initial: Readonly<ProviderSettings>,
): void {
  populatePresetOptions(presetSelect);
  presetSelect.value = inferPresetFromUrl(initial.baseUrl, initial.apiFormat);
  formatSelect.value = initial.apiFormat;

  // Picking a preset: overwrite format/baseUrl/model defaults so the user
  // doesn't have to retype them. Empty defaultModel (e.g. OpenRouter) leaves
  // model blank — user must fill it in.
  presetSelect.addEventListener('change', () => {
    if (presetSelect.value === CUSTOM_PRESET_ID) return;
    const preset = getPreset(presetSelect.value);
    if (!preset) return;
    formatSelect.value = preset.format;
    baseUrlInput.value = preset.baseUrl;
    modelInput.value = preset.defaultModel;
  });

  // Editing baseUrl manually drops back to "custom" so the selector doesn't
  // misleadingly show a brand name once the URL has drifted.
  const refreshPreset = () => {
    const format = formatSelect.value as ApiFormat;
    presetSelect.value = inferPresetFromUrl(baseUrlInput.value.trim(), format);
  };
  baseUrlInput.addEventListener('input', refreshPreset);
  formatSelect.addEventListener('change', refreshPreset);
}

export function bindSettingsForm(
  initial: Readonly<ProviderSettings>,
  deps: SettingsFormDeps,
): void {
  const apiKeyInput = $<HTMLInputElement>('api-key');
  const baseUrlInput = $<HTMLInputElement>('base-url');
  const modelInput = $<HTMLInputElement>('model');
  const presetSelect = $<HTMLSelectElement>('api-preset');
  const formatSelect = $<HTMLSelectElement>('api-format');

  apiKeyInput.value = initial.apiKey;
  baseUrlInput.value = initial.baseUrl;
  modelInput.value = initial.model;
  $<HTMLInputElement>('min-cards').value = String(initial.minCards);
  $<HTMLInputElement>('max-cards').value = String(initial.maxCards);
  $<HTMLSelectElement>('summary-language').value = initial.summaryLanguage;
  $<HTMLSelectElement>('card-density').value = initial.cardDensity;
  $<HTMLInputElement>('max-doc').value = String(initial.maxDocChars);
  $<HTMLInputElement>('cache-ttl-days').value = String(initial.cacheTtlDays);
  const uiLanguageSelect = document.getElementById('ui-language');
  if (uiLanguageSelect instanceof HTMLSelectElement) {
    uiLanguageSelect.value = initial.uiLanguage;
  }

  bindPresetSelector(presetSelect, formatSelect, baseUrlInput, modelInput, initial);

  $('settings-toggle').addEventListener('click', () => {
    const s = $('settings');
    s.hidden = !s.hidden;
  });

  $('settings-save').addEventListener('click', async () => {
    const uiLanguageEl = document.getElementById('ui-language');
    const uiLanguage =
      uiLanguageEl instanceof HTMLSelectElement ? uiLanguageEl.value : initial.uiLanguage;
    const parsed = ProviderSettingsSchema.safeParse({
      apiKey: apiKeyInput.value.trim(),
      baseUrl: baseUrlInput.value.trim(),
      model: modelInput.value.trim(),
      apiFormat: formatSelect.value,
      minCards: Number($<HTMLInputElement>('min-cards').value),
      maxCards: Number($<HTMLInputElement>('max-cards').value),
      summaryLanguage: $<HTMLSelectElement>('summary-language').value,
      uiLanguage,
      cardDensity: $<HTMLSelectElement>('card-density').value,
      maxDocChars: Number($<HTMLInputElement>('max-doc').value),
      cacheTtlDays: Number($<HTMLInputElement>('cache-ttl-days').value),
    });
    if (!parsed.success) {
      showSettingsError(
        t('settingsInvalid', {
          error: parsed.error.issues[0]?.message ?? t('settingsCheckInput'),
        }),
        deps,
      );
      return;
    }
    clearSettingsError();
    const localeChanged = parsed.data.uiLanguage !== initial.uiLanguage;
    await deps.saveSettings(parsed.data);
    deps.setStatus(t('settingsSaved'));
    if (localeChanged) {
      // Re-load so applyI18n picks up the new override and dynamic strings
      // already rendered re-render in the new locale.
      window.location.reload();
    }
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
      setCacheStatus(t('cacheStatusClearedCount', { count: removed }));
    });
  }
}
