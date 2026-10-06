// TG 生命周期回归：用安装版 typing/queue/capability monitor 验证后台清理、会话替换和脱敏诊断；关联 final-reply-only.ts、telegram-turn/index.ts 及其维护补丁，不联网。
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";

const bot = process.cwd();
const host = path.join(bot, "node_modules/@earendil-works/pi-coding-agent");
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
const base = path.join(bot, ".pi/npm/node_modules/@llblab/pi-telegram/lib");
const runtime = await jiti.import(path.join(base, "runtime.ts"));
const queue = await jiti.import(path.join(base, "queue.ts"));
const polling = await jiti.import(path.join(base, "polling.ts"));
const { finalReplyOnlyApi } = await jiti.import(path.join(bot, "src/telegram/final-reply-only.ts"));
const { registerTelegramTurnObservability } = await jiti.import(path.join(bot, "extensions/observability/telegram-turn/index.ts"));
const observerKey = Symbol.for("bot.observability.telegram-turn");
const controlKey = Symbol.for("bot.background.control-turn");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async predicate => {
  const deadline = performance.now() + 1000;
  while (!predicate()) {
    assert(performance.now() < deadline, "本地生命周期夹具未到达预期阶段");
    await delay(2);
  }
};
const ctx = { sessionManager: { getSessionId: () => "lifecycle-fixture" } };
const events = new Map();
const records = [];
const pi = { on: (event, handler) => events.set(event, handler), getThinkingLevel: () => "low" };
registerTelegramTurnObservability(pi, (stage, detail) => records.push({ stage, ...detail }));
await events.get("session_start")({}, ctx);
const typing = runtime.createTelegramBridgeRuntime();
let sends = 0;
let monitor;
try {
  const bridge = finalReplyOnlyApi(pi);
  bridge.on("agent_end", event => queue.handleTelegramAgentEndRuntime({
    turn: undefined,
    assistant: {},
    foldQueuedPromptsIntoHistory: false,
    resetRuntimeState: runtime.createTelegramAgentEndResetter({
      typing: typing.typing,
      abort: typing.abort,
      clearActiveTurn() {},
      resetToolExecutions() {},
      clearPendingModelSwitch() {},
      clearDispatchPending() {},
    }),
    updateStatus() {},
    dispatchNextQueuedTelegramTurn() {},
    clearPreview: async () => {},
    setPreviewPendingText() {},
  }));
  typing.typing.start({ chatId: 123, intervalMs: 2, sendTypingAction: async () => { sends++; } });
  await until(() => sends > 1);
  globalThis[controlKey] = { sessionId: "lifecycle-fixture" };
  await events.get("agent_end")({ messages: [{ role: "assistant", content: [{ type: "text", text: "内部验收正文" }] }] }, ctx);
  await typing.typing.waitForIdle();
  const stoppedAt = sends;
  await delay(20);
  assert.equal(sends, stoppedAt, "后台 agent_end 清理后不能继续发送 typing");
  assert.equal(typing.state.typingInterval, undefined);
  assert(records.some(item => item.stage === "telegram_typing_start"));
  assert(records.some(item => item.stage === "telegram_typing_stop"));
  delete globalThis[controlKey];

  let resolveProbe;
  let probes = 0;
  let oldTouched = 0;
  let botState = { threadMode: "disabled" };
  let deferLoad;
  let loaded = false;
  const deps = {
    intervalMs: 2,
    callApi: async () => {
      probes++;
      return new Promise(resolve => { resolveProbe = resolve; });
    },
    topicTargetStore: {
      getBotState: () => botState,
      setBotState: value => { botState = value; },
      getAll: () => [],
      load: async () => {
        loaded = true;
        if (deferLoad) await deferLoad;
      },
      persist: async () => {},
    },
    getPollingStartedWithTelegramBus: () => false,
    ownsLock: current => { if (current === "old") oldTouched++; return false; },
    setTopicModeUnavailable() {},
    updateStatus: current => { if (current === "old") oldTouched++; },
    recordEvent() {},
  };
  monitor = polling.createTelegramThreadCapabilityMonitor(deps);
  monitor.start("old");
  await until(() => probes === 1);
  monitor.stop();
  resolveProbe({ has_topics_enabled: true });
  await delay(10);
  assert.equal(oldTouched, 0, "getMe 迟到后不能访问旧 ctx");
  assert.equal(botState.threadMode, "disabled");
  monitor.start("new");
  await until(() => probes === 2);
  resolveProbe({ has_topics_enabled: true });
  await until(() => botState.threadMode === "enabled");
  monitor.stop();
  await delay(10);

  botState = { threadMode: "disabled" };
  let releaseLoad;
  deferLoad = new Promise(resolve => { releaseLoad = resolve; });
  loaded = false;
  const nextProbe = probes + 1;
  monitor.start("old");
  await until(() => probes === nextProbe);
  resolveProbe({ has_topics_enabled: true });
  await until(() => loaded);
  monitor.stop();
  releaseLoad();
  await delay(10);
  assert.equal(oldTouched, 0, "能力转换内部 await 返回后也必须拒绝旧 ctx");

  const cause = Object.assign(new Error("https://secret.invalid/token"), { code: "ETIMEDOUT" });
  const failure = new TypeError("fetch failed", { cause });
  await assert.rejects(globalThis[observerKey].transport("getUpdates", { token: "private" }, async () => { throw failure; }), error => error === failure);
  const diagnostic = records.findLast(item => item.stage === "telegram_transport_error");
  assert(diagnostic.causes.some(item => item.code === "ETIMEDOUT"));
  assert(!JSON.stringify(diagnostic).includes("secret.invalid"));
  assert(!JSON.stringify(diagnostic).includes("private"));
  await globalThis[observerKey].transport("sendChatAction", {}, async () => ({}));
  assert(records.some(item => item.stage === "telegram_typing_api_confirmed"));
  console.log(JSON.stringify({ passed: true, checks: ["后台 typing 停止", "getMe 迟到旧 ctx 围栏", "能力转换异步围栏", "新监控继续工作", "网络 code 脱敏", "typing API 确认"], liveCalls: 0 }));
} finally {
  monitor?.stop();
  typing.typing.stop();
  globalThis[observerKey]?.dispose();
  delete globalThis[controlKey];
}
