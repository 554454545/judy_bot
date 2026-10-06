// TG 观察点与生命周期补丁：适配项目 Pi 0.84.1 / pi-telegram 0.27.12；关联 index.ts 的 typing/网络观测及会话替换围栏，不修改全局包。
// 所有文件先校验再写入；重复 apply 幂等，未知源码拒绝覆盖；--check 用于 start.sh 启动核对。
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const digest = text => createHash("sha256").update(text).digest("hex");

const patches = [
  {
    "path": ".pi/npm/node_modules/@llblab/pi-telegram/lib/updates.ts",
    "before": "2e076e87dac09719b0edf69237d0b55664c7182f1b90851453bec9cf8f2c8233",
    "after": "bf795953a7376f76e8da2c2f11d9b7b5cb8579febb5602082280c61b9fbfcf71",
    "replacements": [
      [
        "    const verdict = await registry.dispatch(update);",
        "    (globalThis as any)[Symbol.for(\"bot.observability.telegram-turn\")]?.inbound(update);\n    const verdict = await registry.dispatch(update);"
      ]
    ]
  },
  {
    "path": ".pi/npm/node_modules/@llblab/pi-telegram/lib/queue.ts",
    "before": "1bad2e1be5ad893c88c3ce6d4cb47b69dfd58ab80450cdafd2582d1981375e07",
    "after": "e315b580c6986467082f69693a27ff7ae9aff482d063fb3efeb0e359268de68a",
    "replacements": [
      [
        "  const turn = await deps.createTurn(messages, enqueuePlan.historyTurns);",
        "  const turn = await deps.createTurn(messages, enqueuePlan.historyTurns);\n  (globalThis as any)[Symbol.for(\"bot.observability.telegram-turn\")]?.enqueue(turn, messages);"
      ],
      [
        "  deps.onPromptDispatchStart(plan.item.chatId);",
        "  (globalThis as any)[Symbol.for(\"bot.observability.telegram-turn\")]?.dispatch(plan.item);\n  deps.onPromptDispatchStart(plan.item.chatId);"
      ],
      [
        "  const rawFinalText = assistant.text;",
        "  (globalThis as any)[Symbol.for(\"bot.observability.telegram-turn\")]?.finalize(turn);\n  const rawFinalText = assistant.text;"
      ],
      [
        "    await deps.sendTextReply(\n      turn.chatId,\n      turn.replyToMessageId,\n      assistant.errorMessage ||\n        \"Telegram bridge: Pi failed while processing the request.\",\n      { target: turn.target },\n    );",
        "    const sendError = () => deps.sendTextReply(\n      turn.chatId,\n      turn.replyToMessageId,\n      (globalThis as any)[Symbol.for(\"bot.observability.telegram-turn\")]?.decorateFinalText(turn, assistant.errorMessage || \"Telegram bridge: Pi failed while processing the request.\") || assistant.errorMessage || \"Telegram bridge: Pi failed while processing the request.\",\n      { target: turn.target },\n    );\n    const observer = (globalThis as any)[Symbol.for(\"bot.observability.telegram-turn\")];\n    await (observer ? observer.delivery(turn, sendError) : sendError());"
      ],
      [
        "  const deliverActiveTurn = async () => {",
        "  const deliverActiveTurn = () => {\n    const deliver = async () => {"
      ],
      [
        "  };\n  if (\n    deps.scheduleActiveTurnDelivery &&",
        "    };\n    const observer = (globalThis as any)[Symbol.for(\"bot.observability.telegram-turn\")];\n    return observer\n      ? observer.delivery(turn, deliver)\n      : deliver();\n  };\n  if (\n    deps.scheduleActiveTurnDelivery &&"
      ],
      [
        "  const finalText = outboundReply ? outboundReply.markdown : rawFinalText;",
        "  let finalText = outboundReply ? outboundReply.markdown : rawFinalText;"
      ],
      [
        "    if (finalText) deps.setPreviewPendingText(finalText);",
        "    const footerObserver = (globalThis as any)[Symbol.for(\"bot.observability.telegram-turn\")];\n    finalText = footerObserver ? footerObserver.decorateFinalText(turn, finalText) : finalText;\n    if (finalText) deps.setPreviewPendingText(finalText);"
      ]
    ]
  },
  {
    "path": ".pi/npm/node_modules/@llblab/pi-telegram/lib/telegram-api.ts",
    "before": "8d39cf1810295bdc1be9fb23b6237b641ea05af342e41cad5ce2cbe0811ee7c1",
    "after": "f1a7d2cc0b28275d34e1f24dd590274c78c3d820e49321502904de21109d66fb",
    "replacements": [
      [
        "      return await deps.client.call<TResponse>(method, body, options);",
        "      const observer = (globalThis as any)[Symbol.for(\"bot.observability.telegram-turn\")];\n      const work = () => deps.client.call<TResponse>(method, body, options);\n      return observer\n        ? await observer.transport(method, body, work)\n        : await work();"
      ],
      [
        "        await deps.client.call(\"editMessageText\", body);",
        "        const observer = (globalThis as any)[Symbol.for(\"bot.observability.telegram-turn\")];\n        const work = () => deps.client.call(\"editMessageText\", body);\n        if (observer) {\n          await observer.transport(\"editMessageText\", body, work);\n        } else {\n          await work();\n        }"
      ],
      [
        "      return unwrapTelegramApiResult(\n        method,\n        await parseTelegramApiResponse<TResponse>(\n          await callTelegramTransportRequest(request, retrySafe),\n          method,\n        ),\n      );",
        "      const response = await callTelegramTransportRequest(request, retrySafe);\n      (globalThis as any)[Symbol.for(\"bot.observability.telegram-turn\")]?.clock(method, response.headers.get(\"date\"));\n      const result = unwrapTelegramApiResult(\n        method,\n        await parseTelegramApiResponse<TResponse>(response, method),\n      );\n      (globalThis as any)[Symbol.for(\"bot.observability.telegram-turn\")]?.acknowledged(method, result);\n      return result;"
      ],
      [
        "  for (let attempt = 0; ; attempt += 1) {\n    try {",
        "  for (let attempt = 0; ; attempt += 1) {\n    (globalThis as any)[Symbol.for(\"bot.observability.telegram-turn\")]?.attempt(method, attempt);\n    try {"
      ],
      [
        "          await sleep(\n            getTelegramRetryDelayMs(error, attempt, retryBaseDelayMs),\n          );",
        "          const wait = () => sleep(getTelegramRetryDelayMs(error, attempt, retryBaseDelayMs));\n          const observer = (globalThis as any)[Symbol.for(\"bot.observability.telegram-turn\")];\n          await (observer ? observer.span(\"telegram.retry_wait\", wait) : wait());"
      ],
      [
        "      await sleep(getTelegramRetryDelayMs(error, attempt, retryBaseDelayMs));",
        "      const wait = () => sleep(getTelegramRetryDelayMs(error, attempt, retryBaseDelayMs));\n      const observer = (globalThis as any)[Symbol.for(\"bot.observability.telegram-turn\")];\n      await (observer ? observer.span(\"telegram.retry_wait\", wait) : wait());"
      ]
    ]
  },
  {
    "path": "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js",
    "before": "1f5e40029548bd3e8b62f15b8e764c478ce7612dcba658cca2bba934127e2e3d",
    "after": "54f7f8359af6e5d683aab5f5501d6ead0490c129cf32133c8bb9dd4e55b4fff5",
    "replacements": [
      [
        "        if (response?.usage) {",
        "        globalThis[Symbol.for(\"bot.observability.telegram-turn\")]?.usage(output, response?.usage, \"responses\", response);\n        if (response?.usage) {"
      ]
    ]
  },
  {
    "path": "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js",
    "before": "727d744f20985f667151e8ecee3ad30af388d9d66d91a92d0fb9ad3261da4363",
    "after": "714f54f994ee621279298503d079def73f73a5f004f3bcdf500920def7576b34",
    "replacements": [
      [
        "                    output.usage = parseChunkUsage(chunk.usage, model);",
        "                    globalThis[Symbol.for(\"bot.observability.telegram-turn\")]?.usage(output, chunk.usage, \"completions\");\n                    output.usage = parseChunkUsage(chunk.usage, model);"
      ],
      [
        "                    output.usage = parseChunkUsage(choice.usage, model);",
        "                    globalThis[Symbol.for(\"bot.observability.telegram-turn\")]?.usage(output, choice.usage, \"completions\");\n                    output.usage = parseChunkUsage(choice.usage, model);"
      ]
    ]
  },
  {
    "path": "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js",
    "before": "f0699749b06045244fd6ced26aee4f2627e7218199fd2955b0003fe08592aead",
    "after": "cb0a1387f85cf6ce3482a6ba538130bcc75d08a2025f8f4ce55962d059e188e4",
    "replacements": [
      [
        "function buildRequestBody(model, context, options, cacheSessionId, grammarToolInputProperties",
        "// Project-only observer: failures never alter model transport; credentials are never passed.\nfunction observeProviderTransport(details) {\n    try {\n        globalThis[Symbol.for(\"bot.observability.telegram-turn\")]?.providerTransport(details);\n    } catch {\n        // Keep provider behavior unchanged if an observer fails.\n    }\n}\nfunction buildRequestBody(model, context, options, cacheSessionId, grammarToolInputProperties"
      ],
      [
        "            for (let attempt = 0; attempt <= maxRetries; attempt++) {",
        "            for (let attempt = 0; attempt <= maxRetries; attempt++) {\n                observeProviderTransport({ phase: \"send\", transport: \"sse\", attempt: attempt + 1, configuredTransport: transport, endpoint: resolveCodexUrl(model.baseUrl).split(\"?\")[0], providerPayload: body, contentEncoding: compressedBody ? \"zstd\" : \"identity\", bodyScope: \"JSON before optional zstd compression; not proof of provider receipt\" });"
      ],
      [
        "                    await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);",
        "                    observeProviderTransport({ phase: \"headers\", transport: \"sse\", attempt: attempt + 1, status: response.status, headers: Object.fromEntries([\"x-request-id\", \"request-id\", \"openai-processing-ms\", \"retry-after\", \"retry-after-ms\", \"date\"].map(name => [name, response.headers.get(name)]).filter(([, value]) => value !== null)) });\n                    await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);"
      ],
      [
        "                            : validateRetryDelayMs(retryAfterDelayMs, options);\n                        await sleep(delayMs, options?.signal);\n                        continue;",
        "                            : validateRetryDelayMs(retryAfterDelayMs, options);\n                        observeProviderTransport({ phase: \"retry_wait\", transport: \"sse\", attempt: attempt + 1, reason: \"retryable_http_status\", status: response.status, delayMs });\n                        await sleep(delayMs, options?.signal);\n                        continue;"
      ],
      [
        "                        await sleep(delayMs, options?.signal);\n                        continue;\n                    }\n                    throw lastError;",
        "                        observeProviderTransport({ phase: \"retry_wait\", transport: \"sse\", attempt: attempt + 1, reason: \"transport_error\", errorName: lastError.name, delayMs });\n                        await sleep(delayMs, options?.signal);\n                        continue;\n                    }\n                    observeProviderTransport({ phase: \"failure\", transport: \"sse\", attempt: attempt + 1, errorName: lastError.name });\n                    throw lastError;"
      ],
      [
        "                        const aborted = options?.signal?.aborted;",
        "                        const aborted = options?.signal?.aborted;\n                        observeProviderTransport({ phase: \"failure\", transport: \"websocket\", eventsEmitted: websocketStarted, errorName: error?.name ?? \"Error\", aborted: !!aborted });"
      ],
      [
        "                            retriedMissingWebSocketContinuation = true;",
        "                            observeProviderTransport({ phase: \"retry\", transport: \"websocket\", reason: \"previous_response_not_found\" });\n                            retriedMissingWebSocketContinuation = true;"
      ],
      [
        "                            retriedWebSocketConnectionLimit = true;",
        "                            observeProviderTransport({ phase: \"retry\", transport: \"websocket\", reason: \"connection_limit\" });\n                            retriedWebSocketConnectionLimit = true;"
      ],
      [
        "                        recordWebSocketSseFallback(cacheSessionId);\n                        break;",
        "                        observeProviderTransport({ phase: \"fallback\", transport: \"websocket\", nextTransport: \"sse\" });\n                        recordWebSocketSseFallback(cacheSessionId);\n                        break;"
      ],
      [
        "    const { socket, entry, reused, release } = await acquireWebSocket(",
        "    observeProviderTransport({ phase: \"connect\", transport: \"websocket\", configuredTransport: options?.transport ?? \"auto\" });\n    const { socket, entry, reused, release } = await acquireWebSocket("
      ],
      [
        "        socket.send(JSON.stringify({ type: \"response.create\", ...requestBody }));",
        "        observeProviderTransport({ phase: \"send\", transport: \"websocket\", connectionReused: reused, fullInputItems: fullBody.input?.length ?? 0, sentInputItems: requestBody.input?.length ?? 0, previousResponseId: requestBody.previous_response_id ?? null, providerPayload: { type: \"response.create\", ...requestBody }, bodyScope: \"JSON frame passed to socket.send; not proof of provider receipt\" });\n        socket.send(JSON.stringify({ type: \"response.create\", ...requestBody }));"
      ],
      [
        "            if (websocketDisabledForSession) {",
        "            if (websocketDisabledForSession) {\n                observeProviderTransport({ phase: \"fallback\", transport: \"websocket\", nextTransport: \"sse\", reason: \"previous_session_transport_failure\" });"
      ]
    ]
  },
  {
    "path": ".pi/npm/node_modules/@llblab/pi-telegram/lib/runtime.ts",
    "before": "6256e74bb1038a941c114888b8db18e84b9e6773084ff5126e8f813a49e66992",
    "after": "c7c4812bfe02171690b454a1e57dc1fcbd0989b0168aea3bde50c61974add429",
    "replacements": [
      [
        "  state.typingLoopKey = nextKey;",
        "  state.typingLoopKey = nextKey;\n  (globalThis as any)[Symbol.for(\"bot.observability.telegram-turn\")]?.runtime(\"typing_start\", { chatId: deps.chatId, retargeted: !!state.typingInterval });"
      ],
      [
        "      .then(async () => {\n        await activeDeps.sendTypingAction",
        "      .then(async () => {\n        if (state.typingLoopDeps !== activeDeps) return;\n        await activeDeps.sendTypingAction"
      ],
      [
        "  clearInterval(state.typingInterval);",
        "  (globalThis as any)[Symbol.for(\"bot.observability.telegram-turn\")]?.runtime(\"typing_stop\", {});\n  clearInterval(state.typingInterval);"
      ]
    ]
  },
  {
    "path": ".pi/npm/node_modules/@llblab/pi-telegram/lib/polling.ts",
    "before": "d0ad3e741013bf35e89fd05b6ebe02cae507c51d77ac634ced6b3a21bb295040",
    "after": "c5547e0c1ad4abf3463046d6c57e1ce69a0bbe009590690339cede79022d5444",
    "replacements": [
      [
        "export async function applyTelegramThreadCapability<TContext>(\n  ctx: TContext,\n  threadModeEnabled: boolean,\n  phase: string,\n  deps: TelegramThreadCapabilityRuntimeDeps<TContext>,\n): Promise<void> {\n  await deps.topicTargetStore.load();\n  const nowMs = (deps.getNowMs ?? Date.now)();\n  const previousBotState = deps.topicTargetStore.getBotState();\n  if (!threadModeEnabled) {\n    if (\n      hasTelegramThreadCapabilityBindings(deps.topicTargetStore) &&\n      !phase.endsWith(\"-confirmed\")\n    ) {\n      deps.recordEvent(\"bus\", \"Telegram Threaded Mode probe deferred\", {\n        phase,\n        reason: \"active-thread-bindings-present\",\n      });\n      return;\n    }\n    deps.topicTargetStore.setBotState({\n      threadMode: \"disabled\",\n      updatedAtMs: nowMs,\n      lastReconcileAction: phase,\n    });\n    await deps.topicTargetStore.persist();\n    deps.setTopicModeUnavailable(true);\n    deps.stopFollowerRegistration();\n    if (\n      deps.getPollingStartedWithTelegramBus() ||\n      hasTelegramClassicRestoreFailure(previousBotState)\n    ) {\n      deps.stopLeaderHealth();\n      await deps.stopBusPolling();\n      deps.setPollingStartedWithTelegramBus(false);\n      try {\n        await deps.startClassicPolling(ctx);\n      } catch (classicError) {\n        deps.topicTargetStore.setBotState({\n          threadMode: \"disabled\",\n          updatedAtMs: (deps.getNowMs ?? Date.now)(),\n          lastReconcileAction: `${phase}-classic-restore-failed`,\n        });\n        await deps.topicTargetStore.persist();\n        deps.recordEvent(\"bus\", classicError, {\n          phase: `${phase}-classic-restore`,\n        });\n      }\n    }\n    deps.updateStatus(ctx);\n    return;\n  }\n  deps.topicTargetStore.setBotState({\n    ...deps.topicTargetStore.getBotState(),\n    threadMode: \"enabled\",\n    updatedAtMs: nowMs,\n    lastReconcileAction: phase,\n  });\n  await deps.topicTargetStore.persist();\n  deps.setTopicModeUnavailable(false);\n  if (!deps.getPollingStartedWithTelegramBus() && deps.ownsLock(ctx)) {\n    await deps.stopClassicPolling();\n    deps.setPollingStartedWithTelegramBus(true);\n    try {\n      await deps.startBusPolling(ctx);\n      deps.startLeaderHealth();\n    } catch (error) {\n      deps.setPollingStartedWithTelegramBus(false);\n      const threadModeUnavailable =\n        deps.isTopicModeUnavailableError?.(error) === true;\n      if (threadModeUnavailable) {\n        deps.topicTargetStore.setBotState({\n          threadMode: \"disabled\",\n          updatedAtMs: nowMs,\n          lastReconcileAction: `${phase}-unavailable`,\n        });\n        await deps.topicTargetStore.persist();\n        deps.setTopicModeUnavailable(true);\n      }\n      try {\n        await deps.startClassicPolling(ctx);\n      } catch (classicError) {\n        deps.topicTargetStore.setBotState({\n          threadMode: \"disabled\",\n          updatedAtMs: (deps.getNowMs ?? Date.now)(),\n          lastReconcileAction: `${phase}-classic-restore-failed`,\n        });\n        await deps.topicTargetStore.persist();\n        deps.recordEvent(\"bus\", classicError, {\n          phase: `${phase}-classic-restore`,\n        });\n      }\n      deps.updateStatus(ctx);\n      if (threadModeUnavailable) return;\n      throw error;\n    }\n  }\n  deps.updateStatus(ctx);\n}\n",
        "export async function applyTelegramThreadCapability<TContext>(\n  ctx: TContext,\n  threadModeEnabled: boolean,\n  phase: string,\n  deps: TelegramThreadCapabilityRuntimeDeps<TContext>,\n  isActive: () => boolean = () => true,\n): Promise<void> {\n  await deps.topicTargetStore.load();\n  if (!isActive()) return;\n  const nowMs = (deps.getNowMs ?? Date.now)();\n  const previousBotState = deps.topicTargetStore.getBotState();\n  if (!threadModeEnabled) {\n    if (\n      hasTelegramThreadCapabilityBindings(deps.topicTargetStore) &&\n      !phase.endsWith(\"-confirmed\")\n    ) {\n      deps.recordEvent(\"bus\", \"Telegram Threaded Mode probe deferred\", {\n        phase,\n        reason: \"active-thread-bindings-present\",\n      });\n      return;\n    }\n    deps.topicTargetStore.setBotState({\n      threadMode: \"disabled\",\n      updatedAtMs: nowMs,\n      lastReconcileAction: phase,\n    });\n    await deps.topicTargetStore.persist();\n    if (!isActive()) return;\n    deps.setTopicModeUnavailable(true);\n    deps.stopFollowerRegistration();\n    if (\n      deps.getPollingStartedWithTelegramBus() ||\n      hasTelegramClassicRestoreFailure(previousBotState)\n    ) {\n      deps.stopLeaderHealth();\n      await deps.stopBusPolling();\n      if (!isActive()) return;\n      deps.setPollingStartedWithTelegramBus(false);\n      try {\n        await deps.startClassicPolling(ctx);\n        if (!isActive()) return;\n      } catch (classicError) {\n        deps.topicTargetStore.setBotState({\n          threadMode: \"disabled\",\n          updatedAtMs: (deps.getNowMs ?? Date.now)(),\n          lastReconcileAction: `${phase}-classic-restore-failed`,\n        });\n        await deps.topicTargetStore.persist();\n        if (!isActive()) return;\n        deps.recordEvent(\"bus\", classicError, {\n          phase: `${phase}-classic-restore`,\n        });\n      }\n    }\n    deps.updateStatus(ctx);\n    return;\n  }\n  deps.topicTargetStore.setBotState({\n    ...deps.topicTargetStore.getBotState(),\n    threadMode: \"enabled\",\n    updatedAtMs: nowMs,\n    lastReconcileAction: phase,\n  });\n  await deps.topicTargetStore.persist();\n  if (!isActive()) return;\n  deps.setTopicModeUnavailable(false);\n  if (!deps.getPollingStartedWithTelegramBus() && deps.ownsLock(ctx)) {\n    await deps.stopClassicPolling();\n    if (!isActive()) return;\n    deps.setPollingStartedWithTelegramBus(true);\n    try {\n      await deps.startBusPolling(ctx);\n      if (!isActive()) return;\n      deps.startLeaderHealth();\n    } catch (error) {\n      deps.setPollingStartedWithTelegramBus(false);\n      const threadModeUnavailable =\n        deps.isTopicModeUnavailableError?.(error) === true;\n      if (threadModeUnavailable) {\n        deps.topicTargetStore.setBotState({\n          threadMode: \"disabled\",\n          updatedAtMs: nowMs,\n          lastReconcileAction: `${phase}-unavailable`,\n        });\n        await deps.topicTargetStore.persist();\n        if (!isActive()) return;\n        deps.setTopicModeUnavailable(true);\n      }\n      try {\n        await deps.startClassicPolling(ctx);\n        if (!isActive()) return;\n      } catch (classicError) {\n        deps.topicTargetStore.setBotState({\n          threadMode: \"disabled\",\n          updatedAtMs: (deps.getNowMs ?? Date.now)(),\n          lastReconcileAction: `${phase}-classic-restore-failed`,\n        });\n        await deps.topicTargetStore.persist();\n        if (!isActive()) return;\n        deps.recordEvent(\"bus\", classicError, {\n          phase: `${phase}-classic-restore`,\n        });\n      }\n      deps.updateStatus(ctx);\n      if (threadModeUnavailable) return;\n      throw error;\n    }\n  }\n  deps.updateStatus(ctx);\n}\n"
      ],
      [
        "export function createTelegramThreadCapabilityMonitor<TContext>(\n  deps: TelegramThreadCapabilityRuntimeDeps<TContext>,\n): TelegramThreadCapabilityMonitor<TContext> {\n  const intervalMs =\n    deps.intervalMs ?? TELEGRAM_THREAD_CAPABILITY_MONITOR_INTERVAL_MS;\n  let interval: ReturnType<typeof setInterval> | undefined;\n  let transitionPending = false;\n  let consecutiveDisabledProbes = 0;\n  const stop = (): void => {\n    if (!interval) return;\n    clearInterval(interval);\n    interval = undefined;\n  };\n  const check = (ctx: TContext): void => {\n    if (transitionPending) return;\n    transitionPending = true;\n    void readTelegramThreadCapability(deps)\n      .then(async (threadModeEnabled) => {\n        if (threadModeEnabled === undefined) {\n          if (\n            deps.topicTargetStore.getBotState().threadMode !== \"enabled\" &&\n            !deps.getPollingStartedWithTelegramBus() &&\n            deps.ownsLock(ctx)\n          ) {\n            await applyTelegramThreadCapability(\n              ctx,\n              true,\n              \"capability-monitor-retry\",\n              deps,\n            );\n          }\n          return;\n        }\n        if (threadModeEnabled) consecutiveDisabledProbes = 0;\n        const botState = deps.topicTargetStore.getBotState();\n        const current = botState.threadMode;\n        if (threadModeEnabled && current === \"enabled\") return;\n        if (!threadModeEnabled && current === \"disabled\") {\n          if (\n            !deps.ownsLock(ctx) ||\n            !hasTelegramClassicRestoreFailure(botState)\n          ) {\n            return;\n          }\n          await applyTelegramThreadCapability(\n            ctx,\n            false,\n            \"capability-monitor-disabled-confirmed\",\n            deps,\n          );\n          return;\n        }\n        if (\n          !threadModeEnabled &&\n          hasTelegramThreadCapabilityBindings(deps.topicTargetStore)\n        ) {\n          consecutiveDisabledProbes += 1;\n          if (\n            consecutiveDisabledProbes <\n            TELEGRAM_THREAD_CAPABILITY_DISABLED_CONFIRMATION_PROBES\n          ) {\n            deps.recordEvent(\"bus\", \"Telegram Threaded Mode probe deferred\", {\n              phase: \"capability-monitor-disabled\",\n              reason: \"active-thread-bindings-present\",\n              consecutiveDisabledProbes,\n            });\n            return;\n          }\n        }\n        await applyTelegramThreadCapability(\n          ctx,\n          threadModeEnabled,\n          threadModeEnabled\n            ? \"capability-monitor-enabled\"\n            : consecutiveDisabledProbes >=\n                TELEGRAM_THREAD_CAPABILITY_DISABLED_CONFIRMATION_PROBES\n              ? \"capability-monitor-disabled-confirmed\"\n              : \"capability-monitor-disabled\",\n          deps,\n        );\n      })\n      .catch((error) => {\n        deps.recordEvent(\"bus\", error, { phase: \"capability-monitor\" });\n      })\n      .finally(() => {\n        transitionPending = false;\n      });\n  };\n  return {\n    start(ctx) {\n      stop();\n      interval = setInterval(() => {\n        check(ctx);\n      }, intervalMs);\n      interval.unref?.();\n    },\n    stop,\n  };\n}\n",
        "export function createTelegramThreadCapabilityMonitor<TContext>(\n  deps: TelegramThreadCapabilityRuntimeDeps<TContext>,\n): TelegramThreadCapabilityMonitor<TContext> {\n  const intervalMs =\n    deps.intervalMs ?? TELEGRAM_THREAD_CAPABILITY_MONITOR_INTERVAL_MS;\n  let interval: ReturnType<typeof setInterval> | undefined;\n  let transitionPending = false;\n  let generation = 0;\n  let consecutiveDisabledProbes = 0;\n  const stop = (): void => {\n    generation++;\n    transitionPending = false;\n    if (!interval) return;\n    clearInterval(interval);\n    interval = undefined;\n  };\n  const check = (ctx: TContext): void => {\n    if (transitionPending) return;\n    transitionPending = true;\n    const current = generation;\n    const isActive = () => current === generation;\n    void readTelegramThreadCapability(deps)\n      .then(async (threadModeEnabled) => {\n        if (!isActive()) return;\n        if (threadModeEnabled === undefined) {\n          if (\n            deps.topicTargetStore.getBotState().threadMode !== \"enabled\" &&\n            !deps.getPollingStartedWithTelegramBus() &&\n            deps.ownsLock(ctx)\n          ) {\n            await applyTelegramThreadCapability(\n              ctx,\n              true,\n              \"capability-monitor-retry\",\n              deps,\n              isActive,\n            );\n          }\n          return;\n        }\n        if (threadModeEnabled) consecutiveDisabledProbes = 0;\n        const botState = deps.topicTargetStore.getBotState();\n        const current = botState.threadMode;\n        if (threadModeEnabled && current === \"enabled\") return;\n        if (!threadModeEnabled && current === \"disabled\") {\n          if (\n            !deps.ownsLock(ctx) ||\n            !hasTelegramClassicRestoreFailure(botState)\n          ) {\n            return;\n          }\n          await applyTelegramThreadCapability(\n            ctx,\n            false,\n            \"capability-monitor-disabled-confirmed\",\n            deps,\n            isActive,\n          );\n          return;\n        }\n        if (\n          !threadModeEnabled &&\n          hasTelegramThreadCapabilityBindings(deps.topicTargetStore)\n        ) {\n          consecutiveDisabledProbes += 1;\n          if (\n            consecutiveDisabledProbes <\n            TELEGRAM_THREAD_CAPABILITY_DISABLED_CONFIRMATION_PROBES\n          ) {\n            deps.recordEvent(\"bus\", \"Telegram Threaded Mode probe deferred\", {\n              phase: \"capability-monitor-disabled\",\n              reason: \"active-thread-bindings-present\",\n              consecutiveDisabledProbes,\n            });\n            return;\n          }\n        }\n        await applyTelegramThreadCapability(\n          ctx,\n          threadModeEnabled,\n          threadModeEnabled\n            ? \"capability-monitor-enabled\"\n            : consecutiveDisabledProbes >=\n                TELEGRAM_THREAD_CAPABILITY_DISABLED_CONFIRMATION_PROBES\n              ? \"capability-monitor-disabled-confirmed\"\n              : \"capability-monitor-disabled\",\n          deps,\n          isActive,\n        );\n      })\n      .catch((error) => {\n        if (isActive()) deps.recordEvent(\"bus\", error, { phase: \"capability-monitor\" });\n      })\n      .finally(() => {\n        if (isActive()) transitionPending = false;\n      });\n  };\n  return {\n    start(ctx) {\n      stop();\n      interval = setInterval(() => {\n        check(ctx);\n      }, intervalMs);\n      interval.unref?.();\n    },\n    stop,\n  };\n}\n"
      ]
    ]
  }
];

