#!/usr/bin/env node
import { createServer } from 'node:http';
import { constants } from 'node:fs';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const root = process.cwd();
const e2eDir = join(root, '.e2e');
const evidenceDir = join(e2eDir, 'evidence', 'extension-smoke');
const profileDir = join(evidenceDir, 'chrome-profile');
const artifactPath = join(e2eDir, 'artifact.json');
const distDir = resolve(root, 'dist');

const tests = [];
let context;
let server;
let baseUrl = '';
let extensionId = '';
let sidePage;

async function executableExists(path) {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveChromeExecutable() {
  if (process.env.CHROME_PATH) {
    if (!(await executableExists(process.env.CHROME_PATH))) {
      throw new Error(`CHROME_PATH is not executable: ${process.env.CHROME_PATH}`);
    }
    return process.env.CHROME_PATH;
  }

  const channel = process.env.PLAYWRIGHT_CHROME_CHANNEL || 'chrome';
  const playwrightPath = chromium.executablePath({ channel });
  if (await executableExists(playwrightPath)) return playwrightPath;

  const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (await executableExists(macChrome)) return macChrome;

  throw new Error(
    `No executable Chromium found. Set CHROME_PATH or run npx playwright install chromium for channel ${channel}.`,
  );
}

function nowMs() {
  return Date.now();
}

function makeError(error) {
  if (error instanceof Error) {
    return {
      message: error.message,
      trace: error.stack || error.message,
    };
  }
  return {
    message: String(error),
    trace: String(error),
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function record(name, tags, fn) {
  const start = nowMs();
  try {
    await fn();
    tests.push({
      name,
      status: 'passed',
      duration: nowMs() - start,
      tags,
    });
  } catch (error) {
    tests.push({
      name,
      status: 'failed',
      duration: nowMs() - start,
      tags,
      message: makeError(error).message,
      trace: makeError(error).trace,
    });
  }
}

function summaryCounts() {
  const summary = { tests: tests.length, passed: 0, failed: 0, pending: 0, skipped: 0, other: 0 };
  for (const test of tests) {
    if (test.status === 'passed') summary.passed += 1;
    else if (test.status === 'failed') summary.failed += 1;
    else if (test.status === 'pending') summary.pending += 1;
    else if (test.status === 'skipped') summary.skipped += 1;
    else summary.other += 1;
  }
  return summary;
}

async function writeArtifact(start, stop) {
  const artifact = {
    reportFormat: 'CTRF',
    specVersion: '0.0.0',
    results: {
      tool: { name: 'parallel-reader-extension-smoke' },
      summary: { ...summaryCounts(), start, stop },
      tests,
    },
  };
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
}

function listen(httpServer) {
  return new Promise((resolveListen, rejectListen) => {
    httpServer.once('error', rejectListen);
    httpServer.listen(0, '127.0.0.1', () => {
      const address = httpServer.address();
      if (!address || typeof address === 'string') {
        rejectListen(new Error('server did not expose an address'));
        return;
      }
      resolveListen(address.port);
    });
  });
}

function closeServer(httpServer) {
  return new Promise((resolveClose, rejectClose) => {
    httpServer.close((error) => {
      if (error) rejectClose(error);
      else resolveClose();
    });
  });
}

async function startFixtureServer() {
  server = createServer((req, res) => {
    if (req.url !== '/' && req.url !== '/article.html') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html>
      <html>
        <head><title>Parallel Reader Local Fixture</title></head>
        <body>
          <main>
            <article>
              <h1>Parallel Reader Local Fixture</h1>
              <p>Gemini is not limited to one tab. It can summarize a page and help compare open tabs while the reader stays in flow.</p>
              <p>The extension should extract this article text, preserve anchor quotes, and locate the exact sentence in the live DOM.</p>
            </article>
          </main>
        </body>
      </html>`);
  });
  const port = await listen(server);
  baseUrl = `http://127.0.0.1:${port}/article.html`;
}

async function waitForExtensionId() {
  let serviceWorker = context.serviceWorkers()[0];
  if (!serviceWorker) {
    serviceWorker = await context.waitForEvent('serviceworker', { timeout: 10000 });
  }
  const url = serviceWorker.url();
  const match = url.match(/^chrome-extension:\/\/([^/]+)\//);
  assert(match, `could not parse extension id from service worker URL: ${url}`);
  extensionId = match[1];
}

async function launchExtension() {
  await rm(profileDir, { recursive: true, force: true });
  await mkdir(profileDir, { recursive: true });

  const executablePath = await resolveChromeExecutable();
  const launchOptions = {
    headless: false,
    executablePath,
    ignoreDefaultArgs: ['--disable-extensions', '--disable-component-extensions-with-background-pages'],
    args: [
      `--disable-extensions-except=${distDir}`,
      `--load-extension=${distDir}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  };
  context = await chromium.launchPersistentContext(profileDir, launchOptions);
  await waitForExtensionId();
}

const ANALYZE_TRIGGER_SELECTOR = '#analyze:visible, #analyze-hero:visible';

function analyzeTrigger() {
  return sidePage.locator(ANALYZE_TRIGGER_SELECTOR).first();
}

async function openSidePanelPage() {
  sidePage = await context.newPage();
  await sidePage.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await analyzeTrigger().waitFor({ state: 'visible', timeout: 5000 });
}

async function activeTabExtract() {
  return sidePage.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) throw new Error('no active tab id');
    return chrome.tabs.sendMessage(tab.id, { type: 'extract' });
  });
}

async function activeTabLocate(anchor) {
  return sidePage.evaluate(async (needle) => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) throw new Error('no active tab id');
    return chrome.tabs.sendMessage(tab.id, { type: 'locate', anchor: needle });
  }, anchor);
}

async function main() {
  const start = nowMs();
  await rm(evidenceDir, { recursive: true, force: true });
  await mkdir(evidenceDir, { recursive: true });

  await record('local article fixture server starts', ['risk:boundary_io', 'risk:resource_lifecycle'], async () => {
    await startFixtureServer();
    assert(baseUrl.startsWith('http://127.0.0.1:'), 'fixture server did not expose a local URL');
  });

  await record('unpacked extension service worker starts', ['risk:wiring', 'risk:resource_lifecycle'], async () => {
    await launchExtension();
    assert(extensionId.length > 10, 'extension id was not discovered');
  });

  await record('side panel blocks analysis until provider settings exist', ['risk:failure_path', 'risk:security'], async () => {
    await openSidePanelPage();
    await analyzeTrigger().click({ timeout: 5000 });
    await sidePage.waitForFunction(
      () => {
        const settings = document.querySelector('#settings');
        const status = document.querySelector('#status');
        return settings && settings.hidden === false && status?.textContent?.includes('请先保存 API Key');
      },
      null,
      { timeout: 5000 },
    );
    const note = await sidePage.locator('.settings-note').textContent();
    assert(
      note?.includes('API Key 只保存在当前 Chrome'),
      'settings note does not explain local key storage mode',
    );
  });

  await record('content script extracts the local article fixture', ['risk:boundary_io', 'risk:wiring', 'risk:contract'], async () => {
    const page = await context.newPage();
    await page.goto(baseUrl);
    await page.bringToFront();
    const extracted = await activeTabExtract();
    assert(extracted.title === 'Parallel Reader Local Fixture', `unexpected title: ${extracted.title}`);
    assert(
      extracted.rawText.includes('Gemini is not limited to one tab'),
      'raw text did not include fixture article text',
    );
    assert(extracted.url === baseUrl, `unexpected extracted URL: ${extracted.url}`);
  });

  await record('content script locates an anchor in the live DOM', ['risk:regression', 'risk:contract'], async () => {
    const located = await activeTabLocate('Gemini is not limited to one tab');
    assert(located.rawHit === true, 'anchor was not found in raw text');
    assert(located.domRange === true, 'anchor did not locate to a DOM Range');
  });

  // The pending-analyze message is what background's command handler (Alt+Shift+R)
  // emits to the side panel. Playwright cannot fire a real Chrome global shortcut,
  // so we exercise the consumer wire from the service worker (the same context
  // the real handler runs in). Producer construction is covered by
  // tests/pending-analyze.test.mjs (buildPendingAnalyzeRequest).
  await record('service worker can ack pending-analyze through side panel listener', ['risk:wiring', 'risk:contract'], async () => {
    const sw = context.serviceWorkers()[0];
    assert(sw, 'service worker not available');
    const fixtureTabId = await sw.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      const fixture = tabs.find((t) => t.url?.includes('/article.html'));
      if (!fixture?.id) throw new Error('fixture tab not found');
      return fixture.id;
    });
    const ack = await sw.evaluate(
      async ({ tabId, url }) => {
        return chrome.runtime.sendMessage({
          type: 'pending-analyze',
          request: { tabId, url, nonce: `e2e-ok-${Date.now()}`, ts: Date.now() },
        });
      },
      { tabId: fixtureTabId, url: baseUrl },
    );
    assert(ack && ack.ok === true, `expected ack.ok=true, got: ${JSON.stringify(ack)}`);
  });

  await record('side panel rejects malformed pending-analyze message', ['risk:wiring', 'risk:failure_path'], async () => {
    const sw = context.serviceWorkers()[0];
    assert(sw, 'service worker not available');
    const ack = await sw.evaluate(async () => {
      return chrome.runtime.sendMessage({
        type: 'pending-analyze',
        request: { tabId: 'not-a-number', url: 1, nonce: '', ts: -1 },
      });
    });
    assert(ack && ack.ok === false, `expected ack.ok=false, got: ${JSON.stringify(ack)}`);
    assert(typeof ack.error === 'string' && ack.error.length > 0, 'expected non-empty error string');
  });

  await record('browser context and fixture server close cleanly', ['risk:resource_lifecycle'], async () => {
    if (context) {
      await context.close();
      context = undefined;
    }
    if (server) {
      await closeServer(server);
      server = undefined;
    }
  });

  if (context) await context.close().catch(() => undefined);
  if (server) await closeServer(server).catch(() => undefined);
  const stop = nowMs();
  await writeArtifact(start, stop);

  const failed = tests.filter((test) => test.status === 'failed');
  if (failed.length > 0) {
    for (const test of failed) {
      console.error(`${test.name}: ${test.message}`);
    }
    process.exitCode = 1;
  }
}

if (process.argv.includes('--check-browser')) {
  await resolveChromeExecutable()
    .then((path) => console.log(path))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
} else {
  await main().catch(async (error) => {
  tests.push({
    name: 'extension smoke runner uncaught error',
    status: 'failed',
    duration: 0,
    tags: ['risk:failure_path'],
    message: makeError(error).message,
    trace: makeError(error).trace,
  });
  await writeArtifact(nowMs(), nowMs()).catch(() => undefined);
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
  });
}
