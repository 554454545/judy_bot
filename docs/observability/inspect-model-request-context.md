# 上下文观测查询规则

用户询问模型实际收到的内容、System Prompt、注入的上下文、历史、回复、工具、缓存或费用时，读取本说明，再查询项目私有观测文件。

## 数据来源

记录位置：`/home/judy/workspace/bot/.pi/agent/observability/<北京时间>_<session-id>.jsonl`。每个 session 一份，每行一条 JSON 记录。

`providerPayload` 是观测文件中请求记录的字段，不是另一个数据源。直接读取 observability，再查询其中字段；不需要另存一份请求，不向供应商额外查询，不为了查看记录重新调用模型。

## 如何定位

1. 用户指定会话、问题或时间时，按指定条件定位；否则按请求记录的 `at` 找最近一次请求，不能只看文件修改时间，因为重启和状态事件也会修改文件。
2. 找 `stage: "request"` 的记录，确认 sessionId、requestId、时间和用户消息。报告中把 UTC 时间转换为北京时间；不要改写历史记录。
3. 一轮可能有多个模型请求，工具执行后会再次请求。需要整轮时查看全部相关请求，不能只展示最后一次并称为整轮。
4. 找同一 `requestId` 且 `stage: "response"` 的记录查看回复和用量。没有对应回复时明确说明尚未记录到完成，不猜测原因或结果。

## 字段对应

| 用户想查看 | 读取字段 |
| --- | --- |
| Pi 内部 System Prompt | request.systemPrompt |
| 实际交给 SDK 的 System Prompt | request.providerPayload.messages 中的 system/developer 消息；其他协议查看相应字段 |
| 实际发送的问题、历史和工具结果 | request.providerPayload.messages；其他协议查看 input 等实际字段 |
| 工具定义 | request.providerPayload.tools |
| 模型及请求参数 | request.model、request.providerPayload 的其他字段 |
| 模型正文、工具调用及结束原因 | response.assistantMessage |
| 归一化 token 用量和费用估算依据 | response.accounting、request.model.catalogCostPerMillionTokens |
| 工具耗时、HTTP 状态、生命周期 | 对应阶段事件 |

动态召回目前为持久追加的 `memory-recall` 自定义消息；供应商转换后在 input/messages 中表现为包含 `<recalled-memory>` 的 user-role 内容。历史旧记录仍可能将召回放在 systemPrompt 中，按请求时间确认。

调查 Codex 缓存未命中时，还要查同 requestId 的 `provider_transport`：send.providerPayload 是最终 SSE JSON／WebSocket 帧，可能已经被 Pi 改为 previous_response_id 加增量消息。比较完整 request.providerPayload 用于核查上下文，检查 transport 用于核查实际发起的发送、连接复用、重试和回退；两者不能互相替代。该记录不包含原始网络字节或供应商接收证明，旧记录没有这些事件时无法事后补出。

响应元数据读取 `response.providerResponseMetadata`，包括实际 model、serviceTier 和 promptCacheDiagnostics。诊断不存在或 null 时保持原因未知；当前只被动保存返回字段，没有启用官方比较诊断参数，不能假定 ChatGPT Codex 后端支持它。原始缓存用量仍读取 accounting.providerRawUsage，不用诊断的估算 token 替代 usage。

`systemPrompt` 不包含 user 消息。用户问“模型收到的全部内容”时，要检查整个 providerPayload，包括消息、工具定义及请求参数。contextMessages、state.providerPayload 等摘要不能代替完整的 request.providerPayload。

## 回答要求

- 以实际请求快照为依据，不从回复或原生 sessions 历史反推。先确认问题对应的请求，给出时间与会话，防止把旧请求说成当前配置。
- 用户要原文或全部内容时，展示对应字段完整内容，不用省略号、占位符或总结替代。只问某个字段时只提取该字段，避免无关历史进入输出。
- 如果 Pi 内部 System Prompt 与最终 Provider 字段不同，分别说明，不能默认一致。
- 保存的 payload 是交给 SDK 的请求对象，不是 HTTP 字节或供应商接收证明；SDK 内部重试可能复用一次快照。
- 常见凭据已脱敏，data URL 内容省略并留指纹，普通文本未截断；不能声称记录包含被省略的二进制内容或所有原始数据。
- 用量同时查看 response.accounting.normalizedUsage 与 providerRawUsage。新接入的 Responses / OpenAI 兼容 Completions 请求会保存归一化前的原始 usage；旧记录或未覆盖协议的 providerRawUsage 仍为 null。缺失的缓存字段可能被 Pi 归一化为零，不能证明供应商明确报告了零；费用是按记录的模型目录价格估算，不是实际账单。
- 观测记录是私有资料，不公开、不发布；读取和展示用户请求范围内的内容，不输出凭据。

## 记忆模块的模型调用

同一个 session 的 JSONL 还包含 `memory_request`、`memory_response`、`memory_error`、`memory_task` 和 `memory_notification`（旧记录中仍可能有 `memory_decision`）。`source` 区分 `memory.filter`（筛选）、`memory.mem0.llm`（mem0 内部模型）和 `memory.mem0.embedding`（向量模型）。用 `sessionId`、`operationId`、`requestId` 关联，不能只查普通 Pi 的 request/response 就声称费用完整。

