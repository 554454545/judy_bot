// 模型请求观测入口：记录私有上下文快照、回复与用量；项目时间使用北京时间。
import { beijingIsoTime } from "../../src/time/beijing.ts";
import type { ExtensionAPI, ExtensionContext, BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { registerTelegramTurnObservability } from "./telegram-turn/index.ts";

function fingerprint(text: string) {
  return { chars: text.length, sha256: createHash("sha256").update(text).digest("hex") };
}

function summarizeMessages(messages: any[]) {
  return messages.map(message => ({
    role: message.role,
    ...(message.customType ? { customType: message.customType } : {}),
    ...(message.toolName ? { toolName: message.toolName } : {}),
    blocks: typeof message.content === "string"
      ? [{ type: "text", ...fingerprint(message.content) }]
      : (Array.isArray(message.content) ? message.content : []).map((block: any) => ({
          type: block.type,
          ...(typeof block.text === "string" ? fingerprint(block.text) : {}),
          ...(block.type === "toolCall" ? { toolName: block.name } : {}),
        })),
  }));
}

function summarizeOptions(options: BuildSystemPromptOptions) {
  return {
    customPrompt: fingerprint(options.customPrompt ?? ""),
    appendSystemPrompt: fingerprint(options.appendSystemPrompt ?? ""),
    contextFiles: (options.contextFiles ?? []).map(file => ({ path: file.path, ...fingerprint(file.content) })),
    skills: (options.skills ?? []).map(skill => ({ name: skill.name, filePath: skill.filePath })),
    selectedTools: options.selectedTools ?? [],
    toolSnippetNames: Object.keys(options.toolSnippets ?? {}),
    guidelineCount: options.promptGuidelines?.length ?? 0,
  };
}

function launchSelection() {
  const extensions: string[] = [];
  const appendedFiles: string[] = [];
  const switches: string[] = [];
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if ((arg === "-e" || arg === "--extension") && process.argv[i + 1]) extensions.push(process.argv[++i]);
    else if (arg === "--append-system-prompt" && process.argv[i + 1]) {
      const value = process.argv[++i];
      // This launcher passes absolute file paths. Never log literal prompt text.
      if (value.startsWith("/")) {
        try { if (statSync(value).isFile()) appendedFiles.push(value); } catch {}
      }
    } else if (["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"].includes(arg)) switches.push(arg);
  }
  return { requestedExtensions: extensions, requestedAppendFiles: appendedFiles, discoverySwitches: switches };
}

