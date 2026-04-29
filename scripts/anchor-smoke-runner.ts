import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { build } from 'esbuild';
import { matchAnchor } from '../src/shared/anchor';
import { callProvider } from '../src/shared/provider';
import { ProviderSettingsSchema, type Card, type ExtractResponse } from '../src/shared/types';

type CliOptions = {
  urls: string[];
  outputDir: string;
  timeoutMs: number;
  networkIdleMs: number;
  settleMs: number;
  headful: boolean;
  minDomHitRate?: number;
  minReadableChars?: number;
  gateReport?: string;
};

type CardReport = {
  index: number;
  title: string;
  anchor: string;
  gist: string;
  rawHit: boolean;
  readabilityHit: boolean;
  domRange: boolean;
  rawIndex: number;
  readabilityIndex: number;
  rectCount: number;
};

type PageReport = {
  url: string;
  finalUrl?: string;
  title?: string;
  usedText?: 'raw' | 'readability';
  rawTextLength?: number;
  readabilityTextLength?: number;
  cards: CardReport[];
  stats?: {
    total: number;
    rawHits: number;
    readabilityHits: number;
    domRangeHits: number;
  };
  error?: string;
};

export type SmokeGateThresholds = Pick<CliOptions, 'minDomHitRate' | 'minReadableChars'>;

export type SmokeGateFailure = {
  url: string;
  reason: 'page-error' | 'readable-chars' | 'dom-hit-rate';
  message: string;
};

type BrowserSmokeApi = {
  extract(): ExtractResponse;
  locate(anchor: string): { domRange: boolean; rectCount: number };
};

declare global {
  interface Window {
    ParallelReaderAnchorSmoke: BrowserSmokeApi;
  }
}

export function usage(): string {
  return `Usage:
  npm run anchor:smoke -- https://example.com/article https://example.com/post
  npm run anchor:smoke -- --urls urls.txt
  npm run anchor:smoke -- --gate-report reports/anchor-smoke.json --min-dom-hit-rate 90%

Environment:
  PARALLEL_READER_API_KEY    Provider API key. DEEPSEEK_API_KEY also works.
  PARALLEL_READER_BASE_URL   Default: https://api.deepseek.com/v1
  PARALLEL_READER_MODEL      Default: deepseek-chat
  DASHSCOPE_CODING_SK        Also accepted as provider API key.
  DASHSCOPE_CODING_BASE_URL  Also accepted as provider base URL.
  DASHSCOPE_CODING_MODEL     Also accepted as provider model. Defaults to qwen3-coder-plus when using DASHSCOPE_CODING_*.
  CHROME_PATH                Optional Chrome/Chromium executable path.

Options:
  --urls <file>              Read URLs from a newline-delimited file.
  --output-dir <dir>         Default: reports
  --timeout-ms <ms>          Page navigation timeout. Default: 45000
  --network-idle-ms <ms>     Optional networkidle wait. Default: 5000
  --settle-ms <ms>           Extra wait after load. Default: 1500
  --min-dom-hit-rate <rate>  Fail if a page's DOM anchor hit rate is below this value. Accepts 0.9, 90, or 90%.
  --min-readable-chars <n>   Fail if the selected article text is shorter than this many characters.
  --gate-report <file>       Evaluate thresholds against an existing JSON report without rerunning browser/model.
  --headful                  Show the browser window.
`;
}