请求查看 `providerPayload`，响应查看 `providerResponse`，供应商返回用量查看 `rawUsage`。价格未配置时 `cost` 为 null，`costStatus` 为 `unknown_missing_price`；不能当作零费用。缓存命中只能依据实际 usage 字段；未返回的字段保持未知。Python 边界为 OpenAI SDK 的 create 方法，SDK 内部 HTTP 重试未逐次记录，保存的是解析后的响应而非 HTTP 字节。记录写入失败不会阻断业务，stderr 会提示失败；请求无对应响应时可能仍在执行、超时或进程退出，不猜测。

当前只适配项目配置中的 OpenAI 兼容 LLM 和 Embedding 后端。额外手动运行 CLI 若没有传入 session 观测环境不会写入会话记录。直接调用其他模型、原生压缩摘要等仍需单独接入。

自动沉淀任务用 `taskId`、`sourceMessageId` 关联原用户消息；`memory_task.taskState` 记录筛选、写入、核对和通知的状态，`attempts` 记录各阶段次数，`result.ids` 保存完整记忆 ID。`rejected` 是明确不保存；`filter_blocked`、`write_blocked` 是处理失败；`write_needs_review` 和 `notification_unknown` 表示结果不明确，不能当作未写入或未发送。同一任务重试与重启后继续使用原 `operationId`，原 session JSONL 内能查看全部状态变化。任务和写入凭据的私有目录及恢复规则见 [上下文接入规则](context-pipeline.md)。

会话摘要保存失败记录为 `stage: "memory_recap_error"`、`source: "memory.recap"`，写入原 session 的 JSONL；`targetFile` 为摘要目标文件，`errorType` 和 `errorCode` 为错误类型及系统错误码。该事件不含摘要正文，不阻断模型回复。缺少有效 session 或观测文件也无法写入时，通过 stderr 的 `Session recap write failed`／`Memory observability write failed` 提示排查；没有错误事件不能单独证明保存成功。

## Telegram 回合尾部与全链路耗时

按 `telegramTurnId` 关联 TG 队列项与普通 request/response，查询 `telegram_turn_start`、`telegram_span`、`telegram_model_end`、`telegram_transport_attempt`、`telegram_transport_ack`、`telegram_turn_end` 及错误事件。尾部显示值读取 telegram_turn_end.displaySummary / footer（旧记录使用 summary）；逐阶段读取 spans 和 stages。`occupiedMs` 是同名阶段区间并集，嵌套或并行阶段不可相加冒充总耗时。

页脚时间截止到最终回复发送前拼装；正文和统计一起投递，不事后编辑。实际最终正文/附件的 Telegram API 确认耗时读取 summary.elapsedMs，界面值读取 displaySummary.elapsedMs，不能混用，也不是手机收到回执。原始 message.date 只有秒精度，显示不加近似符号但测量精度不变。旧记录可能包含 footer_edit。ctx 是最近主模型请求的输入上下文占用率；↑/↓ 是该 TG 回合所有主模型请求之和，不包括记忆模块调用。字段缺失保持未知。出现 interrupted 或提交状态未知时，不推断发送成功，也不把跨进程时间拼成完整耗时。实现、观察范围与维护方法见 [Telegram 回合统计说明](../../extensions/observability/telegram-turn/README.md)。

## 后台任务最终交付的统计

后台报告不走普通 TG 提问的最终发送函数。先按真实 `taskId/runId` 查对应登记根目录的 `runs/<task>/<run>/final-report-receipt.json.observability`：`source` 是不可变原始 TG 身份，`sourceRecordFile` 是原始派发 session 的观测文件，`reviewSegments` 指向各验收 session 的观测文件。前台 `/pi_new` 后仍按这些引用查证，不能只读当前 session。

`observability.prepared.summary.requestIds` 是显示数字实际累计的请求集合。逐个到上述 JSONL 查 `request/response` 与原始 `response.accounting.providerRawUsage`；验收请求带有匹配的 `backgroundTask.taskId/runId/reviewId`，不通过正文关键词匹配。统计范围是原始 TG 派发回合加该 run 的主 Pi 验收请求；Coding Agent、记忆和压缩调用另查各自记录。ctx 取最后一个验收请求，初次派发回复的页脚不能代替最终报告累计用量。

最终界面值读 `observability.prepared.summary` 或 `background_footer_prepared.summary`；实际 API 确认时间读 `background_delivery_end.confirmedTiming`，来源不是手机回执。时间检查同时核对 Telegram HTTP Date 校准、Linux boot_id、单调接收/准备/发送确认锚点。缺证据保持未知，不拿 WSL 本地墙钟直接减 TG 发送时间。准备后重试不重算界面值；确认日志仍记录实际最终耗时。

阶段记录在 `prepared.summary.stages` 与 `background_delivery_end.finalDeliveryMs`，按字段的范围解释，不能把重叠区间相加。完整原文、分块和真实 message_id 保存在同一 receipt 与发送账本中；hash、分块总数和 success 要一起查，不能因第一块成功就认定完整报告已交付。
