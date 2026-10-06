// 验证模型按钮菜单、权限、会话失效和忙碌拦截；关联 src/telegram/commands/pi_model.ts。
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
const root = process.cwd();
const require = createRequire(resolve(root, "node_modules/@earendil-works/pi-coding-agent/package.json"));
const { createJiti } = await import(require.resolve("jiti"));
const jiti = createJiti(import.meta.url, { fsCache: false });
const { createPiModelCommand } = await jiti.import(resolve(root, "src/telegram/commands/pi_model.ts"));
const models = [
  { provider: "deepseek", id: "flash", reasoning: true },
  { provider: "openai", id: "sol", reasoning: true },
];
let idle = true;
let thinking = "high";
let selected;
let update;
let rendered;
let removed = false;
let shutdown;
const notices = [];
const ctx = {
  model: models[0],
  isIdle: () => idle,
  hasPendingMessages: () => false,
  sessionManager: { getSessionId: () => "session-a" },
  modelRegistry: {
    async refresh() { await Promise.resolve(); },
    getAvailable: () => models,
  },
};
let current = ctx;
const handle = { target: { chatId: 123 }, messageIds: [10], generation: "test" };
const command = createPiModelCommand({
  on(name, callback) { shutdown = callback; },
  getThinkingLevel: () => thinking,
  setThinkingLevel(level) { thinking = level; },
  async setModel(model) {
    selected = model;
    ctx.model = model;
    return true;
  },
}, () => current, () => "personal", {
  subscribe(callback) {
    update = callback;
    return () => { removed = true; };
  },
  profile: () => ({ botToken: "test", allowedUserId: 7 }),
  acknowledge: async (token, id, text) => { notices.push(text); },
  async send(view) { rendered = view; return { ok: true, value: handle }; },
  async edit(actual, view) {
    assert.equal(actual, handle);
    rendered = view;
    return { ok: true, value: handle };
  },
});
const invoke = () => command.handler({ args: "", reply: async text => { notices.push(text); } });
const buttons = () => rendered.replyMarkup.inline_keyboard.flat();
const click = async (data, user = 7, chat = 123) => update({ callback_query: {
  id: "click",
  data,
  from: { id: user },
  message: { message_id: 10, chat: { id: chat } },
} });
await invoke();
assert.match(rendered.text, /当前模型：deepseek\/flash/);
await click(buttons().find(b => b.text === "openai").callback_data);
const modelButton = buttons().find(b => b.text === "sol").callback_data;
await click(modelButton, 99);
assert.equal(selected, undefined);
await click(modelButton, 7, 999);
assert.equal(selected, undefined);
idle = false;
await click(modelButton);
assert.equal(selected, undefined);
assert.match(rendered.text, /正在回答/);
idle = true;
await click(modelButton);
assert.equal(selected, models[1]);
await click(buttons().find(b => b.text === "low").callback_data);
assert.equal(thinking, "low");
const old = buttons()[0].callback_data;
await invoke();
await click(old);
assert.match(notices.at(-1), /已过期/);
current = undefined;
await click(buttons()[0].callback_data);
assert.match(notices.at(-1), /已过期/);
shutdown();
assert.equal(removed, true);
console.log("TG model button checks passed");
