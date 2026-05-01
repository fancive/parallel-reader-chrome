import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const localesDir = join(__dirname, '..', '_locales');

function load(locale) {
  return JSON.parse(readFileSync(join(localesDir, locale, 'messages.json'), 'utf8'));
}

const en = load('en');
const zh = load('zh_CN');

test('en and zh_CN messages.json declare the same set of keys', () => {
  const enKeys = Object.keys(en).sort();
  const zhKeys = Object.keys(zh).sort();
  const onlyInEn = enKeys.filter((k) => !zh[k]);
  const onlyInZh = zhKeys.filter((k) => !en[k]);
  assert.deepEqual(
    onlyInEn,
    [],
    `keys present in en but missing in zh_CN: ${onlyInEn.join(', ')}`,
  );
  assert.deepEqual(
    onlyInZh,
    [],
    `keys present in zh_CN but missing in en: ${onlyInZh.join(', ')}`,
  );
});

test('every message has a non-empty string body in both locales', () => {
  for (const [key, entry] of Object.entries(en)) {
    assert.equal(typeof entry.message, 'string', `en.${key} missing message`);
    assert.ok(entry.message.length > 0, `en.${key} is empty`);
  }
  for (const [key, entry] of Object.entries(zh)) {
    assert.equal(typeof entry.message, 'string', `zh_CN.${key} missing message`);
    assert.ok(entry.message.length > 0, `zh_CN.${key} is empty`);
  }
});

test('placeholders ($1..$9) match between en and zh_CN for the same key', () => {
  const placeholderRegex = /\$([1-9])/g;
  for (const key of Object.keys(en)) {
    const enPlaceholders = new Set(
      [...en[key].message.matchAll(placeholderRegex)].map((m) => m[1]),
    );
    const zhPlaceholders = new Set(
      [...zh[key].message.matchAll(placeholderRegex)].map((m) => m[1]),
    );
    assert.deepEqual(
      [...enPlaceholders].sort(),
      [...zhPlaceholders].sort(),
      `placeholder mismatch for "${key}": en=${[...enPlaceholders]} zh=${[...zhPlaceholders]}`,
    );
  }
});

test('chrome.i18n.getMessage substitutes $1..$N from a passed string array', () => {
  // Simulates the runtime substitution chrome.i18n performs so we know our
  // t() wrapper round-trips values correctly when locale is zh_CN.
  function fakeGetMessage(template, subs) {
    const arr = Array.isArray(subs) ? subs : subs === undefined ? [] : [subs];
    let out = template;
    for (let i = 0; i < arr.length; i++) {
      out = out.split('$' + (i + 1)).join(String(arr[i]));
    }
    return out;
  }

  assert.equal(
    fakeGetMessage(zh.statusFoundLocating.message, ['7']),
    '找到 7 处亮点，正在标注...',
  );
  assert.equal(
    fakeGetMessage(en.statusFoundLocating.message, ['7']),
    'Found 7 highlights, locating…',
  );
});
