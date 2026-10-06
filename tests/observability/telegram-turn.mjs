// TG 回合观测验证：使用安装版桥接、Responses 解析器与假客户端，覆盖队列、用量、重试和错误；不联网。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";
globalThis.fetch = async () => {
  throw new Error("Network disabled in offline Telegram statistics verification");
};
const host = path.join(root, "node_modules/@earendil-works/pi-coding-agent");
const bridge = path.join(root, ".pi/npm/node_modules/@llblab/pi-telegram");
const require = createRequire(path.join(host, "package.json"));
const { createJiti } = await import(require.resolve("jiti"));
const jiti = createJiti(import.meta.url, {
  fsCache: false,
  alias: {
    "@sinclair/typebox": require.resolve("typebox"),
    "@earendil-works/pi-ai": path.join(host, "node_modules/@earendil-works/pi-ai/dist/compat.js"),
    "@earendil-works/pi-agent-core": path.join(host, "node_modules/@earendil-works/pi-agent-core/dist/index.js"),
    "@earendil-works/pi-coding-agent": path.join(host, "dist/index.js"),
  },
});
const feature = await jiti.import(path.join(root, "extensions/observability/telegram-turn/index.ts"));
const statistics = await jiti.import(path.join(root, "extensions/observability/telegram-turn/statistics.ts"));
const queue = await jiti.import(path.join(bridge, "lib/queue.ts"));
const api = await jiti.import(path.join(bridge, "lib/telegram-api.ts"));
const updates = await jiti.import(path.join(bridge, "lib/updates.ts"));
const rendering = await jiti.import(path.join(bridge, "lib/rendering.ts"));
const { processResponsesStream } = await import(path.join(host, "node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js"));
const key = Symbol.for("bot.observability.telegram-turn");
const events = new Map();
const entries = [];
const source = new Date().toISOString();
const ctx = {
  sessionManager: {
    getSessionId: () => "synthetic-session",
    getSessionFile: () => "synthetic-session.jsonl",
    getHeader: () => ({ timestamp: source }),
  },
  model: {
    provider: "synthetic",
    id: "model-one",
    contextWindow: 1000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
};
const pi = {
  on(name, handler) {
    events.set(name, handler);
  },
  getThinkingLevel: () => "low",
};
const record = (stage, details, context) => entries.push({ stage, ...details, sessionId: context.sessionManager.getSessionId() });
const observer = feature.registerTelegramTurnObservability(pi, record);
await events.get("session_start")({}, ctx);
const noop = () => {};
let messageSequence = 500;
const sent = [];
let failDelivery = false;
const client = {
  async call(method, body) {
    sent.push({ method, body });
    if (method === "sendMessage" && failDelivery) throw new Error("Synthetic send failure");
    return { message_id: body.message_id ?? ++messageSequence };
  },
};
const transport = api.createTelegramBridgeApiRuntime({ client, recordRuntimeEvent: noop });
const handle = updates.createTelegramUpdateHandle({ defaultHandle: async () => {} });

async function enqueue(id, text = "1 + 1 = ?", date = Math.floor(Date.now() / 1000) - 2) {
  const message = { message_id: id, chat: { id: 123 }, date, text };
  await handle({ update_id: id + 100, message }, ctx);
  let turn;
  let queuedItems = [];
  const store = queue.createTelegramTransportStampedQueueStore({
    getQueuedItems: () => queuedItems,
    hasQueuedItems: () => queuedItems.length > 0,
    setQueuedItems: items => { queuedItems = items; },
  }, () => ({ profile: "synthetic", generation: "stamp-added-later" }));
  await queue.enqueueTelegramPromptTurnRuntime([message], {
    getQueuedItems: () => [],
    getFoldQueuedPromptsIntoHistory: () => false,
    setFoldQueuedPromptsIntoHistory: noop,
    createTurn: async () => (turn = {
      kind: "prompt",
      chatId: 123,
      replyToMessageId: id,
      sourceMessageIds: [id],
      queuedAttachments: [],
      content: [{ type: "text", text }],
      queueOrder: id,
      queueLane: "default",
      laneOrder: id,
    }),
    setQueuedItems: store.setQueuedItems,
    updateStatus: noop,
    dispatchNextQueuedTelegramTurn: noop,
  });
  assert.notEqual(store.getQueuedItems()[0], turn, "Installed bridge did not exercise the admission clone");
  return store.getQueuedItems()[0];
}

function dispatch(turn) {
  queue.executeTelegramQueueDispatchPlan({ kind: "prompt", item: { ...turn, transportStamp: { profile: "synthetic", generation: "stamp-added-later" } } }, {
    onPromptDispatchStart: noop,
    sendUserMessage: () => events.get("input")({}, ctx),
    onPromptDispatchFailure: message => { throw new Error(message); },
    onIdle: noop,
  });
  observer.observe("before_agent_start", {}, ctx);
}

async function modelRequest(id, rawUsage, apiName = "responses") {
  observer.observe("request", { requestId: id }, ctx);
  observer.observe("after_provider_response", { requestId: id, status: 200 }, ctx);
  const message = { role: "assistant", content: [{ type: "text", text: "2" }], usage: {}, stopReason: "stop" };
  if (apiName === "responses") {
    await processResponsesStream((async function* () {
      yield { type: "response.completed", response: { id, status: "completed", output: [], usage: rawUsage } };
    })(), message, { push: noop }, ctx.model);
  } else {
    globalThis[key].usage(message, rawUsage, "completions");
  }
  observer.observe("response", { requestId: id, assistantMessage: message }, ctx);
  return message;
}

async function deliver(turn, text = "2") {
  const activeStore = queue.createTelegramActiveTurnStore();
  activeStore.set(turn);
  assert.notEqual(activeStore.get(), turn, "Installed bridge did not exercise the active-turn clone");
  await queue.handleTelegramAgentEndRuntime({
    turn: activeStore.get(),
    assistant: { text, stopReason: "stop" },
    foldQueuedPromptsIntoHistory: false,
    resetRuntimeState: noop,
    updateStatus: noop,
    dispatchNextQueuedTelegramTurn: noop,
    clearPreview: async () => {},
    setPreviewPendingText: noop,
    finalizeMarkdownPreview: async () => false,
    sendQueuedAttachments: async () => {},
    sendMarkdownReply: async (chatId, replyId, text) => {
      for (const chunk of rendering.renderTelegramMessage(text, { mode: "markdown" })) {
        await transport.sendMessage({ chat_id: chatId, text: chunk.text, parse_mode: chunk.parseMode });
      }
    },
    sendTextReply: async () => {},
  });
}

try {
  const first = await enqueue(1);
  const second = await enqueue(2);
  dispatch(first);
  await globalThis[key].span("context.memory.personal-memory", async () => {});
  const raw = { input_tokens: 100, input_tokens_details: { cached_tokens: 60 }, output_tokens: 12, output_tokens_details: { reasoning_tokens: 3 } };
  const message = await modelRequest("request-1", raw);
  assert.deepEqual(observer.rawUsage(message).rawUsage, raw, "Installed parser did not retain raw usage");
  observer.observe("tool_execution_start", { toolName: "lookup", toolCallId: "tool-1" }, ctx);
  observer.observe("tool_execution_start", { toolName: "lookup", toolCallId: "tool-2" }, ctx);
  observer.observe("tool_execution_end", { toolCallId: "tool-1" }, ctx);
  observer.observe("tool_execution_end", { toolCallId: "tool-2" }, ctx);
  await modelRequest("request-2", { ...raw, input_tokens: 120 });
  const beforeFirstDelivery = sent.length;
  await deliver(first);
  assert.equal(sent.length, beforeFirstDelivery + 1, "Simple answer and footer must use one send");
  let summary = entries.findLast(entry => entry.stage === "telegram_turn_end");
  assert.equal(summary.summary.usage.uncachedInput, 100);
  assert.equal(summary.summary.usage.output, 24, "Reasoning was counted twice");
  assert.equal(summary.summary.context.tokens, 120);
  assert.equal(summary.summary.context.window, 1000);
  assert(summary.summary.elapsedMs >= 2000);
  assert(summary.footer.includes("↑100 ↓24"));
  assert(summary.footer.includes("tools 2"));
  assert.equal(summary.footerStatus, "included_in_reply");
  assert.equal(sent.at(-1).method, "sendMessage");
  assert(sent.at(-1).body.text.startsWith("2\n────\n⏱"));
  assert.equal(sent.filter(item => item.method === "editMessageText").length, 0);
  assert.equal(summary.bodyConfirmedAt, summary.footerConfirmedAt);
  assert(summary.summary.elapsedMs >= summary.displaySummary.elapsedMs);
  assert.equal(summary.requestIds.length, 2);
  assert(summary.stages.tool.occupiedMs <= summary.stages.tool.summedMs);

  dispatch(second);
  ctx.model = { ...ctx.model, id: "model-two", contextWindow: 2000 };
  await modelRequest("request-3", { input_tokens: 100, output_tokens: 4 });
  await deliver(second);
  summary = entries.findLast(entry => entry.stage === "telegram_turn_end");
  assert.equal(summary.summary.usage.uncachedInput, null);
  assert.equal(summary.summary.usage.output, 4);
  assert.equal(summary.summary.context.window, 2000);
  assert(summary.footer.includes("↑? ↓4"));
  assert(summary.footer.includes("model-two"));
  assert.notEqual(summary.telegramTurnId, entries.find(entry => entry.stage === "telegram_turn_end").telegramTurnId);

  const command = await enqueue(3, "/pi_new");
  dispatch(command);
  const beforeCommand = sent.length;
  await deliver(command);
  assert.equal(sent.length, beforeCommand + 1, "Command got a footer");

  const errorTurn = await enqueue(4);
  dispatch(errorTurn);
  await modelRequest("request-4", raw);
  failDelivery = true;
  await deliver(errorTurn);
  failDelivery = false;
  summary = entries.findLast(entry => entry.stage === "telegram_turn_end");
  assert.equal(summary.status, "delivery_failed_or_unknown");

  const longTurn = await enqueue(6);
  dispatch(longTurn);
  await modelRequest("request-6", raw);
  const beforeLongDelivery = sent.length;
  await deliver(longTurn, "x".repeat(4096) + "\n\n");
  assert.equal(entries.findLast(entry => entry.stage === "telegram_turn_end").footerStatus, "included_in_reply");
  const longChunks = sent.slice(beforeLongDelivery);
  assert(longChunks.length > 1, "Oversized reply must use installed renderer chunking");
  assert(longChunks.every(item => item.method === "sendMessage" && item.body.text.length <= 4096));
  const combined = longChunks.map(item => item.body.text).join("");
  assert(combined.startsWith("x".repeat(4096)), "Long body was truncated");
  assert(combined.includes("────"), "Chunked reply lost footer");

  const retryTurn = await enqueue(7);
  dispatch(retryTurn);
  await modelRequest("request-7", raw);
  const oldFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    return new Response(JSON.stringify(attempts === 1
      ? { ok: false, error_code: 429, description: "Synthetic limit", parameters: { retry_after: 0 } }
      : { ok: true, result: { message_id: 900 } }), {
      status: attempts === 1 ? 429 : 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    await globalThis[key].delivery(retryTurn, () => globalThis[key].transport("sendMessage", { chat_id: 123, text: "2" },
      () => api.callTelegram("synthetic-token", "sendMessage", { chat_id: 123, text: "2" }, { sleep: async () => {} }),
      client.call.bind(client)));
  } finally {
    globalThis.fetch = oldFetch;
  }
  assert.equal(attempts, 2);
  assert(entries.some(entry => entry.stage === "telegram_transport_attempt" && entry.attempt === 1));
  assert(entries.findLast(entry => entry.stage === "telegram_turn_end").stages["telegram.retry_wait"]);

  assert.equal(statistics.interpretUsage({ protocol: "completions", rawUsage: { prompt_tokens: 150, prompt_cache_hit_tokens: 100, completion_tokens: 10 } }).uncachedInput, 50);
  assert.equal(statistics.interpretUsage({ protocol: "responses", rawUsage: { input_tokens: 20, input_tokens_details: { cached_tokens: 50 }, output_tokens: 4 } }).uncachedInput, null);
  assert.equal(statistics.unionDuration([
    { startMs: 0, endMs: 10 }, { startMs: 5, endMs: 15 }, { startMs: 20, endMs: 30 },
  ]), 25);

  const clockTurn = await enqueue(9);
  dispatch(clockTurn);
  await modelRequest("clock-request", raw);
  const originalNow = Date.now;
  Date.now = () => originalNow() + 3600000;
  try {
    await deliver(clockTurn);
  } finally {
    Date.now = originalNow;
  }
  assert(entries.findLast(entry => entry.stage === "telegram_turn_end").summary.elapsedMs < 10000, "Wall-clock jump changed duration");

  assert.equal(statistics.formatTokenCount(3108), "3.1k");
  assert.equal(statistics.formatTokenCount(1050000), "1050k");
  assert.equal(statistics.formatTokenCount(1000000), "1M");
  assert.equal(statistics.formatTokenCount(2000000), "2M");
  const displayFooter = statistics.formatFooter({
    elapsedMs: 21300,
    usage: { uncachedInput: 7900, output: 184 },
    context: { tokens: 45000, window: 1000000 },
    model: "test",
    thinking: "low",
    tools: 0,
  });
  assert.ok(displayFooter.startsWith("────\n⏱ 21.3s"));
  assert.equal(displayFooter.split("\n").length, 2);
  assert.ok(displayFooter.includes("ctx 4.5% / 1M"));
  assert.ok(!displayFooter.includes("≈"));
  assert.equal(statistics.formatTokenCount(5), "5");
  const realNow = Date.now;
  const previousFetch = globalThis.fetch;
  const serverDate = Math.floor(realNow() / 1000) - 2;
  Date.now = () => realNow() - 9000;
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: true,
    result: [{ update_id: 110, message: { message_id: 10, chat: { id: 123 }, date: serverDate, text: "1 + 1 = ?" } }],
  }), { headers: { "content-type": "application/json", date: new Date(realNow()).toUTCString() } });
  try {
    await api.callTelegram("synthetic-token", "getUpdates", {});
    const calibrated = await enqueue(10, "1 + 1 = ?", serverDate);
    dispatch(calibrated);
    await modelRequest("calibrated-request", raw);
    await deliver(calibrated);
    const result = entries.findLast(entry => entry.stage === "telegram_turn_end");
    assert(result.summary.elapsedMs >= 2000 && result.summary.elapsedMs < 5000, "Telegram Date did not correct local clock skew");
    assert(!result.footer.includes("⏱ ?"));
    assert(entries.findLast(entry => entry.stage === "telegram_turn_start").serverClockOffsetEstimateMs > 7000);
  } finally {
    Date.now = realNow;
    globalThis.fetch = previousFetch;
  }

  const interrupted = await enqueue(8);
  dispatch(interrupted);
  await events.get("session_shutdown")({}, ctx);
  assert.equal(entries.findLast(entry => entry.stage === "telegram_turn_end").status, "interrupted_runtime_shutdown");
  const recoveryFile = path.join(root, `.cache/tmp/telegram-turn-recovery-${process.pid}.jsonl`);
  try {
    fs.writeFileSync(recoveryFile, [
      { stage: "telegram_turn_start", telegramTurnId: "unfinished", runtimeId: "old-runtime" },
      { stage: "telegram_turn_start", telegramTurnId: "finished", runtimeId: "old-runtime" },
      { stage: "telegram_turn_end", telegramTurnId: "finished", status: "delivered" },
    ].map(value => JSON.stringify(value)).join("\n") + "\n", { mode: 0o600 });
    const recovery = feature.registerTelegramTurnObservability(pi, (stage, details) => {
      fs.appendFileSync(recoveryFile, JSON.stringify({ stage, ...details }) + "\n");
    }, () => recoveryFile);
    await events.get("session_start")({}, ctx);
    await events.get("session_start")({}, ctx);
    const recovered = fs.readFileSync(recoveryFile, "utf8").trim().split("\n").map(JSON.parse)
      .filter(entry => entry.status === "interrupted_previous_runtime");
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].telegramTurnId, "unfinished");
    assert.equal(recovered[0].elapsedMs, null);
    recovery.rawUsage({});
    globalThis[key].dispose();
  } finally {
    fs.rmSync(recoveryFile, { force: true });
  }

  // Native AgentSession integration: raw evidence must survive Pi event dispatch and reach the same JSONL.
  const temporary = fs.mkdtempSync(path.join(root, ".cache/tmp/telegram-turn-sdk-"));
  let session;
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    const agentDir = path.join(temporary, "agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const load = file => import(path.join(host, "dist", file));
    const { createAgentSession } = await load("core/sdk.js");
    const { DefaultResourceLoader } = await load("core/resource-loader.js");
    const { ModelRuntime } = await load("core/model-runtime.js");
    const { AuthStorage } = await load("core/auth-storage.js");
    const { SettingsManager } = await load("core/settings-manager.js");
    const { SessionManager } = await load("core/session-manager.js");
    const { AssistantMessageEventStream } = await import(path.join(host, "node_modules/@earendil-works/pi-ai/dist/compat.js"));
    const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
    const loader = new DefaultResourceLoader({
      cwd: temporary,
      agentDir,
      settingsManager: settings,
      noExtensions: true,
      noSkills: true,
      noThemes: true,
      noPromptTemplates: true,
      noContextFiles: true,
      additionalExtensionPaths: [path.join(root, "extensions/observability/index.ts")],
    });
    await loader.reload({ resolveProjectTrust: async () => true });
    assert.deepEqual(loader.getExtensions().errors, []);
    const runtime = await ModelRuntime.create({
      credentials: AuthStorage.inMemory({ synthetic: { type: "api_key", key: "synthetic-auth" } }),
      modelsPath: null,
      modelsStorePath: path.join(temporary, "models.json"),
      refreshOnCreate: false,
    });
    runtime.registerProvider("synthetic", {
      baseUrl: "https://synthetic.invalid",
      api: "openai-responses",
      models: [{ id: "offline", name: "Offline", reasoning: false, input: ["text"], contextWindow: 5000, maxTokens: 1000, cost: ctx.model.cost }],
    });
    runtime.streamSimple = async (model, context, options) => {
      await options.onPayload({ model: model.id, instructions: context.systemPrompt, input: context.messages }, model);
      await options.onResponse({ status: 200, headers: {} }, model);
      const message = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), content: [{ type: "text", text: "2" }], stopReason: "stop", usage: {},
      };
      const stream = new AssistantMessageEventStream();
      stream.push({ type: "start", partial: message });
      await processResponsesStream((async function* () {
        yield { type: "response.completed", response: { id: "sdk-response", status: "completed", output: [], usage: raw } };
      })(), message, stream, model);
      stream.push({ type: "done", reason: message.stopReason, message });
      return stream;
    };
    ({ session } = await createAgentSession({
      cwd: temporary, agentDir, modelRuntime: runtime, model: runtime.getModel("synthetic", "offline"),
      resourceLoader: loader, settingsManager: settings, tools: [],
      sessionManager: SessionManager.create(temporary, path.join(agentDir, "sessions")),
    }));
    const sdkErrors = [];
    await session.bindExtensions({ onError: error => sdkErrors.push(error) });
    await session.sendUserMessage("1 + 1 = ?");
    const recordDirectory = path.join(agentDir, "observability");
    const files = fs.readdirSync(recordDirectory);
    assert.equal(files.length, 1);
    const records = fs.readFileSync(path.join(recordDirectory, files[0]), "utf8").trim().split("\n").map(JSON.parse);
    const response = records.find(entry => entry.stage === "response");
    assert.deepEqual(response.accounting.providerRawUsage, raw, "Pi dispatch lost original usage evidence");
    assert.equal(response.accounting.providerUsageProtocol, "responses");
    assert.deepEqual(sdkErrors, []);
  } finally {
    session?.dispose();
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  const directory = path.join(root, ".pi/agent/logs/observability");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(directory, "telegram-turn-verification.json"), JSON.stringify({
    at: new Date(Date.now() + 8 * 3600000).toISOString().replace("Z", "+08:00"),
    status: "passed",
    cases: ["installed bridge hooks", "installed Responses raw usage", "queue isolation", "queue and active turn cloning with later-added transport stamp", "multi-request tokens", "reasoning inclusion", "model context window", "unknown cache", "command exclusion", "delivery failure", "footer prepared with body before rendering", "no footer edit", "overflow body preservation", "429 retry", "parallel span union", "k display with exact log counts", "Telegram Date calibration for 9-second WSL skew", "shutdown interruption", "restart recovery deduplication", "monotonic clock across wall-clock change", "native AgentSession raw usage persistence"],
    realModelCalls: 0,
    realTelegramMessages: 0,
  }, null, 2) + "\n", { mode: 0o600 });
  console.log("Telegram turn verification passed");
} finally {
  globalThis[key]?.dispose();
  delete globalThis[key];
}
