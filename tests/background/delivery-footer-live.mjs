// 后台交付真实验收：新 Pi session 经构造 TG 入站派发真实 Codex，切换前台 session 后核查最终尾注与 API 签收；关联 re.md 与 relay-notify.ts。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

assert(process.argv.includes("--live"), "真实模型和 TG 投递须显式 --live");
process.umask(0o077);
const bot = process.cwd();
const beijing = () => new Date(Date.now() + 8 * 3600000).toISOString().replace("Z", "+08:00");
const resumeIndex = process.argv.indexOf("--resume-evidence");
const resuming = resumeIndex >= 0;
const evidence = resuming
  ? path.resolve(process.argv[resumeIndex + 1])
  : path.join(bot, ".pi/agent/background/verification/delivery-footer", beijing().replaceAll(":", "-"));
assert(evidence.startsWith(path.join(bot, ".pi/agent/background/verification/delivery-footer") + path.sep));
const previousResult = resuming ? JSON.parse(fs.readFileSync(path.join(evidence, "result.json"), "utf8")) : undefined;
const root = path.join(evidence, "background");
const agentDir = path.join(evidence, "frontend");
const business = previousResult?.business ?? `health-experiments/delivery-footer-${Date.now()}`;
const host = path.join(bot, "node_modules/@earendil-works/pi-coding-agent");
const bridge = path.join(bot, ".pi/npm/node_modules/@llblab/pi-telegram");
const protocol = path.join(bot, ".pi/extensions/background/tasks/task_protocol.py");
const notifier = path.join(bot, ".pi/extensions/background/notifications/notify-telegram.py");
const observerKey = Symbol.for("bot.observability.telegram-turn");
const production = JSON.parse(fs.readFileSync(path.join(bot, ".pi/agent/background/registry.json"), "utf8"));
const project = structuredClone(production.projects.test);
assert(project.sessionId && !project.activeExecution);
if (!resuming) {
  assert(!fs.existsSync(path.join(project.worktreePath, business)));
}
const paired = JSON.parse(fs.readFileSync(path.join(bot, ".pi/agent/telegram.json"), "utf8")).profiles.personal.allowedUserId;
const target = { chatId: paired };
const save = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
};
const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const protectedFiles = ["start.sh", ".pi/agent/auth.json", ".pi/agent/models.json", ".pi/agent/settings.json", ".pi/agent/background/codex/test/config.toml"];
const beforeHashes = Object.fromEntries(protectedFiles.map(file => [file, hash(path.join(bot, file))]));
const errors = [];
const tools = [];
const result = {
  ...previousResult,
  startedAt: beijing(),
  evidence,
  business,
  workerSessionId: project.sessionId,
  realUserTelegramIngress: false,
  realTelegramApiDelivery: true,
  handsetReceipt: false,
  passed: false,
  recovery: resuming,
  error: undefined,
};
let session;
let relay;
let deadline;
// 只继承项目常驻入口的代理变量，不复制或打印其其他环境。
for (const pid of fs.readdirSync("/proc").filter(value => /^\d+$/.test(value))) {
  try {
    if (!fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").includes(path.join(bot, "scripts/startup/telegram.mjs"))) {
      continue;
    }
    for (const entry of fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0")) {
      const separator = entry.indexOf("=");
      const name = entry.slice(0, separator);
      if (["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"].includes(name)) {
        process.env[name] = entry.slice(separator + 1);
      }
    }
    break;
  } catch {}
}
const proxy = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
if (proxy) {
  const endpoint = new URL(proxy);
  if (["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)) {
    const route = fs.readFileSync("/proc/net/route", "utf8").split("\n").map(line => line.trim().split(/\s+/)).find(fields => fields[1] === "00000000");
    endpoint.hostname = route[2].match(/../g).reverse().map(byte => parseInt(byte, 16)).join(".");
  }
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) {
    process.env[name] = endpoint.href;
  }
}
const wait = (predicate, timeout = 900000) => new Promise((resolve, reject) => {
  const origin = performance.now();
  const timer = setInterval(() => {
    try {
      const value = predicate();
      if (value) {
        clearInterval(timer);
        resolve(value);
      } else if (performance.now() - origin >= timeout) {
        clearInterval(timer);
        reject(new Error("真实后台交付超时，保留证据"));
      }
    } catch (error) {
      clearInterval(timer);
      reject(error);
    }
  }, 1000);
});
try {
  if (!resuming) {
    save(path.join(root, "registry.json"), { version: 1, revision: 0, projects: { test: project }, tasks: {} });
    save(path.join(evidence, "baseline.json"), { project, beforeHashes });
  }
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_CODING_AGENT_SESSION_DIR = path.join(agentDir, "sessions");
  process.env.PI_OFFLINE = "1";
  process.env.PI_TELEMETRY = "0";
  process.env.PYTHONDONTWRITEBYTECODE = "1";
  process.env.TMPDIR = path.join(bot, ".cache/tmp/background");
  process.env.NODE_COMPILE_CACHE = path.join(bot, ".cache/node-compile");
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
  const auth = JSON.parse(fs.readFileSync(path.join(bot, ".pi/agent/auth.json"), "utf8"));
  const models = await ModelRuntime.create({
    credentials: AuthStorage.inMemory({ [selected.defaultProvider]: auth[selected.defaultProvider] }),
    modelsPath: path.join(bot, ".pi/agent/models.json"),
    modelsStorePath: path.join(agentDir, "models-store.json"),
    refreshOnCreate: false,
  });
  const require = createRequire(path.join(host, "package.json"));
  const { createJiti } = await import(require.resolve("jiti"));
  const jiti = createJiti(import.meta.url, { fsCache: false });
  const { createRelay } = await jiti.import(path.join(bot, ".pi/extensions/background/notifications/relay-notify.ts"));
  const { renderTelegramMessage } = await jiti.import(path.join(bridge, "lib/rendering.ts"));
  const { executeTelegramQueueDispatchPlan } = await jiti.import(path.join(bridge, "lib/queue.ts"));
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
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
    additionalExtensionPaths: [".pi/extensions/background/index.ts", ".pi/extensions/reply-health/index.ts", "extensions/observability/index.ts"].map(file => path.join(bot, file)),
    extensionFactories: [{ name: "delivery-footer-owner", factory: pi => { relay = createRelay(pi, { root, isMain: () => true, intervalMs: 1500, target }); } }],
    additionalSkillPaths: [path.join(bot, ".pi/skills/joye/personal/herdr-workflow/SKILL.md")],
    appendSystemPrompt: [fs.readFileSync(path.join(bot, "AGENTS.md"), "utf8"), [
      `本次是用户授权的真实后台尾注验收。唯一登记根目录=${root}；所有 task_protocol.py 命令在子命令前必须传 --root ${root}。禁止修改正式登记表。`,
      `spec/review 等私有文件仅写 ${root}/handoffs 和 ${root}/reviews，真实 Coding Agent 仅修改 test worktree 下 ${business}/。前台不能代写业务代码，不修改 Bot 其他文件。`,
      "沿用 Joye herdr-workflow 登记原话、prepare、核对 hash、start-run、run，沿用项目默认后台等待预算。每次 bash 一个协议操作；异步收据返回就回复，不等待或轮询 worker，不自行控制 Herdr。",
      "内部事件到来才按原始 acceptance 独立验收，读取确认存在的任务范围产物，实际运行检查后 verify。不得读完整 worker 对话、终端历史或 diff；不要自行发送 TG 或调用 report/prepare-report/ack。",
    ].join("\n")],
  });
  async function createFrontend() {
    await loader.reload({ resolveProjectTrust: async () => true });
    assert.deepEqual(loader.getExtensions().errors, []);
    const manager = SessionManager.create(bot, path.join(agentDir, "sessions"));
    ({ session } = await createAgentSession({ cwd: bot, agentDir, resourceLoader: loader, modelRuntime: models, model: models.getModel(selected.defaultProvider, selected.defaultModel), thinkingLevel: selected.defaultThinkingLevel ?? "low", settingsManager: settings, sessionManager: manager, tools: ["read", "write", "edit", "bash"] }));
    await session.bindExtensions({ onError: error => errors.push(error) });
    session.subscribe(event => {
      if (event.type === "tool_execution_end") {
        tools.push(event);
        console.log(JSON.stringify({ at: beijing(), stage: event.type, tool: event.toolName, isError: event.isError }));
      }
    });
  }
  await createFrontend();
  let task;
  if (!resuming) {
  result.sourceSessionId = session.sessionId;
  // 获取真实 Telegram HTTP Date 校时；不轮询生产 Bot、不消费用户消息。
  const calibration = JSON.parse(execFileSync("python3", ["-B", "-c", [
    "import json, urllib.request",
    "from pathlib import Path",
    "cfg=json.loads(Path('.pi/agent/telegram.json').read_text())",
    "token=cfg['profiles']['personal']['botToken']",
    "with urllib.request.urlopen('https://api.telegram.org/bot'+token+'/getMe',timeout=15) as response:",
    " print(json.dumps({'date':response.headers.get('Date')}))",
  ].join("\n")], { encoding: "utf8", timeout: 20000 }));
  assert(calibration.date);
  globalThis[observerKey].clock("getMe", calibration.date);
  result.clockCalibration = { source: "real Telegram getMe HTTP Date", ...calibration };
  const text = `test 帮我写个 C++17 批量模快速幂程序，逐行读 a b mod，支持负底数和完整64位无符号指数，乘法不能溢出。坏行报错但继续处理后面的合法行，附中文使用说明和独立回归检查。放在 ${business}/。`;
  const message = { message_id: 900001, chat: { id: paired }, date: Math.floor(Date.parse(calibration.date) / 1000), text };
  result.sourceMessageDate = message.date;
  result.inputWallMs = Date.now();
  result.inputMonotonicNs = process.hrtime.bigint().toString();
  save(path.join(evidence, "input.json"), { constructed: true, message });
  const turn = { kind: "prompt", chatId: paired, queueOrder: message.message_id, replyToMessageId: message.message_id, sourceMessageIds: [message.message_id], content: [{ type: "text", text }] };
  globalThis[observerKey].inbound({ update_id: message.message_id, message }, "getUpdates_api_confirmation");
  globalThis[observerKey].enqueue(turn, [message]);
  let processing;
  executeTelegramQueueDispatchPlan({ kind: "prompt", item: turn }, {
    onPromptDispatchStart() {},
    sendUserMessage(content) { processing = session.sendUserMessage(content); },
    onPromptDispatchFailure(error) { throw new Error(error); },
  });
  deadline = setTimeout(() => void session.abort(), 360000);
  await processing;
  clearTimeout(deadline);
  const tasks = Object.values(JSON.parse(fs.readFileSync(path.join(root, "registry.json"), "utf8")).tasks);
  assert.equal(tasks.length, 1);
  task = tasks[0];
  assert.equal(task.originalRequest.telegram.messageId, message.message_id);
  assert(task.runs[task.run_id].dispatch_requested);
  const last = session.messages.findLast(item => item.role === "assistant");
  assert(last && !["error", "aborted"].includes(last.stopReason));
  const answer = last.content.filter(block => block.type === "text").map(block => block.text).join("");
  relay.dispose();
  const front = globalThis[observerKey].decorateFinalText(turn, `🧪 后台尾注验收\n${answer}`);
  const chunk = renderTelegramMessage(front, { mode: "markdown" })[0];
  await globalThis[observerKey].delivery(turn, () => globalThis[observerKey].transport("sendMessage", { text: chunk.text }, async () => {
    const sent = JSON.parse(execFileSync("python3", [notifier, chunk.text, "--root", root, "--event-id", `dispatch-${task.taskId}`, "--target", JSON.stringify(target), "--parse-mode", "HTML"], { encoding: "utf8", timeout: 25000 }));
    assert.equal(sent.state, "success");
    save(path.join(evidence, "dispatch-receipt.json"), sent);
    return { message_id: sent.message_id };
  }));
  globalThis[observerKey].dispose();
  session.dispose();
  await createFrontend();
  } else {
    task = Object.values(JSON.parse(fs.readFileSync(path.join(root, "registry.json"), "utf8")).tasks)[0];
  }
  result.reviewSessionId = session.sessionId;
  assert.notEqual(result.reviewSessionId, result.sourceSessionId);
  console.log(JSON.stringify({ at: beijing(), stage: "dispatched-and-new-session", taskId: task.taskId, runId: task.run_id }));
  const finalTask = await wait(() => {
    const current = JSON.parse(fs.readFileSync(path.join(root, "registry.json"), "utf8")).tasks[task.taskId];
    if (["blocked", "needs_reconciliation", "rework", "cancelled"].includes(current.status)) {
      throw new Error(`真实任务未完成：${current.status}`);
    }
    return current.status === "reported" ? current : undefined;
  });
  await wait(() => Object.values(JSON.parse(fs.readFileSync(path.join(root, "inbox.json"), "utf8"))).some(item => item.task_id === task.taskId && item.state === "handled"));
  const receiptFile = path.join(root, "runs", task.taskId, task.run_id, "final-report-receipt.json");
  const receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
  const summary = receipt.observability.prepared.summary;
  result.actualReviewSessionId = receipt.observability.reviewSegments.at(-1).sessionId;
  assert.notEqual(result.actualReviewSessionId, result.sourceSessionId);
  assert.equal(receipt.state, "success");
  assert(receipt.body.includes("────") && receipt.body.includes("tokens ↑"));
  assert(summary.elapsedMs > 0 && summary.completeEvidence);
  assert(summary.usage.uncachedInput !== null && summary.usage.output !== null);
  const independentlyMeasured = Number(BigInt(receipt.observability.prepared.preparedMonotonicNs) - BigInt(result.inputMonotonicNs)) / 1e6;
  if (Number.isFinite(result.inputWallMs)) {
    const sourceFile = receipt.observability.sourceRecordFile;
    const start = fs.readFileSync(sourceFile, "utf8").trim().split("\n").map(JSON.parse).find(entry => entry.stage === "telegram_turn_start" && entry.telegramTurnId === task.originalRequest.telegram.turnId);
    const expected = independentlyMeasured + result.inputWallMs - result.sourceMessageDate * 1000 + (start.serverClockOffsetEstimateMs ?? 0);
    assert(Math.abs(summary.elapsedMs - expected) < 50, "task duration must match independent monotonic measurement within 50ms");
    result.independentlyMeasuredMs = expected;
  } else {
    assert(summary.elapsedMs >= independentlyMeasured - 50 && summary.elapsedMs < independentlyMeasured + 1050);
    result.independentTimingScope = "historical input lacks wall milliseconds; independent second-precision bounds only";
  }
  assert.equal(receipt.observability.source.telegramTurnId, task.originalRequest.telegram.turnId);
  assert.equal(finalTask.report.hash, createHash("sha256").update(JSON.stringify(receipt.body)).digest("hex"));
  const native = JSON.parse(fs.readFileSync(path.join(root, "runs", task.taskId, task.run_id, "herdr-evidence.json"), "utf8"));
  assert.equal(native.session_id, project.sessionId);
  assert.equal(native.native_input_count, 1);
  assert.deepEqual(native.outside_scope, []);
  assert.deepEqual(errors, []);
  assert.equal(tools.filter(item => item.isError).length, 0);
  for (const [file, before] of Object.entries(beforeHashes)) {
    assert.equal(hash(path.join(bot, file)), before, `${file} changed`);
  }
  const currentRegistry = JSON.parse(fs.readFileSync(path.join(root, "registry.json"), "utf8"));
  assert(!currentRegistry.projects.test.activeExecution);
  result.taskId = task.taskId;
  result.runId = task.run_id;
  result.summary = summary;
  result.messageIds = receipt.message_ids ?? [receipt.message_id];
  result.verificationKind = resuming ? "audit existing delivery without repeating dispatch or Telegram send" : "fresh full-chain delivery";
  result.passed = true;
} catch (error) {
  result.error = { name: error.name, message: error.message };
  throw error;
} finally {
  clearTimeout(deadline);
  relay?.dispose();
  await session?.abort();
  session?.dispose();
  result.finishedAt = beijing();
  save(path.join(evidence, resuming ? "recovery-result.json" : "result.json"), result);
  save(path.join(evidence, "tool-events.json"), tools);
  console.log(JSON.stringify({ evidence, passed: result.passed, error: result.error ?? null }));
}
