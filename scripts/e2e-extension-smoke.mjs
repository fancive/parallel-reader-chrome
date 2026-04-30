#!/usr/bin/env node
import { constants } from 'node:fs';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const root = process.cwd();
const e2eDir = join(root, '.e2e');
const evidenceDir = join(e2eDir, 'evidence', 'extension-smoke');
const profileDir = join(evidenceDir, 'chrome-profile');
const artifactPath = join(e2eDir, 'artifact.json');
const distDir = resolve(root, 'dist');
const settingsKey = 'parallel-reader-settings';
const pageStatePrefix = 'parallel-reader-page:';

const tests = [];
let context;
let server;
let serverOrigin = '';
let baseUrl = '';
let otherUrl = '';
let extensionId = '';
let sidePage;
let fixturePage;
let providerMode = 'success';
let providerDelayMs = 0;
const providerRequests = [];

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

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitUntil(predicate, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error(message);
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

function readRequestBody(req) {
  return new Promise((resolveRead, rejectRead) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        rejectRead(new Error('request body exceeded 1MB'));
        req.destroy();
      }
    });
    req.on('end', () => resolveRead(body));
    req.on('error', rejectRead);
  });
}

function writeJson(res, status, payload) {
  res.writeHead(status, {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'POST, OPTIONS',
    'content-type': 'application/json; charset=utf-8',
  });
  res.end(JSON.stringify(payload));
}

function fakeProviderCards() {
  return {
    cards: [
      {
        title: 'Tab-aware reading',
        anchor: 'Gemini is not limited to one tab',
        gist: 'The fixture confirms the provider result can anchor back into the live page.',
        bullets: ['The analysis path crosses side panel, background, provider, and content script.'],
      },
      {
        title: 'Quote-preserving anchors',
        anchor: 'preserve anchor quotes',
        gist: 'The generated card keeps a verbatim quote that the content script can locate.',
        bullets: ['This guards the release-grade generation happy path without external LLM calls.'],
      },
    ],
  };
}

async function handleProviderRequest(req, res) {
  const body = await readRequestBody(req);
  let parsed = {};
  try {
    parsed = JSON.parse(body || '{}');
  } catch {
    writeJson(res, 400, { error: { message: 'invalid JSON request' } });
    return;
  }
  providerRequests.push({
    authorization: req.headers.authorization || '',
    bodyLength: body.length,
    messageCount: Array.isArray(parsed.messages) ? parsed.messages.length : 0,
    model: parsed.model || '',
    responseFormatType: parsed.response_format?.type || '',
  });

  if (providerMode === 'error') {
    writeJson(res, 502, { error: { message: 'fake provider failure' } });
    return;
  }

  if (providerDelayMs > 0) await delay(providerDelayMs);
  writeJson(res, 200, {
    choices: [
      {
        message: {
          content: JSON.stringify(fakeProviderCards()),
        },
      },
    ],
  });
}

async function startFixtureServer() {
  server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'OPTIONS') {
      writeJson(res, 204, {});
      return;
    }
    if (req.method === 'POST' && url.pathname === '/chat/completions') {
      void handleProviderRequest(req, res).catch((error) => {
        writeJson(res, 500, { error: { message: error instanceof Error ? error.message : String(error) } });
      });
      return;
    }
    if (url.pathname !== '/' && url.pathname !== '/article.html' && url.pathname !== '/other.html') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (url.pathname === '/other.html') {
      res.end(`<!doctype html>
      <html>
        <head><title>Parallel Reader Other Fixture</title></head>
        <body>
          <main>
            <article>
              <h1>Parallel Reader Other Fixture</h1>
              <p>This is a second tab used to verify that a running analysis remains attached to the original page.</p>
            </article>
          </main>
        </body>
      </html>`);
      return;
    }
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
  serverOrigin = `http://127.0.0.1:${port}`;
  baseUrl = `${serverOrigin}/article.html`;
  otherUrl = `${serverOrigin}/other.html`;
}

