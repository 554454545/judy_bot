// 原话来源验证：真实 SessionManager 与安装版 TG 出队函数关联单条文本、同文与迟到事件；不联网，不启动 Agent。
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { resolve, join } from "node:path";

const root = process.cwd();
process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";
const require = createRequire(join(root, "node_modules/@earendil-works/pi-coding-agent/package.json"));
const { SessionManager } = await import(resolve(root, "node_modules/@earendil-works/pi-coding-agent/dist/index.js"));
const { createJiti } = await import(require.resolve("jiti"));
const jiti = createJiti(import.meta.url, { fsCache: false });
const feature = await jiti.import(resolve(root, ".pi/extensions/background/tasks/source.ts"));
const observations = await jiti.import(resolve(root, "extensions/observability/telegram-turn/index.ts"));
const queue = await jiti.import(resolve(root, ".pi/npm/node_modules/@llblab/pi-telegram/lib/queue.ts"));
const handlers = new Map();
const pi = {
  events: new EventEmitter(),
  getThinkingLevel: () => "low",
  on(name, handler) {
    const listeners = handlers.get(name) ?? [];
    listeners.push(handler);
    handlers.set(name, listeners);
  },
};
function emit(name, event, context) {
  for (const handler of handlers.get(name) ?? []) {
    handler(event, context);
  }
}
const ctx = { sessionManager: SessionManager.inMemory(root) };
const capture = feature.createOriginalRequestCapture(pi);
const observer = observations.registerTelegramTurnObservability(pi, () => {});
for (const handler of handlers.get("session_start")) {
  await handler({}, ctx);
}
const globalObserver = globalThis[Symbol.for("bot.observability.telegram-turn")];
let sequence = 100;
function addUser(text, context = ctx, source = "interactive", content) {
  emit("input", { text, source }, context);
  const message = { role: "user", content: content ?? [{ type: "text", text }], timestamp: Date.now() };
  emit("message_start", { message }, context);
  context.sessionManager.appendMessage(message);
  return message;
}
function settle(context = ctx) {
  emit("agent_settled", {}, context);
}
function telegram(raw, options = {}) {
  const id = ++sequence;
  const messages = options.messages ?? [{
    text: raw,
    message_id: id,
    date: Math.floor(Date.now() / 1000),
    message_thread_id: 7,
    chat: { id: 123 },
  }];
  const decorated = `[telegram] ${raw}`;
  const turn = {
    kind: "prompt",
    chatId: 123,
    replyToMessageId: id,
    sourceMessageIds: messages.map(message => message.message_id),
    queueOrder: id,
    content: options.content ?? [{ type: "text", text: decorated }],
  };
  globalObserver.enqueue(turn, messages);
  queue.executeTelegramQueueDispatchPlan({ kind: "prompt", item: turn }, {
    onPromptDispatchStart() {},
    sendUserMessage() {
      options.beforeInput?.();
      addUser(options.inputText ?? decorated, ctx, "extension", options.userContent);
    },
    onPromptDispatchFailure(error) {
      throw new Error(error);
    },
  });
  return { id, messages, decorated };
}

try {
  const first = telegram("  帮 test 项目加个函数。\r\n保留空白  ");
  const original = capture(ctx);
  assert.equal(original.text, first.messages[0].text);
  assert.equal(original.source, "telegram");
  assert.equal(original.telegram.messageId, first.id);
  assert.equal(original.telegram.threadId, 7);
  assert(original.telegram.turnId);
  assert(original.telegram.sentAt.endsWith("+08:00"));
  assert(original.receivedAt.endsWith("+08:00"));
  assert.equal(ctx.sessionManager.getEntry(original.entryId).message.content[0].text, first.decorated);
  emit("agent_end", {}, ctx);
  assert.deepEqual(capture(ctx), original);
  const stale = {
    sessionId: ctx.sessionManager.getSessionId(),
    turnId: "stale-turn",
    inputText: first.decorated,
    message: { ...first.messages[0], message_id: 1 },
  };
  pi.events.emit(feature.REQUEST_SOURCE_EVENT, stale);
  assert.deepEqual(capture(ctx), original);
  settle();

  // 一样的正文连续发送：新轮次必须拿到新的 message ID、turn ID 和 entry ID。
  const second = telegram(first.messages[0].text, {
    beforeInput() {
      pi.events.emit(feature.REQUEST_SOURCE_EVENT, stale);
    },
  });
  const next = capture(ctx);
  assert.equal(next.telegram.messageId, second.id);
  assert.notEqual(next.telegram.turnId, original.telegram.turnId);
  assert.notEqual(next.entryId, original.entryId);
  second.messages[0].text = "桥接随后修改了对象";
  assert.equal(capture(ctx).text, original.text);
  settle();

  telegram("来源不匹配", { inputText: "[telegram] 被其他输入改写" });
  assert.throws(() => capture(ctx), /未关联/);
  settle();
  telegram("两条消息", {
    messages: [
      { text: "a", message_id: 201, date: 1, chat: { id: 123 } },
      { text: "b", message_id: 202, date: 1, chat: { id: 123 } },
    ],
  });
  assert.throws(() => capture(ctx), /未关联/);
  settle();
  telegram("带图片", {
    content: [{ type: "text", text: "[telegram] 带图片" }, { type: "image", data: "", mimeType: "image/png" }],
    userContent: [{ type: "text", text: "[telegram] 带图片" }, { type: "image", data: "", mimeType: "image/png" }],
  });
  assert.throws(() => capture(ctx), /单条文本/);
  settle();

  const local = "  本地 Pi 原始消息\n带换行  ";
  addUser(local);
  assert.equal(capture(ctx).source, "pi-session");
  assert.equal(capture(ctx).text, local);
  settle();
  const other = { sessionManager: SessionManager.inMemory(root) };
  addUser("[telegram] 未采集的装饰输入", other, "extension");
  assert.throws(() => capture(other), /未关联/);
  const empty = { sessionManager: SessionManager.inMemory(root) };
  assert.throws(() => capture(empty), /没有真实用户消息/);
  console.log("PASS: installed TG dispatch source, exact Pi entry identity, same-text rounds, late-event fencing, retry retention and unsupported input refusal");
} finally {
  globalObserver.dispose();
  emit("session_shutdown", {}, ctx);
  delete globalThis[Symbol.for("bot.observability.telegram-turn")];
}
