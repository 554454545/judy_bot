// 迟到结果投递回归：实际 relay 的正文、事件、回执与观测路径独立于旧失败；关联 notifications/relay-notify.ts，不调用模型或 Telegram。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const bot = process.cwd();
const require = createRequire(path.join(bot, "node_modules/@earendil-works/pi-coding-agent/package.json"));
const { createJiti } = await import(require.resolve("jiti"));
const jiti = createJiti(import.meta.url, { fsCache: false });
const { createRelay } = await jiti.import(path.join(bot, ".pi/extensions/background/notifications/relay-notify.ts"));
const temporary = fs.mkdtempSync(path.join(bot, ".cache/tmp/late-delivery-"));
const directory = path.join(temporary, "runs/task/run");
fs.mkdirSync(directory, { recursive: true });
const oldBody = "旧失败通知";
const oldReceipt = { state: "success", message_id: 10, body: oldBody };
fs.writeFileSync(path.join(directory, "final-report.txt"), oldBody);
fs.writeFileSync(path.join(directory, "final-report-receipt.json"), JSON.stringify(oldReceipt));
fs.writeFileSync(path.join(temporary, "registry.json"), JSON.stringify({
  tasks: {
    task: {
      taskId: "task",
      run_id: "run",
      status: "verified",
      runs: { run: { late_result: { sha256: "a".repeat(64) } } },
      originalRequest: { telegram: { chatId: 123, messageId: 77 } },
    },
  },
}));
const handlers = new Map();
const operations = [];
const identities = [];
let claimed = false;
const pi = {
  on: (event, handler) => handlers.set(event, handler),
  sendMessage() { throw new Error("已验收恢复不得唤醒模型"); },
  async exec(_executable, args) {
    const file = path.basename(args[0]);
    let value = {};
    if (file === "task_protocol.py") {
      const action = args[args.indexOf(temporary) + 1];
      operations.push({ action, args });
      if (action === "claim") {
        value = claimed ? null : { event_id: "late-event", claim_id: "claim", task_id: "task", run_id: "run", phase: "verified" };
        claimed = true;
      } else if (action === "validate-notice") {
        value = { action: "current" };
      } else if (action === "result") {
        value = { status: "verified", summary: "迟到成果已完成独立验收" };
      }
    } else if (file === "notify-telegram.py") {
      const eventId = args[args.indexOf("--event-id") + 1];
      assert.equal(eventId, "final-task-run-late-aaaaaaaaaaaaaaaa");
      assert.equal(args[args.indexOf("--reply-to-message-id") + 1], "77");
      assert(!args[1].includes(oldBody));
      assert(args[1].includes("迟到成果"));
      value = { state: "success", message_id: 11, event_id: eventId };
    }
    return { code: 0, stdout: JSON.stringify(value), stderr: "" };
  },
};
const ctx = {
  isIdle: () => true,
  hasPendingMessages: () => false,
  sessionManager: {
    getSessionId: () => "late-review",
    getLeafId: () => "leaf",
    getBranch: () => [],
  },
};
const key = Symbol.for("bot.observability.telegram-turn");
const previous = globalThis[key];
globalThis[key] = {
  beginBackgroundReview: async identity => identities.push(identity),
  prepareBackgroundDelivery: async identity => {
    identities.push(identity);
    return { footer: "────\n⏱ ? · tokens ↑? ↓?" };
  },
  confirmBackgroundDelivery: identity => identities.push(identity),
  abandonBackgroundReview() {},
};
const relay = createRelay(pi, { root: temporary, isMain: () => true, target: { chatId: 123 }, intervalMs: 60000 });
try {
  handlers.get("session_start")({}, ctx);
  await relay.collect();
  assert.equal(fs.readFileSync(path.join(directory, "final-report.txt"), "utf8"), oldBody);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, "final-report-receipt.json"))), oldReceipt);
  const newReceipt = JSON.parse(fs.readFileSync(path.join(directory, "late-aaaaaaaaaaaaaaaa/final-report-receipt.json")));
  assert.equal(newReceipt.message_id, 11);
  assert.equal(newReceipt.state, "success");
  assert(identities.length >= 3 && identities.every(identity => identity.deliveryId === "late-aaaaaaaaaaaaaaaa"));
  const reported = operations.find(item => item.action === "report");
  assert(reported.args.at(-1).endsWith("late-aaaaaaaaaaaaaaaa/final-report-receipt.json"));
  assert(operations.some(item => item.action === "ack" && item.args.includes("handled")));
  console.log(JSON.stringify({ passed: true, lateReplySeparated: true, preservedFailure: true, modelCalls: 0, telegramCalls: 0 }));
} finally {
  relay.dispose();
  globalThis[key] = previous;
  fs.rmSync(temporary, { recursive: true, force: true });
}
