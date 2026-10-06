// 后台结果接力：复用 Joye inbox/claim/ack/签收，引用原 TG 提问交付结果；关联通知脚本及 extensions/observability/telegram-turn/ 的尾注和时间。
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { renderTelegramMessage } from "../../../npm/node_modules/@llblab/pi-telegram/lib/rendering.ts";
import { formatFooter } from "../../../../extensions/observability/telegram-turn/statistics.ts";

export const backgroundControlKey = Symbol.for("bot.background.control-turn");
const bot = path.resolve(import.meta.dirname, "../../../..");
const defaultRoot = path.join(bot, ".pi/agent/background");
const protocol = path.join(bot, ".pi/extensions/background/tasks/task_protocol.py");
const scripts = path.join(bot, ".pi/extensions/background/notifications");
const beijing = () => new Date(Date.now() + 8 * 3600000).toISOString().replace("Z", "+08:00");

function save(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function launchedByTelegram() {
  try {
    const args = fs.readFileSync(`/proc/${process.ppid}/cmdline`, "utf8").split("\0");
    return args.includes(path.join(bot, "scripts/startup/telegram.mjs"));
  } catch {
    return false;
  }
}

function ownsTelegramProfile() {
  try {
    const directory = path.join(bot, ".pi/agent/tmp/telegram");
    const owner = JSON.parse(fs.readFileSync(path.join(directory, "owners.json"), "utf8")).personal;
    const state = JSON.parse(fs.readFileSync(path.join(directory, "state.personal.json"), "utf8")).runtime;
    const age = Date.now() - owner.heartbeatMs;
    return owner.pid === process.pid
      && path.resolve(owner.cwd) === bot
      && age >= 0
      && age < 180000
      && state.pollingActive === true
      && state.lockState === "active here";
  } catch {
    return false;
  }
}

type Notice = {
  event_id: string;
  claim_id: string;
  task_id: string;
  run_id: string;
  phase: string;
  result_path?: string;
};

export function createRelay(pi: ExtensionAPI, options: {
  root?: string;
  isMain?: () => boolean;
  intervalMs?: number;
  target?: { chatId: number; threadId?: number };
} = {}) {
  const root = options.root ?? defaultRoot;
  const generation = randomUUID();
  let ctx: ExtensionContext | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = true;
  let collecting = false;
  let finishing = false;
  let lastUserInput = 0;
  let version = 0;
  let owned = false;
  let active: {
    notice: Notice;
    session: string;
    details: object;
    finalText: string;
    entryId?: string;
  } | undefined;

  const errors = path.join(root, "logs/relay.jsonl");
  function record(stage: string, fields: Record<string, unknown> = {}) {
    fs.mkdirSync(path.dirname(errors), { recursive: true, mode: 0o700 });
    fs.appendFileSync(errors, JSON.stringify({ at: beijing(), monotonicNs: process.hrtime.bigint().toString(), stage, ...fields }) + "\n", { mode: 0o600 });
  }
  function owner() {
    const main = options.isMain ? options.isMain() : launchedByTelegram() && ownsTelegramProfile();
    if (!ctx || !main) {
      if (owned) {
        record("owner_unavailable", { epoch: version });
        owned = false;
      }
      return undefined;
    }
    try {
      const config = JSON.parse(fs.readFileSync(path.join(bot, ".pi/agent/telegram.json"), "utf8"));
      const target = options.target ?? { chatId: config.profiles.personal.allowedUserId };
      const current = {
        pid: process.pid,
        session_id: ctx.sessionManager.getSessionId(),
        leaf_id: ctx.sessionManager.getLeafId(),
        profile: "personal",
        generation,
        epoch: version,
        target,
        main: true,
        idle: ctx.isIdle() && !ctx.hasPendingMessages(),
      };
      if (!owned) {
        record("owner_ready", {
          pid: process.pid,
          sessionId: current.session_id,
          epoch: version,
          explicitOwnerOverride: Boolean(options.isMain),
        });
        owned = true;
      }
      return current;
    } catch {
      // SDK dispose/reload 会使捕获的 ctx 失效；不得让定时器异常终止整个 Pi。
      return undefined;
    }
  }
  async function call(args: string[]) {
    const result = await pi.exec("python3", [protocol, "--root", root, ...args], { timeout: 20000 });
    if (result.code !== 0) {
      const evidence = path.join(root, "logs/protocol", `${Date.now()}-${randomUUID()}.json`);
      save(evidence, { at: beijing(), operation: args[0], code: result.code, stdout: result.stdout, stderr: result.stderr });
      throw Object.assign(new Error(`Background protocol failed: ${args[0]}`), { operation: args[0], evidence });
    }
    return JSON.parse(result.stdout);
  }
  function observation() {
    return (globalThis as any)[Symbol.for("bot.observability.telegram-turn")];
  }
  function observationIdentity(notice: Notice, details = active?.details ?? {}) {
    return {
      root,
      taskId: notice.task_id,
      runId: notice.run_id,
      eventId: notice.event_id,
      details,
    };
  }
  function clearControl() {
    delete (globalThis as any)[backgroundControlKey];
    observation()?.abandonBackgroundReview();
  }
  async function deliver(notice: Notice, text: string, verified: boolean) {
    const target = owner()?.target;
    if (!target) throw new Error("Background delivery owner unavailable");
    const directory = path.join(root, "runs", notice.task_id, notice.run_id);
    const bodyFile = path.join(directory, "final-report.txt");
    const receiptFile = path.join(directory, "final-report-receipt.json");
    // 重启后沿用已经准备的正文；不会用新回复覆盖发送意图。
    if (!fs.existsSync(bodyFile)) {
      const old = fs.existsSync(receiptFile) ? JSON.parse(fs.readFileSync(receiptFile, "utf8")) : undefined;
      let prepared = old;
      if (old?.state !== "prepared") {
        const task = JSON.parse(fs.readFileSync(path.join(root, "registry.json"), "utf8")).tasks[notice.task_id];
        if (task?.run_id !== notice.run_id) {
          throw new Error("Background reply task/run mismatch");
        }
        const original = task.originalRequest?.telegram;
        // 回复身份随正文固定；换前台 session 或重试时仍引用原始任务消息。
        const replyToMessageId = original?.chatId === target.chatId
          && Number.isSafeInteger(original.messageId)
          && original.messageId > 0
          ? original.messageId
          : undefined;
        let footer;
        let reportText = text;
        try {
          const snapshot = await observation()?.prepareBackgroundDelivery(observationIdentity(notice), ctx, text);
          footer = snapshot?.footer;
          reportText = snapshot?.reportText ?? text;
        } catch {
          record("observation_error", { operation: "prepare_footer", taskId: notice.task_id, runId: notice.run_id });
        }
        footer ??= formatFooter({
          elapsedMs: null,
          usage: {
            requests: 0,
            uncachedInput: null,
            output: null,
            cacheRead: null,
            scope: "observation unavailable",
          },
          context: {
            tokens: null,
            window: null,
          },
          model: "?",
          thinking: "?",
          tools: null,
        });
        // 完整渲染，不裁切正文；超出 Telegram 上限的块由通知脚本逐块签收。
        const chunks = renderTelegramMessage(`${reportText.trimEnd()}\n${footer}`, { mode: "markdown" }).map(chunk => chunk.text);
        prepared = {
          ...(fs.existsSync(receiptFile) ? JSON.parse(fs.readFileSync(receiptFile, "utf8")) : {}),
          state: "prepared",
          parse_mode: "HTML",
          reply_to_message_id: replyToMessageId,
          chunks,
          body: chunks.join(""),
        };
      }
      // 先持久化格式和正文意图，崩溃后按同一份内容恢复，不拆出额外配置文件。
      save(receiptFile, prepared);
      fs.writeFileSync(bodyFile, prepared.body, { mode: 0o600 });
    }
    const prepared = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
    const parseMode = prepared.parse_mode;
    if (verified) {
      await call(["prepare-report", notice.task_id, notice.run_id, "--text-file", bodyFile, "--target", JSON.stringify(target)]);
    }
    const body = fs.readFileSync(bodyFile, "utf8");
    const response = await pi.exec("python3", [
      path.join(scripts, "notify-telegram.py"), body,
      "--root", root,
      "--event-id", `final-${notice.task_id}-${notice.run_id}`,
      "--target", JSON.stringify(target),
      ...(parseMode ? ["--parse-mode", parseMode] : []),
      ...(prepared.chunks ? ["--chunks-file", receiptFile] : []),
      ...(prepared.reply_to_message_id ? ["--reply-to-message-id", String(prepared.reply_to_message_id)] : []),
    ], { timeout: 30000 });
    const receipt = JSON.parse(response.stdout);
    save(receiptFile, { ...JSON.parse(fs.readFileSync(receiptFile, "utf8")), ...receipt });
    try {
      observation()?.confirmBackgroundDelivery(observationIdentity(notice), receipt, ctx);
    } catch {
      record("observation_error", { operation: "delivery_confirmation", taskId: notice.task_id, runId: notice.run_id });
    }
    if (receipt.state !== "success") {
      record("delivery_unconfirmed", { taskId: notice.task_id, runId: notice.run_id, state: receipt.state });
      throw Object.assign(new Error("Background delivery not confirmed"), { receipt });
    }
    if (verified) {
      await call(["report", notice.task_id, notice.run_id, "--receipt", receiptFile]);
    }
    return receipt;
  }

  async function finish() {
    const current = active;
    if (!current || !ctx?.isIdle() || ctx.hasPendingMessages() || finishing) {
      return;
    }
    finishing = true;
    try {
      current.entryId ??= ctx.sessionManager.getBranch().findLast((entry: any) => entry.type === "custom_message" && entry.details?.eventId === current.notice.event_id)?.id;
      const result = await call(["result", current.notice.task_id, current.notice.run_id]);
      if (stopped || current !== active || current.session !== ctx.sessionManager.getSessionId()) {
        return;
      }
      let receipt;
      if (result.status === "verified") {
        const text = current.finalText.trim() || `✅ ${current.notice.task_id} 已完成并独立验收。${result.summary}`;
        receipt = await deliver(current.notice, text, true);
      } else if (["blocked", "needs_reconciliation", "cancelled", "rework"].includes(result.status)) {
        const reason = result.status === "rework"
          ? "独立验收未通过"
          : result.status === "cancelled"
            ? "已取消"
            : result.status === "needs_reconciliation"
              ? "执行状态尚未确认"
              : result.error || result.reason || "执行失败";
        const text = `⚠️ 后台任务 ${current.notice.task_id} 未完成：${reason}。${current.finalText.trim()}`;
        receipt = await deliver(current.notice, text, false);
      } else if (result.status !== "reported") {
        record("review_unconfirmed", { taskId: current.notice.task_id, runId: current.notice.run_id, status: result.status });
        const failure = path.join(root, "attention", `${current.notice.event_id}.json`);
        save(failure, {
          at: beijing(),
          event_id: current.notice.event_id,
          status: result.status,
          entry_id: current.entryId,
          reason: "review_not_verified",
          owner: owner(),
        });
        await call(["attention", current.notice.event_id, current.notice.claim_id, "--evidence", failure]);
        active = undefined;
        clearControl();
        return;
      }
      const evidenceFile = path.join(root, "handled", `${current.notice.event_id}.json`);
      save(evidenceFile, {
        event_id: current.notice.event_id,
        task_id: current.notice.task_id,
        run_id: current.notice.run_id,
        session_id: current.session,
        entry_id: current.entryId,
        status: result.status,
        verification: result.verification,
        receipt,
        at: beijing(),
      });
      await call(["ack", current.notice.event_id, current.notice.claim_id, "handled", "--evidence", evidenceFile]);
      record("handled", { eventId: current.notice.event_id, taskId: current.notice.task_id, runId: current.notice.run_id });
      active = undefined;
      clearControl();
    } catch (error) {
      const type = error instanceof Error ? error.name : "unknown";
      record("finish_error", { type, eventId: current.notice.event_id, operation: (error as any)?.operation, evidence: (error as any)?.evidence });
      const failure = path.join(root, "attention", `${current.notice.event_id}.json`);
      save(failure, {
        at: beijing(),
        event_id: current.notice.event_id,
        type,
        reason: "delivery_or_protocol_unconfirmed",
        receipt: (error as any)?.receipt,
        owner: owner(),
      });
      try {
        await call(["attention", current.notice.event_id, current.notice.claim_id, "--evidence", failure]);
      } catch {
        record("attention_error", { eventId: current.notice.event_id });
      }
      active = undefined;
      clearControl();
    } finally {
      finishing = false;
    }
  }

  async function collect() {
    const epoch = version;
    const current = owner();
    if (stopped || collecting || !current?.idle || Date.now() - lastUserInput < 1500) {
      return;
    }
    collecting = true;
    try {
      if (active) {
        await finish();
        return;
      }
      const tick = await pi.exec("python3", [path.join(scripts, "task-watchdog.py"), "--root", root], { timeout: 30000 });
      if (tick.code !== 0) {
        record("watchdog_error", { code: tick.code });
      }
      const notice: Notice | null = await call(["claim", "--owner", JSON.stringify(current)]);
      if (!notice) {
        return;
      }
      const live = owner();
      if (stopped || epoch !== version || !live?.idle || Date.now() - lastUserInput < 1500 || JSON.stringify(live) !== JSON.stringify(current)) {
        await call(["ack", notice.event_id, notice.claim_id, "pending"]);
        return;
      }
      const decision = await call(["validate-notice", notice.event_id, notice.claim_id, "--owner", JSON.stringify(current)]);
      if (decision.action !== "current") {
        return;
      }
      const branch = ctx!.sessionManager.getBranch();
      const previous = branch.filter((entry: any) => entry.type === "custom_message" && entry.customType === "background-task-event" && entry.details?.eventId === notice.event_id);
      if (previous.length) {
        const observed = await call([
          "observe-input", notice.event_id, notice.claim_id,
          "--entry-id", previous[0].id,
          "--session-id", current.session_id,
          "--entry-at", String(Date.parse(previous[0].timestamp) / 1000),
          ...(previous.length > 1 ? ["--recovery-entry-id", previous.at(-1)!.id] : []),
        ]);
        if (observed.action !== "recover") {
          return;
        }
      }
      const details = { eventId: notice.event_id, nonce: randomUUID() };
      fs.mkdirSync(path.join(root, "reviews"), { recursive: true, mode: 0o700 });
      active = { notice, session: current.session_id, details, finalText: "" };
      try {
        await observation()?.beginBackgroundReview(observationIdentity(notice, details), ctx);
      } catch {
        record("observation_error", { operation: "begin_review", taskId: notice.task_id, runId: notice.run_id });
      }
      // 已验收的恢复事件只补投递，不让模型再跑业务检查或重复副作用。
      if (notice.phase === "verified" || notice.phase === "verified_overdue") {
        await finish();
        return;
      }
      // 控制身份来自本进程实际发出的对象，用户正文中的 marker 不授予控制权限。
      (globalThis as any)[backgroundControlKey] = { sessionId: current.session_id, details };
      pi.sendMessage({
        customType: "background-task-event",
        display: false,
        details,
        content: [
          "后台任务状态事件。先查当前 run；只读取验收需要的产物，不能读取完整 worker 对话、终端日志或 diff。",
          `task_id=${notice.task_id} run_id=${notice.run_id} phase=${notice.phase}`,
          `本次唯一登记根目录=${root}，CLI=${protocol}；所有命令在子命令前传 --root ${root}。`,
          `结果路径=${notice.result_path ?? "尚无执行结果"}`,
          `如 ready_for_review，按原 acceptance 实际检查并运行测试，写 ${root}/reviews/ 内匹配 task_id/run_id/passed/checks 的 JSON，再 verify。`,
          "如检查失败，verify --reject，并据实说明问题，不自动冒充通过或重复派发。",
          "失败或状态不明确时只查有界证据，说明真实问题。不要重发任务，不直接关闭 Herdr。",
          "最后按原始需求交付，而不是只给完成回执。先说明本次对象、范围和结论，再用实际产物、验收证据或相关已有报告说明依据、原因和实际影响；区分已完成、未完成和建议。不得混入其他 Agent/项目的工作或套用别处的数据。",
          "代码任务说明做了什么、如何运行或使用、关键设计理由及限制；调查任务解释事实为何构成问题、优先处理什么。信息量随任务复杂度调整，简单任务不凑篇幅；不要在回复里罗列常规测试项数，关键验证结论和限制保留。",
          "可以分段或用有意义的小标题，避免干瘪的状态清单。正文尽量在一条 TG 消息内说清；详细资料留在实际允许的产物文件，给出确实存在的路径，不能编造链接。",
          "统计尾注由扩展按原始用量和时间证据生成，不要自行写耗时、token、ctx、tools。扩展核查真实状态后发送 TG 并记录签收；不要自己发 TG，也不要调用 report/prepare-report/ack。",
        ].join("\n"),
      }, { triggerTurn: true, deliverAs: "followUp" });
      await call(["ack", notice.event_id, notice.claim_id, "enqueued", "--evidence", current.session_id]);
      record("enqueued", { eventId: notice.event_id, taskId: notice.task_id, runId: notice.run_id });
    } catch (error) {
      record("collect_error", { type: error instanceof Error ? error.name : "unknown" });
    } finally {
      collecting = false;
    }
  }

  pi.on("input", event => {
    if (event.source !== "extension") lastUserInput = Date.now();
  });
  pi.on("message_start", (event, context) => {
    if (!active) {
      return;
    }
    if (event.message.role === "custom" && (event.message as any).details === active.details) {
      const entry = context.sessionManager.getBranch().findLast((item: any) => item.type === "custom_message" && item.details === active?.details);
      active.entryId = entry?.id;
    } else if (event.message.role === "user") {
      // 用户抢占优先；未处理事件保留租约，稍后按持久证据恢复。
      active = undefined;
      clearControl();
    }
  });
  pi.on("message_end", event => {
    if (active && event.message.role === "assistant" && !["error", "aborted"].includes(event.message.stopReason)) {
      active.finalText = event.message.content.filter(block => block.type === "text").map(block => block.type === "text" ? block.text : "").join("");
    }
  });
  pi.on("agent_settled", async () => {
    await finish();
  });
  pi.on("session_start", (_event, context) => {
    if (timer) {
      clearInterval(timer);
    }
    ctx = context;
    stopped = false;
    version += 1;
    owned = false;
    timer = setInterval(() => void collect().catch(error => record("timer_error", { type: error instanceof Error ? error.name : "unknown" })), options.intervalMs ?? 4000);
    timer.unref?.();
  });
  pi.on("session_tree", (_event, context) => {
    ctx = context;
    version += 1;
    lastUserInput = Date.now();
    active = undefined;
    clearControl();
  });
  pi.on("session_shutdown", () => {
    stopped = true;
    version += 1;
    active = undefined;
    clearControl();
    if (timer) {
      clearInterval(timer);
    }
    timer = undefined;
    ctx = undefined;
  });
  function dispose() {
    stopped = true;
    version += 1;
    if (timer) {
      clearInterval(timer);
    }
    timer = undefined;
    ctx = undefined;
    active = undefined;
    clearControl();
  }
  return { collect, dispose };
}
