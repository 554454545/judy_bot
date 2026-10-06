import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const temporary = fs.mkdtempSync(path.join(root, ".cache/tmp/observability-"));
const agentDir = path.join(temporary, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.TMPDIR = temporary;
process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";
globalThis.fetch = () => { throw new Error("Network forbidden during verification"); };
const host = path.join(root, "node_modules/@earendil-works/pi-coding-agent");
const load = file => import(path.join(host, "dist", file));
let session;
let errors = [];
try {
  const { createAgentSession } = await load("core/sdk.js");
  const { DefaultResourceLoader } = await load("core/resource-loader.js");
  const { ModelRuntime } = await load("core/model-runtime.js");
  const { AuthStorage } = await load("core/auth-storage.js");
  const { SettingsManager } = await load("core/settings-manager.js");
  const { SessionManager } = await load("core/session-manager.js");
  const { AssistantMessageEventStream } = await import(path.join(host, "node_modules/@earendil-works/pi-ai/dist/compat.js"));
  const fixture = path.join(temporary, "injection.ts");
  fs.writeFileSync(fixture, `// 离线 SDK 样本：验证记忆分类顺序和实际 provider 请求，不调用网络。
    import { registerSystemSource } from ${JSON.stringify(path.join(root, "src/context/system-prompt.ts"))};
    export default function(pi) {
    registerSystemSource(pi, 'session-recap', async () => '[Session Recap] FIXTURE_RECAP_RULE');
    registerSystemSource(pi, 'personal-memory', async () => 'FIXTURE_STATIC_MEMORY');
    pi.on('before_agent_start', event => ({
      systemPrompt: event.systemPrompt + '\\nSYS_MEMORY',
      message: { customType: 'fixture-memory', content: 'CUSTOM_MEMORY', display: false }
    }));
    pi.on('context', event => ({ messages: [...event.messages,
      { role: 'user', content: [{type:'text', text:'CONTEXT_MEMORY'}], timestamp:1 }
    ] }));
    pi.on('before_provider_request', event => ({...event.payload,
      messages: event.payload.messages.map((message, i) => i===0
        ? {...message, content:message.content+'\\nPROVIDER_ONLY'} : message)
    }));
    pi.registerTool({name:'fixture_lookup', label:'Fixture', description:'Offline fixture',
      parameters:{type:'object',properties:{}}, execute:async()=>({content:[{type:'text',text:'PRIVATE_TOOL_RESULT'}]})});
  }`);
  const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd: temporary, agentDir, settingsManager: settings,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    additionalExtensionPaths: [
      fixture,
      path.join(root, "extensions/context/index.ts"),
      path.join(root, "extensions/observability/index.ts"),
    ],
    appendSystemPrompt: ["PROJECT_RULES"],
  });
  await loader.reload({ resolveProjectTrust: async () => true });
  assert.deepEqual(loader.getExtensions().errors, []);
  const runtime = await ModelRuntime.create({
    credentials: AuthStorage.inMemory({ fixture: { type: "api_key", key: "synthetic-auth" } }),
    modelsPath: null, modelsStorePath: path.join(temporary, "models-store.json"), refreshOnCreate: false,
  });
  runtime.registerProvider("fixture", {
    baseUrl: "https://fixture.invalid", api: "openai-completions",
    models: [{ id: "synthetic", name: "Synthetic", reasoning: false, input: ["text"],
      contextWindow: 100000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  });
  let requests = 0;
  runtime.streamSimple = async (model, context, options) => {
    requests++;
    assert(requests <= 5);
    const payload = {
      model: model.id, messages: [{ role: "system", content: context.systemPrompt }, ...context.messages],
      tools: context.tools, api_key: "sk-fixture-private-credential", max_tokens: 1000,
    };
    const wire = await options.onPayload(payload, model);
    assert.equal(payload.messages[0].content.includes("PROVIDER_ONLY"), false);
    assert(wire.messages[0].content.includes("SYS_MEMORY"));
    assert(wire.messages[0].content.indexOf("FIXTURE_STATIC_MEMORY") < wire.messages[0].content.indexOf("[Session Recap]"));
    assert.equal(wire.messages[0].content.split("[Session Recap]").length - 1, 1);
    assert(wire.messages[0].content.includes("PROVIDER_ONLY"));
    assert(wire.messages.some(message => JSON.stringify(message).includes("CUSTOM_MEMORY")));
    assert(wire.messages.some(message => JSON.stringify(message).includes("CONTEXT_MEMORY")));
    await options.onResponse({ status: 200, headers: { authorization: "PRIVATE_HEADER" } }, model);
    const tool = requests === 1;
    const message = {
      role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
      stopReason: tool ? "toolUse" : "stop",
      content: tool ? [{type:"toolCall",id:"lookup-1",name:"fixture_lookup",arguments:{}}] : [{type:"text",text:"OFFLINE_OK"}],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const stream = new AssistantMessageEventStream();
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason: message.stopReason, message });
    return stream;
  };
  ({ session } = await createAgentSession({
    cwd: temporary, agentDir, modelRuntime: runtime, model: runtime.getModel("fixture", "synthetic"),
    resourceLoader: loader, settingsManager: settings, tools: ["fixture_lookup"],
    sessionManager: SessionManager.create(temporary, path.join(agentDir, "sessions")),
  }));
  await session.bindExtensions({ onError: error => errors.push(error) });
  // First prompt: automatic snapshots with private metadata. No captured conversation or credential text.
  await session.sendUserMessage("PRIVATE_USER");
  const directory = path.join(agentDir, "observability");
  const timestamp = new Date(Date.parse(session.sessionManager.getHeader().timestamp) + 8 * 60 * 60 * 1000)
    .toISOString().replace("Z", "+08-00").replace(/[:.]/g, "-");
  const name = `${timestamp}_${session.sessionId}.jsonl`;
  const file = path.join(directory, name);
  const entries = () => fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
  const requestsSaved = () => entries().filter(e => e.stage === "request");
  assert.deepEqual(fs.readdirSync(directory), [name]);
  assert.equal(requestsSaved().length, 2);
  assert(JSON.stringify(requestsSaved()[1].providerPayload).includes("PRIVATE_TOOL_RESULT"));
  const metadata = JSON.stringify(entries().filter(e => !["request", "response"].includes(e.stage)));
  for (const value of ["PRIVATE_USER", "PRIVATE_HEADER", "sk-fixture-private-credential", "CUSTOM_MEMORY", "PRIVATE_TOOL_RESULT"]) assert(!metadata.includes(value));
  const persisted = fs.readFileSync(session.sessionFile, "utf8");
  assert(persisted.includes("CUSTOM_MEMORY"));
  assert(!persisted.includes("CONTEXT_MEMORY"));
  await session.prompt("/observe");
  assert.equal(requests, 2);
  await session.sendUserMessage("PRIVATE_USER_TWO");
  const capture = requestsSaved()[2];
  assert(capture.systemPrompt.includes("SYS_MEMORY"));
  assert(!capture.systemPrompt.includes("PROVIDER_ONLY"));
  assert(capture.providerPayload.messages[0].content.includes("PROVIDER_ONLY"));
  assert.equal(capture.providerPayload.api_key, "[REDACTED]");
  assert.equal(capture.providerPayload.max_tokens, 1000);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  await session.sendUserMessage("PRIVATE_USER_THREE");
  assert.equal(requestsSaved().length, 4);
  const responses = entries().filter(e => e.stage === "response");
  assert.equal(responses.length, 4);
  for (const response of responses) {
    assert(requestsSaved().some(request => request.requestId === response.requestId));
    assert.equal(response.httpStatus, 200);
    assert(response.assistantMessage.content.length);
    assert.equal(response.accounting.providerRawUsage, null);
  }
  assert.equal(entries().at(-1).state.captureMode, "every-request");
  assert(!fs.readFileSync(file, "utf8").includes("PRIVATE_HEADER"));
  assert.deepEqual(fs.readdirSync(directory), [name]);
  // A failed observer write must not turn a successful conversation into a failed one.
  const base = path.join(agentDir, "observability");
  fs.renameSync(base, base + ".saved");
  fs.writeFileSync(base, "blocked");
  await session.sendUserMessage("PRIVATE_USER_FOUR");
  assert.equal(session.messages.at(-1).content[0].text, "OFFLINE_OK");
  assert.equal(requests, 5);
  assert.deepEqual(errors, []);
  assert(fs.existsSync(session.sessionFile));
  console.log("PASS: native Pi SDK/loader, explicit memory category order, chained prompt + custom/context injection, provider boundary, tools, persistent session, metadata privacy, automatic request/response correlation and failure isolation.");
  console.log("Network requests: 0. Real model requests: 0. Live Telegram was not exercised.");
} finally {
  session?.dispose();
  fs.rmSync(temporary, { recursive: true, force: true });
}
