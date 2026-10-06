// memory-recovery — 离线验证持久任务重启恢复、有限重试及未知结果保护。
// 关联：autosediment/tasks.ts；使用临时任务目录与真实 flock，不调用模型/数据库/TG。
// 验收：重复事件不重复处理；写入恢复只核对；通知恢复不重新写记忆；中止后任务保留。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const requirePi = createRequire(new URL("../../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url));
const { createJiti } = requirePi("jiti");
const jiti = createJiti(import.meta.url, { fsCache: false });
const { MemoryTasks, TaskFailure } = await jiti.import("../../.pi/extensions/memory/autosediment/tasks.ts");
const temp = fs.mkdtempSync(path.resolve(".cache/tmp/memory-recovery-"));
const workers = [];
let serial = 0;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function records(directory) {
  return fs.readdirSync(directory).filter(name => name.endsWith(".json")).map(name => ({
    file: path.join(directory, name),
    task: JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")),
  }));
}
async function waitState(directory, state) {
  for (let index = 0; index < 400; index++) {
    const found = records(directory).find(entry => entry.task.state === state);
    if (found) {
      return found;
    }
    await delay(10);
  }
  throw new Error(`State not reached: ${state}`);
}
function fixture(overrides = {}, directory) {
  directory ??= path.join(temp, String(serial++));
  const counts = { filter: 0, write: 0, verify: 0, notify: 0 };
  const operations = {
    async filter() {
      counts.filter++;
      return { save: true, memory: "fact", reason: "fixture" };
    },
    async write() {
      counts.write++;
      return { status: "completed", ids: ["full-memory-id"] };
    },
    async verify() {
      counts.verify++;
      return { status: "completed", ids: ["full-memory-id"] };
    },
    async notify() {
      counts.notify++;
      return { status: "sent", ids: [10] };
    },
    record() {},
    ...overrides,
  };
  const worker = new MemoryTasks(directory, operations);
  workers.push(worker);
  const input = { sessionId: "session", sessionFile: "fixture", sourceMessage: "message", text: "fact" };
  return { directory, counts, operations, worker, input };
}
try {
  const normal = fixture();
  normal.worker.enqueue(normal.input);
  normal.worker.enqueue(normal.input);
  assert.equal(records(normal.directory).length, 1);
  await normal.worker.start("session");
  await waitState(normal.directory, "notified");
  assert.deepEqual(normal.counts, { filter: 1, write: 1, verify: 0, notify: 1 });
  assert.equal(fs.statSync(records(normal.directory)[0].file).mode & 0o777, 0o600);
  await normal.worker.stop();

  const retry = fixture();
  retry.operations.filter = async () => {
    retry.counts.filter++;
    if (retry.counts.filter === 1) {
      throw new TaskFailure("filter_timeout", true);
    }
    return { save: false, memory: "", reason: "not worth saving" };
  };
  retry.worker.enqueue(retry.input);
  await retry.worker.start("session");
  const failed = await waitState(retry.directory, "filter_failed");
  failed.task.nextAt = 0;
  fs.writeFileSync(failed.file, JSON.stringify(failed.task));
  await waitState(retry.directory, "rejected");
  assert.equal(retry.counts.filter, 2);
  assert.equal(retry.counts.write, 0);
  await retry.worker.stop();

  const blocked = fixture({
    async filter() {
      throw new TaskFailure("credentials_invalid");
    },
  });
  blocked.worker.enqueue(blocked.input);
  await blocked.worker.start("session");
  await waitState(blocked.directory, "filter_blocked");
  assert.equal(blocked.counts.write, 0);
  await blocked.worker.stop();

  for (const known of [true, false]) {
    const recovery = fixture({
      async verify() {
        return {
          status: known ? "completed" : "unknown",
          ids: known ? ["saved"] : [],
          matches: known ? [] : ["partial"],
        };
      },
    });
    recovery.worker.enqueue(recovery.input);
    const entry = records(recovery.directory)[0];
    entry.task.state = "writing";
    entry.task.memory = "fact";
    fs.writeFileSync(entry.file, JSON.stringify(entry.task));
    await recovery.worker.start("session");
    await waitState(recovery.directory, known ? "notified" : "write_needs_review");
    assert.equal(recovery.counts.write, 0);
    assert.equal(recovery.counts.filter, 0);
    await recovery.worker.stop();
  }

  const notification = fixture();
  notification.operations.notify = async () => {
    notification.counts.notify++;
    return { status: notification.counts.notify === 1 ? "retry" : "sent" };
  };
  notification.worker.enqueue(notification.input);
  await notification.worker.start("session");
  const notifyFailed = await waitState(notification.directory, "notification_failed");
  notifyFailed.task.nextAt = 0;
  fs.writeFileSync(notifyFailed.file, JSON.stringify(notifyFailed.task));
  await waitState(notification.directory, "notified");
  assert.equal(notification.counts.write, 1);
  assert.equal(notification.counts.notify, 2);
  await notification.worker.stop();

  const notifyUnknown = fixture();
  notifyUnknown.worker.enqueue(notifyUnknown.input);
  const entry = records(notifyUnknown.directory)[0];
  entry.task.state = "notifying";
  fs.writeFileSync(entry.file, JSON.stringify(entry.task));
  await notifyUnknown.worker.start("session");
  await waitState(notifyUnknown.directory, "notification_unknown");
  assert.equal(notifyUnknown.counts.notify, 0);
  await notifyUnknown.worker.stop();

  const aborted = fixture({
    async filter(task, signal) {
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new TaskFailure("aborted", true)), { once: true });
      });
    },
  });
  aborted.worker.enqueue(aborted.input);
  await aborted.worker.start("session");
  await waitState(aborted.directory, "filtering");
  await aborted.worker.stop();
  await waitState(aborted.directory, "pending_filter");

  const exhausted = fixture();
  exhausted.worker.enqueue(exhausted.input);
  const exhaustedEntry = records(exhausted.directory)[0];
  exhaustedEntry.task.filterAttempts = 3;
  fs.writeFileSync(exhaustedEntry.file, JSON.stringify(exhaustedEntry.task));
  await exhausted.worker.start("session");
  await waitState(exhausted.directory, "filter_blocked");
  assert.equal(exhausted.counts.filter, 0);
  await exhausted.worker.stop();

  const previousSession = fixture();
  previousSession.worker.enqueue(previousSession.input);
  await previousSession.worker.start("another-session");
  await waitState(previousSession.directory, "saved");
  assert.equal(previousSession.counts.notify, 0);
  await previousSession.worker.stop();
  await previousSession.worker.start("session");
  await waitState(previousSession.directory, "notified");
  assert.equal(previousSession.counts.write, 1);
  await previousSession.worker.stop();

  const owner = fixture();
  await owner.worker.start("session");
  await delay(150);
  const follower = fixture({}, owner.directory);
  follower.worker.enqueue(follower.input);
  await follower.worker.start("session");
  await delay(200);
  assert.equal(follower.counts.filter, 0);
  await owner.worker.stop();
  await waitState(follower.directory, "notified");
  assert.equal(follower.counts.write, 1);
  await follower.worker.stop();
  console.log("PASS durable tasks, retry/recovery, notification isolation and exclusive worker");
} finally {
  for (const worker of workers) {
    await worker.stop();
  }
  fs.rmSync(temp, { recursive: true, force: true });
}
