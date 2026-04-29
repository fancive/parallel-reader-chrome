#!/usr/bin/env node
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = process.cwd();
const tmpDir = join(root, '.tmp');
const outfile = join(tmpDir, 'anchor-smoke-runner.mjs');

try {
  await mkdir(tmpDir, { recursive: true });
  await build({
    entryPoints: [join(root, 'scripts', 'anchor-smoke-runner.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    external: ['esbuild', 'playwright-core'],
    logLevel: 'silent',
  });

  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  await mod.main(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}
