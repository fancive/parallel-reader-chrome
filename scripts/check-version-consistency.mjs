#!/usr/bin/env node
// Fail when package.json, manifest.json, and package-lock.json disagree
// on the release version. Run as part of `npm run check`.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function readJson(rel) {
  return JSON.parse(readFileSync(join(repoRoot, rel), 'utf8'));
}

const pkg = readJson('package.json');
const manifest = readJson('manifest.json');
const lock = readJson('package-lock.json');

const sources = [
  { label: 'package.json', version: pkg.version },
  { label: 'manifest.json', version: manifest.version },
  { label: 'package-lock.json (root)', version: lock.version },
  { label: 'package-lock.json (packages."")', version: lock.packages?.['']?.version },
];

const missing = sources.filter((s) => !s.version);
if (missing.length > 0) {
  console.error('check-version-consistency: missing version in:');
  for (const m of missing) console.error(`  ${m.label}`);
  process.exit(1);
}

const reference = sources[0].version;
const mismatched = sources.filter((s) => s.version !== reference);
if (mismatched.length > 0) {
  console.error(`check-version-consistency: version drift detected (expected ${reference}):`);
  for (const m of mismatched) console.error(`  ${m.label} = ${m.version}`);
  console.error('');
  console.error('Fix: bump every source to the same version, then run `npm install` to refresh the lockfile.');
  process.exit(1);
}

console.log(`check-version-consistency: all sources at ${reference}.`);
