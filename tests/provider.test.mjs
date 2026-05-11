import './helpers/i18n-mock.mjs';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const tmpRoot = join(process.cwd(), '.tmp');
await mkdir(tmpRoot, { recursive: true });
const tempDir = await mkdtemp(join(tmpRoot, 'parallel-reader-provider-'));
const outfile = join(tempDir, 'provider.mjs');

await build({
  entryPoints: [join(process.cwd(), 'src', 'shared', 'provider', 'index.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  logLevel: 'silent',
});

const {
  PROVIDER_PRESETS,
  CUSTOM_PRESET_ID,
  getPreset,
  inferPresetFromUrl,
  callProvider,
} = await import(pathToFileURL(outfile));

test.after(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ---------- Preset table ----------

test('PROVIDER_PRESETS has the expected curated provider list', () => {
  const ids = PROVIDER_PRESETS.map((p) => p.id);
  assert.deepEqual(ids, [
    'openai',
    'anthropic',
    'gemini',
    'openrouter',
    'deepseek',
    'volcengine-ark',
  ]);
});

test('every preset declares format, authType, baseUrl, and defaultModel fields', () => {
  for (const preset of PROVIDER_PRESETS) {
    assert.ok(typeof preset.id === 'string' && preset.id.length > 0, `${preset.id} id`);
    assert.ok(typeof preset.label === 'string' && preset.label.length > 0, `${preset.id} label`);
    assert.ok(
      ['openai-chat', 'openai-responses', 'anthropic-messages', 'google-generative-ai'].includes(
        preset.format,
      ),
      `${preset.id} format`,
    );
    assert.ok(
      ['bearer', 'x-api-key', 'x-goog-api-key', 'none'].includes(preset.authType),
      `${preset.id} authType`,
    );
    assert.equal(typeof preset.baseUrl, 'string', `${preset.id} baseUrl`);
    assert.equal(typeof preset.defaultModel, 'string', `${preset.id} defaultModel`);
  }
});

test('preset ids are unique', () => {
  const ids = PROVIDER_PRESETS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('getPreset returns the entry by id', () => {
  assert.equal(getPreset('anthropic')?.label, 'Anthropic');
  assert.equal(getPreset('does-not-exist'), undefined);
});

test('inferPresetFromUrl matches a known preset by baseUrl + format', () => {
  assert.equal(
    inferPresetFromUrl('https://api.anthropic.com/v1', 'anthropic-messages'),
    'anthropic',
  );
  assert.equal(
    inferPresetFromUrl('https://api.openai.com/v1/', 'openai-chat'),
    'openai',
    'trailing slash should not change the match',
  );
  assert.equal(
    inferPresetFromUrl('https://api.deepseek.com/v1', 'openai-chat'),
    'deepseek',
  );
});

test('inferPresetFromUrl returns custom when the URL is not a known preset', () => {
  assert.equal(
    inferPresetFromUrl('https://api.example.com/v1', 'openai-chat'),
    CUSTOM_PRESET_ID,
  );
});

test('inferPresetFromUrl ignores presets whose format does not match', () => {
  // Anthropic baseUrl with the wrong format should not collapse onto anthropic preset.
  assert.equal(
    inferPresetFromUrl('https://api.anthropic.com/v1', 'openai-chat'),
    CUSTOM_PRESET_ID,
  );
});

// ---------- callProvider request shapes ----------

const baseSettings = {
  apiKey: 'test-key',
  model: 'test-model',
  minCards: 4,
  maxCards: 10,
  maxDocChars: 20000,
  summaryLanguage: 'en',
  uiLanguage: 'en',
  cardDensity: 'normal',
  cacheTtlDays: 7,
};

function captureFetch(responseFactory) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const { status = 200, body = { cards: [] } } = await responseFactory({ url, init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return calls;
}

test('callProvider sends OpenAI-compatible requests with bearer auth and json_object response_format', async () => {
  const calls = captureFetch(() => ({
    body: { choices: [{ message: { content: '{"cards":[]}' } }] },
  }));
  const settings = {
    ...baseSettings,
    apiFormat: 'openai-chat',
    baseUrl: 'https://api.openai.com/v1',
  };
  await callProvider('hello world', settings);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(calls[0].init.headers.authorization, 'Bearer test-key');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'test-model');
  assert.equal(body.response_format.type, 'json_object');
  assert.equal(body.stream, false);
});

test('callProvider sends OpenAI Responses requests with text.format=json_object and input array', async () => {
  const calls = captureFetch(() => ({
    body: { output_text: '{"cards":[]}' },
  }));
  const settings = {
    ...baseSettings,
    apiFormat: 'openai-responses',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  };
  await callProvider('hello world', settings);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://ark.cn-beijing.volces.com/api/v3/responses');
  assert.equal(calls[0].init.headers.authorization, 'Bearer test-key');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'test-model');
  assert.equal(body.text.format.type, 'json_object');
  assert.equal(Array.isArray(body.input), true);
  assert.equal(body.input[0].role, 'system');
  assert.equal(body.input[1].role, 'user');
  assert.equal(body.stream, false);
  assert.equal('response_format' in body, false, 'must not send chat-style response_format');
});

test('callProvider parses OpenAI Responses output[].content[].text when output_text is absent', async () => {
  captureFetch(() => ({
    body: {
      output: [
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: '{"cards":[{"title":"A","anchor":"hello","gist":"g","bullets":["b"]}]}',
            },
          ],
        },
      ],
    },
  }));
  const settings = {
    ...baseSettings,
    apiFormat: 'openai-responses',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  };
  const cards = await callProvider('hello world', settings);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].title, 'A');
});

