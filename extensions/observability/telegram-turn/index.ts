// TG 与后台交付观测：关联原始消息、主 Pi 请求及单调时间；statistics.ts 生成尾注，后台 relay 接入恢复和投递。
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beijingIsoTime } from "../../../src/time/beijing.ts";
import {
  formatFooter,
  interpretUsage,
  summarizeStages,
  summarizeCoverage,
  summarizeUsage,
  type Span,
  type UsageEvidence,
} from "./statistics.ts";

export const OBSERVER_KEY = Symbol.for("bot.observability.telegram-turn");
type Writer = (stage: string, details: Record<string, any>, ctx: ExtensionContext) => void;
type Request = {
  id: string;
  model: string;
  start: number;
  firstContentMs?: number;
  firstTextMs?: number;
  usage?: ReturnType<typeof interpretUsage>;
};
type BackgroundIdentity = {
  root: string;
  taskId: string;
  runId: string;
  eventId: string;
  details: object;
  deliveryId?: string;
};
type Turn = {
  id: string;
  bridge: any;
  messages: any[];
  origin: number;
  receivedWallMs: number;
  receivedServerMs?: number;
  sentWallMs: number | null;
  dispatched?: number;
  ctx?: ExtensionContext;
  sessionId?: string;
  spans: Span[];
  open: Map<string, { name: string; start: number; details?: Record<string, unknown> }>;
  requests: Request[];
  deliveries: Array<{ method: string; body: any; result: any; confirmedAt: string }>;
  model: string;
  window: number | null;
  thinking: string;
  tools: number;
  completed: boolean;
  lastConfirmedMono?: number;
  lastConfirmedAt?: string;
  deliveryErrors: string[];
  ackSequence: number;
  outputMessageIds: Set<number>;
  footer?: string;
  displaySummary?: {
    elapsedMs: number | null;
    senderToBotEstimateMs: number | null;
    bodyLocalElapsedMs: number | null;
    usage: ReturnType<typeof summarizeUsage>;
    context: { tokens: number | null; window: number | null };
    model: string;
    thinking: string;
    tools: number;
  };
};

