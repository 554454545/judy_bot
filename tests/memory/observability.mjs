// 离线验证记忆观测与当前 session 共用 JSONL，并保存请求/响应、usage 和脱敏后的内容。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const requirePi = createRequire(new URL("../../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url));
const { createJiti } = requirePi("jiti");
const jiti = createJiti(import.meta.url, { fsCache: false });
const { memoryObservation, recordMemoryCall } = await jiti.import("../../src/observability/memory.ts");
const temp = fs.mkdtempSync(path.resolve(".cache/tmp/memory-observation-"));
try {
  fs.mkdirSync(path.join(temp, "sessions"));
  const session = path.join(temp, "sessions/session.jsonl");
  fs.writeFileSync(session, JSON.stringify({ id: "11111111-1111-1111-1111-111111111111", timestamp: "2026-10-03T16:00:00.000Z" }) + "\n");
  const context = memoryObservation(session);
  assert.ok(context.file.endsWith("2026-10-04T00-00-00-000+08-00_11111111-1111-1111-1111-111111111111.jsonl"));
  recordMemoryCall(context, "memory_request", { requestId: "request", providerPayload: { api_key: "secret", messages: [{ content: "query" }] } });
  recordMemoryCall(context, "memory_response", { requestId: "request", rawUsage: { prompt_tokens: 12 }, cost: null });
  const rows = fs.readFileSync(context.file, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(rows[0].providerPayload.api_key, "[REDACTED]");
  assert.equal(rows[0].operationId, rows[1].operationId);
  assert.equal(rows[1].rawUsage.prompt_tokens, 12);
  assert.equal(fs.statSync(context.file).mode & 0o777, 0o600);

  // 制造 recap 目录被文件占用的错误；只操作临时目录，验证失败不会被去重吞掉。
  const blockedDirectory = path.join(temp, "recaps");
  fs.writeFileSync(blockedDirectory, "directory blocked");
  let source = fs.readFileSync(".pi/extensions/memory/recap/index.ts", "utf8");
  source = source.replace('"../../../../src/time/beijing.ts"', JSON.stringify(path.resolve("src/time/beijing.ts")));
  source = source.replace('"../../../../src/observability/memory.ts"', JSON.stringify(path.resolve("src/observability/memory.ts")));
  source = source.replace('"../../../../src/context/system-prompt.ts"', JSON.stringify(path.resolve("src/context/system-prompt.ts")));
  source = source.replace('import { RECAPS_DIR } from "../paths.ts";', `const RECAPS_DIR = ${JSON.stringify(blockedDirectory)};`);
  const fixture = path.join(temp, "recap.ts");
  fs.writeFileSync(fixture, source);
  const recap = await jiti.import(fixture);
  const handlers = new Map();
  recap.default({ on(name, handler) { handlers.set(name, handler); } });
  const event = { messages: [{ role: "assistant", content: [{ type: "text", text: "📌 状态: 已完成离线检查 | 下一步: 查看结果" }] }] };
  const ctx = { sessionManager: { getSessionFile() { return session; } } };
  const originalError = console.error;
  const diagnostics = [];
  console.error = (...args) => diagnostics.push(args.join(" "));
  try {
    assert.doesNotThrow(() => handlers.get("agent_end")(event, ctx));
    fs.unlinkSync(blockedDirectory);
    assert.doesNotThrow(() => handlers.get("agent_end")(event, ctx));
  } finally {
    console.error = originalError;
  }
  const recapErrors = fs.readFileSync(context.file, "utf8").trim().split("\n").map(JSON.parse)
    .filter(row => row.stage === "memory_recap_error");
  assert.equal(recapErrors.length, 1);
  assert.equal(recapErrors[0].sessionId, context.sessionId);
  assert.equal(recapErrors[0].source, "memory.recap");
  assert.equal(recapErrors[0].errorCode, "EEXIST");
  assert.ok(recapErrors[0].targetFile.startsWith(blockedDirectory));
  assert.equal(diagnostics.length, 1);
  assert.equal(fs.readdirSync(blockedDirectory).length, 1);
} finally {
  fs.rmSync(temp, { recursive: true });
}
console.log("PASS session-linked memory observations");