function captureReplacer(key: string, value: unknown) {
  if (/^(authorization|proxy[-_]authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|bot[-_]?token|secret|password)$/i.test(key)) return "[REDACTED]";
  if (typeof value !== "string") return value;
  if (value.startsWith("data:")) return { omitted: "data-url", ...fingerprint(value) };
  return value
    .replace(/\bsk[-_][A-Za-z0-9_-]{8,}/g, "[REDACTED]")
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]")
    .replace(/\bBearer\s+[^\s"']+/gi, "Bearer [REDACTED]");
}

export default function observability(pi: ExtensionAPI) {
  // No HOME fallback: the launcher must explicitly select a project agent directory.
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  if (!agentDir) throw new Error("Observability requires PI_CODING_AGENT_DIR");
  const base = join(resolve(agentDir), "observability");
  const runtimeId = randomUUID();
  const startedAt = beijingIsoTime();
  let turn = 0;
  let request = 0;
  let activeRequest: { id: string; file: string; model: any } | undefined;
  let warned = false;
  let lastOptions: ReturnType<typeof summarizeOptions> | undefined;
  let lastContext: ReturnType<typeof summarizeMessages> = [];
  let state: Record<string, any> = {};
  const toolStarts = new Map<string, number>();
  let telegramTurns: ReturnType<typeof registerTelegramTurnObservability>;

  function paths(ctx: ExtensionContext) {
    const sessionId = ctx.sessionManager.getSessionId();
    const instant = new Date(ctx.sessionManager.getHeader()?.timestamp ?? startedAt);
    const timestamp = new Date(instant.getTime() + 8 * 60 * 60 * 1000)
      .toISOString()
      .replace("Z", "+08-00")
      .replace(/[:.]/g, "-");
    return { directory: base, file: join(base, `${timestamp}_${sessionId}.jsonl`) };
  }

  function reportFailure(ctx: ExtensionContext, error: any) {
    state.observerError = error?.code ?? "OBSERVABILITY_WRITE_FAILED";
    if (!warned) {
      warned = true;
      if (ctx.hasUI) {
        ctx.ui.notify(`观测记录失败：${state.observerError}；对话继续运行。`, "warning");
      } else {
        console.error(`Observability write failed: ${state.observerError}; conversation continues.`);
      }
    }
  }

  function record(stage: string, details: Record<string, any>, ctx: ExtensionContext) {
    try {
      telegramTurns?.observe(stage, details, ctx);
      const files = paths(ctx);
      mkdirSync(files.directory, { recursive: true, mode: 0o700 });
      const common = {
        schemaVersion: 3, at: beijingIsoTime(), pid: process.pid, runtimeId,
        sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile() ?? null,
        turn, request,
        telegramTurnId: details.telegramTurnId ?? telegramTurns?.turnId ?? null,
      };
      state = {
        ...state, ...common, lastStage: stage, mode: ctx.mode, cwd: ctx.cwd,
        model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id, api: ctx.model.api } : null,
        activeTools: pi.getActiveTools(), captureMode: "every-request", recordFile: files.file,
      };
      const event = { ...common, stage, ...details, state };
      appendFileSync(files.file, JSON.stringify(event, captureReplacer) + "\n", { mode: 0o600 });
      chmodSync(files.file, 0o600);
    } catch (error) { reportFailure(ctx, error); }
  }

  // TG 全链路沿用本入口的私有 session JSONL；具体事件与统计集中在 telegram-turn/。
  telegramTurns = registerTelegramTurnObservability(pi, record, ctx => paths(ctx).file);

  pi.on("session_start", (event, ctx) => {
    turn = 0; request = 0; activeRequest = undefined; lastOptions = undefined; lastContext = []; toolStarts.clear();
    state = {
      launch: launchSelection(),
      registeredCommands: pi.getCommands().map(command => ({ name: command.name, source: command.source, path: command.path })),
      systemPrompt: fingerprint(ctx.getSystemPrompt()),
    };
    record("session_start", { reason: event.reason }, ctx);
  });
  pi.on("resources_discover", (event, ctx) => { record("resources_discover", { reason: event.reason }, ctx); });
  pi.on("input", (event, ctx) => { record("input", { source: event.source, text: fingerprint(event.text), imageCount: event.images?.length ?? 0 }, ctx); });
  pi.on("before_agent_start", (event, ctx) => {
    turn++;
    delete state.lastOutcome; delete state.httpStatus; delete state.providerPayload;
    lastContext = []; state.contextMessages = [];
    lastOptions = summarizeOptions(event.systemPromptOptions);
    state.promptSources = lastOptions;
    state.systemPrompt = fingerprint(event.systemPrompt);
    record("before_agent_start", { systemPrompt: state.systemPrompt, promptSources: lastOptions, expandedInput: fingerprint(event.prompt) }, ctx);
  });
  pi.on("context", (event, ctx) => {
    lastContext = summarizeMessages(event.messages);
    state.contextMessages = lastContext;
    state.systemPrompt = fingerprint(ctx.getSystemPrompt());
    record("context", { messages: lastContext, systemPrompt: state.systemPrompt }, ctx);
  });
  pi.on("before_provider_request", (event, ctx) => {
    request++;
    delete state.httpStatus;
    const payload: any = event.payload;
    const serialized = JSON.stringify(payload) ?? "";
    state.providerPayload = {
      ...fingerprint(serialized), keys: payload && typeof payload === "object" ? Object.keys(payload) : [],
      messages: Array.isArray(payload?.messages) ? summarizeMessages(payload.messages) : [],
      inputItemCount: Array.isArray(payload?.input) ? payload.input.length : undefined,
      toolCount: Array.isArray(payload?.tools) ? payload.tools.length : undefined,
    };
    record("before_provider_request", { payload: state.providerPayload }, ctx);
    activeRequest = undefined;
    try {
      const id = randomUUID();
      const file = paths(ctx).file;
      const model = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id, api: ctx.model.api,
        catalogCostPerMillionTokens: ctx.model.cost } : null;
      activeRequest = { id, file, model };
      state.requestId = id;
      record("request", {
        schemaVersion: 3, requestId: id, at: beijingIsoTime(), runtimeId,
        sessionId: ctx.sessionManager.getSessionId(), turn, request, model,
        observation: {
          stage: "before_provider_request", piVersion: "0.84.1",
          scope: "Provider payload passed to SDK, not HTTP bytes or proof of receipt; internal retries may reuse it",
          transformations: ["common credential fields and strings redacted", "data URLs omitted with fingerprint"],
          truncation: "No text truncation; binary data URLs omitted",
        },
        systemPrompt: ctx.getSystemPrompt(), promptSources: lastOptions,
        contextMessages: lastContext, providerPayload: payload,
      }, ctx);
    } catch (error) { reportFailure(ctx, error); }
    // Returning nothing leaves the real provider request unchanged.
  });
  pi.on("after_provider_response", (event, ctx) => { state.httpStatus = event.status; record("after_provider_response", { status: event.status, requestId: activeRequest?.id ?? null }, ctx); });
  pi.on("tool_execution_start", (event, ctx) => {
    toolStarts.set(event.toolCallId, performance.now());
    record("tool_execution_start", { requestId: state.requestId ?? null, toolName: event.toolName, toolCallId: event.toolCallId }, ctx);
  });
  pi.on("tool_execution_end", (event, ctx) => {
    const start = toolStarts.get(event.toolCallId); toolStarts.delete(event.toolCallId);
    record("tool_execution_end", { requestId: state.requestId ?? null, toolName: event.toolName, toolCallId: event.toolCallId, isError: event.isError, durationMs: start === undefined ? null : performance.now() - start }, ctx);
  });
  pi.on("message_end", (event, ctx) => {
    const message: any = event.message;
    if (message.role !== "assistant") return;
    state.lastOutcome = { stopReason: message.stopReason, usage: message.usage };
    const pending = activeRequest;
    activeRequest = undefined;
    if (pending) {
      try {
        const evidence = telegramTurns.rawUsage(message);
        record("response", {
          schemaVersion: 3, requestId: pending.id,
          at: beijingIsoTime(), runtimeId, sessionId: ctx.sessionManager.getSessionId(),
          turn, request, model: pending.model, httpStatus: state.httpStatus ?? null,
          assistantMessage: message,
          providerResponseMetadata: evidence?.responseMetadata ?? null,
          accounting: {
            source: evidence ? "provider raw usage + Pi normalized response usage" : "Pi normalized response usage",
            providerRawUsage: evidence?.rawUsage ?? null,
            providerUsageProtocol: evidence?.protocol ?? null,
            cacheFieldPresence: evidence
              ? "See providerRawUsage; absent fields remain unknown in Telegram statistics"
              : "unknown: Pi defaults absent provider cache counters to zero",
            normalizedUsage: message.usage ?? null,
            estimatedCost: message.usage?.cost ?? null,
            priceSource: "Pi model catalog captured in request; USD per million tokens; not provider bill",
            formula: "sum(input, output, cacheRead, cacheWrite tokens * corresponding catalog price / 1000000)",
          },
        }, ctx);
      } catch (error) { reportFailure(ctx, error); }
    }
    record("assistant_end", { ...state.lastOutcome, requestId: pending?.id ?? null }, ctx);
  });
  pi.on("agent_end", (_event, ctx) => { record("agent_end", {}, ctx); });
  pi.on("session_shutdown", (_event, ctx) => { activeRequest = undefined; record("session_shutdown", {}, ctx); });

  pi.registerCommand("observe", {
    description: "查看每次请求自动记录的上下文、回复及用量路径。",
    handler: async (args, ctx) => {
      const action = args.trim();
      if (action) {
        ctx.ui.notify("每次请求已自动记录。使用 /observe 查看状态；capture/cancel 一次性模式已移除。", "info"); return;
      }
      record("observe_command", { action: action || "status" }, ctx);
      ctx.ui.notify([
        `会话：${ctx.sessionManager.getSessionId()}`,
        `模型：${ctx.model?.provider ?? "?"}/${ctx.model?.id ?? "?"}`,
        `轮次：${turn}；请求观察点：${request}；上下文消息：${lastContext.length}`,
        `System Prompt：${state.systemPrompt?.chars ?? 0} 字符`,
        `请求快照：每次自动记录`,
        `会话记录：${paths(ctx).file}`,
        ...(state.observerError ? [`观测错误：${state.observerError}`] : []),
      ].join("\n"), "info");
    },
  });
}
