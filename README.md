# Parallel Reader Chrome

Chrome MV3 extension for reading web pages with LLM-generated summary cards anchored to exact text on the page. The side panel is keyed by tab and URL, so different pages keep separate card state.

## Install

```bash
npm install
npm run build
```

Load the extension in Chrome:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click **Load unpacked**.
4. Select `/Users/wujunchen/dev/github.com/fancive/parallel-reader-chrome/dist`.

After loading, click the extension icon to open the side panel, save provider settings, then click **Analyze current page**.

## Side Panel Extraction State

Each analyzed page shows the raw text length, Readability text length, the version sent to the LLM, and the actual selected text length. The panel also shows a non-blocking extraction quality line:

- `抽取正常`: the selected text is long enough for normal card generation.
- `可读文本偏短`: the page may still be loading, gated by login, or not an article body.
- `使用 Raw 文本`: Readability could not extract a stable article body, so the extension used raw page text.

These warnings do not stop analysis. They are meant to make partial-page state visible before judging anchor hit rate or card quality.

## Rerun Behavior

Results are cached per tab and URL. When the current page already has saved cards, the main action changes from `分析当前页` to `重新分析当前页`. Rerun explicitly extracts the current page again and replaces the cached result only after a successful analysis. Existing cards stay visible while the replacement run is in progress, so a failed provider call or partially loaded page does not erase the previous saved result.

## Card Actions

Each card can copy its verbatim quote or a compact summary directly from the side panel. Copy actions remain available even when the card cannot be highlighted in the live DOM, so DOM miss cards are still useful for note-taking and follow-up reading.

## Permissions And Unsupported Pages

The prototype declares `<all_urls>` because the core validation target is arbitrary English media pages, not a fixed allowlist. The content script needs page text and live DOM ranges from whichever article the reader opens. `activeTab` and `scripting` are also used so the side panel can retry content-script injection for the current active page after extension reloads.

Unsupported or restricted pages are handled before analysis:

- Browser internal pages and extension pages, such as `chrome://extensions` or `chrome-extension://...`, cannot receive extension content scripts.
- Browser PDF viewer pages are not supported by this prototype; use an article page or another copyable text view instead.
- `file://` pages require enabling **Allow access to file URLs** for the unpacked extension in `chrome://extensions`.
- Other non-HTTP protocols may fail because Chrome does not expose a normal page DOM to content scripts.

## Provider Settings

The extension stores settings in Chrome local storage under `parallel-reader-settings`.
This is a local BYOK prototype: the API key is stored on the current Chrome profile and used by the extension background worker.

## Credential Boundary And Release Decision

Decision as of 2026-04-29: this project remains a local, developer-operated BYOK tool. It is acceptable for private unpacked-extension testing where the reader knowingly stores their own provider key in their own Chrome profile.

This is not an acceptable production credential model for public distribution. Before any Chrome Web Store or broad-user release, provider calls must move behind one of these designs:

- A backend service that owns provider credentials, applies auth, rate limits, request logging, and abuse controls.
- An ephemeral-token proxy that issues short-lived scoped credentials instead of persisting a long-lived provider key in extension storage.

Release implication: the current `storage` plus background-worker provider call path is a prototype boundary, not a launch boundary. Product work can continue locally, but public release is blocked until the credential model is replaced and reviewed.

Default settings:

- Base URL: `https://api.deepseek.com/v1`
- Model: `deepseek-chat`
- Cards: `4` to `10`
- Summary language: Chinese (`zh-CN`)
- Card density: Normal (`normal`)
- Max document chars: `20000`

Summary language can be switched to English when reading English media and you want English cards instead of Chinese cards. Card density can be set to concise, normal, or detailed; it changes the prompt-level bullet count and detail budget without changing the anchor requirement.

For DashScope or another OpenAI-compatible endpoint, set the side-panel fields to the same API key, base URL, and model you want the browser extension to call. The smoke CLI also accepts these environment variables:

```bash
export DASHSCOPE_CODING_SK=...
export DASHSCOPE_CODING_BASE_URL=...
export DASHSCOPE_CODING_MODEL=qwen3-coder-plus
```

`DASHSCOPE_CODING_MODEL` is optional for the CLI; when the DashScope coding variables are used without an explicit model, the CLI defaults to `qwen3-coder-plus`.

## Development

```bash
npm run dev        # watch build into dist/
npm run build      # production-style local build
npm run check      # test, typecheck, build, and audit
npm run e2e        # project-local .e2e contract gate
npm run lint       # Biome lint baseline for src/, scripts/, tests/, and build config
npm test           # node test suite
npm run typecheck  # TypeScript only
npm audit          # dependency audit
```

The build output in `dist/` is what Chrome loads. After editing source files, rebuild and reload the unpacked extension from `chrome://extensions`.

## E2E Contract

The project-local `.e2e` gate runs an extension-level smoke test against a local article fixture:

```bash
npm run e2e
```

The gate builds the unpacked extension, launches Chrome, opens the side-panel page, verifies the first-run provider setup guard, and checks that the content script can extract and locate fixture article text without provider credentials. Generated CTRF evidence is written to `.e2e/artifact.json`.

## English Media Smoke Test

Create a newline-delimited URL file. Blank lines and `#` comments are ignored.

```text
https://arstechnica.com/google/2025/09/google-announces-massive-expansion-of-ai-features-in-chrome/
https://aeon.co/essays/sure-ai-can-do-writing-but-memoir-not-so-much
```

Run the smoke test:

```bash
npm run anchor:smoke -- --urls urls.txt --output-dir reports --timeout-ms 60000 --network-idle-ms 7000 --settle-ms 2500
```

The smoke test opens each page with Chrome, extracts raw and Readability text, calls the provider, and validates each returned anchor against:

- raw page text
- Readability article text
- DOM Range location on the live page

Reports are written as JSON and Markdown under `reports/`.

## Regression Gate

Use thresholds when you want the smoke test to fail with a non-zero exit code:

```bash
npm run anchor:smoke -- --urls urls.txt --min-dom-hit-rate 90% --min-readable-chars 1000
```

You can also gate an existing JSON report without rerunning the browser or model:

```bash
npm run anchor:smoke -- --gate-report reports/anchor-smoke-2026-04-29T02-27-25-530Z.json --min-dom-hit-rate 90% --min-readable-chars 1000
```

`--min-dom-hit-rate` accepts `0.9`, `90`, or `90%`. `--min-readable-chars` checks the selected text version sent to the model. A page that is still loading or only partly extractable can still be inspected manually; the gate lets each batch decide how strict it should be.
