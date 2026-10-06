// 记忆上下文验证：实际 Pi SDK、inject、Codex 序列化和观测记录；假 CLI/HTTP，不访问真实模型、TG 或记忆库。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const temporary = fs.mkdtempSync(path.join(root, ".cache/tmp/memory-append-only-"));
const agentDir = path.join(temporary, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.TMPDIR = temporary;
process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";
const host = path.join(root, "node_modules/@earendil-works/pi-coding-agent");
const load = file => import(path.join(host, "dist", file));
const errors = [];
let session;
let modelCalls = 0;
let toolCalls = 0;
const fakeJwt = `fixture.${Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" },
})).toString("base64")}.fixture`;

// 只允许假供应商域名；用安装版 SSE 解析器生成真实 assistant 消息。
globalThis.fetch = async (url, options) => {
  assert(String(url).startsWith("https://fixture.invalid/"), "Unexpected network target");
  assert.equal(options.method, "POST");
  modelCalls++;
  const useTool = modelCalls === 1;
  const item = useTool
    ? { type: "function_call", id: "fc_fixture_lookup", call_id: "call_fixture_lookup", name: "fixture_lookup", arguments: "{}" }
    : { type: "message", id: `msg_fixture_${modelCalls}`, role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "2", annotations: [] }] };
  const events = [
    { type: "response.created", response: { id: `resp_fixture_${modelCalls}` } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    ...(useTool ? [] : [{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "2" }]),
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: {
      id: `resp_fixture_${modelCalls}`, status: "completed", output: [item],
      usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5, total_tokens: 105 },
    } },
  ];
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200, headers: { "content-type": "text/event-stream" },
  });
};