const versions = [
  ["node_modules/@earendil-works/pi-coding-agent/package.json", "0.84.1"],
  [".pi/npm/node_modules/@llblab/pi-telegram/package.json", "0.27.12"],
];
for (const [path, expected] of versions) {
  if (JSON.parse(readFileSync(resolve(root, path), "utf8")).version !== expected) {
    throw new Error(`Telegram observability patch version mismatch: ${path}`);
  }
}
const check = process.argv.includes("--check");
const restore = process.argv.includes("--restore");
const prepared = patches.map(patch => {
  const path = resolve(root, patch.path);
  const text = readFileSync(path, "utf8");
  const hash = digest(text);
  if (hash !== patch.before && hash !== patch.after) {
    throw new Error(`Telegram observability patch source mismatch: ${patch.path}`);
  }
  if (check && hash !== patch.after) {
    throw new Error(`Telegram observability patch missing: ${patch.path}; run node extensions/observability/telegram-turn/patch.mjs`);
  }
  let next = text;
  if (restore && hash === patch.after) {
    for (const [before, after] of [...patch.replacements].reverse()) {
      next = next.replace(after, before);
    }
  } else if (!restore && hash === patch.before) {
    for (const [before, after] of patch.replacements) {
      next = next.replace(before, after);
    }
  }
  const expected = restore ? patch.before : patch.after;
  if (!check && digest(next) !== expected) {
    throw new Error(`Telegram observability patch verification failed: ${patch.path}`);
  }
  return { path, text, next };
});
if (!check) {
  for (const { path, text, next } of prepared) {
    if (text === next) {
      continue;
    }
    const temporary = `${path}.telegram-observer.tmp`;
    writeFileSync(temporary, next, { mode: 0o600 });
    renameSync(temporary, path);
  }
}
console.log(`Telegram observability patch: ${check ? "verified" : restore ? "restored" : "applied"}`);
