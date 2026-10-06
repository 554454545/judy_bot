// Exercise the installed Pi and bridge with synthetic input, a fake model and sender.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = path.join(root, ".cache", "tmp");
fs.mkdirSync(temporaryRoot, { recursive: true });
const temporary = fs.mkdtempSync(path.join(temporaryRoot, "telegram-frontline-"));
process.env.PI_CODING_AGENT_DIR = path.join(temporary, "agent");
process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";
globalThis.fetch = () => { throw new Error("Network disabled in offline verification"); };

let session;
let extensionRuntime;
try {
  const host = path.join(root, "node_modules/@earendil-works/pi-coding-agent");
  const bridge = path.join(root, ".pi/npm/node_modules/@llblab/pi-telegram");
  assert.equal(JSON.parse(fs.readFileSync(path.join(host, "package.json"))).version, "0.84.1");
  assert.equal(JSON.parse(fs.readFileSync(path.join(bridge, "package.json"))).version, "0.27.12");

  const { loadExtensions } = await import(path.join(host, "dist/core/extensions/loader.js"));
  const loaded = await loadExtensions([path.join(bridge, "index.ts")], root);
  extensionRuntime = loaded.runtime;
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  for (const name of ["telegram-setup", "telegram-connect", "telegram-disconnect", "telegram-status"]) {
    assert(loaded.extensions[0].commands.has(name), `Missing connection command: ${name}`);
  }

  // Use Pi's existing TS loader dependency and legacy TypeBox mapping; no extra packages.
  const require = createRequire(path.join(host, "package.json"));
  const coreEntry = path.join(host, "node_modules/@earendil-works/pi-agent-core/dist/index.js");
  const aiEntry = path.join(host, "node_modules/@earendil-works/pi-ai/dist/compat.js");
  const { createJiti } = await import(require.resolve("jiti"));
  const jiti = createJiti(import.meta.url, {
    fsCache: false,
    alias: {
      "@sinclair/typebox": require.resolve("typebox"),
      "@earendil-works/pi-agent-core": coreEntry,
      "@earendil-works/pi-ai": aiEntry,
      "@earendil-works/pi-coding-agent": path.join(host, "dist/index.js"),
    },
  });
  const { executeTelegramUpdate } = await jiti.import(path.join(bridge, "lib/updates.ts"));
  const { handleTelegramAgentEndRuntime } = await jiti.import(path.join(bridge, "lib/queue.ts"));
  const { createTelegramConfigStore } = await jiti.import(path.join(bridge, "lib/config.ts"));
  const { resolveTelegramConfigPath, resolveTelegramTempDir } = await jiti.import(path.join(bridge, "lib/paths.ts"));
  assert.equal(resolveTelegramConfigPath(), path.join(temporary, "agent/telegram.json"));
  assert.equal(resolveTelegramTempDir(), path.join(temporary, "agent/tmp/telegram"));
  const config = createTelegramConfigStore({ initialConfig: {
    profiles: { personal: { botToken: "synthetic-token", allowedUserId: 123 } },
    assistant: { rendering: "html", activity: "quiet", proactivePush: false },
  }});
  assert(config.activateProfile("personal"));
  await config.persist();
  assert.equal(config.getAllowedUserId(), 123);
  assert.equal(fs.statSync(resolveTelegramConfigPath()).mode & 0o777, 0o600);

  const { Agent } = await import(coreEntry);
  const { AssistantMessageEventStream } = await import(aiEntry);
  const { AgentSession } = await import(path.join(host, "dist/core/agent-session.js"));
  const { SessionManager } = await import(path.join(host, "dist/core/session-manager.js"));
  const { SettingsManager } = await import(path.join(host, "dist/core/settings-manager.js"));
  let modelCalls = 0;
  let toolCalls = 0;
  const usage = {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const model = {
    id: "synthetic", name: "synthetic", api: "synthetic", provider: "synthetic",
    baseUrl: "", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 1000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const agent = new Agent({
    initialState: { model, tools: [{
      name: "synthetic_tool", description: "Offline tool fixture",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        toolCalls++;
        return { content: [{ type: "text", text: "synthetic tool result" }] };
      },
    }] },
    streamFn: () => {
      modelCalls++;
      assert(modelCalls <= 4, "Unexpected extra model invocation");
      const isToolCall = modelCalls % 2 === 1;
      const message = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), usage, stopReason: isToolCall ? "toolUse" : "stop",
        content: isToolCall
          ? [{ type: "toolCall", id: `tool-${modelCalls}`, name: "synthetic_tool", arguments: {} }]
          : [{ type: "text", text: "TG_PI_OFFLINE_OK" }],
      };
      const stream = new AssistantMessageEventStream();
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: message.stopReason, message });
      return stream;
    },
  });
  // Keep real core execution and session persistence, disable resource/provider discovery.
  class OfflineSession extends AgentSession {
    _buildRuntime() {
      this._extensionRunner = {
        invalidate() {}, hasHandlers: () => false,
        emit: async () => {}, emitBeforeAgentStart: async () => {},
        emitMessageEnd: async () => {},
      };
    }
    _installAgentToolHooks() {}
    _installAgentNextTurnRefresh() {}
    async _checkCompaction() { return false; }
  }
  session = new OfflineSession({
    agent, sessionManager: SessionManager.inMemory(), cwd: temporary,
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
    modelRuntime: { hasConfiguredAuth: () => true },
    resourceLoader: { getPromptTemplates: () => [], getPrompts: () => [] },
  });

  const finalReplies = [];
  const deniedReplies = [];
  const noop = () => {};
  const rejectUnexpected = () => { throw new Error("Unexpected non-text route"); };
  const ports = {
    ctx: {}, pairTelegramUserIfNeeded: async () => false,
    sendTextReply: async (...args) => deniedReplies.push(args),
    handleAuthorizedTelegramMessage: async message => {
      await session.sendUserMessage(message.text);
      const assistant = session.messages.at(-1);
      assert.equal(assistant.role, "assistant");
      await handleTelegramAgentEndRuntime({
        turn: { chatId: message.chat.id, replyToMessageId: message.message_id,
          target: { chatId: message.chat.id }, queuedAttachments: [] },
        assistant: { text: assistant.content.map(block => block.text ?? "").join(""), stopReason: assistant.stopReason },
        foldQueuedPromptsIntoHistory: false,
        resetRuntimeState: noop, updateStatus: noop, dispatchNextQueuedTelegramTurn: noop,
        clearPreview: async () => {}, setPreviewPendingText: noop,
        finalizeMarkdownPreview: async () => false, sendQueuedAttachments: async () => {},
        sendMarkdownReply: async (chatId, replyId, text) => finalReplies.push({ chatId, replyId, text }),
        sendTextReply: rejectUnexpected,
      });
    },
    handleAuthorizedTelegramEditedMessage: rejectUnexpected,
    handleAuthorizedTelegramCallbackQuery: rejectUnexpected,
    handleAuthorizedTelegramReactionUpdate: rejectUnexpected,
  };
  const update = (userId, messageId) => ({ update_id: messageId, message: {
    message_id: messageId, chat: { id: userId, type: "private" },
    from: { id: userId, is_bot: false, first_name: "Synthetic" }, text: "synthetic request",
  } });
  await executeTelegramUpdate(update(456, 100), 123, ports);
  assert.equal(modelCalls, 0, "Unauthorized input reached Pi");
  for (const messageId of [101, 102]) {
    await executeTelegramUpdate(update(123, messageId), 123, ports);
  }
  assert.equal(modelCalls, 4);
  assert.equal(toolCalls, 2);
  assert.deepEqual(finalReplies, [101, 102].map(replyId => ({ chatId: 123, replyId, text: "TG_PI_OFFLINE_OK" })));
  assert.equal(session.messages.filter(message => message.role === "user").length, 2);
  console.log("PASS: local bridge loading, private paths, authorization, Pi tool execution and one final reply per request.");
  console.log("Real Telegram messages: 0. Real model requests: 0. Polling and live credentials are not exercised.");
} finally {
  session?.dispose();
  extensionRuntime?.invalidate("Offline verification completed");
  fs.rmSync(temporary, { recursive: true, force: true });
}