test('callProvider sends Anthropic Messages requests with x-api-key auth and tool_use forcing', async () => {
  const calls = captureFetch(() => ({
    body: {
      content: [
        { type: 'tool_use', name: 'emit_cards', input: { cards: [] } },
      ],
    },
  }));
  const settings = {
    ...baseSettings,
    apiFormat: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com/v1',
  };
  await callProvider('hello world', settings);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(calls[0].init.headers['x-api-key'], 'test-key');
  assert.equal(calls[0].init.headers['anthropic-version'], '2023-06-01');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.tool_choice.name, 'emit_cards');
  assert.equal(body.tools[0].name, 'emit_cards');
  assert.equal(body.system?.length > 0, true, 'system prompt populated');
});

test('callProvider sends Gemini requests against the model-specific generateContent URL', async () => {
  const calls = captureFetch(() => ({
    body: {
      candidates: [
        { content: { parts: [{ text: '{"cards":[]}' }] } },
      ],
    },
  }));
  const settings = {
    ...baseSettings,
    apiFormat: 'google-generative-ai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-2.5-pro',
  };
  await callProvider('hello world', settings);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent',
  );
  assert.equal(calls[0].init.headers['x-goog-api-key'], 'test-key');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.ok(body.generationConfig.responseJsonSchema);
});

test('callProvider parses Anthropic tool_use input directly even when content blocks lack text', async () => {
  captureFetch(() => ({
    body: {
      content: [
        {
          type: 'tool_use',
          name: 'emit_cards',
          input: {
            cards: [
              { title: 'A', anchor: 'hello', gist: 'g', bullets: ['b'] },
            ],
          },
        },
      ],
    },
  }));
  const settings = {
    ...baseSettings,
    apiFormat: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com/v1',
  };
  const cards = await callProvider('hello world', settings);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].title, 'A');
});

test('callProvider surfaces a localized error on HTTP 401', async () => {
  captureFetch(() => ({ status: 401, body: { error: { message: 'no' } } }));
  const settings = {
    ...baseSettings,
    apiFormat: 'openai-chat',
    baseUrl: 'https://api.openai.com/v1',
  };
  await assert.rejects(callProvider('x', settings), /401|Unauthorized|rejected/i);
});

test('callProvider rejects when apiKey is missing', async () => {
  const settings = {
    ...baseSettings,
    apiFormat: 'openai-chat',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
  };
  await assert.rejects(callProvider('x', settings), /API key/i);
});
