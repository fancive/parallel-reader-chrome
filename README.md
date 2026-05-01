# Parallel Reader

> LLM-generated summary cards anchored to verbatim quotes on any web page.
> A URL-keyed Chrome side panel for slow, evidence-linked reading.

[![Manifest V3](https://img.shields.io/badge/manifest-v3-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![Chrome 114+](https://img.shields.io/badge/chrome-%E2%89%A5114-4285F4?logo=googlechrome&logoColor=white)](manifest.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?logo=typescript&logoColor=white)](tsconfig.json)
[![Biome](https://img.shields.io/badge/lint-Biome-60A5FA?logo=biome&logoColor=white)](biome.json)
[![esbuild](https://img.shields.io/badge/build-esbuild-FFCF00?logo=esbuild&logoColor=black)](esbuild.config.mjs)
[![tests](https://img.shields.io/badge/tests-93%20passing-2EA043)](tests)
[![status](https://img.shields.io/badge/status-prototype%20%C2%B7%20BYOK-orange)](#credential-boundary-and-release-decision)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](#contributing)

**English** · [简体中文](README.zh-CN.md)

---

## Table of Contents

- [Why](#why)
- [Features](#features)
- [Quick Start](#quick-start)
- [Side Panel UX](#side-panel-ux)
  - [Extraction State](#extraction-state)
  - [Rerun Behavior](#rerun-behavior)
  - [Card Actions](#card-actions)
  - [Keyboard & Accessibility](#keyboard--accessibility)
- [Permissions & Unsupported Pages](#permissions--unsupported-pages)
- [Provider Settings](#provider-settings)
- [Credential Boundary and Release Decision](#credential-boundary-and-release-decision)
- [Development](#development)
- [Project Structure](#project-structure)
- [E2E Contract](#e2e-contract)
- [Anchor Smoke Test](#anchor-smoke-test)
- [Regression Gate](#regression-gate)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

## Why

Most LLM "summarize this page" tools produce a paragraph of generated prose
that you cannot trace back to the original article. Parallel Reader takes the
opposite approach: every card is a **verbatim quote** from the page plus a
short LLM gist, and the quote anchors back to the exact location in the live
DOM so you can jump to it and verify in context. The side panel stores card
state by URL, so a page can recover its cards after browser restart.

## Features

- **Anchored summary cards** — each card carries the literal quote and a click
  jumps to that exact text range in the page.
- **Three-way anchor validation** — every anchor is checked against raw page
  text, Mozilla Readability article text, and a live DOM Range, so you see
  honestly which cards are still locatable.
- **Persistent per-URL cache with governance** — switch pages, recreate
  tabs, or restart Chrome without losing cards. Each entry carries a
  content fingerprint and a configurable TTL (default 7 days), so when the
  page changes the side panel shows a "rerun" banner instead of silently
  restoring stale cards. Settings exposes one-click *Clear cards for this
  page* and *Clear all cached pages*.
- **History / library view** — list every URL you have analyzed with title,
  timestamp, and card count; reopen, delete individually, or bulk-export
  the whole library as Markdown / JSON.
- **Copy quote / copy summary** — works even when the live DOM no longer
  matches the cached anchor (DOM-miss cards are still useful for note-taking).
- **Configurable density and language** — concise / normal / detailed bullet
  budget; Chinese or English summaries.
- **Configurable card count** — request between 4 and 10 cards per analysis.
- **OpenAI-compatible BYOK** — works with DeepSeek, DashScope, OpenAI-shaped
  endpoints; key is stored in the local Chrome profile only.
- **Accessible side panel** — `aria-live` status, keyboard-navigable card
  context menu (Arrow / Home / End / Esc / Tab), persistent active-card
  highlight, visible `:focus-visible` outlines.
- **Anchor smoke CLI** — batch-validate a list of URLs end-to-end against the
  real provider with a regression gate on DOM hit rate and readable text size.

## Quick Start

```bash
npm install
npm run build
```

Load the unpacked extension in Chrome:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the project's `./dist` directory.
5. Click the extension toolbar icon to open the side panel.
6. Save provider settings (see [Provider Settings](#provider-settings)).
7. Click **Analyze current page**.

Requires Chrome **114 or newer** (the side panel API and MV3 service worker
features used here are not available in older builds).

## Side Panel UX

### Extraction State

Each analyzed page reports the raw text length, the Readability article
length, the version sent to the LLM, and the actual selected text length.
A non-blocking quality line tells you what to expect:

| Tag | Meaning |
| --- | --- |
| `抽取正常` | Selected text is long enough for normal card generation. |
| `可读文本偏短` | Page may still be loading, gated by login, or not an article body. |
| `使用 Raw 文本` | Readability could not extract a stable article body, so raw page text was used. |

These warnings do **not** stop analysis — they make partial-page state
visible before you judge anchor hit rate or card quality.

### Rerun Behavior

Results are cached per tab and URL. When the current page already has saved
cards, the main action label changes from `分析当前页` to `重新分析当前页`.
Rerun explicitly extracts the page again and replaces the cached result
**only after** a successful analysis. Existing cards stay visible while the
new run is in progress, so a failed provider call or a partially loaded page
does not erase the previous saved result.

### Card Actions

Each card can copy its verbatim quote or a compact summary directly from the
side panel. Copy actions remain available even when the card cannot be
highlighted in the live DOM, so DOM-miss cards still help with note-taking
and follow-up reading.

### Keyboard & Accessibility

- The card context menu opens with right-click and is fully keyboard-driven:
  - `↑` / `↓` cycles non-disabled menu items.
  - `Home` / `End` jumps to the first / last item.
  - `Esc` closes the menu.
  - `Tab` leaves the menu and closes it.
- The most recently activated card receives a persistent `card-active`
  accent so you can scroll back without losing your reading position.
- Status messages live in an `aria-live="polite"` region; settings errors
  surface inline via a `role="alert"` paragraph.
- All interactive elements (cards, primary action, icon buttons, debug
  toggle) expose `:focus-visible` outlines.

## Permissions & Unsupported Pages

The prototype declares `<all_urls>` because the validation target is
arbitrary English-media articles, not a fixed allowlist. The content script
needs the page text and live DOM ranges from whichever article the reader
opens. `activeTab` and `scripting` are also used so the side panel can retry
content-script injection for the current active page after extension reloads.

Unsupported or restricted pages are handled before analysis:

- Browser internal pages and extension pages (e.g. `chrome://extensions`,
  `chrome-extension://...`) cannot receive extension content scripts.
- Browser PDF viewer pages are not supported by this prototype; use an
  article page or another copyable text view instead.
- `file://` pages require enabling **Allow access to file URLs** for the
  unpacked extension in `chrome://extensions`.
- Other non-HTTP protocols may fail because Chrome does not expose a normal
  page DOM to content scripts.

## Provider Settings

Settings are stored in Chrome local storage under `parallel-reader-settings`.
This is a local BYOK prototype: the API key lives on the current Chrome
profile and is used by the extension background worker.

Default settings:

| Setting | Default |
| --- | --- |
| Base URL | `https://api.deepseek.com/v1` |
| Model | `deepseek-chat` |
| Card count | `4` to `10` |
| Summary language | Chinese (`zh-CN`) |
| Card density | Normal (`normal`) |
| Max document chars | `20000` |

Summary language can be switched to English when reading English media.
Card density can be set to **concise**, **normal**, or **detailed**; it
changes the prompt-level bullet count and detail budget without changing the
anchor requirement.

For DashScope or another OpenAI-compatible endpoint, set the side-panel
fields to the same API key, base URL, and model the extension should call.
The smoke CLI also accepts these environment variables:

```bash
export DASHSCOPE_CODING_SK=...
export DASHSCOPE_CODING_BASE_URL=...
export DASHSCOPE_CODING_MODEL=qwen3-coder-plus  # optional; defaults to qwen3-coder-plus
```

## Credential Boundary and Release Decision

**Decision (2026-04-29):** this project remains a **local, developer-operated
BYOK tool**. It is acceptable for private unpacked-extension testing where
the reader knowingly stores their own provider key in their own Chrome
profile.

This is **not** an acceptable production credential model for public
distribution. Before any Chrome Web Store release, provider calls must move
behind one of the following:

- A backend service that owns provider credentials and applies auth, rate
  limits, request logging, and abuse controls.
- An ephemeral-token proxy that issues short-lived scoped credentials
  instead of persisting a long-lived provider key in extension storage.

Release implication: the current `storage` + background-worker provider call
path is a **prototype boundary, not a launch boundary**. Product work can
continue locally, but public release is blocked until the credential model
is replaced and reviewed.

## Development

```bash
npm run dev        # watch build into dist/
npm run build      # production-style local build
npm run check      # test + lint + typecheck + build + audit
npm run e2e        # project-local .e2e contract gate (Playwright)
npm run e2e:linux  # same gate inside a Linux container (mirrors CI Chromium-for-Testing)
npm run lint       # Biome lint baseline for src/, scripts/, tests/, build config
npm test           # node --test test suite
npm run typecheck  # TypeScript only
npm audit          # dependency audit
```

The build output in `dist/` is what Chrome loads. After editing source
files, rebuild and reload the unpacked extension from `chrome://extensions`.

## Project Structure

```
src/
  background.ts            MV3 service worker, provider call orchestration
  content.ts               page extraction + DOM Range location
  sidepanel.ts             side-panel entry; wires modules below
  sidepanel.html / .css    side-panel UI
  shared/                  pure helpers (no chrome.* calls)
    anchor.ts              anchor matching algorithms
    anchor-repair.ts       fuzzy fallback for anchor location
    dom-anchor.ts          DOM Range builder for the content script
    extraction-quality.ts  raw / readable / selected text classification
    json-extract.ts        defensive JSON parsing for provider responses
    logger.ts              debug-flag-gated console.warn shim
    page-support.ts        URL/protocol allow-list for the side panel
    prompt.ts              prompt construction
    provider.ts            provider request/response shape
    types.ts               shared TypeScript types
  sidepanel/               extracted side-panel modules
    card-view.ts           DOM-safe card rendering (no innerHTML)
    clipboard.ts           clipboard helpers + fallback
    concurrency.ts         runWithConcurrency, debounce
    dom.ts                 $, escapeHtml, errorMessage helpers
    history.ts             per-URL history index + Markdown / JSON export
    history-view.ts        history panel rendering
    menu.ts                card context menu (keyboard navigable)
    page-identity.ts       URL normalization for cache key
    settings-form.ts       settings panel binding + inline error
tests/                     node --test specs (93 tests)
scripts/                   anchor smoke CLI + e2e-linux container helper
tools/e2e/                 vendored e2e_contract_validator (Python, gate-only)
.e2e/                      project-local E2E contract (gate.sh + Playwright)
```

## E2E Contract

The project-local `.e2e` gate runs an extension-level smoke test against a
local article fixture:

```bash
npm run e2e
```

The gate builds the unpacked extension, launches Chrome, opens the
side-panel page, verifies the first-run provider setup guard, and checks
that the content script can extract and locate fixture article text without
provider credentials. Generated CTRF evidence is written to
`.e2e/artifact.json`.

## Anchor Smoke Test

Batch-validate a list of real article URLs end-to-end against the real
provider. Create a newline-delimited URL file (blank lines and `#` comments
are ignored):

```text
https://arstechnica.com/google/2025/09/google-announces-massive-expansion-of-ai-features-in-chrome/
https://aeon.co/essays/sure-ai-can-do-writing-but-memoir-not-so-much
```

Run the smoke test:

```bash
npm run anchor:smoke -- \
  --urls urls.txt \
  --output-dir reports \
  --timeout-ms 60000 \
  --network-idle-ms 7000 \
  --settle-ms 2500
```

For each URL, the smoke test opens the page in Chrome, extracts raw and
Readability text, calls the provider, and validates each returned anchor
against:

- raw page text
- Readability article text
- DOM Range location on the live page

Reports are written as JSON and Markdown under `reports/`.

## Regression Gate

Use thresholds when you want the smoke test to fail with a non-zero exit
code:

```bash
npm run anchor:smoke -- --urls urls.txt --min-dom-hit-rate 90% --min-readable-chars 1000
```

You can also gate an existing JSON report without rerunning the browser or
model:

```bash
npm run anchor:smoke -- \
  --gate-report reports/anchor-smoke-2026-04-29T02-27-25-530Z.json \
  --min-dom-hit-rate 90% --min-readable-chars 1000
```

`--min-dom-hit-rate` accepts `0.9`, `90`, or `90%`. `--min-readable-chars`
checks the selected text version sent to the model. A page that is still
loading or only partly extractable can still be inspected manually; the gate
lets each batch decide how strict it should be.

## Roadmap

- Backend or ephemeral-token credential model (blocker for any public
  release — see [Credential Boundary](#credential-boundary-and-release-decision)).
- More provider profiles (Anthropic, native OpenAI, local models) once the
  credential boundary is replaced.
- Multi-language UI strings (currently mixed Chinese / English in the
  side panel — keys exist, full i18n pass pending).
- Per-card "open in note" export to Obsidian / Markdown.

## Contributing

Issues and PRs are welcome — especially anchor-correctness regressions on
real article URLs (please attach the URL and the JSON report from
`npm run anchor:smoke`).

Before opening a PR:

```bash
npm run check      # tests + lint + typecheck + build + audit
npm run e2e        # extension smoke (Playwright)
```

Coding conventions are enforced by Biome (`biome.json`) and TypeScript
(`tsconfig.json`). Please do not modify either config in the same PR as a
behavior change.

## License

License is **not yet specified**. Until a `LICENSE` file is added, treat the
source as "all rights reserved" by the repository author. If you would like
to use this code under a specific license, open an issue.
