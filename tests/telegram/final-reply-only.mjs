// 验证桥接隐藏中间文字，保留最终回复、生命周期与其他扩展的原始事件。
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const requirePi = createRequire(new URL("../../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url));
const { createJiti } = requirePi("jiti");
const jiti = createJiti(import.meta.url, { fsCache: false });
const { finalReplyOnlyApi } = await jiti.import("../../src/telegram/final-reply-only.ts");

const handlers = new Map();
const pi = {
  on(name, handler) {
    const list = handlers.get(name) ?? [];
    list.push(handler);
    handlers.set(name, list);
  },
};
const bridge = finalReplyOnlyApi(pi);
const visible = [];
const observed = [];
const ctx = { sessionManager: { getSessionId: () => "typing-fixture" } };
pi.on("message_update", event => observed.push(event));
bridge.on("message_update", event => visible.push(event));
let ended;
bridge.on("agent_end", event => {
  ended = event;
});
const intermediate = {
  type: "message_update",
  message: { role: "assistant", content: [{ type: "text", text: "Let me search" }] },
  assistantMessageEvent: { type: "text_end", content: "Let me search", contentIndex: 0 },
};
for (const handler of handlers.get("message_update")) {
  await handler(intermediate, ctx);
}
assert.equal(visible.length, 0);
assert.equal(observed[0], intermediate);
const final = {
  role: "assistant",
  content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "结果" }, { type: "text", text: "如下" }],
};
const event = { messages: [intermediate.message, final] };
for (const handler of handlers.get("agent_end")) {
  await handler(event, ctx);
}
assert.equal(ended, event);
assert.equal(visible.length, 2);
assert.equal(visible[0].assistantMessageEvent.content, "结果如下");
assert.equal(visible[1].assistantMessageEvent.type, "done");
assert.equal(visible[0].message, final);
visible.length = 0;
await handlers.get("agent_end")[0]({ messages: [] }, ctx);
assert.equal(visible.length, 0);
const controlKey = Symbol.for("bot.background.control-turn");
globalThis[controlKey] = { sessionId: "typing-fixture" };
try {
  await handlers.get("agent_end")[0](event, ctx);
  assert.deepEqual(ended.messages, [], "后台回合仍执行桥接结束清理，不传递内部模型正文");
  assert.equal(visible.length, 0);
} finally {
  delete globalThis[controlKey];
}
console.log("PASS: intermediate output hidden; final text combined; original events retained; empty turn supported.");

// 接入锁定版本桥接的真实 Activity 归一化，确认没有 intermediate 投影。
const { createTelegramActivityRuntime } = await jiti.import("../../.pi/npm/node_modules/@llblab/pi-telegram/lib/activity.ts");
const activities = [];
const activity = createTelegramActivityRuntime({
  generation: "fixture",
  dispatcher: {
    dispatch(event) { activities.push(event); },
    stop() {},
  },
});
const activityApi = finalReplyOnlyApi(pi);
activityApi.on("message_update", event => activity.onAssistantEvent(event.assistantMessageEvent));
activityApi.on("agent_end", () => activity.onAgentEnd());
activity.recordInputSource("extension");
activity.onAgentStart({ chatId: 123 });
await handlers.get("agent_end").at(-1)(event, ctx);
const segments = activities.filter(item => item.type === "assistant-segment");
assert.equal(segments.length, 1);
assert.equal(segments[0].placement, "final");
assert.equal(segments[0].text, "结果如下");
console.log("PASS: installed bridge Activity produces one final segment and no intermediate segment.");
