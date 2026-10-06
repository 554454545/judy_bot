// 真实失败恢复实验的 Pi 接力端：消费私有测试输入并实际验收/投递；关联 live-lifecycle.py 和 background/notifications/relay-notify.ts，不计入十组复杂实验。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

assert(process.argv.includes("--live"));
process.umask(0o077);
const bot = process.cwd();
const root = path.resolve(process.argv[process.argv.indexOf("--root") + 1]);
assert(root.startsWith(path.join(bot, ".pi/agent/background/verification") + path.sep));
const evidenceIndex = process.argv.indexOf("--evidence");
const evidence = evidenceIndex >= 0 ? path.resolve(process.argv[evidenceIndex + 1]) : path.dirname(root);
assert(evidence.startsWith(path.join(bot, ".pi/agent/background/verification") + path.sep));
const agentDir = path.join(evidence, "frontend");
const host = path.join(bot, "node_modules/@earendil-works/pi-coding-agent");
const save = (name, value) => {
  fs.writeFileSync(path.join(evidence, name), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
};
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(agentDir, "sessions");
process.env.NODE_COMPILE_CACHE = path.join(bot, ".cache/node-compile");
process.env.PYTHONDONTWRITEBYTECODE = "1";
process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";
const load = file => import(path.join(host, "dist", file));
const { createAgentSession } = await load("core/sdk.js");
const { DefaultResourceLoader } = await load("core/resource-loader.js");
const { ModelRuntime } = await load("core/model-runtime.js");
const { AuthStorage } = await load("core/auth-storage.js");
const { SessionManager } = await load("core/session-manager.js");
const { SettingsManager } = await load("core/settings-manager.js");
const { createEventBus } = await load("core/event-bus.js");
const { applyHttpProxySettings, configureHttpDispatcher } = await load("core/http-dispatcher.js");
const selected = JSON.parse(fs.readFileSync(path.join(bot, ".pi/agent/settings.json"), "utf8"));
applyHttpProxySettings(selected.httpProxy);
configureHttpDispatcher(30000);
const credentials = JSON.parse(fs.readFileSync(path.join(bot, ".pi/agent/auth.json"), "utf8"));
const models = await ModelRuntime.create({
  credentials: AuthStorage.inMemory({ [selected.defaultProvider]: credentials[selected.defaultProvider] }),
  modelsPath: path.join(bot, ".pi/agent/models.json"),
  modelsStorePath: path.join(agentDir, "models-store.json"),
  refreshOnCreate: false,
});
const require = createRequire(path.join(host, "package.json"));
const { createJiti } = await import(require.resolve("jiti"));
const jiti = createJiti(import.meta.url, { fsCache: false });
const { createRelay } = await jiti.import(path.join(bot, ".pi/extensions/background/notifications/relay-notify.ts"));
const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
let relay;
const errors = [];
const events = [];
const loader = new DefaultResourceLoader({
  cwd: bot,
  agentDir,
  settingsManager: settings,
  eventBus: createEventBus(),
  noExtensions: true,
  noSkills: true,
  noThemes: true,
  noPromptTemplates: true,
  noContextFiles: true,
  additionalExtensionPaths: [
    ".pi/extensions/background/index.ts",
    ".pi/extensions/reply-health/index.ts",
    "extensions/observability/index.ts",
  ].map(file => path.join(bot, file)),
  additionalSkillPaths: [path.join(bot, ".pi/skills/joye/personal/herdr-workflow/SKILL.md")],
  extensionFactories: [{
    name: "real-lifecycle-owner",
    factory: pi => {
      relay = createRelay(pi, { root, isMain: () => true, intervalMs: 1500 });
    },
  }],
  appendSystemPrompt: [
    `这是用户授权的真实故障实验，唯一登记根目录为 ${root}。每次 task_protocol.py 在子命令前必须传 --root ${root}，禁止使用正式登记表。`,
    `spec/review 只写 ${root}/handoffs 或 ${root}/reviews。前台不代写业务代码。正常登记/prepare/start-run/run，遵守用户指定 timeout，不等待或轮询 worker。`,
    "内部后台事件只查当前结果，按 acceptance 实查；明确失败不得 verify 成功，也不自动重试。独立验收失败用 verify --reject。",
    "不要读取完整 worker 历史，不发 Telegram、不调用 ack/report/prepare-report；接力扩展核对状态后实际发送并签收。",
  ],
});
await loader.reload();
const manager = SessionManager.create(bot, path.join(agentDir, "sessions"));
const { session } = await createAgentSession({
  cwd: bot,
  agentDir,
  resourceLoader: loader,
  modelRuntime: models,
  model: models.getModel(selected.defaultProvider, selected.defaultModel),
  thinkingLevel: selected.defaultThinkingLevel ?? "high",
  settingsManager: settings,
  sessionManager: manager,
  tools: ["read", "write", "edit", "bash"],
});
await session.bindExtensions({ onError: error => errors.push(error) });
session.subscribe(event => {
  if (event.type !== "tool_execution_end") return;
  events.push(event);
  save("tool-events.json", events);
});
save("owner-ready.json", { pid: process.pid, sessionId: session.sessionId, model: `${session.model.provider}/${session.model.id}` });
const consumed = new Set();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  const deadline = Date.now() + 2400000;
  while (!fs.existsSync(path.join(evidence, "stop.json"))) {
    if (Date.now() > deadline) throw new Error("真实故障实验接力端超时");
    for (const name of fs.readdirSync(path.join(evidence, "inputs")).sort()) {
      if (consumed.has(name) || !session.isIdle) continue;
      consumed.add(name);
      const input = JSON.parse(fs.readFileSync(path.join(evidence, "inputs", name), "utf8"));
      await session.sendUserMessage(input.text);
      save(`reply-${name}`, { input: input.text, sessionId: session.sessionId, messages: session.messages });
    }
    await sleep(500);
  }
} finally {
  relay.dispose();
  await session.abort();
  session.dispose();
  save("observer-finished.json", { errors, toolErrors: events.filter(event => event.isError).length });
}
