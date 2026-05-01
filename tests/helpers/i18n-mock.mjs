// Test-time chrome.i18n shim that reads _locales/en/messages.json so t()
// returns real English copy instead of the raw key. Import this helper
// once at the top of any test that exercises localized strings.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const messagesPath = join(__dirname, '..', '..', '_locales', 'en', 'messages.json');
const messages = JSON.parse(readFileSync(messagesPath, 'utf8'));

function applySubstitutions(template, substitutions) {
  if (substitutions === undefined) return template;
  const arr = Array.isArray(substitutions) ? substitutions : [substitutions];
  let out = template;
  for (let i = 0; i < arr.length; i++) {
    const placeholder = `$${i + 1}`;
    // Replace all occurrences without using a regex (avoids escaping headaches).
    out = out.split(placeholder).join(String(arr[i]));
  }
  return out;
}

if (!globalThis.chrome) {
  globalThis.chrome = {};
}
if (!globalThis.chrome.i18n) {
  globalThis.chrome.i18n = {
    getMessage(key, substitutions) {
      const entry = messages[key];
      if (!entry || typeof entry.message !== 'string') return key;
      return applySubstitutions(entry.message, substitutions);
    },
  };
}
