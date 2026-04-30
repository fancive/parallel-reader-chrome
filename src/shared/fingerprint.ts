const FINGERPRINT_HEX_LENGTH = 16;

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function bufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

export async function computeContentFingerprint(text: string): Promise<string> {
  const normalized = normalizeText(text);
  const encoded = new TextEncoder().encode(normalized);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return bufferToHex(digest).slice(0, FINGERPRINT_HEX_LENGTH);
}
