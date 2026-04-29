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
      label: '页面无可读文本',
      detail: '当前页面可能还未加载完成、需要登录，或不是正文页面。',
      selectedTextLength,
    };
  }

  if (selectedTextLength < SHORT_TEXT_WARNING_CHARS) {
    return {
      level: 'warn',
      reason: 'short-text',
      label: '可读文本偏短',
      detail: '页面可能未加载完整、正文被登录墙截断，或当前不是文章正文页。',
      selectedTextLength,
    };
  }

  if (input.usedText === 'raw' && input.readabilityTextLength <= READABILITY_MIN_CHARS) {
    return {
      level: 'warn',
      reason: 'raw-fallback',
      label: '使用原文文本',
      detail: '未抽取到稳定正文，结果可能混入导航、评论或广告文本。',
      selectedTextLength,
    };
  }

  return {
    level: 'ok',
    reason: 'ok',
    label: '抽取正常',
    detail: '当前页面正文长度足够，已使用稳定文本版本生成卡片。',
    selectedTextLength,
  };
}