function findExtensionServiceWorker() {
  return context.serviceWorkers().find((sw) => sw.url().endsWith('/background.js'));
}

async function waitForExtensionId() {
  let serviceWorker = findExtensionServiceWorker();
  const deadline = Date.now() + 10000;
  while (!serviceWorker && Date.now() < deadline) {
    await context
      .waitForEvent('serviceworker', { timeout: deadline - Date.now() })
      .catch(() => undefined);
    serviceWorker = findExtensionServiceWorker();
  }
  assert(serviceWorker, 'parallel-reader background service worker did not appear within 10s');
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
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
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

async function openSidePanelPage(tabId) {
  if (sidePage && !sidePage.isClosed()) await sidePage.close();
  sidePage = await context.newPage();
  const suffix = tabId === undefined ? '' : `?tabId=${encodeURIComponent(String(tabId))}`;
  await sidePage.goto(`chrome-extension://${extensionId}/sidepanel.html${suffix}`);
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

async function openFixtureArticle() {
  if (!fixturePage || fixturePage.isClosed()) {
    fixturePage = await context.newPage();
    await fixturePage.goto(baseUrl);
  }
  await fixturePage.bringToFront();
  return fixturePage;
}

async function openArticleInFixtureTab(url) {
  if (!fixturePage || fixturePage.isClosed()) {
    fixturePage = await context.newPage();
  }
  await fixturePage.goto(url);
  await fixturePage.bringToFront();
  return fixturePage;
}

async function tabIdForUrl(url) {
  const sw = findExtensionServiceWorker();
  assert(sw, 'service worker not available');
  return sw.evaluate((targetUrl) => {
    return chrome.tabs.query({}).then((tabs) => {
      const tab = tabs.find((candidate) => candidate.url === targetUrl);
      if (!tab?.id) throw new Error(`tab not found for ${targetUrl}`);
      return tab.id;
    });
  }, url);
}

async function waitForTabScopedSidePanelPath(tabId) {
  const sw = findExtensionServiceWorker();
  assert(sw, 'service worker not available');
  const expected = `sidepanel.html?tabId=${tabId}`;
  await waitUntil(
    async () =>
      sw.evaluate(async ({ expectedPath, id }) => {
        const options = await chrome.sidePanel.getOptions({ tabId: id });
        return options.enabled === true && options.path === expectedPath;
      }, { expectedPath: expected, id: tabId }),
    `side panel path was not scoped to tab ${tabId}`,
  );
}

async function enableSidePanelForTab(tabId) {
  const sw = findExtensionServiceWorker();
  assert(sw, 'service worker not available');
  await sw.evaluate(async (id) => {
    await chrome.sidePanel.setOptions({
      tabId: id,
      path: `sidepanel.html?tabId=${id}`,
      enabled: true,
    });
  }, tabId);
}

async function sidePanelSnapshot(tabIds = []) {
  const sw = findExtensionServiceWorker();
  assert(sw, 'service worker not available');
  return sw.evaluate(async (ids) => {
    const manifest = chrome.runtime.getManifest();
    const globalOptions = await chrome.sidePanel.getOptions({});
    const tabOptions = {};
    for (const id of ids) {
      tabOptions[id] = await chrome.sidePanel.getOptions({ tabId: id });
    }
    return {
      manifestDefaultPath: manifest.side_panel?.default_path ?? null,
      globalEnabled: globalOptions.enabled ?? null,
      globalPath: globalOptions.path ?? null,
      tabOptions,
    };
  }, tabIds);
}

async function pageStateSnapshot(url) {
  return sidePage.evaluate(
    async ({ prefix, pageUrl }) => {
      const key = `${prefix}${pageUrl}`;
      const [local, session] = await Promise.all([
        chrome.storage.local.get(key),
        chrome.storage.session?.get(key) ?? Promise.resolve({}),
      ]);
      return {
        key,
        localState: local[key] ?? null,
        sessionState: session[key] ?? null,
      };
    },
    { prefix: pageStatePrefix, pageUrl: url },
  );
}

async function openSidePanelFromExtensionGesture(tabId) {
  await sidePage.evaluate((id) => {
    delete window.__gestureSidePanelOpenResult;
    document.querySelector('#gesture-sidepanel-open')?.remove();
    const button = document.createElement('button');
    button.id = 'gesture-sidepanel-open';
    button.addEventListener(
      'click',
      () => {
        const enablePromise = chrome.sidePanel.setOptions({
          tabId: id,
          path: `sidepanel.html?tabId=${id}`,
          enabled: true,
        });
        const openPromise = chrome.sidePanel.open({ tabId: id });
        window.__gestureSidePanelOpenResult = Promise.all([enablePromise, openPromise]).then(
          () => ({ ok: true }),
          (error) => ({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      },
      { once: true },
    );
    document.body.append(button);
  }, tabId);
  await sidePage.locator('#gesture-sidepanel-open').click({ timeout: 5000 });
  return sidePage.evaluate(() => window.__gestureSidePanelOpenResult);
}

async function configureFakeProvider() {
  await sidePage.evaluate(
    async ({ key, origin }) => {
      await chrome.storage.local.set({
        [key]: {
          apiKey: 'e2e-test-key',
          baseUrl: origin,
          model: 'fake-chat',
          minCards: 2,
          maxCards: 2,
          maxDocChars: 20000,
          summaryLanguage: 'zh-CN',
          cardDensity: 'normal',
        },
      });
    },
    { key: settingsKey, origin: serverOrigin },
  );
}

async function triggerAnalysisWithoutChangingActiveTab() {
  await sidePage.evaluate(() => {
    const button = document.querySelector('#analyze:not([hidden]), #analyze-hero:not([hidden])');
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error('analyze button is not available');
    }
    button.click();
  });
}

async function waitForCompletedCards(expectedCount) {
  await sidePage.waitForFunction(
    (count) => document.querySelector('#status')?.textContent?.includes(`完成 · ${count} 张卡片`),
    expectedCount,
    { timeout: 10000 },
  );
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

  await record('side panel has no global fallback path', ['risk:wiring', 'risk:regression'], async () => {
    let snapshot;
    await waitUntil(async () => {
      snapshot = await sidePanelSnapshot();
      return (
        snapshot.manifestDefaultPath === null &&
        snapshot.globalPath === null &&
        snapshot.globalEnabled === false
      );
    }, 'global side panel fallback remained enabled');
    assert(
      snapshot.manifestDefaultPath === null,
      `manifest still defines side_panel.default_path=${snapshot.manifestDefaultPath}`,
    );
    assert(snapshot.globalPath === null, `global side panel path remained set: ${snapshot.globalPath}`);
    assert(snapshot.globalEnabled === false, `global side panel was not disabled: ${snapshot.globalEnabled}`);
  });

  await record('browser action does not use global open-on-click behavior', ['risk:wiring', 'risk:regression'], async () => {
    const sw = findExtensionServiceWorker();
    assert(sw, 'service worker not available');
    const behavior = await sw.evaluate(async () => chrome.sidePanel.getPanelBehavior());
    assert(
      behavior?.openPanelOnActionClick === false,
      `expected openPanelOnActionClick=false; got ${JSON.stringify(behavior)}`,
    );
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
    await openFixtureArticle();
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

  await record('side panel is disabled on unopened tabs', ['risk:wiring', 'risk:regression'], async () => {
    const fixtureTabId = await tabIdForUrl(baseUrl);
    const otherPage = await context.newPage();
    await otherPage.goto(otherUrl);
    const otherTabId = await tabIdForUrl(otherUrl);
    const snapshot = await sidePanelSnapshot([fixtureTabId, otherTabId]);
    assert(snapshot.tabOptions[fixtureTabId]?.enabled === false, 'fixture tab side panel started enabled');
    assert(snapshot.tabOptions[fixtureTabId]?.path == null, 'fixture tab side panel started with a path');
    assert(snapshot.tabOptions[otherTabId]?.enabled === false, 'other tab side panel started enabled');
    assert(snapshot.tabOptions[otherTabId]?.path == null, 'other tab side panel started with a path');
  });

  await record('side panel paths are scoped per opened tab', ['risk:wiring', 'risk:regression'], async () => {
    const fixtureTabId = await tabIdForUrl(baseUrl);
    await enableSidePanelForTab(fixtureTabId);
    await waitForTabScopedSidePanelPath(fixtureTabId);
    const otherTabId = await tabIdForUrl(otherUrl);
    let snapshot = await sidePanelSnapshot([fixtureTabId, otherTabId]);
    assert(snapshot.tabOptions[otherTabId]?.enabled === false, 'unopened other tab became enabled');
    assert(snapshot.tabOptions[otherTabId]?.path == null, 'unopened other tab got a side panel path');
    await enableSidePanelForTab(otherTabId);
    await waitForTabScopedSidePanelPath(otherTabId);
    snapshot = await sidePanelSnapshot([fixtureTabId, otherTabId]);
    const fixturePath = snapshot.tabOptions[fixtureTabId]?.path;
    const otherPath = snapshot.tabOptions[otherTabId]?.path;
    assert(fixturePath === `sidepanel.html?tabId=${fixtureTabId}`, `unexpected fixture tab path: ${fixturePath}`);
    assert(otherPath === `sidepanel.html?tabId=${otherTabId}`, `unexpected other tab path: ${otherPath}`);
    assert(fixturePath !== otherPath, 'two tabs shared the same side panel path');
    await openSidePanelPage(fixtureTabId);
  });

  await record('side panel opens when options and open share one user gesture', ['risk:wiring', 'risk:regression'], async () => {
    const fixtureTabId = await tabIdForUrl(baseUrl);
    const result = await openSidePanelFromExtensionGesture(fixtureTabId);
    assert(result?.ok === true, `sidePanel.open failed from a user gesture: ${result?.error}`);
  });

  await record('fake provider analysis renders anchored cards', ['risk:boundary_io', 'risk:wiring', 'risk:contract', 'risk:regression'], async () => {
    providerMode = 'success';
    providerDelayMs = 0;
    providerRequests.length = 0;
    await configureFakeProvider();
    await openFixtureArticle();
    await triggerAnalysisWithoutChangingActiveTab();
    await waitForCompletedCards(2);
    const cardCount = await sidePage.locator('.card').count();
    assert(cardCount === 2, `expected 2 rendered cards, got ${cardCount}`);
    const firstCard = await sidePage.locator('.card').first().textContent();
    assert(firstCard?.includes('Tab-aware reading'), 'first fake provider card was not rendered');
    assert(providerRequests.length === 1, `expected 1 fake provider request, got ${providerRequests.length}`);
    const request = providerRequests[0];
    assert(request.authorization === 'Bearer e2e-test-key', 'provider request did not include the stored API key');
    assert(request.model === 'fake-chat', `unexpected provider model: ${request.model}`);
    assert(request.responseFormatType === 'json_object', 'provider request did not ask for a JSON object');
    assert(request.messageCount === 2, `unexpected provider message count: ${request.messageCount}`);
  });

  await record('analysis state is persisted by URL in local storage', ['risk:regression', 'risk:resource_lifecycle'], async () => {
    const snapshot = await pageStateSnapshot(baseUrl);
    assert(snapshot.localState, `missing local page state at ${snapshot.key}`);
    assert(snapshot.localState.page?.key === baseUrl, `unexpected page state key: ${snapshot.localState.page?.key}`);
    assert(snapshot.localState.page?.url === baseUrl, `unexpected page state URL: ${snapshot.localState.page?.url}`);
    assert(snapshot.sessionState === null, 'page state was written to session storage');
  });

  await record('analysis state restores for the same URL after tab recreation', ['risk:regression', 'risk:resource_lifecycle'], async () => {
    const requestsBefore = providerRequests.length;
    if (fixturePage && !fixturePage.isClosed()) await fixturePage.close();
    fixturePage = undefined;
    await openFixtureArticle();
    const newTabId = await tabIdForUrl(baseUrl);
    await enableSidePanelForTab(newTabId);
    await openSidePanelPage(newTabId);
    await sidePage.waitForFunction(
      () => document.querySelector('#status')?.textContent?.includes('已恢复当前页结果'),
      null,
      { timeout: 5000 },
    );
    const cardCount = await sidePage.locator('.card').count();
    assert(cardCount === 2, `expected 2 restored cards, got ${cardCount}`);
    assert(providerRequests.length === requestsBefore, 'restore path unexpectedly called provider again');
  });

  await record('provider failure preserves existing rendered cards', ['risk:failure_path', 'risk:regression'], async () => {
    providerMode = 'error';
    providerDelayMs = 0;
    await openFixtureArticle();
    await triggerAnalysisWithoutChangingActiveTab();
    await sidePage.waitForFunction(
      () => document.querySelector('#status')?.textContent?.includes('错误: HTTP 502'),
      null,
      { timeout: 10000 },
    );
    const cardCount = await sidePage.locator('.card').count();
    assert(cardCount === 2, `provider failure cleared existing cards; count=${cardCount}`);
  });

  await record('analysis remains attached to its tab while another tab is active', ['risk:failure_path', 'risk:regression', 'risk:wiring'], async () => {
    providerMode = 'success';
    providerDelayMs = 500;
    providerRequests.length = 0;
    const switchUrl = `${baseUrl}?case=switch-away`;
    await openArticleInFixtureTab(switchUrl);
    const fixtureTabId = await tabIdForUrl(switchUrl);
    await enableSidePanelForTab(fixtureTabId);
    await waitForTabScopedSidePanelPath(fixtureTabId);
    await openSidePanelPage(fixtureTabId);
    await configureFakeProvider();
    await triggerAnalysisWithoutChangingActiveTab();
    await waitUntil(() => providerRequests.length === 1, 'fake provider was not called');
    const otherPage = await context.newPage();
    await otherPage.goto(otherUrl);
    await otherPage.bringToFront();
    await delay(providerDelayMs + 250);
    await fixturePage.bringToFront();
    await waitForCompletedCards(2);
    providerDelayMs = 0;
  });

  // The pending-analyze message is what background's command handler (Alt+Shift+R)
  // emits to the side panel. Playwright cannot fire a real Chrome global shortcut,
  // so we exercise the consumer wire from the service worker (the same context
  // the real handler runs in). Producer construction is covered by
  // tests/pending-analyze.test.mjs (buildPendingAnalyzeRequest).
  await record('service worker can ack pending-analyze through side panel listener', ['risk:wiring', 'risk:contract'], async () => {
    providerMode = 'success';
    providerDelayMs = 0;
    const sw = findExtensionServiceWorker();
    assert(sw, 'service worker not available');
    const fixture = await sw.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((t) => t.url?.includes('/article.html'));
      if (!tab?.id || !tab.url) throw new Error('fixture tab not found');
      return { tabId: tab.id, url: tab.url };
    });
    const ack = await sw.evaluate(
      async ({ tabId, url }) => {
        return chrome.runtime.sendMessage({
          type: 'pending-analyze',
          request: { tabId, url, nonce: `e2e-ok-${Date.now()}`, ts: Date.now() },
        });
      },
      fixture,
    );
    assert(ack && ack.ok === true, `expected ack.ok=true, got: ${JSON.stringify(ack)}`);
    await waitForCompletedCards(2);
  });

  await record('side panel rejects malformed pending-analyze message', ['risk:wiring', 'risk:failure_path'], async () => {
    const sw = findExtensionServiceWorker();
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