async function readUrlsFile(path: string): Promise<string[]> {
  const text = await readFile(path, 'utf8');
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function parseDomHitRate(value: string | undefined): number {
  if (!value) throw new Error('--min-dom-hit-rate requires a number');
  const text = value.trim();
  const percent = text.endsWith('%');
  const numeric = Number(percent ? text.slice(0, -1) : text);
  if (!Number.isFinite(numeric)) throw new Error('--min-dom-hit-rate requires a number');
  if (numeric < 0 || numeric > 100) {
    throw new Error('--min-dom-hit-rate must be between 0 and 1, or between 0 and 100%');
  }
  const rate = percent || numeric > 1 ? numeric / 100 : numeric;
  if (rate < 0 || rate > 1) {
    throw new Error('--min-dom-hit-rate must be between 0 and 1');
  }
  return rate;
}

function parseNonNegativeInteger(name: string, value: string | undefined): number {
  if (!value) throw new Error(`${name} requires a number`);
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 0) {
    throw new Error(`${name} requires a non-negative integer`);
  }
  return numeric;
}

export async function parseArgs(argv: string[]): Promise<CliOptions> {
  const opts: CliOptions = {
    urls: [],
    outputDir: 'reports',
    timeoutMs: 45_000,
    networkIdleMs: 5_000,
    settleMs: 1_500,
    headful: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exitCode = 0;
      return opts;
    }
    if (arg === '--headful') {
      opts.headful = true;
      continue;
    }
    if (arg === '--urls') {
      const file = argv[++i];
      if (!file) throw new Error('--urls requires a file path');
      opts.urls.push(...(await readUrlsFile(file)));
      continue;
    }
    if (arg === '--output-dir') {
      const value = argv[++i];
      if (!value) throw new Error('--output-dir requires a directory');
      opts.outputDir = value;
      continue;
    }
    if (arg === '--timeout-ms') {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value)) throw new Error('--timeout-ms requires a number');
      opts.timeoutMs = value;
      continue;
    }
    if (arg === '--network-idle-ms') {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value)) throw new Error('--network-idle-ms requires a number');
      opts.networkIdleMs = value;
      continue;
    }
    if (arg === '--settle-ms') {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value)) throw new Error('--settle-ms requires a number');
      opts.settleMs = value;
      continue;
    }
    if (arg === '--min-dom-hit-rate') {
      opts.minDomHitRate = parseDomHitRate(argv[++i]);
      continue;
    }
    if (arg === '--min-readable-chars') {
      opts.minReadableChars = parseNonNegativeInteger('--min-readable-chars', argv[++i]);
      continue;
    }
    if (arg === '--gate-report') {
      const file = argv[++i];
      if (!file) throw new Error('--gate-report requires a file path');
      opts.gateReport = file;
      continue;
    }
    if (arg?.startsWith('@')) {
      opts.urls.push(...(await readUrlsFile(arg.slice(1))));
      continue;
    }
    if (arg?.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    if (arg) opts.urls.push(arg);
  }

  return opts;
}

