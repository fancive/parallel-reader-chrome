import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, context } from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');
const outdir = join(__dirname, 'dist');

async function copyStatic() {
  await rm(outdir, { recursive: true, force: true });
  await mkdir(join(outdir, 'icons'), { recursive: true });
  await copyFile(join(__dirname, 'manifest.json'), join(outdir, 'manifest.json'));
  await copyFile(join(__dirname, 'src', 'sidepanel.html'), join(outdir, 'sidepanel.html'));
  await copyFile(join(__dirname, 'src', 'sidepanel.css'), join(outdir, 'sidepanel.css'));
  // copy any icons if present
  try {
    const iconDir = join(__dirname, 'public', 'icons');
    const files = await readdir(iconDir);
    for (const f of files) {
      await copyFile(join(iconDir, f), join(outdir, 'icons', f));
    }
  } catch {
    // no icons yet, fine
  }
}

const entries = {
  background: 'src/background.ts',
  content: 'src/content.ts',
  sidepanel: 'src/sidepanel.ts',
};

const baseOpts = {
  bundle: true,
  format: 'esm',
  target: 'chrome120',
  sourcemap: true,
  logLevel: 'info',
  outdir,
  entryPoints: entries,
};

await copyStatic();

if (watch) {
  const ctx = await context(baseOpts);
  await ctx.watch();
  console.log('[parallel-reader-chrome] watching...');
} else {
  await build(baseOpts);
  console.log('[parallel-reader-chrome] built →', outdir);
}
