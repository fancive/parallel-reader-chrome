import { t } from '../shared/i18n';

function fallbackCopyText(text: string): void {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const ok = document.execCommand('copy');
  textarea.remove();
  if (!ok) throw new Error(t('clipboardWriteDenied'));
}

export async function copyText(
  text: string,
  okStatus: string,
  setStatus: (text: string) => void,
): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      fallbackCopyText(text);
    }
    setStatus(okStatus);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'unknown error';
    setStatus(t('clipboardCopyFailed', [msg]));
  }
}