try {
  const { createAgentSession } = await load("core/sdk.js");
  const { DefaultResourceLoader } = await load("core/resource-loader.js");
  const { ModelRuntime } = await load("core/model-runtime.js");
  const { AuthStorage } = await load("core/auth-storage.js");
  const { SettingsManager } = await load("core/settings-manager.js");
  const { SessionManager } = await load("core/session-manager.js");
  const { AgentSessionRuntime } = await load("core/agent-session-runtime.js");
  const codex = await import(path.join(host, "node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js"));

  const staticFile = path.join(temporary, "memory.md");
  fs.writeFileSync(staticFile, "## 好习惯\n保持简洁\n## 基本信息\n静态事实\n");
  const cli = path.join(temporary, "recall.mjs");
  fs.writeFileSync(cli, `// 假 mem0 CLI：不同问题给不同分数，空结果与进程失败用于验证降级。
    const query = process.argv[3];
    if (query.includes('FAIL')) process.exit(1);
    if (!query.includes('EMPTY')) console.log(query.includes('Q2')
      ? '[bbbb] (score=0.92) 本轮资料 B'
      : '[aaaa] (score=0.51) 本轮资料 A');
  `);
  const recapDir = path.join(temporary, "recaps");
  fs.mkdirSync(recapDir);
  const pathsFixture = path.join(temporary, "paths.ts");
  fs.writeFileSync(pathsFixture, `// 测试路径：所有数据均隔离在项目临时目录。
    export const MEMORY_FILES = [${JSON.stringify(staticFile)}];
    export const MEM0_CLI = ${JSON.stringify(cli)};
    export const MEM0_PYTHON = ${JSON.stringify(process.execPath)};
    export const PROJECT_ROOT = ${JSON.stringify(temporary)};
    export const RECAPS_DIR = ${JSON.stringify(recapDir)};
  `);
  // 执行实际 inject 内容，仅替换路径依赖，不改变其召回、排序或注入逻辑。
  const sourceFile = path.join(temporary, "inject.ts");
  let source = fs.readFileSync(path.join(root, ".pi/extensions/memory/inject/index.ts"), "utf8");
  source = source.replace('"../../../../src/context/system-prompt.ts"', JSON.stringify(path.join(root, "src/context/system-prompt.ts")));
  source = source.replace('"../../../../src/observability/memory.ts"', JSON.stringify(path.join(root, "src/observability/memory.ts")));
  source = source.replace('"../paths.ts"', JSON.stringify(pathsFixture));
  fs.writeFileSync(sourceFile, source);
  const fixture = path.join(temporary, "extension.ts");
  fs.writeFileSync(fixture, `// 测试入口：加载实际记忆来源及离线工具。
    import memory from ${JSON.stringify(sourceFile)};
    export default function(pi) {
      memory(pi);
      pi.registerTool({ name:'fixture_lookup', label:'Fixture', description:'Offline fixture',
        parameters:{ type:'object', properties:{} }, execute:async()=>({ content:[{ type:'text',text:'TOOL_RESULT' }] }) });
    }
  `);
  const runtime = await ModelRuntime.create({
    credentials: AuthStorage.inMemory({ fixture: { type: "api_key", key: fakeJwt } }),
    modelsPath: null, modelsStorePath: path.join(temporary, "models-store.json"), refreshOnCreate: false,
  });
  runtime.registerProvider("fixture", {
    baseUrl: "https://fixture.invalid", api: "openai-codex-responses",
    models: [{ id: "synthetic", name: "Synthetic", reasoning: false, input: ["text"],
      contextWindow: 100000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  });
  runtime.streamSimple = (model, context, options) => codex.streamSimple(model, context, {
    ...options, apiKey: fakeJwt, transport: "sse", maxRetries: 0,
  });
  const create = async ({ sessionManager, sessionStartEvent }) => {
    const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
    const loader = new DefaultResourceLoader({
      cwd: temporary, agentDir, settingsManager: settings,
      noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
      additionalExtensionPaths: [fixture, path.join(root, "extensions/context/index.ts"), path.join(root, "extensions/observability/index.ts")],
    });
    await loader.reload({ resolveProjectTrust: async () => true });
    assert.deepEqual(loader.getExtensions().errors, []);
    const result = await createAgentSession({
      cwd: temporary, agentDir, modelRuntime: runtime, model: runtime.getModel("fixture", "synthetic"),
      resourceLoader: loader, settingsManager: settings, tools: ["fixture_lookup"], sessionManager, sessionStartEvent,
    });
    result.session.subscribe(event => {
      if (event.type === "tool_execution_start") toolCalls++;
    });
    return { ...result, services: { cwd: temporary, agentDir }, diagnostics: [] };
  };
  const initial = await create({ sessionManager: SessionManager.create(temporary, path.join(agentDir, "sessions")) });
  const hostRuntime = new AgentSessionRuntime(initial.session, initial.services, create);
  const bind = async current => {
    session = current;
    await current.bindExtensions({ onError: error => errors.push(error), mode: "rpc" });
  };
  hostRuntime.setRebindSession(bind);
  await bind(hostRuntime.session);
  const records = () => {
    const files = fs.readdirSync(path.join(agentDir, "observability"));
    return files.flatMap(file => fs.readFileSync(path.join(agentDir, "observability", file), "utf8").trim().split("\n").map(JSON.parse));
  };
  const requests = () => records().filter(record => record.stage === "request");
  const assertPrefix = (oldRequest, nextRequest) => {
    const old = oldRequest.providerPayload;
    const next = nextRequest.providerPayload;
    assert.equal(next.instructions, old.instructions, "System Prompt changed across rounds");
    assert.deepEqual(next.input.slice(0, old.input.length), old.input, "Earlier provider input was rewritten");
    assert.deepEqual(next.tools, old.tools);
  };

  await session.sendUserMessage("Q1: 1 + 1 = ?");
  assert.equal(toolCalls, 1);
  assert.equal(requests().length, 2);
  const first = requests()[0];
  const toolFollowup = requests()[1];
  assertPrefix(first, toolFollowup);
  assert(first.providerPayload.instructions.includes("静态事实"));
  assert(!first.providerPayload.instructions.includes("<recalled-memory>"));
  assert(first.providerPayload.input.at(-2).content[0].text.includes("Q1"));
  assert(first.providerPayload.input.at(-1).content[0].text.includes("本轮资料 A"));
  assert.equal(toolFollowup.providerPayload.input.filter(item => JSON.stringify(item).includes("本轮资料 A")).length, 1);
  const firstMemory = session.messages.find(message => message.role === "custom");
  assert.equal(firstMemory.customType, "memory-recall");
  assert.equal(firstMemory.display, false);
  assert(firstMemory.content.includes("0.51"));
  assert(fs.readFileSync(session.sessionFile, "utf8").includes("memory-recall"));
  await session.sendUserMessage("Q2: 2 + 2 = ?");
  const second = requests().at(-1);
  assertPrefix(toolFollowup, second);
  assert(second.providerPayload.input.at(-1).content[0].text.includes("0.92"));
  assert(second.providerPayload.input.some(item => JSON.stringify(item).includes("0.51")));
  assert.equal(session.messages.filter(message => message.role === "custom").length, 2);

  await session.sendUserMessage("EMPTY: 1 + 1 = ?");
  const empty = requests().at(-1);
  assertPrefix(second, empty);
  assert.equal(session.messages.filter(message => message.role === "custom").length, 2);
  await session.sendUserMessage("FAIL: 1 + 1 = ?");
  const failure = requests().at(-1);
  assertPrefix(empty, failure);
  assert.equal(session.messages.filter(message => message.role === "custom").length, 2);

  const oldFile = session.sessionFile;
  await hostRuntime.switchSession(oldFile);
  await session.sendUserMessage("Q2 after resume");
  const resumed = requests().at(-1);
  assertPrefix(failure, resumed);
  assert.equal(session.messages.filter(message => message.role === "custom").length, 3);
  await hostRuntime.newSession();
  assert.equal(session.messages.length, 0);
  await session.sendUserMessage("Q1 fresh session");
  const fresh = requests().at(-1);
  assert.equal(fresh.providerPayload.input.length, 2);
  assert(!JSON.stringify(fresh.providerPayload.input).includes("本轮资料 B"));
  assert.equal(fresh.providerPayload.instructions, first.providerPayload.instructions);
  assert.equal(fs.readdirSync(path.join(agentDir, "observability")).length, 2);
  assert.deepEqual(errors, []);
  for (const request of requests()) {
    const observed = records().filter(record => record.requestId === request.requestId);
    const send = observed.find(record => record.stage === "provider_transport" && record.phase === "send");
    assert(send, "Missing actual provider transport observation");
    assert.deepEqual(send.providerPayload, request.providerPayload);
    const response = observed.find(record => record.stage === "response");
    assert.equal(response.providerResponseMetadata.promptCacheDiagnostics, null);
    assert.equal(response.providerResponseMetadata.promptCacheDiagnosticsPresent, false);
    assert.equal(response.providerResponseMetadata.responseId, response.assistantMessage.responseId);
  }
  const result = {
    status: "passed", at: new Date(Date.now() + 8 * 3600000).toISOString().replace("Z", "+08:00"),
    realNetworkCalls: 0, realModelCalls: 0, fakeProviderCalls: modelCalls,
    cases: ["actual inject with fake CLI", "actual Codex adapter and SSE parser", "stable instructions", "provider input append-only", "tool followup without duplicate recall", "changed recall score preserves earlier message", "empty recall", "CLI failure fallback", "native session resume", "native new session isolation", "session persistence", "per-session observation"],
    payloadEvidence: requests().map(record => ({ at: record.at, sessionId: record.sessionId, requestId: record.requestId, providerPayload: record.providerPayload })),
  };
  const directory = path.join(root, ".pi/agent/logs/memory/verification");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(directory, "append-only-context-verification.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
  console.log("PASS: actual request snapshots retain history and recall, including tools, resume and fresh session; no real network/model/TG calls.");
} finally {
  session?.dispose();
  fs.rmSync(temporary, { recursive: true, force: true });
}