function envNumber(name: string): number | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number`);
  return parsed;
}

function loadProviderSettings() {
  const usingDashScopeCoding =
    Boolean(process.env.DASHSCOPE_CODING_SK || process.env.DASHSCOPE_CODING_BASE_URL) &&
    !process.env.PARALLEL_READER_API_KEY &&
    !process.env.PARALLEL_READER_BASE_URL &&
    !process.env.PARALLEL_READER_MODEL &&
    !process.env.DEEPSEEK_API_KEY;
  const raw = {
    apiKey:
      process.env.PARALLEL_READER_API_KEY ??
      process.env.DEEPSEEK_API_KEY ??
      process.env.DASHSCOPE_CODING_SK,
    baseUrl: process.env.PARALLEL_READER_BASE_URL ?? process.env.DASHSCOPE_CODING_BASE_URL,
    model:
      process.env.PARALLEL_READER_MODEL ??
      process.env.DASHSCOPE_CODING_MODEL ??
      (usingDashScopeCoding ? 'qwen3-coder-plus' : undefined),
    minCards: envNumber('PARALLEL_READER_MIN_CARDS'),
    maxCards: envNumber('PARALLEL_READER_MAX_CARDS'),
    maxDocChars: envNumber('PARALLEL_READER_MAX_DOC_CHARS'),
  };
  const cleaned = Object.fromEntries(
    Object.entries(raw).filter(([, value]) => value !== undefined && value !== ''),
  );
  const settings = ProviderSettingsSchema.parse(cleaned);
  if (!settings.apiKey) {
    throw new Error(
      'Missing provider key: set PARALLEL_READER_API_KEY, DEEPSEEK_API_KEY, or DASHSCOPE_CODING_SK',
    );
  }
  return settings;
}

async function buildBrowserBundle(): Promise<string> {
  const result = await build({
    entryPoints: [join(process.cwd(), 'scripts', 'anchor-smoke-browser.ts')],
    bundle: true,
    format: 'iife',
    globalName: 'ParallelReaderAnchorSmoke',
    target: 'chrome120',
    write: false,
    logLevel: 'silent',
  });
  const output = result.outputFiles?.[0]?.text;
  if (!output) throw new Error('Failed to build browser smoke bundle');
  return output;
}

function pct(hits: number, total: number): string {
  if (total === 0) return '0/0';
  return `${hits}/${total} (${Math.round((hits / total) * 100)}%)`;
}

function summarize(cards: readonly CardReport[]) {
  return {
    total: cards.length,
    rawHits: cards.filter((card) => card.rawHit).length,
    readabilityHits: cards.filter((card) => card.readabilityHit).length,
    domRangeHits: cards.filter((card) => card.domRange).length,
  };
}

function selectedTextLength(page: PageReport): number {
  if (page.usedText === 'readability') return page.readabilityTextLength ?? 0;
  if (page.usedText === 'raw') return page.rawTextLength ?? 0;
  return Math.max(page.rawTextLength ?? 0, page.readabilityTextLength ?? 0);
}

function formatRate(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function gateEnabled(thresholds: SmokeGateThresholds): boolean {
  return thresholds.minDomHitRate !== undefined || thresholds.minReadableChars !== undefined;
}

function thresholdsFromOptions(opts: SmokeGateThresholds): SmokeGateThresholds {
  return {
    minDomHitRate: opts.minDomHitRate,
    minReadableChars: opts.minReadableChars,
  };
}

export function evaluateSmokeGate(
  pages: readonly PageReport[],
  thresholds: SmokeGateThresholds,
): SmokeGateFailure[] {
  if (!gateEnabled(thresholds)) return [];

  const failures: SmokeGateFailure[] = [];
  for (const page of pages) {
    if (page.error) {
      failures.push({
        url: page.url,
        reason: 'page-error',
        message: `page failed before gate evaluation: ${page.error}`,
      });
      continue;
    }

    if (thresholds.minReadableChars !== undefined) {
      const length = selectedTextLength(page);
      if (length < thresholds.minReadableChars) {
        failures.push({
          url: page.url,
          reason: 'readable-chars',
          message: `selected text length ${length} is below required ${thresholds.minReadableChars}`,
        });
      }
    }

    if (thresholds.minDomHitRate !== undefined) {
      const stats = page.stats ?? summarize(page.cards);
      const rate = stats.total === 0 ? 0 : stats.domRangeHits / stats.total;
      if (rate < thresholds.minDomHitRate) {
        failures.push({
          url: page.url,
          reason: 'dom-hit-rate',
          message: `DOM hit rate ${pct(stats.domRangeHits, stats.total)} is below required ${formatRate(thresholds.minDomHitRate)}`,
        });
      }
    }
  }

  return failures;
}

function printGateResult(failures: readonly SmokeGateFailure[]): void {
  if (failures.length === 0) {
    console.log('anchor smoke gate passed');
    return;
  }
  console.error('anchor smoke gate failed:');
  for (const failure of failures) {
    console.error(`- ${failure.url}: ${failure.message}`);
  }
  process.exitCode = 1;
}

async function analyzePage(args: {
  page: import('playwright-core').Page;
  url: string;
  browserBundle: string;
  timeoutMs: number;
  networkIdleMs: number;
  settleMs: number;
  settings: ReturnType<typeof loadProviderSettings>;
}): Promise<PageReport> {
  const { page, url, browserBundle, timeoutMs, networkIdleMs, settleMs, settings } = args;

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForLoadState('networkidle', { timeout: networkIdleMs }).catch(() => undefined);
    if (settleMs > 0) await page.waitForTimeout(settleMs);
    await page.evaluate((bundle) => {
      // biome-ignore lint/security/noGlobalEval: The smoke runner injects its built extractor into the tested page context.
      window.ParallelReaderAnchorSmoke = window.eval(`${bundle}\nParallelReaderAnchorSmoke;`);
    }, browserBundle);

    const extracted = await page.evaluate(() => window.ParallelReaderAnchorSmoke.extract());
    const usedText: 'raw' | 'readability' =
      extracted.readabilityText.length > 200 ? 'readability' : 'raw';
    const text = usedText === 'readability' ? extracted.readabilityText : extracted.rawText;
    if (!text.trim()) throw new Error('Page has no readable text');

    const cards = await callProvider(text, settings);
    const reports: CardReport[] = [];

    for (let i = 0; i < cards.length; i++) {
      const card = cards[i] as Card;
      const rawMatch = matchAnchor(extracted.rawText, card.anchor);
      const readMatch = matchAnchor(extracted.readabilityText, card.anchor);
      const dom = await page.evaluate(
        (anchor) => window.ParallelReaderAnchorSmoke.locate(anchor),
        card.anchor,
      );
      reports.push({
        index: i + 1,
        title: card.title,
        anchor: card.anchor,
        gist: card.gist,
        rawHit: rawMatch.hit,
        readabilityHit: readMatch.hit,
        domRange: dom.domRange,
        rawIndex: rawMatch.index,
        readabilityIndex: readMatch.index,
        rectCount: dom.rectCount,
      });
    }

    return {
      url,
      finalUrl: extracted.url,
      title: extracted.title,
      usedText,
      rawTextLength: extracted.rawText.length,
      readabilityTextLength: extracted.readabilityText.length,
      cards: reports,
      stats: summarize(reports),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { url, cards: [], error: message };
  }
}

function renderMarkdown(report: {
  generatedAt: string;
  pages: PageReport[];
  gate?: {
    thresholds: SmokeGateThresholds;
    failures: SmokeGateFailure[];
  };
}): string {
  const lines: string[] = [];
  lines.push('# Anchor Smoke Report');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push('');

  if (report.gate && gateEnabled(report.gate.thresholds)) {
    lines.push('## Gate');
    lines.push('');
    if (report.gate.thresholds.minDomHitRate !== undefined) {
      lines.push(`- Min DOM hit rate: ${formatRate(report.gate.thresholds.minDomHitRate)}`);
    }
    if (report.gate.thresholds.minReadableChars !== undefined) {
      lines.push(`- Min selected text length: ${report.gate.thresholds.minReadableChars}`);
    }
    lines.push(`- Result: ${report.gate.failures.length === 0 ? 'pass' : 'fail'}`);
    for (const failure of report.gate.failures) {
      lines.push(`- ${failure.url}: ${failure.message}`);
    }
    lines.push('');
  }

  for (const page of report.pages) {
    lines.push(`## ${page.title || page.url}`);
    lines.push('');
    lines.push(`- URL: ${page.url}`);
    if (page.finalUrl && page.finalUrl !== page.url) lines.push(`- Final URL: ${page.finalUrl}`);
    if (page.error) {
      lines.push(`- Error: ${page.error}`);
      lines.push('');
      continue;
    }
    const stats = page.stats ?? summarize(page.cards);
    lines.push(`- Used text: ${page.usedText}`);
    lines.push(`- Text length: raw ${page.rawTextLength}, readability ${page.readabilityTextLength}`);
    lines.push(`- Raw: ${pct(stats.rawHits, stats.total)}`);
    lines.push(`- Readability: ${pct(stats.readabilityHits, stats.total)}`);
    lines.push(`- DOM Range: ${pct(stats.domRangeHits, stats.total)}`);
    lines.push('');
    lines.push('| # | Title | Raw | Read | DOM | Anchor |');
    lines.push('|---:|---|---|---|---|---|');
    for (const card of page.cards) {
      const anchor = card.anchor.replaceAll('|', '\\|').replace(/\s+/g, ' ').slice(0, 120);
      lines.push(
        `| ${card.index} | ${card.title.replaceAll('|', '\\|')} | ${card.rawHit ? 'Y' : 'N'} | ${card.readabilityHit ? 'Y' : 'N'} | ${card.domRange ? 'Y' : 'N'} | ${anchor} |`,
      );
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

export async function main(argv: string[]): Promise<void> {
  const opts = await parseArgs(argv);
  if (process.exitCode === 0) return;
  if (opts.gateReport) {
    const text = await readFile(opts.gateReport, 'utf8');
    const report = JSON.parse(text) as { pages?: PageReport[] };
    if (!Array.isArray(report.pages)) throw new Error('--gate-report JSON must contain a pages array');
    const failures = evaluateSmokeGate(report.pages, thresholdsFromOptions(opts));
    printGateResult(failures);
    return;
  }
  if (opts.urls.length === 0) {
    console.log(usage());
    process.exitCode = 1;
    return;
  }

  const settings = loadProviderSettings();
  const browserBundle = await buildBrowserBundle();
  const { chromium } = await import('playwright-core');
  const launchOptions: import('playwright-core').LaunchOptions = {
    headless: !opts.headful,
  };
  if (process.env.CHROME_PATH) {
    launchOptions.executablePath = process.env.CHROME_PATH;
  } else {
    launchOptions.channel = process.env.PLAYWRIGHT_CHROME_CHANNEL ?? 'chrome';
  }

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    bypassCSP: true,
    viewport: { width: 1280, height: 900 },
  });
  const pages: PageReport[] = [];

  try {
    for (const url of opts.urls) {
      const page = await context.newPage();
      const result = await analyzePage({
        page,
        url,
        browserBundle,
        timeoutMs: opts.timeoutMs,
        networkIdleMs: opts.networkIdleMs,
        settleMs: opts.settleMs,
        settings,
      });
      pages.push(result);
      await page.close().catch(() => undefined);

      if (result.error) {
        console.log(`${url}: ERROR ${result.error}`);
      } else {
        const stats = result.stats ?? summarize(result.cards);
        console.log(
          `${url}: raw ${pct(stats.rawHits, stats.total)}, read ${pct(stats.readabilityHits, stats.total)}, dom ${pct(stats.domRangeHits, stats.total)}`,
        );
      }
    }
  } finally {
    await context.close().catch(() => undefined);
    await browser.close();
  }

  const generatedAt = new Date().toISOString();
  const stamp = generatedAt.replace(/[:.]/g, '-');
  const outDir = isAbsolute(opts.outputDir) ? opts.outputDir : join(process.cwd(), opts.outputDir);
  await mkdir(outDir, { recursive: true });

  const gateThresholds = thresholdsFromOptions(opts);
  const gateFailures = evaluateSmokeGate(pages, gateThresholds);
  const report = {
    generatedAt,
    pages,
    gate: gateEnabled(gateThresholds)
      ? {
          thresholds: gateThresholds,
          failures: gateFailures,
        }
      : undefined,
  };
  const jsonPath = join(outDir, `anchor-smoke-${stamp}.json`);
  const mdPath = join(outDir, `anchor-smoke-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(mdPath, renderMarkdown(report));
  console.log(`wrote ${jsonPath}`);
  console.log(`wrote ${mdPath}`);

  if (gateEnabled(gateThresholds)) printGateResult(gateFailures);
}
