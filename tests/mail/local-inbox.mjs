// 邮件扩展离线验证：隔离收件箱检查注册、读取、北京时间、截断和路径保护；关联 .pi/extensions/mail/index.ts。
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";
const root = process.cwd();
mkdirSync(join(root, ".cache/tmp"), { recursive: true });
const temp = mkdtempSync(join(root, ".cache/tmp/mail-test-"));
const require = createRequire(join(root, "node_modules/@earendil-works/pi-coding-agent/package.json"));
const { createJiti } = await import(require.resolve("jiti"));
try {
  const entry = join(temp, "extensions/mail/index.ts");
  mkdirSync(join(temp, "extensions/mail"), { recursive: true });
  symlinkSync(join(root, ".pi/npm"), join(temp, "npm"), "dir");
  copyFileSync(resolve(".pi/extensions/mail/index.ts"), entry);
  const jiti = createJiti(import.meta.url, { fsCache: false, alias: { typebox: require.resolve("typebox") } });
  const { default: register, createMailRuntime } = await jiti.import(entry);
  const tools = {};
  register({ on() {}, registerTool(tool) { tools[tool.name] = tool; } });
  assert.deepEqual(Object.keys(tools), ["mail_status", "mail_sync", "mail_list", "mail_read"]);
  const run = async (name, args) => (await tools[name].execute("test", args)).content[0].text;
  assert.match(await run("mail_list", {}), /mail_status/);
  const inbox = join(temp, "agent/mail/inbox");
  mkdirSync(inbox, { recursive: true });
  writeFileSync(join(inbox, "2026-10-05T10-00-00.json"), JSON.stringify({
    from: "fixture@example.invalid", subject: "样本", date: "2026-10-05T02:00:00Z", html: "<p>abcdef</p>",
  }));
  const list = await run("mail_list", {});
  assert.match(list, /2026-10-05 10:00:00\+08:00/);
  const mail = await run("mail_read", { id: "2026-10-05T10-00-00.json", maxLength: 3 });
  assert.match(mail, /abc/);
  assert.match(mail, /全文 6 字符/);
  assert.match(await run("mail_read", { id: "../outside.json" }), /找不到/);
  assert.match(await run("mail_read", { id: "2026" }), /找不到/);
  await assert.rejects(() => run("mail_list", { limit: -1 }));
  writeFileSync(join(inbox, "broken.json"), "{");
  assert.match(await run("mail_list", {}), /解析失败/);
  const configDir = join(temp, "agent/config/mail");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "accounts.json"), JSON.stringify({ accounts: [
    { id: "qq", provider: "qq", email: "test@qq.com", enabled: true },
  ] }));
  const pendingPath = join(inbox, "pending.json");
  writeFileSync(pendingPath, JSON.stringify({ account: "qq", identity: "qq:test@qq.com", notificationPending: true, from: "sender", subject: "pending", date: "2026-10-05T02:00:00Z" }));
  let succeed = false;
  let delivered = 0;
  let collections = 0;
  const runtime = createMailRuntime({
    async collect() { collections++; await Promise.resolve(); },
    async notify() { delivered++; return succeed ? { ok: true } : { ok: false, reason: "runtime-unavailable" }; },
  });
  await Promise.all([runtime.sync(), runtime.sync()]);
  assert.equal(collections, 1);
  assert.equal(JSON.parse((await import("node:fs")).readFileSync(pendingPath)).notificationPending, true);
  succeed = true;
  await runtime.sync();
  assert.equal(JSON.parse((await import("node:fs")).readFileSync(pendingPath)).notificationPending, false);
  await runtime.sync();
  assert.equal(delivered, 2);
  runtime.stop();
  console.log("Mail local inbox checks passed; no network/model calls.");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
