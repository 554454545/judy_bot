// TG 管理命令验证：假重启、假日志和临时心跳；不发送 TG 消息，不重启进程，不调用模型。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const host = path.join(root, "node_modules/@earendil-works/pi-coding-agent");
const require = createRequire(path.join(host, "package.json"));
const { createJiti } = await import(require.resolve("jiti"));
const jiti = createJiti(import.meta.url, {
  fsCache: false,
  alias: {
    "@sinclair/typebox": require.resolve("typebox"),
    "@earendil-works/pi-ai": path.join(host, "node_modules/@earendil-works/pi-ai/dist/compat.js"),
    "@earendil-works/pi-agent-core": path.join(host, "node_modules/@earendil-works/pi-agent-core/dist/index.js"),
    "@earendil-works/pi-coding-agent": path.join(host, "dist/index.js"),
  },
});
const base = path.join(root, "src/telegram/commands");
const { createPiRestartCommand } = await jiti.import(path.join(base, "pi_restart.ts"));
const { createPiStatusCommand } = await jiti.import(path.join(base, "pi_status.ts"));
const { createPiLogsCommand, redactLog } = await jiti.import(path.join(base, "pi_logs.ts"));
const temporary = fs.mkdtempSync(path.join(root, ".cache/tmp/telegram-management-"));
const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
const replies = [];
const invoke = (command, args = "", reply = async text => { replies.push(text); }) => command.handler({
  name: command.name, args, reply,
  enqueuePrompt: () => { throw new Error("Commands must not call a model"); },
});
try {
  let prepared = 0;
  let executed = 0;
  const restart = createPiRestartCommand(async () => {
    prepared++;
    return async () => {
      assert(replies.some(text => text.startsWith("🔄 正在重启")));
      executed++;
    };
  });
  await invoke(restart, "bad");
  assert.equal(prepared, 0);
  await invoke(restart);
  assert.equal(executed, 0);
  await invoke(restart);
  assert.equal(prepared, 1);
  await new Promise(resolve => setTimeout(resolve, 1600));
  assert.equal(executed, 1);
  const failedReply = createPiRestartCommand(async () => async () => { executed++; });
  await assert.rejects(invoke(failedReply, "", async () => { throw new Error("No delivery"); }));
  await new Promise(resolve => setTimeout(resolve, 1600));
  assert.equal(executed, 1);

  process.env.PI_CODING_AGENT_DIR = temporary;
  fs.mkdirSync(path.join(temporary, "tmp/telegram"), { recursive: true });
  fs.writeFileSync(path.join(temporary, "tmp/telegram/owners.json"), JSON.stringify({ personal: {
    pid: 123, heartbeatMs: Date.now() - 2000,
  } }));
  const status = createPiStatusCommand(() => ({
    sessionManager: { getSessionId: () => "fixture-session" }, isIdle: () => false,
  }), () => "personal");
  await invoke(status);
  assert(replies.at(-1).includes("fixture-session"));
  assert(replies.at(-1).includes("执行中"));
  assert(replies.at(-1).includes("owner PID：123"));
  fs.writeFileSync(path.join(temporary, "tmp/telegram/owners.json"), "invalid");
  await invoke(status);
  assert(replies.at(-1).includes("心跳记录不可用"));
  const logs = createPiLogsCommand(async file => `tail:${file}`);
  await invoke(logs);
  assert(replies.at(-1).includes("restart-command.log"));
  const secret = "123456:abcdefghijklmnopqrstuvwxyzABC";
  assert(!redactLog(`url=https://api.telegram.org/bot${secret}/getMe`).includes(secret));
  assert(!redactLog('Authorization: Bearer abc-secret').includes('abc-secret'));
  assert(!redactLog('api_key="private-key"').includes('private-key'));
  console.log("Management commands passed: delayed restart, reply failure, repeated requests, status, corrupt heartbeat, log redaction.");
} finally {
  if (oldAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  }
  fs.rmSync(temporary, { recursive: true, force: true });
}
