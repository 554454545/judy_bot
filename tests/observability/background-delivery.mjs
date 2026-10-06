// 后台交付统计回归：核对原始 TG 时间、跨 session/重启归属、去重及未知用量；关联 telegram-turn/index.ts 和后台 relay，不联网。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const bot = process.cwd();
const require = createRequire(path.join(bot, "node_modules/@earendil-works/pi-coding-agent/package.json"));
const { createJiti } = await import(require.resolve("jiti"));
const jiti = createJiti(import.meta.url, { fsCache: false });
const { registerTelegramTurnObservability } = await jiti.import(path.join(bot, "extensions/observability/telegram-turn/index.ts"));
const key = Symbol.for("bot.observability.telegram-turn");
const directory = fs.mkdtempSync(path.join(bot, ".cache/tmp/background-delivery-"));
const observations = path.join(directory, "observability");
const root = path.join(directory, "background");
fs.mkdirSync(observations, { mode: 0o700 });
fs.mkdirSync(root, { mode: 0o700 });
const handlers = new Map();
const records = [];
let feature;
let wallNow = Date.now;
const context = (id, window = 2000) => ({
  sessionManager: {
    getSessionId: () => id,
    getSessionFile: () => path.join(directory, `${id}.jsonl`),
    getHeader: () => ({ timestamp: "2026-10-06T00:00:00.000Z" }),
  },
  model: { provider: "fixture", id: id, contextWindow: window },
});
const original = context("source", 1000);
const review = context("review");
const file = ctx => path.join(observations, `records_${ctx.sessionManager.getSessionId()}.jsonl`);
const record = (stage, details, ctx) => {
  feature?.observe(stage, details, ctx);
  const entry = { stage, telegramTurnId: feature?.turnId ?? null, ...details, sessionId: ctx.sessionManager.getSessionId(), at: new Date().toISOString() };
  records.push(entry);
  fs.appendFileSync(file(ctx), JSON.stringify(entry) + "\n", { mode: 0o600 });
};
const pi = {
  on: (event, handler) => handlers.set(event, handler),
  getThinkingLevel: () => "low",
};
const emit = (event, value, ctx) => handlers.get(event)?.(value, ctx);
function install() {
  handlers.clear();
  feature = registerTelegramTurnObservability(pi, record, file);
}
function request(id, input, cached, output, ctx, respond = true) {
  record("request", { requestId: id, model: ctx.model }, ctx);
  if (!respond) {
    return;
  }
  const raw = {
    input_tokens: input,
    input_tokens_details: cached === null ? {} : { cached_tokens: cached },
    output_tokens: output,
  };
  const assistantMessage = { role: "assistant", stopReason: "stop", content: [] };
  globalThis[key].usage(assistantMessage, raw, "responses");
  record("response", {
    requestId: id,
    assistantMessage,
    accounting: { providerRawUsage: raw, providerUsageProtocol: "responses" },
  }, ctx);
}
const boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
try {
  install();
  await emit("session_start", {}, original);
  const date = Math.floor(wallNow() / 1000) - 5;
  const message = { message_id: 1, chat: { id: 123 }, date, text: "实际测试任务" };
  const turn = { chatId: 123, queueOrder: 1, replyToMessageId: 1, sourceMessageIds: [1] };
  globalThis[key].clock("getUpdates", new Date(wallNow()).toUTCString());
  globalThis[key].inbound({ update_id: 1, message }, "getUpdates_api_confirmation");
  globalThis[key].enqueue(turn, [message]);
  globalThis[key].dispatch(turn);
  await emit("input", {}, original);
  const sourceId = records.find(entry => entry.stage === "telegram_turn_start").telegramTurnId;
  request("dispatch-1", 100, 60, 12, original);
  request("dispatch-2", 120, 60, 12, original);
  record("tool_execution_start", { toolCallId: "dispatch-tool", toolName: "bash" }, original);
  const earlyText = globalThis[key].decorateFinalText(turn, "已派发");
  await globalThis[key].delivery(turn, () => globalThis[key].transport("sendMessage", { text: earlyText }, async () => ({ message_id: 7 })));
  const early = records.find(entry => entry.stage === "telegram_footer_prepared").displaySummary.elapsedMs;
  // 已完成的其他聊天不应计入这条任务。
  record("request", { requestId: "unrelated", model: original.model, telegramTurnId: "other-turn" }, original);
  record("response", { requestId: "unrelated", telegramTurnId: "other-turn", accounting: { providerRawUsage: { input_tokens: 999999, output_tokens: 999999 }, providerUsageProtocol: "responses" } }, original);
  const source = {
    sessionId: "source",
    telegram: { turnId: sourceId, messageId: 1, chatId: 123, sentAt: new Date(date * 1000).toISOString() },
  };
  const registry = { tasks: {} };
  const identity = (taskId, runId = "run-1") => ({ root, taskId, runId, eventId: `event-${taskId}`, details: {} });
  const register = id => {
    registry.tasks[id.taskId] = { taskId: id.taskId, run_id: id.runId, originalRequest: source };
    fs.writeFileSync(path.join(root, "registry.json"), JSON.stringify(registry), { mode: 0o600 });
  };
  const active = identity("accurate");
  register(active);
  await globalThis[key].beginBackgroundReview(active, review);
  // 文字或相似 details 不能冒充真实控制对象。
  await emit("message_start", { message: { role: "custom", details: {} } }, review);
  request("spoofed", 8888, 0, 8888, review);
  await emit("message_start", { message: { role: "custom", details: active.details } }, review);
  request("review-1", 130, 100, 7, review);
  request("review-2", 140, 100, 3, review);
  const proofDirectory = path.join(root, "runs", active.taskId, active.runId);
  fs.writeFileSync(path.join(proofDirectory, "result.json"), JSON.stringify({
    task_id: active.taskId,
    run_id: active.runId,
    pid_identity: { boot_id: boot },
  }));
  fs.writeFileSync(path.join(proofDirectory, "herdr-evidence.json"), JSON.stringify({
    task_id: active.taskId,
    run_id: active.runId,
    dispatch_started_monotonic_ns: "1000000000",
    dispatch_finished_monotonic_ns: "2250000000",
  }));
  // 重复日志条目不重复计费或累计工具数量。
  request("review-2", 140, 100, 3, review);
  for (const toolCallId of ["review-tool-1", "review-tool-2", "review-tool-2"]) {
    record("tool_execution_start", { toolCallId, toolName: "bash" }, review);
  }
  Date.now = () => wallNow() + 86400000;
  const prepared = await globalThis[key].prepareBackgroundDelivery(active, review);
  Date.now = wallNow;
  assert.equal(prepared.summary.usage.uncachedInput, 170);
  assert.equal(prepared.summary.usage.output, 34);
  assert.equal(prepared.summary.tools, 3);
  assert.deepEqual(prepared.summary.context, { tokens: 140, window: 2000 });
  assert.equal(prepared.summary.model, "fixture/review");
  assert.equal(prepared.summary.requestIds.length, 4);
  assert(prepared.summary.elapsedMs >= early && prepared.summary.elapsedMs < 10000);
  assert(prepared.footer.includes("↑170 ↓34"));
  assert(prepared.footer.includes("ctx 7.0% / 2k"));
  assert(prepared.summary.clock.includes("same-boot"));
  assert.equal(prepared.summary.stages.codingAgentMs, 1250);
  assert(prepared.summary.stages.dispatchReplyMs >= early);
  assert(prepared.summary.stages.reviewPreparationMs >= 0);
  // 新进程同一 Linux boot 仍可核对原起点；prepared 不重新计算。
  install();
  const resumed = context("resumed");
  await emit("session_start", {}, resumed);
  await globalThis[key].beginBackgroundReview(active, resumed);
  assert.deepEqual(await globalThis[key].prepareBackgroundDelivery(active, resumed), prepared);
  const beforePython = process.hrtime.bigint();
  const pythonNs = BigInt(execFileSync("python3", ["-B", "-c", "import time; print(time.monotonic_ns())"], { encoding: "utf8" }).trim());
  assert(pythonNs >= beforePython && pythonNs <= process.hrtime.bigint(), "Python/Node must share same-boot CLOCK_MONOTONIC");
  globalThis[key].confirmBackgroundDelivery(active, { state: "success", monotonic_ns: pythonNs.toString(), boot_id: boot, message_id: 8 }, resumed);
  const confirmed = records.findLast(entry => entry.stage === "background_delivery_end");
  assert(confirmed.confirmedTiming.elapsedMs >= prepared.summary.elapsedMs);
  assert.equal(confirmed.finalDeliveryMs, Number(pythonNs - BigInt(prepared.preparedMonotonicNs)) / 1e6);
  assert.deepEqual(confirmed.displaySummary, prepared.summary);
  globalThis[key].abandonBackgroundReview();

  // 尚未准备正文就重启，按实际持久请求恢复，不能只统计重启后的请求。
  const restart = identity("unprepared-restart");
  register(restart);
  await globalThis[key].beginBackgroundReview(restart, review);
  await emit("message_start", { message: { role: "custom", details: restart.details } }, review);
  request("before-restart", 150, 100, 9, review);
  install();
  await emit("session_start", {}, resumed);
  await globalThis[key].beginBackgroundReview(restart, resumed);
  await emit("message_start", { message: { role: "custom", details: restart.details } }, resumed);
  request("after-restart", 170, 100, 11, resumed);
  const restored = await globalThis[key].prepareBackgroundDelivery(restart, resumed);
  assert.equal(restored.summary.usage.uncachedInput, 220);
  assert.equal(restored.summary.usage.output, 44);
  assert.equal(restored.summary.model, "fixture/resumed");
  assert(restored.summary.elapsedMs >= early && restored.summary.elapsedMs < 10000);
  assert.equal(restored.summary.completeEvidence, true);
  globalThis[key].abandonBackgroundReview();

  for (const [name, respond, cache] of [["missing-response", false, 0], ["missing-cache", true, null]]) {
    const id = identity(name);
    register(id);
    await globalThis[key].beginBackgroundReview(id, review);
    await emit("message_start", { message: { role: "custom", details: id.details } }, review);
    request(`request-${name}`, 140, cache, 3, review, respond);
    const result = await globalThis[key].prepareBackgroundDelivery(id, review);
    assert.equal(result.summary.usage.uncachedInput, null);
    assert.equal(result.summary.usage.output, respond ? 27 : null);
    assert(result.footer.includes("↑?"));
    globalThis[key].abandonBackgroundReview();
  }
  // 单有本机墙上时间不构成 Telegram 跨主机校时证据。
  const content = fs.readFileSync(file(original), "utf8").trim().split("\n").map(JSON.parse);
  const sourceEntry = content.find(entry => entry.stage === "telegram_turn_start");
  const calibratedReceive = sourceEntry.receivedServerEstimatedAt;
  sourceEntry.receivedServerEstimatedAt = null;
  fs.writeFileSync(file(original), content.map(entry => JSON.stringify(entry)).join("\n") + "\n");
  install();
  const uncalibrated = identity("uncalibrated");
  register(uncalibrated);
  await globalThis[key].beginBackgroundReview(uncalibrated, review);
  await emit("message_start", { message: { role: "custom", details: uncalibrated.details } }, review);
  request("uncalibrated-review", 140, 100, 3, review);
  assert.equal((await globalThis[key].prepareBackgroundDelivery(uncalibrated, review)).summary.elapsedMs, null);
  sourceEntry.receivedServerEstimatedAt = calibratedReceive;
  // 已经重启 Linux boot 且没有新的 Telegram 校时证据，耗时必须未知。
  content.find(entry => entry.stage === "telegram_turn_start").clockAnchor.bootId = "different-boot";
  fs.writeFileSync(file(original), content.map(entry => JSON.stringify(entry)).join("\n") + "\n");
  install();
  const rebooted = identity("rebooted");
  register(rebooted);
  await globalThis[key].beginBackgroundReview(rebooted, review);
  await emit("message_start", { message: { role: "custom", details: rebooted.details } }, review);
  request("after-reboot", 140, 100, 3, review);
  assert.equal((await globalThis[key].prepareBackgroundDelivery(rebooted, review)).summary.elapsedMs, null);
  // 新 Telegram 校时允许跨 boot 用原始 Telegram 日期重建耗时，不相减不同 boot 的单调时间。
  globalThis[key].clock("getMe", new Date(wallNow()).toUTCString());
  const calibratedReboot = identity("calibrated-reboot");
  register(calibratedReboot);
  await globalThis[key].beginBackgroundReview(calibratedReboot, review);
  await emit("message_start", { message: { role: "custom", details: calibratedReboot.details } }, review);
  request("calibrated-reboot-review", 140, 100, 3, review);
  const rebootTiming = await globalThis[key].prepareBackgroundDelivery(calibratedReboot, review);
  assert(rebootTiming.summary.elapsedMs >= 4000 && rebootTiming.summary.elapsedMs < 15000);
  assert(rebootTiming.summary.clock.includes("fresh Telegram"));
  // 用户抢占后，后续请求不能继续归属旧任务。
  globalThis[key].abandonBackgroundReview();
  const preempted = identity("preempted");
  register(preempted);
  await globalThis[key].beginBackgroundReview(preempted, review);
  await emit("message_start", { message: { role: "custom", details: preempted.details } }, review);
  await emit("message_start", { message: { role: "user" } }, review);
  request("new-user", 1000, 0, 1000, review);
  assert.equal(records.findLast(entry => entry.stage === "request").backgroundTask, undefined);
  const result = {
    at: new Date(wallNow() + 8 * 3600000).toISOString().replace("Z", "+08:00"),
    passed: true,
    cases: ["same-boot monotonic timing", "24-hour local wall-clock jump", "cross-session origin", "request/tool deduplication", "unrelated chat exclusion", "control object identity", "prepared receipt frozen across restart", "unprepared restart recovery", "Python/Node clock compatibility", "unknown cache and response", "uncalibrated local clock unknown", "reboot without calibration unknown", "reboot with fresh Telegram calibration", "execution/review/delivery stage boundaries", "user preemption"],
    liveModelCalls: 0,
    liveTelegramMessages: 0,
  };
  const target = path.join(bot, ".pi/agent/logs/observability/background-delivery-verification.json");
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify(result));
} finally {
  Date.now = wallNow;
  globalThis[key]?.dispose();
  delete globalThis[key];
  fs.rmSync(directory, { recursive: true, force: true });
}