export function registerTelegramTurnObservability(pi: ExtensionAPI, write: Writer, recordPath?: (ctx: ExtensionContext) => string) {
  const holder = globalThis as any;
  const previous = holder[OBSERVER_KEY];
  previous?.dispose?.();
  const deliveryScope = new AsyncLocalStorage<Turn>();
  const turns = new Map<string, Turn>();
  const rawUsages = new WeakMap<object, UsageEvidence>();
  const inbound = new Map<string, { mono: number; wall: number; serverWall?: number; updateId: number; boundary: string }>();
  const pending = new Set<Turn>();
  let active: Turn | undefined;
  let enabled = true;
  let latestContext: ExtensionContext | undefined;
  let telegramClock: { serverMs: number; mono: number } | undefined;
  let providerRequest: { id: string; ctx: ExtensionContext; start: number; attempt: number } | undefined;
  // 后台仍写现有 session JSONL；跨会话定位信息保存在已有 final-report-receipt.json 中。
  let background: {
    identity: BackgroundIdentity;
    context: ExtensionContext;
    metadata: any;
    admitted: boolean;
  } | undefined;
  let bootId: string | undefined;
  try {
    bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    // 无可核实的 boot 身份时不跨进程相减单调时间。
  }
  let telegramClockNs: bigint | undefined;

  function recordTransportError(method: string, error: any) {
    const causes = [];
    const visited = new Set();
    let current = error;
    // 只保留类型及错误 code；不保存 message、URL、headers 或请求正文。
    for (let depth = 0; current && depth < 5 && !visited.has(current); depth++) {
      visited.add(current);
      causes.push({
        name: typeof current.name === "string" && /^[A-Za-z0-9_]{1,80}$/.test(current.name) ? current.name : "Error",
        code: typeof current.code === "string" && /^[A-Za-z0-9_]{1,80}$/.test(current.code) ? current.code : null,
      });
      if (Array.isArray(current.errors)) {
        for (const item of current.errors.slice(0, 8)) {
          causes.push({
            name: typeof item?.name === "string" && /^[A-Za-z0-9_]{1,80}$/.test(item.name) ? item.name : "Error",
            code: typeof item?.code === "string" && /^[A-Za-z0-9_]{1,80}$/.test(item.code) ? item.code : null,
          });
        }
      }
      current = current.cause;
    }
    observer.runtime("transport_error", { method, causes });
  }

  function receiptPath(identity: BackgroundIdentity) {
    return path.join(identity.root, "runs", identity.taskId, identity.runId, ...(identity.deliveryId ? [identity.deliveryId] : []), "final-report-receipt.json");
  }

  function readReceipt(identity: BackgroundIdentity) {
    const file = receiptPath(identity);
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  }

  function saveMetadata(identity: BackgroundIdentity, metadata: any) {
    const file = receiptPath(identity);
    const previous = readReceipt(identity);
    // 已准备/投递的正文及显示值不可因恢复或重试而重算。
    if (previous.observability?.prepared) {
      return previous.observability;
    }
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${randomUUID()}`;
    writeFileSync(temporary, JSON.stringify({
      ...previous,
      observability: metadata,
    }, null, 2) + "\n", { mode: 0o600 });
    renameSync(temporary, file);
    return metadata;
  }

  async function* statisticsEntries(file: string) {
    const stream = createReadStream(file);
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (/"stage"\s*:\s*"(request|response|tool_execution_start|telegram_turn_start|telegram_turn_end)"/.test(line)) {
          yield JSON.parse(line);
        }
      }
    } finally {
      lines.close();
      stream.destroy();
    }
  }

  function elapsedBackground(metadata: any, boundaryNs: bigint, boundaryBoot = bootId) {
    const source = metadata.sourceClock;
    if (source?.serverCalibrated && source.bootId && source.bootId === boundaryBoot && /^\d+$/.test(source.receiveMonotonicNs ?? "")
        && Number.isFinite(source.senderToBotEstimateMs) && source.senderToBotEstimateMs >= 0) {
      const origin = BigInt(source.receiveMonotonicNs);
      if (boundaryNs >= origin) {
        return {
          elapsedMs: source.senderToBotEstimateMs + Number(boundaryNs - origin) / 1e6,
          clock: "persisted Telegram receive anchor + same-boot monotonic clock",
        };
      }
    }
    const sent = Date.parse(metadata.source?.sentAt ?? "");
    if (source && boundaryBoot === bootId && telegramClock && telegramClockNs && Number.isFinite(sent)) {
      const elapsed = telegramClock.serverMs + Number(boundaryNs - telegramClockNs) / 1e6 - sent;
      if (elapsed >= 0) {
        return {
          elapsedMs: elapsed,
          clock: "fresh Telegram HTTP Date anchor + monotonic clock",
        };
      }
    }
    return {
      elapsedMs: null,
      clock: "unknown: missing or incompatible clock evidence",
    };
  }

  function monotonicDuration(start: unknown, end: unknown) {
    if (typeof start !== "string" || typeof end !== "string" || !/^\d+$/.test(start) || !/^\d+$/.test(end)) {
      return null;
    }
    const delta = BigInt(end) - BigInt(start);
    return delta >= 0n ? Number(delta) / 1e6 : null;
  }

  async function backgroundStatistics(metadata: any, ctx: ExtensionContext, identity: BackgroundIdentity) {
    const directory = recordPath ? path.dirname(recordPath(ctx)) : undefined;
    const requests = new Map<string, any>();
    const responses = new Map<string, any>();
    const toolIds = new Set<string>();
    const segments = metadata.reviewSegments ?? [];
    const origins = metadata.originSources ?? [{
      ...metadata.source,
      recordFile: metadata.sourceRecordFile,
    }];
    const files = [...new Set<string>([...origins.map((item: any) => item.recordFile), ...segments.map((item: any) => item.recordFile)].filter(Boolean))];
    let completeEvidence = origins.every((item: any) => Boolean(item.recordFile));
    const matchedSources = new Set<any>();
    let dispatchReplyMs: number | null = null;
    let last: any;
    for (const file of files) {
      try {
        if (!directory || path.dirname(file) !== directory) {
          throw new Error("Observation file is outside this Pi observation directory");
        }
        for await (const entry of statisticsEntries(file)) {
          const origin = !entry.backgroundTask && origins.find((item: any) => file === item.recordFile
            && entry.sessionId === item.sessionId && entry.telegramTurnId === item.telegramTurnId);
          const review = entry.backgroundTask?.taskId === metadata.taskId
            && entry.backgroundTask?.runId === metadata.runId
            && segments.some((segment: any) => segment.reviewId === entry.backgroundTask.reviewId
              && segment.recordFile === file && segment.sessionId === entry.sessionId);
          if (origin && entry.stage === "telegram_turn_start"
              && entry.chatId === origin.chatId
              && entry.sourceMessageIds?.includes(origin.messageId)
              && Date.parse(entry.sentAt) === Date.parse(origin.sentAt)) {
            matchedSources.add(origin);
            // 最终耗时从最初问题开始，后续确认不能覆盖这个起点。
            if (origin.sessionId === metadata.source.sessionId && origin.telegramTurnId === metadata.source.telegramTurnId) {
              metadata.sourceClock = {
                ...entry.clockAnchor,
                serverCalibrated: Number.isFinite(Date.parse(entry.receivedServerEstimatedAt ?? "")),
                senderToBotEstimateMs: entry.senderToBotEstimateMs,
              };
            }
          }
          if (!origin && !review) {
            continue;
          }
          if (origin === origins.at(-1) && entry.stage === "telegram_turn_end" && entry.status === "delivered") {
            dispatchReplyMs = entry.summary?.elapsedMs ?? null;
          }
          if (entry.stage === "request") {
            requests.set(entry.requestId, entry);
          } else if (entry.stage === "response") {
            responses.set(entry.requestId, entry);
          } else if (entry.stage === "tool_execution_start") {
            toolIds.add(`${entry.sessionId}:${entry.requestId}:${entry.toolCallId}`);
          }
        }
      } catch {
        completeEvidence = false;
      }
    }
    // 最近验收段的文件内顺序是真实请求顺序，不按会跳变的本机墙上时间排序。
    for (const segment of segments) {
      for (const request of requests.values()) {
        if (request.backgroundTask?.reviewId === segment.reviewId) {
          last = request;
        }
      }
    }
    const usage = summarizeUsage([...requests.values()].map(request => {
      const accounting = responses.get(request.requestId)?.accounting;
      return {
        usage: interpretUsage(accounting?.providerRawUsage ? {
          rawUsage: accounting.providerRawUsage,
          protocol: accounting.providerUsageProtocol,
        } : undefined),
      };
    }));
    usage.scope = "selected originating Telegram turns + this task/run's main Pi review requests; excludes Coding Agent, memory and compaction";
    completeEvidence &&= matchedSources.size === origins.length && segments.length > 0 && Boolean(last)
      && [...requests.keys()].every(id => responses.has(id));
    if (!completeEvidence) {
      usage.uncachedInput = null;
      usage.output = null;
      usage.cacheRead = null;
    }
    const accounting = last ? responses.get(last.requestId)?.accounting : undefined;
    const lastUsage = interpretUsage(accounting?.providerRawUsage ? {
      rawUsage: accounting.providerRawUsage,
      protocol: accounting.providerUsageProtocol,
    } : undefined);
    let codingAgentMs: number | null = null;
    let codingAgentDurationSource = "Herdr supervised prompt wait (same-boot monotonic)";
    try {
      const directory = path.join(identity.root, "runs", identity.taskId, identity.runId);
      const task = JSON.parse(readFileSync(path.join(identity.root, "registry.json"), "utf8")).tasks[identity.taskId];
      const executionPath = task?.runs?.[identity.runId]?.result_path ?? path.join(directory, "result.json");
      if (path.dirname(executionPath) !== directory) {
        throw new Error("Execution evidence outside task/run directory");
      }
      const execution = JSON.parse(readFileSync(executionPath, "utf8"));
      const evidencePath = execution.herdr_evidence ?? path.join(directory, "herdr-evidence.json");
      if (path.dirname(evidencePath) !== directory) {
        throw new Error("Herdr evidence outside task/run directory");
      }
      const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
      if (execution.task_id === identity.taskId && execution.run_id === identity.runId
          && evidence.task_id === identity.taskId && evidence.run_id === identity.runId
          && execution.pid_identity?.boot_id) {
        codingAgentMs = monotonicDuration(evidence.dispatch_started_monotonic_ns, evidence.dispatch_finished_monotonic_ns);
        if (execution.exit_code_source === "herdr_late_wait_process") {
          const duration = evidence.native_completion?.payload?.duration_ms;
          codingAgentMs = Number.isFinite(duration) && duration >= 0 ? duration : null;
          codingAgentDurationSource = "Codex native task_complete.duration_ms; excludes late collection and review";
        }
      }
    } catch {
      // 明确失败或旧证据未采集时，不从墙上时间或模型文字推算执行耗时。
    }
    const boundaryNs = process.hrtime.bigint();
    return {
      ...elapsedBackground(metadata, boundaryNs),
      boundaryMonotonicNs: boundaryNs.toString(),
      usage,
      context: {
        tokens: lastUsage.inputTotal,
        window: last?.modelContextWindow ?? null,
      },
      model: last?.model ? `${last.model.provider}/${last.model.id}` : "?",
      thinking: last?.thinkingLevel ?? "?",
      tools: completeEvidence ? toolIds.size : null,
      requestIds: [...requests.keys()],
      completeEvidence,
      stages: {
        dispatchReplyMs,
        codingAgentMs,
        codingAgentDurationSource,
        reviewPreparationMs: segments.length === 1 && segments[0].bootId === bootId
          ? monotonicDuration(segments[0].monotonicNs, boundaryNs.toString())
          : null,
        scope: "dispatch is the final selected originating turn including its reply API confirmation; Coding Agent timing source is codingAgentDurationSource; review includes report preparation; ranges may overlap, do not sum",
      },
    };
  }

  function senderToBotEstimate(turn: Turn) {
    const received = turn.receivedServerMs ?? turn.receivedWallMs;
    return turn.sentWallMs !== null && received >= turn.sentWallMs
      ? received - turn.sentWallMs
      : null;
  }

  function buildSummary(turn: Turn, boundaryMono?: number) {
    const delta = senderToBotEstimate(turn);
    const last = turn.requests.at(-1);
    return {
      elapsedMs: delta !== null && delta >= 0 && boundaryMono !== undefined
        ? delta + boundaryMono - turn.origin
        : null,
      senderToBotEstimateMs: delta !== null && delta >= 0 ? delta : null,
      bodyLocalElapsedMs: boundaryMono === undefined ? null : boundaryMono - turn.origin,
      usage: summarizeUsage(turn.requests),
      context: { tokens: last?.usage?.inputTotal ?? null, window: turn.window },
      model: turn.model,
      thinking: turn.thinking,
      tools: turn.tools,
    };
  }

  function queueKey(turn: any): string {
    // The installed bridge clones queue/active objects and adds transport stamps after admission.
    // These immutable queue fields survive every clone; object identity and later-added stamps do not.
    return `${turn.chatId}:${turn.queueOrder}:${turn.replyToMessageId}`;
  }

  function record(turn: Turn, stage: string, details: Record<string, any>) {
    if (turn.ctx) {
      write(stage, { telegramTurnId: turn.id, ...details }, turn.ctx);
    }
  }

  function start(turn: Turn, key: string, name = key, details?: Record<string, unknown>) {
    if (!turn.open.has(key)) {
      turn.open.set(key, { name, start: performance.now(), details });
    }
  }

  function end(turn: Turn, key: string, status = "ok") {
    const opened = turn.open.get(key);
    if (!opened) {
      return;
    }
    turn.open.delete(key);
    const now = performance.now();
    const span = {
      name: opened.name,
      startMs: opened.start - turn.origin,
      endMs: now - turn.origin,
      durationMs: now - opened.start,
      status,
      details: opened.details,
    };
    turn.spans.push(span);
    record(turn, "telegram_span", { span });
  }

  function snapshotContext(ctx: ExtensionContext): ExtensionContext {
    const manager = ctx.sessionManager;
    const sessionId = manager.getSessionId();
    const sessionFile = manager.getSessionFile();
    const header = manager.getHeader();
    // Deferred delivery must retain its original session even if /new changes the current manager.
    return {
      ...ctx,
      sessionManager: new Proxy(manager, {
        get(target, name) {
          if (name === "getSessionId") {
            return () => sessionId;
          }
          if (name === "getSessionFile") {
            return () => sessionFile;
          }
          if (name === "getHeader") {
            return () => header;
          }
          const value = Reflect.get(target, name);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    };
  }

  function bindTurn(turn: Turn, ctx: ExtensionContext) {
    if (turn.ctx || turn.completed) {
      return;
    }
    turn.ctx = snapshotContext(ctx);
    turn.sessionId = turn.ctx.sessionManager.getSessionId();
    record(turn, "telegram_turn_start", {
      updateIds: turn.messages.map(message => inbound.get(`${message.chat.id}:${message.message_id}`)?.updateId ?? null),
      chatId: turn.bridge.chatId,
      sourceMessageIds: turn.bridge.sourceMessageIds,
      replyToMessageId: turn.bridge.replyToMessageId,
      queueOrder: turn.bridge.queueOrder,
      sentAt: turn.sentWallMs === null ? null : beijingIsoTime(turn.sentWallMs),
      receivedAt: beijingIsoTime(turn.receivedWallMs),
      receivedServerEstimatedAt: turn.receivedServerMs === undefined ? null : beijingIsoTime(turn.receivedServerMs),
      serverClockOffsetEstimateMs: turn.receivedServerMs === undefined ? null : turn.receivedServerMs - turn.receivedWallMs,
      receiveBoundaries: turn.messages.map(message => inbound.get(`${message.chat.id}:${message.message_id}`)?.boundary ?? "unknown"),
      timestampPrecisionMs: 1000,
      senderToBotEstimateMs: senderToBotEstimate(turn),
      clock: turn.receivedServerMs === undefined
        ? "Telegram message.date + local wall clock; cross-host clock offset unknown"
        : "Telegram response Date calibrated receive anchor + monotonic elapsed; second precision and network delay uncertainty",
      clockAnchor: {
        bootId: bootId ?? null,
        receiveMonotonicNs: (process.hrtime.bigint() - BigInt(Math.round((performance.now() - turn.origin) * 1e6))).toString(),
      },
    });
    for (const span of turn.spans) {
      record(turn, "telegram_span", { span });
    }
    for (const message of turn.messages) {
      inbound.delete(`${message.chat.id}:${message.message_id}`);
    }
  }

  function bind(ctx: ExtensionContext) {
    if (active) {
      bindTurn(active, ctx);
    }
  }

  function complete(turn: Turn, status: string, details: Record<string, any> = {}) {
    if (turn.completed) {
      return;
    }
    turn.completed = true;
    for (const key of [...turn.open.keys()]) {
      end(turn, key, "interrupted");
    }
    record(turn, "telegram_turn_end", {
      status,
      requestIds: turn.requests.map(request => request.id),
      usage: summarizeUsage(turn.requests),
      spans: turn.spans,
      stages: summarizeStages(turn.spans),
      ...details,
    });
    pending.delete(turn);
    turns.delete(queueKey(turn.bridge));
    if (active === turn) {
      active = undefined;
    }
  }

  const observer = {
    clock(method: string, date: string | null) {
      if (!["getUpdates", "getMe"].includes(method) || !date) {
        return;
      }
      const serverMs = Date.parse(date);
      if (Number.isFinite(serverMs)) {
        telegramClock = { serverMs, mono: performance.now() };
        telegramClockNs = process.hrtime.bigint();
      }
    },
    async beginBackgroundReview(identity: BackgroundIdentity, ctx: ExtensionContext) {
      const task = JSON.parse(readFileSync(path.join(identity.root, "registry.json"), "utf8")).tasks[identity.taskId];
      if (!task || task.run_id !== identity.runId) {
        throw new Error("Background observation task/run mismatch");
      }
      const original = task.originalRequest;
      const source = {
        sessionId: original?.sessionId,
        telegramTurnId: original?.telegram?.turnId,
        messageId: original?.telegram?.messageId,
        chatId: original?.telegram?.chatId,
        sentAt: original?.telegram?.sentAt,
      };
      const previous = readReceipt(identity).observability;
      if (previous && (previous.taskId !== identity.taskId || previous.runId !== identity.runId
          || JSON.stringify(previous.source) !== JSON.stringify(source))) {
        throw new Error("Background observation identity changed");
      }
      const file = recordPath?.(ctx);
      const observationFiles = file ? readdirSync(path.dirname(file)) : [];
      const seen = new Set<string>();
      const originSources = [original, ...(task.clarificationRequests ?? []), ...(task.revisions ?? []).map((item: any) => item.request)]
        .filter(Boolean)
        .map((item: any) => ({
          sessionId: item.sessionId,
          telegramTurnId: item.telegram?.turnId,
          messageId: item.telegram?.messageId,
          chatId: item.telegram?.chatId,
          sentAt: item.telegram?.sentAt,
        }))
        .filter((item: any) => {
          const key = `${item.sessionId}:${item.telegramTurnId}`;
          if (seen.has(key)) {
            return false;
          }
          seen.add(key);
          return true;
        })
        .map((item: any) => {
          const matches = item.sessionId
            ? observationFiles.filter(name => name.endsWith(`_${item.sessionId}.jsonl`))
            : [];
          return {
            ...item,
            recordFile: matches.length === 1 ? path.join(path.dirname(file!), matches[0]) : null,
          };
        });
      const sourceIdentities = (items: any[]) => items.map(({ recordFile, ...item }) => item);
      if (previous?.originSources && JSON.stringify(sourceIdentities(previous.originSources)) !== JSON.stringify(sourceIdentities(originSources))) {
        throw new Error("Background originating turns changed");
      }
      const metadata = previous ?? {
        taskId: identity.taskId,
        runId: identity.runId,
        source,
        sourceRecordFile: originSources[0]?.recordFile ?? null,
        reviewSegments: [],
      };
      if (!metadata.prepared) {
        // 已保存的引用不随文件缺失或重启重新选择；缺证据由统计层明确显示未知。
        metadata.originSources ??= originSources;
        metadata.reviewSegments.push({
          reviewId: randomUUID(),
          sessionId: ctx.sessionManager.getSessionId(),
          recordFile: file,
          startedAt: beijingIsoTime(),
          bootId,
          monotonicNs: process.hrtime.bigint().toString(),
        });
      }
      background = {
        identity,
        context: snapshotContext(ctx),
        metadata: saveMetadata(identity, metadata),
        admitted: false,
      };
      write("background_review_start", {
        taskId: identity.taskId,
        runId: identity.runId,
        source,
      }, background.context);
    },
    async prepareBackgroundDelivery(identity: BackgroundIdentity, ctx: ExtensionContext, reportText?: string) {
      const metadata = readReceipt(identity).observability;
      if (!metadata || metadata.taskId !== identity.taskId || metadata.runId !== identity.runId) {
        throw new Error("Background observation evidence missing");
      }
      if (metadata.prepared) {
        return metadata.prepared;
      }
      const summary = await backgroundStatistics(metadata, ctx, identity);
      metadata.prepared = {
        ...(typeof reportText === "string" ? { reportText } : {}),
        summary,
        footer: formatFooter(summary),
        preparedAt: beijingIsoTime(),
        preparedMonotonicNs: summary.boundaryMonotonicNs,
        bootId,
        elapsedScope: "original Telegram task message.date to final report preparation; includes dispatch, worker wait and review; not handset receipt",
      };
      saveMetadata(identity, metadata);
      write("background_footer_prepared", {
        taskId: identity.taskId,
        runId: identity.runId,
        source: metadata.source,
        ...metadata.prepared,
      }, ctx);
      return metadata.prepared;
    },
    confirmBackgroundDelivery(identity: BackgroundIdentity, receipt: any, ctx: ExtensionContext) {
      const metadata = readReceipt(identity).observability;
      if (!metadata?.prepared) {
        return;
      }
      const valid = receipt.state === "success" && /^\d+$/.test(receipt.monotonic_ns ?? "")
        && typeof receipt.boot_id === "string" && receipt.boot_id.length > 0;
      write("background_delivery_end", {
        taskId: identity.taskId,
        runId: identity.runId,
        source: metadata.source,
        status: receipt.state,
        displaySummary: metadata.prepared.summary,
        confirmedTiming: valid
          ? elapsedBackground(metadata, BigInt(receipt.monotonic_ns), receipt.boot_id)
          : { elapsedMs: null, clock: "unknown: no confirmed sender monotonic timestamp" },
        messageIds: receipt.message_ids ?? (receipt.message_id ? [receipt.message_id] : []),
        confirmationScope: "standalone sender parsed Telegram API response; no handset receipt",
        finalDeliveryMs: valid && receipt.boot_id === metadata.prepared.bootId
          ? monotonicDuration(metadata.prepared.preparedMonotonicNs, receipt.monotonic_ns)
          : null,
      }, ctx);
    },
    abandonBackgroundReview() {
      background = undefined;
    },
    inbound(update: any, boundary = "update_handler") {
      const message = update?.message;
      if (!enabled || !message || /^\s*\//.test(message.text ?? message.caption ?? "")) {
        return;
      }
      const key = `${message.chat.id}:${message.message_id}`;
      if (inbound.has(key)) {
        return;
      }
      inbound.set(key, {
        mono: performance.now(),
        wall: Date.now(),
        serverWall: boundary === "getUpdates_api_confirmation" && telegramClock
          ? telegramClock.serverMs + performance.now() - telegramClock.mono
          : undefined,
        updateId: update.update_id,
        boundary,
      });
      // Raw update observations are only promoted into logs if the bridge actually admits a prompt.
      if (inbound.size > 2048) {
        inbound.delete(inbound.keys().next().value!);
      }
    },
    enqueue(bridgeTurn: any, messages: any[]) {
      if (!enabled || !messages.length || messages.some(message => /^\s*\//.test(message.text ?? message.caption ?? ""))) {
        return;
      }
      const received = messages.map(message => inbound.get(`${message.chat.id}:${message.message_id}`))
        .filter(Boolean) as Array<{ mono: number; wall: number; serverWall?: number; updateId: number }>;
      const earliest = received.sort((a, b) => a.mono - b.mono)[0];
      const dates = messages.map(message => message.date)
        .filter((date): date is number => Number.isFinite(date));
      const now = performance.now();
      const turn: Turn = {
        id: randomUUID(),
        bridge: bridgeTurn,
        messages,
        origin: earliest?.mono ?? now,
        receivedWallMs: earliest?.wall ?? Date.now(),
        receivedServerMs: earliest?.serverWall,
        sentWallMs: dates.length === messages.length ? Math.min(...dates) * 1000 : null,
        spans: [],
        open: new Map(),
        requests: [],
        deliveries: [],
        model: "?",
        window: null,
        thinking: "?",
        tools: 0,
        completed: false,
        deliveryErrors: [],
        ackSequence: 0,
        outputMessageIds: new Set(),
      };
      turns.set(queueKey(bridgeTurn), turn);
      pending.add(turn);
      turn.spans.push({
        name: "inbound_prepare",
        startMs: 0,
        endMs: now - turn.origin,
        durationMs: now - turn.origin,
        status: earliest ? "ok" : "unknown_receive_boundary",
      });
      if (latestContext) {
        bindTurn(turn, latestContext);
      }
      start(turn, "queue");
      record(turn, "telegram_queued", { queueOrder: bridgeTurn.queueOrder });
    },
    dispatch(bridgeTurn: any) {
      active = turns.get(queueKey(bridgeTurn));
      if (active) {
        end(active, "queue");
        active.dispatched = performance.now();
        start(active, "prompt_prepare");
        // 后台任务原话取证复用既有的授权后出队观察点；只提供来源，不创建任务或修改消息。
        // 关联 .pi/extensions/background/tasks/source.ts；不支持多条合并或附件时由登记脚本明确拒绝。
        if (latestContext && active.messages.length === 1
            && Array.isArray(bridgeTurn.content) && bridgeTurn.content.length === 1
            && bridgeTurn.content[0]?.type === "text") {
          try {
            pi.events?.emit("bot.background.original-request", {
              sessionId: latestContext.sessionManager.getSessionId(),
              turnId: active.id,
              inputText: bridgeTurn.content[0].text,
              message: active.messages[0],
            });
          } catch (error: any) {
            record(active, "background_request_source_error", { errorName: error?.name ?? "Error" });
          }
        }
      }
    },
    usage(message: object, rawUsage: any, protocol: string, response?: any) {
      rawUsages.set(message, {
        rawUsage,
        protocol,
        responseMetadata: response ? {
          responseId: response.id ?? null,
          model: response.model ?? null,
          serviceTier: response.service_tier ?? null,
          status: response.status ?? null,
          promptCacheDiagnostics: response.prompt_cache_diagnostics ?? null,
          promptCacheDiagnosticsPresent: Object.hasOwn(response, "prompt_cache_diagnostics"),
        } : undefined,
      });
    },
    providerTransport(details: Record<string, unknown>) {
      if (!enabled || !providerRequest) {
        return;
      }
      try {
        if (details.phase === "connect" || (details.phase === "send" && details.transport === "sse")) {
          providerRequest.attempt++;
        }
        write("provider_transport", {
          requestId: providerRequest.id,
          transportAttempt: providerRequest.attempt,
          requestElapsedMs: performance.now() - providerRequest.start,
          ...details,
        }, providerRequest.ctx);
      } catch {
        // An observation failure must not change transport or retry behavior.
        console.error("Provider transport observability write failed");
      }
    },
    async span<T>(name: string, work: () => Promise<T>): Promise<T> {
      const turn = name.startsWith("telegram.") ? deliveryScope.getStore() : active;
      if (!turn || turn.completed) {
        return work();
      }
      const key = `${name}:${randomUUID()}`;
      start(turn, key, name);
      try {
        const result = await work();
        end(turn, key);
        return result;
      } catch (error) {
        end(turn, key, "error");
        throw error;
      }
    },
    attempt(method: string, attempt: number) {
      const turn = deliveryScope.getStore();
      if (turn) {
        record(turn, "telegram_transport_attempt", {
          method,
          attempt,
          offsetMs: performance.now() - turn.origin,
        });
      }
    },
    acknowledged(method: string, result: any) {
      if (method === "getUpdates" && Array.isArray(result)) {
        for (const update of result) {
          observer.inbound(update, "getUpdates_api_confirmation");
        }
        return;
      }
      const turn = deliveryScope.getStore();
      if (turn && !turn.completed && /^(send|editMessage)/.test(method) && !/Draft|ChatAction/.test(method)) {
        turn.ackSequence++;
        turn.lastConfirmedMono = performance.now();
        turn.lastConfirmedAt = beijingIsoTime();
        if (typeof result?.message_id === "number") {
          turn.outputMessageIds.add(result.message_id);
        }
        record(turn, "telegram_transport_ack", {
          method,
          outputMessageId: result?.message_id ?? null,
          offsetMs: turn.lastConfirmedMono - turn.origin,
        });
      }
    },
    finalize(bridgeTurn: object | undefined) {
      const turn = bridgeTurn ? turns.get(queueKey(bridgeTurn)) : undefined;
      if (turn && !turn.completed) {
        start(turn, "final_render_and_wait");
      }
    },
    async transport<T>(method: string, body: any, work: () => Promise<T>): Promise<T> {
      const turn = deliveryScope.getStore();
      if (!turn || turn.completed) {
        try {
          const result = await work();
          if (method === "sendChatAction") {
            observer.runtime("typing_api_confirmed", { method });
          }
          return result;
        } catch (error: any) {
          recordTransportError(method, error);
          throw error;
        }
      }
      let result: any;
      try {
        const sequence = turn.ackSequence;
        result = await observer.span(`telegram.api.${method}`, async () => {
          const response = await work();
          if (turn.ackSequence === sequence) {
            observer.acknowledged(method, response);
          }
          return response;
        });
      } catch (error: any) {
        recordTransportError(method, error);
        turn.deliveryErrors.push(error?.name ?? "Error");
        record(turn, "telegram_delivery_error", {
          method,
          errorName: error?.name ?? "Error",
          commitUnknown: error?.name === "TelegramApiCommitUnknownError",
        });
        throw error;
      }
      if (["sendMessage", "sendRichMessage", "editMessageText"].includes(method)) {
        turn.deliveries.push({ method, body: { ...body }, result, confirmedAt: beijingIsoTime() });
      }
      return result;
    },
    runtime(stage: string, details: Record<string, unknown>) {
      if (!enabled || !latestContext) {
        return;
      }
      try {
        write(`telegram_${stage}`, { ...details, monotonicNs: process.hrtime.bigint().toString() }, latestContext);
      } catch {
        // 替换中的 ctx 不可再写；观测失败不能改变真实网络结果。
      }
    },
    decorateFinalText(bridgeTurn: object, text: string | undefined): string | undefined {
      const turn = turns.get(queueKey(bridgeTurn));
      if (!turn || turn.completed || !text?.trim()) {
        return text;
      }
      // 在 Markdown/HTML 渲染和分块前拼好，正文和统计共享一次投递。
      // 这里的时间截止到发送前；实际 API 确认后的总耗时只写观测记录。
      if (!turn.footer) {
        turn.displaySummary = buildSummary(turn, performance.now());
        turn.footer = formatFooter(turn.displaySummary);
        record(turn, "telegram_footer_prepared", {
          displaySummary: turn.displaySummary,
          elapsedScope: "Telegram original message.date to final reply preparation before rendering and send",
        });
      }
      return `${text.trimEnd()}\n${turn.footer}`;
    },
    async delivery<T>(bridgeTurn: object, work: () => Promise<T>): Promise<T> {
      const turn = turns.get(queueKey(bridgeTurn));
      if (!turn || turn.completed) {
        return work();
      }
      return deliveryScope.run(turn, async () => {
        end(turn, "final_render_and_wait");
        start(turn, "delivery");
        try {
          const result = await work();
          end(turn, "delivery");
          if (turn.completed) {
            return result;
          }
          const confirmedMono = turn.lastConfirmedMono;
          const confirmedAt = turn.lastConfirmedAt;
          const delivery = turn.deliveries.findLast(item => item.result?.message_id || item.body?.message_id);
          const lastOutputId = [...turn.outputMessageIds].at(-1);
          if (turn.deliveryErrors.length > 0 && (delivery || lastOutputId !== undefined)) {
            complete(turn, "partial_delivery_or_unknown", {
              deliveryErrors: turn.deliveryErrors,
              outputMessageIds: [...turn.outputMessageIds],
              elapsedMs: null,
              footerStatus: "delivery_incomplete_or_unknown",
            });
            return result;
          }
          if (!delivery && lastOutputId === undefined) {
            complete(turn, turn.deliveryErrors.length ? "delivery_failed_or_unknown" : "no_confirmed_text_delivery", {
              deliveryErrors: turn.deliveryErrors,
            });
            return result;
          }
          const summary = buildSummary(turn, confirmedMono);
          complete(turn, "delivered", {
            summary,
            footer: turn.footer ?? null,
            footerStatus: turn.footer ? "included_in_reply" : "not_applicable",
            displaySummary: turn.displaySummary ?? null,
            displayElapsedScope: "Telegram original message.date to final reply preparation before rendering and send",
            stageCoverage: summarizeCoverage(turn.spans, summary.bodyLocalElapsedMs),
            bodyConfirmedAt: confirmedAt,
            footerConfirmedAt: turn.footer ? confirmedAt : null,
            elapsedScope: "Telegram original message.date to final body/attachment API confirmation; no client receipt available",
            outputMessageIds: [...new Set([
              ...turn.outputMessageIds,
              ...turn.deliveries.map(item => item.result?.message_id ?? item.body.message_id).filter(id => typeof id === "number"),
            ])],
            footerMessageId: null,
          });
          return result;
        } catch (error: any) {
          end(turn, "delivery", "error");
          complete(turn, "delivery_failed", { errorName: error?.name ?? "Error" });
          throw error;
        }
      });
    },
    dispose() {
      enabled = false;
      providerRequest = undefined;
      background = undefined;
      inbound.clear();
      for (const turn of [...pending]) {
        complete(turn, "interrupted_runtime_shutdown");
      }
    },
  };
  holder[OBSERVER_KEY] = observer;

  pi.on("session_start", async (_event, ctx) => {
    latestContext = ctx;
    if (!recordPath || !existsSync(recordPath(ctx))) {
      return;
    }
    // Reconcile only this resumed session. A killed process cannot close its old monotonic spans.
    const unfinished = new Map<string, any>();
    const input = createReadStream(recordPath(ctx));
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.includes('"stage":"telegram_turn_')) {
          continue;
        }
        try {
          const entry = JSON.parse(line);
          if (entry.stage === "telegram_turn_start") {
            unfinished.set(entry.telegramTurnId, entry);
          } else if (entry.stage === "telegram_turn_end") {
            unfinished.delete(entry.telegramTurnId);
          }
        } catch {
          // A partial line after a hard crash is not evidence of a completed delivery.
        }
      }
      for (const [telegramTurnId, entry] of unfinished) {
        write("telegram_turn_end", {
          telegramTurnId,
          status: "interrupted_previous_runtime",
          previousRuntimeId: entry.runtimeId,
          sentAt: entry.sentAt,
          elapsedMs: null,
          deliveryConfirmed: "unknown",
        }, ctx);
      }
    } catch (error: any) {
      write("telegram_recovery_error", { errorName: error?.name ?? "Error" }, ctx);
    } finally {
      lines.close();
      input.destroy();
    }
  });
  pi.on("input", (_event, ctx) => {
    bind(ctx);
  });
  pi.on("message_start", (event: any, ctx) => {
    if (background?.context.sessionManager.getSessionId() !== ctx.sessionManager.getSessionId()) {
      return;
    }
    if (event.message.role === "custom" && event.message.details === background.identity.details) {
      background.admitted = true;
    } else if (event.message.role === "user") {
      background = undefined;
    }
  });
  pi.on("session_tree", () => {
    background = undefined;
  });
  pi.on("message_update", (event: any) => {
    const request = active?.requests.at(-1);
    const kind = event.assistantMessageEvent?.type;
    if (request && ["text_delta", "thinking_delta", "toolcall_delta"].includes(kind)) {
      request.firstContentMs ??= performance.now() - request.start;
      if (kind === "text_delta") {
        request.firstTextMs ??= performance.now() - request.start;
      }
    }
  });
  pi.on("session_shutdown", () => {
    observer.dispose();
  });

  return {
    get turnId() {
      return active?.id ?? null;
    },
    rawUsage(message: object) {
      return rawUsages.get(message);
    },
    observe(stage: string, details: any, ctx: ExtensionContext) {
      if (stage === "request") {
        details.modelContextWindow = ctx.model?.contextWindow ?? null;
        details.thinkingLevel = pi.getThinkingLevel();
      }
      if (background?.admitted && background.context.sessionManager.getSessionId() === ctx.sessionManager.getSessionId()
          && !stage.startsWith("telegram_")) {
        details.backgroundTask = {
          taskId: background.identity.taskId,
          runId: background.identity.runId,
          reviewId: background.metadata.reviewSegments.at(-1)?.reviewId,
          source: background.metadata.source,
        };
        details.telegramTurnId = background.metadata.source.telegramTurnId ?? null;
      }
      if (stage === "request") {
        providerRequest = {
          id: details.requestId,
          ctx: snapshotContext(ctx),
          start: performance.now(),
          attempt: 0,
        };
      } else if (stage === "response" || stage === "session_shutdown") {
        providerRequest = undefined;
      }
      if (!active || active.completed || stage.startsWith("telegram_")) {
        return;
      }
      bind(ctx);
      const turn = active;
      if (stage === "before_agent_start") {
        end(turn, "prompt_prepare");
      } else if (stage === "context") {
        start(turn, "model_prepare");
      } else if (stage === "request") {
        end(turn, "model_prepare");
        const request = {
          id: details.requestId,
          model: `${ctx.model?.provider ?? "?"}/${ctx.model?.id ?? "?"}`,
          start: performance.now(),
        };
        turn.requests.push(request);
        turn.model = request.model;
        turn.window = ctx.model?.contextWindow ?? null;
        turn.thinking = pi.getThinkingLevel();
        start(turn, request.id, "model_request", { requestId: request.id });
      } else if (stage === "after_provider_response") {
        record(turn, "telegram_model_headers", {
          requestId: details.requestId,
          status: details.status,
          offsetMs: performance.now() - turn.origin,
        });
      } else if (stage === "response") {
        const request = turn.requests.find(item => item.id === details.requestId);
        if (request) {
          request.usage = interpretUsage(rawUsages.get(details.assistantMessage));
          end(turn, request.id, details.assistantMessage.stopReason);
          record(turn, "telegram_model_end", {
            requestId: request.id,
            usage: request.usage,
            firstContentMs: request.firstContentMs ?? null,
            firstTextMs: request.firstTextMs ?? null,
          });
        }
      } else if (stage === "tool_execution_start") {
        turn.tools++;
        start(turn, `tool:${details.toolCallId}`, "tool", {
          toolName: details.toolName,
          toolCallId: details.toolCallId,
        });
      } else if (stage === "tool_execution_end") {
        end(turn, `tool:${details.toolCallId}`, details.isError ? "error" : "ok");
      }
    },
  };
}
