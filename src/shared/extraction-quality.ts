import { t } from './i18n';

export type ExtractedTextVersion = 'raw' | 'readability';

export type ExtractionQualityReason =
  | 'ok'
  | 'empty'
  | 'short-text'
  | 'raw-fallback';

export type ExtractionQualityInput = {
  rawTextLength: number;
  readabilityTextLength: number;
  usedText: ExtractedTextVersion;
};

export type ExtractionQuality = {
  level: 'ok' | 'warn';
  reason: ExtractionQualityReason;
  label: string;
  detail: string;
  selectedTextLength: number;
};

export const READABILITY_MIN_CHARS = 200;
export const SHORT_TEXT_WARNING_CHARS = 1000;

export function selectExtractedTextVersion(readabilityTextLength: number): ExtractedTextVersion {
  return readabilityTextLength > READABILITY_MIN_CHARS ? 'readability' : 'raw';
}

export function assessExtractionQuality(
  input: Readonly<ExtractionQualityInput>,
): ExtractionQuality {
  const selectedTextLength =
    input.usedText === 'readability' ? input.readabilityTextLength : input.rawTextLength;

  if (selectedTextLength === 0) {
    return {
      level: 'warn',
      reason: 'empty',
      label: t('qualityNoTextLabel'),
      detail: t('qualityNoTextDetail'),
      selectedTextLength,
    };
  }

  if (selectedTextLength < SHORT_TEXT_WARNING_CHARS) {
    return {
      level: 'warn',
      reason: 'short-text',
      label: t('qualityShortLabel'),
      detail: t('qualityShortDetail'),
      selectedTextLength,
    };
  }

  if (input.usedText === 'raw' && input.readabilityTextLength <= READABILITY_MIN_CHARS) {
    return {
      level: 'warn',
      reason: 'raw-fallback',
      label: t('qualityRawLabel'),
      detail: t('qualityRawDetail'),
      selectedTextLength,
    };
  }

  return {
    level: 'ok',
    reason: 'ok',
    label: t('qualityOkLabel'),
    detail: t('qualityOkDetail'),
    selectedTextLength,
  };
}
