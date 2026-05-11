#!/usr/bin/env node
// Fail CI when src/ files contain hard-coded CJK strings.
// All user-facing text must flow through the t() helper, sourced from the
// bundled STRINGS table at src/shared/i18n/strings.ts (the only file
// allowed to hold raw zh_CN copy).
//
// The allow-list below keeps strings that are intentionally not UI
// (e.g., LLM prompt scaffolding driven by the user's summaryLanguage).

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const srcDir = join(repoRoot, 'src');

const ALLOW_LIST = new Set([
  // LLM prompt scaffolding (governed by settings.summaryLanguage).
  'src/shared/prompt.ts',
  // Bundled UI string table — the only place where raw zh_CN copy lives.
  'src/shared/i18n/strings.ts',
]);

const CJK_RANGE = /[一-鿿]/;

function walk(dir) {
  const entries = readdirSync(dir);
  const files = [];
  for (const name of entries) {
    const full = join(dir, name);
    const s = statSync(full);
    if (s.isDirectory()) {
      files.push(...walk(full));
    } else if (/\.(?:ts|tsx|html|css)$/.test(name)) {
      files.push(full);
    }
  }
  return files;
}

const offenders = [];
for (const file of walk(srcDir)) {
  const rel = relative(repoRoot, file);
  if (ALLOW_LIST.has(rel)) continue;
  const content = readFileSync(file, 'utf8');
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (CJK_RANGE.test(lines[i])) {
      offenders.push({ rel, line: i + 1, text: lines[i].trim() });
    }
  }
}

if (offenders.length > 0) {
  console.error('Hard-coded CJK strings found in src/. Move them to _locales/<locale>/messages.json and use t().');
  console.error('');
  for (const o of offenders) {
    console.error(`  ${o.rel}:${o.line}  ${o.text}`);
  }
  console.error('');
  console.error(`Allow-list: ${[...ALLOW_LIST].join(', ')}`);
  process.exit(1);
}

console.log(`check-no-cjk: src/ has 0 hard-coded CJK characters (allow-list: ${[...ALLOW_LIST].join(', ')}).`);
