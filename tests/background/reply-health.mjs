// Joye 空回复恢复回归：验证一次重试、真实分支、用户抢占和后台控制围栏；关联 .pi/extensions/reply-health/index.ts，不调用模型或 TG。
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(path.join(process.cwd(), "node_modules/@earendil-works/pi-coding-agent/package.json"));
const { createJiti } = await import(require.resolve("jiti"));
const jiti = createJiti(import.meta.url, { fsCache: false });
const { default: install } = await jiti.import(path.resolve(".pi/extensions/reply-health/index.ts"));
const key = Symbol.for("bot.background.control-turn");

function fixture() {
  const handlers = new Map();
  const sent = [];
  const nodes = new Map();
  let leaf = null;
  let sequence = 0;
  const ctx = {
    sessionManager: {
      getSessionId: () => "offline-reply-health",
      getLeafId: () => leaf,
      getEntry: id => nodes.get(id),
    },
    isIdle: () => true,
    hasPendingMessages: () => false,
    hasUI: false,
  };
  install({
    on: (event, handler) => handlers.set(event, handler),
    sendUserMessage: (text, options) => sent.push({ text, options }),
  });
  const emit = (name, event = {}) => handlers.get(name)(event, ctx);
  const append = message => {
    const id = `entry-${sequence++}`;
    nodes.set(id, { id, parentId: leaf, type: "message", message });
    leaf = id;
  };
  emit("session_start");
  return { emit, append, sent, ctx };
}

const empty = { role: "assistant", stopReason: "stop", content: [] };
const user = text => ({ role: "user", content: [{ type: "text", text }] });
let count = 0;
try {
  const f = fixture();
  f.append(user("真实普通问题"));
  f.append(empty);
  f.emit("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "过期事件" }] }] });
  f.emit("agent_settled");
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].options.deliverAs, "followUp");
  assert.equal(f.emit("input", { source: "extension", text: f.sent[0].text }), undefined);
  f.append(user(f.sent[0].text));
  f.append(empty);
  f.emit("agent_settled");
  assert.equal(f.sent.length, 1, "同一条用户消息只能自动补一次");
  count += 1;

  for (const [name, terminal, settled] of [
    ["已有非空回答", { ...empty, content: [{ type: "text", text: "完成了" }] }, {}],
    ["工具尚未最终答复", { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "bash" }] }, {}],
    ["主动中断", empty, { aborted: true }],
  ]) {
    const f = fixture();
    f.append(user(name));
    f.append(terminal);
    f.emit("agent_settled", settled);
    assert.equal(f.sent.length, 0, name);
    count += 1;
  }
  const internal = fixture();
  internal.append(user("上一次用户消息"));
  internal.append(empty);
  globalThis[key] = { sessionId: "offline-reply-health" };
  internal.emit("agent_settled");
  assert.equal(internal.sent.length, 0, "内部后台控制不得触发模型重发");
  delete globalThis[key];
  internal.emit("session_tree");
  internal.emit("agent_settled");
  assert.equal(internal.sent.length, 0, "切分支后不能恢复旧空回复");
  count += 1;

  const interrupted = fixture();
  interrupted.append(user("旧问题"));
  interrupted.append(empty);
  interrupted.emit("agent_settled");
  interrupted.append(user("用户的新问题"));
  const disposition = interrupted.emit("input", { source: "extension", text: interrupted.sent[0].text });
  assert.equal(disposition.action, "handled", "用户抢占后拒绝旧重试");
  count += 1;
} finally {
  delete globalThis[key];
}
console.log(JSON.stringify({ checks: count, passed: true, liveModelCalls: 0 }));
