// Provider 传输观测验证：安装版 Codex 适配器配合假 SSE/WebSocket，关联实际发送体、重试与缓存元数据；不联网。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const host = path.join(root, 'node_modules/@earendil-works/pi-coding-agent');
const require = createRequire(path.join(host, 'package.json'));
const { createJiti } = await import(require.resolve('jiti'));
const jiti = createJiti(import.meta.url, { fsCache: false });
const feature = await jiti.import(path.join(root, 'extensions/observability/telegram-turn/index.ts'));
const codex = await import(path.join(host, 'node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js'));
const handlers = new Map();
const records = [];
const observer = feature.registerTelegramTurnObservability({
  on(name, handler) {
    handlers.set(name, handler);
  },
  getThinkingLevel: () => 'low',
}, (stage, details, ctx) => records.push({ stage, ...details, sessionId: ctx.sessionManager.getSessionId() }));
let sessionId = 'fixture-session';
const ctx = {
  sessionManager: {
    getSessionId: () => sessionId,
    getSessionFile: () => 'fixture-session.jsonl',
    getHeader: () => ({ timestamp: '2026-10-04T00:00:00Z' }),
  },
};
const model = {
  id: 'synthetic', api: 'openai-codex-responses', provider: 'openai-codex',
  baseUrl: 'https://fixture.invalid', reasoning: true, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100000, maxTokens: 1000,
};
const token = `fixture.${Buffer.from(JSON.stringify({
  'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' },
})).toString('base64')}.fixture`;
let sequence = 0;
function events(diagnostics = true) {
  const n = ++sequence;
  const item = {
    type: 'message', id: `msg_fixture_${n}`, role: 'assistant', phase: 'final_answer',
    content: [{ type: 'output_text', text: 'OK', annotations: [] }],
  };
  return [
    { type: 'response.created', response: { id: `resp_fixture_${n}` } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'OK' },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: {
      id: `resp_fixture_${n}`, model: 'actual-fixture-model', service_tier: 'default', status: 'completed', output: [item],
      usage: { input_tokens: 1100, input_tokens_details: { cached_tokens: 1024 }, output_tokens: 1, total_tokens: 1101 },
      ...(diagnostics ? { prompt_cache_diagnostics: { type: 'cache_hit' } } : {}),
    } },
  ];
}
let fetchCalls = 0;
let retry = false;
let includeDiagnostics = true;
const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;
globalThis.fetch = async url => {
  assert(String(url).startsWith('https://fixture.invalid/'));
  fetchCalls++;
  if (retry) {
    retry = false;
    return new Response('temporary', { status: 503, headers: { 'retry-after-ms': '1' } });
  }
  return new Response(events(includeDiagnostics).map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'x-request-id': 'fixture-http', 'set-cookie': 'private-cookie' },
  });
};
const frames = [];
let failConnect = false;
class FakeWebSocket extends EventTarget {
  readyState = 0;
  constructor(url) {
    super();
    assert(String(url).startsWith('wss://fixture.invalid/'));
    setTimeout(() => {
      if (failConnect) {
        this.dispatchEvent(new Event('error'));
      } else {
        this.readyState = 1;
        this.dispatchEvent(new Event('open'));
      }
    }, 0);
  }
  send(text) {
    frames.push(JSON.parse(text));
    setTimeout(() => {
      for (const e of events()) {
        const event = new Event('message');
        event.data = JSON.stringify(e);
        this.dispatchEvent(event);
      }
    }, 0);
  }
  close() {
    this.readyState = 3;
  }
}
globalThis.WebSocket = FakeWebSocket;
async function run(id, transport, messages, options = {}) {
  observer.observe('request', { requestId: id }, ctx);
  const stream = codex.streamSimple(model, { systemPrompt: 'fixed', messages }, {
    apiKey: token, sessionId: id.startsWith('ws-') ? 'fixture-ws' : id,
    transport, maxRetries: 1, ...options,
  });
  const message = await stream.result();
  assert.equal(message.stopReason, 'stop', message.errorMessage);
  return message;
}
const question = { role: 'user', content: [{ type: 'text', text: 'OK?' }], timestamp: 1 };
try {
  retry = true;
  const sse = await run('sse-retry', 'sse', [question]);
  const sends = records.filter(r => r.requestId === 'sse-retry' && r.phase === 'send');
  assert.equal(sends.length, 2);
  assert.deepEqual(sends[0].providerPayload, sends[1].providerPayload);
  assert.deepEqual(sends.map(r => r.attempt), [1, 2]);
  assert(records.some(r => r.phase === 'retry_wait' && r.status === 503));
  const headers = records.find(r => r.phase === 'headers' && r.status === 200).headers;
  assert.equal(headers['x-request-id'], 'fixture-http');
  assert(!JSON.stringify(records).includes('private-cookie'));
  const evidence = observer.rawUsage(sse);
  assert.equal(evidence.rawUsage.input_tokens_details.cached_tokens, 1024);
  assert.equal(evidence.responseMetadata.model, 'actual-fixture-model');
  assert.equal(evidence.responseMetadata.serviceTier, 'default');
  assert.deepEqual(evidence.responseMetadata.promptCacheDiagnostics, { type: 'cache_hit' });
  includeDiagnostics = false;
  const noDiagnostics = await run('sse-no-diagnostics', 'sse', [question]);
  assert.equal(observer.rawUsage(noDiagnostics).responseMetadata.promptCacheDiagnostics, null);
  assert.equal(observer.rawUsage(noDiagnostics).responseMetadata.promptCacheDiagnosticsPresent, false);
  const first = await run('ws-first', 'websocket-cached', [question]);
  await run('ws-second', 'websocket-cached', [question, first, { ...question, timestamp: 2 }]);
  assert.equal(frames.length, 2);
  const ws = records.filter(r => r.transport === 'websocket' && r.phase === 'send');
  assert.equal(ws[0].connectionReused, false);
  assert.equal(ws[1].connectionReused, true);
  assert.equal(ws[1].previousResponseId, first.responseId);
  assert.equal(ws[1].fullInputItems, 3);
  assert.equal(ws[1].sentInputItems, 1);
  assert.deepEqual(ws[1].providerPayload, frames[1]);
  codex.closeOpenAICodexWebSocketSessions('fixture-ws');
  failConnect = true;
  await run('fallback', 'auto', [question]);
  assert(records.some(r => r.requestId === 'fallback' && r.phase === 'failure' && r.transport === 'websocket'));
  assert(records.some(r => r.requestId === 'fallback' && r.phase === 'fallback' && r.nextTransport === 'sse'));
  assert(records.some(r => r.requestId === 'fallback' && r.phase === 'send' && r.transport === 'sse'));
  sessionId = 'changed-session';
  globalThis[feature.OBSERVER_KEY].providerTransport({ phase: 'test-pinned-session' });
  assert.equal(records.at(-1).sessionId, 'fixture-session');
  observer.observe('session_shutdown', {}, ctx);
  const count = records.length;
  globalThis[feature.OBSERVER_KEY].providerTransport({ phase: 'late-event' });
  assert.equal(records.length, count);
  globalThis[feature.OBSERVER_KEY].providerTransport = () => { throw new Error('observer failed'); };
  const isolated = await run('write-failure', 'sse', [question]);
  assert.equal(isolated.content[0].text, 'OK');
  const directory = path.join(root, '.pi/agent/logs/observability');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(directory, 'provider-transport-verification.json'), JSON.stringify({
    at: new Date(Date.now() + 8 * 3600000).toISOString().replace('Z', '+08:00'),
    status: 'passed', realNetworkCalls: 0, fakeFetchCalls: fetchCalls,
    cases: ['SSE retry actual payload', 'header allowlist', 'raw usage and response metadata', 'absent diagnostics unknown', 'WebSocket full and delta frames', 'connection reuse', 'WS to SSE fallback', 'request and original session association', 'late events ignored', 'observer failure isolation'],
  }, null, 2) + '\n', { mode: 0o600 });
  console.log('PASS: provider transport boundaries and response metadata; fake services only.');
} finally {
  codex.closeOpenAICodexWebSocketSessions('fixture-ws');
  codex.closeOpenAICodexWebSocketSessions('fallback');
  globalThis[feature.OBSERVER_KEY]?.dispose?.();
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
}
