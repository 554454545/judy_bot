# Telegram 回合统计与全链路时间

实现集中在本目录，由 `../index.ts` 注册。运行记录仍追加到 `.pi/agent/observability/<北京时间>_<session-id>.jsonl`，每个 session 一份，不另建回合日志文件。普通 TG 提问完成后追加统计尾部，`/` 命令不追加；尾部由程序生成，不注入模型上下文，也不写进模型回复历史。

## 文件与加载

| 文件 | 职责 |
| --- | --- |
| `index.ts` | 注册 Pi 事件，关联真实 TG 队列回合，记录阶段，发送前拼装尾部，投递后记录确认 |
| `statistics.ts` | 解释原始 usage、累加本轮请求、合并重叠区间、格式化尾部 |
| `patch.mjs` | 维护项目内安装包的最小观察点；校验版本和完整文件 SHA-256 后才修改 |
| `README.md` | 统计口径、查询方式和维护约定 |

Pi 加载现有 `extensions/observability/index.ts`，该入口调用 `registerTelegramTurnObservability()`。本目录没有作为第二个独立扩展加载，辅助文件也不会逐个自动注册。

现有上下文总入口和记忆来源循环各增加一个计时调用，仍使用原来的组装顺序。观测与维护补丁在本目录；前台回复策略在 `src/telegram/final-reply-only.ts`。验证代码按项目约定放在 `tests/observability/telegram-turn.mjs`，结果放在 `.pi/agent/logs/observability/telegram-turn-verification.json`。

## 尾部数字的口径

示例仅说明格式，数字以实际记录为准：

```text
────
⏱ 21.3s · tokens ↑7.9k ↓184 · openai-codex/gpt-6.1sol · thinking low · ctx 4.5% / 1050k · tools 4
```

- **时间**：页脚为 TG 原始消息 `message.date` 到最终回复发送前拼装统计的耗时。答案和尾部在 Markdown/HTML 渲染、分块前拼好，共用最终投递，不再事后编辑；答案末尾只保留一个换行，紧接 `────`。实际正文/附件 Telegram API 确认后的完整耗时保存在 `telegram_turn_end.summary.elapsedMs`，显示值保存在 `displaySummary.elapsedMs`，二者口径不同。使用 getUpdates HTTP Date 校准接收时间，保留原始时间和偏差；协议只有秒精度，存在网络延迟不确定性，界面不加近似符号。本机阶段耗时使用 `performance.now()`。
- **↑**：本 TG 回合所有主模型请求的未缓存输入 token 之和。Responses 用 `input_tokens - input_tokens_details.cached_tokens - 单独的 cache_write_tokens`；Completions 用对应的 `prompt_tokens` 字段，并支持项目 DeepSeek 返回的 `prompt_cache_hit_tokens`。没有明确返回缓存读字段时显示 `?`，不拿 Pi 自动填充的零证明没有命中。原始协议不定义独立 cache-write 桶时不虚构这一桶；兼容接口显式返回时按安装版 Pi 的映射扣除。
- **↓**：同一范围的 `output_tokens` / `completion_tokens` 之和，包括工具调用前的输出。这些协议的输出总数已经包含 reasoning token，不再重复加上 reasoning。
- **ctx**：最后一个实际主模型请求报告的总输入 token（包含缓存命中）除以该请求模型的 `contextWindow`。这是**最近请求的输入上下文占用**，不是本轮所有请求之和，也不是追加最终输出后的未来请求预测。token 和上下文上限显示为 k（不足 1000 显示整数，整百万显示 M），日志继续保留完整整数；百分比四舍五入到一位小数。上下文上限取实际模型配置，不能写死为 272k。缺少原始输入用量时显示 `?`。
- **tools**：本回合触发 `tool_execution_start` 的次数。Pi 在并行工具模式中于预检阶段发出此事件，工具阶段包含该预检及等待时间。
- **模型和 thinking**：最后一个实际请求的模型与 Pi thinking 设置，切换模型后随请求更新。

记忆筛选、mem0 内部 LLM、Embedding 的 token 与费用继续保存为原有 `memory_*` 记录，不混进主模型箭头。自动压缩内部摘要调用没有纳入这两个箭头。目录价格估算仍保留在原有 response.accounting 中；没有价格依据的记录保持未知，不伪造费用。

[Telegram 官方 Message 定义](https://core.telegram.org/bots/api#message) 的 date 是 Unix 秒；[sendMessage](https://core.telegram.org/bots/api#sendmessage) 返回发送结果。Bot API 没有提供对方手机收到或显示该消息的回执，因此这里不能宣称测到了手机端最终收到的时刻。

长正文沿用桥接的渲染及分块，不截断正文；超过 Telegram 单条消息上限时仍需要分块发送。rich 渲染也接收包含统计的最终文字。仅附件且无正文时不额外发送统计。正文与尾部共用发送失败记录，保留 `telegram_delivery_error`，不事后补发或编辑。

## 关联与阶段

`telegramTurnId` 来自实际桥接队列项，不通过问题文本匹配。`telegram_turn_start` 保存 update ID、chat ID、源 message ID、回复目标、队列顺序、原始发送时间和本机收到时间。每个 `request` / `response` 同时携带 `telegramTurnId` 与原有 `requestId`。合并进同一队列项的消息按最早发送时间计算总耗时。

| 阶段 / 事件 | 观察范围 |
| --- | --- |
| `inbound_prepare` | 本机进入原始 update 处理，到构建并接纳队列项，包含入站整理及批处理等待 |
| `queue` | 接纳队列项，到实际派发该项给 Pi |
| `prompt_prepare` | 派发，到 before_agent_start 链完成，包含规则及记忆组装 |
| `context.assemble` | 项目 System Prompt 组装 |
| `context.memory.personal-memory` | 静态记忆读取与规则来源调用 |
| `context.memory.recall.personal-memory` | 本轮动态召回，返回持久记忆消息 |
| `context.memory.session-recap` | recap 规则来源调用 |
| `model_prepare` | context 观察点，到供应商 payload 观察点 |
| `model_request` | 每个实际 payload 观察点，到对应主模型回复完成，包含供应商内部重试等待 |
| `telegram_model_headers` | 能观察到时记录 HTTP 响应头到达；WS 等未提供该事件时不补猜测值 |
| `telegram_model_end` | 请求结束、原始用量解释、首个内容/首个文字 delta 相对请求开始的时间 |
| `tool` | 每个工具 start 到 end，包括失败与并行工具 |
| `final_render_and_wait` | 桥接 agent_end 处理开始，到进入最终投递，包含归一化及前置等待 |
| `delivery` | 最终正文及附件的投递工作 |
| `telegram.api.<method>` | 桥接 API 调用含重试的耗时 |
| `telegram_transport_attempt` / `telegram_transport_ack` | 实际 Telegram 调用尝试及成功确认，包含输出 message ID |
| `telegram.retry_wait` | Telegram 限流/传输重试等待 |
| `telegram_footer_prepared` | 最终回复渲染/发送前保存页脚显示值 |

`telegram_span` 持续落盘，保存相对本机收到消息的 `startMs`、`endMs`、单调时钟 `durationMs`、状态和关联信息。`telegram_turn_end` 保存汇总、全部区间、请求 ID、正文和尾部的确认时间及输出消息 ID；`stageCoverage` 给出本机正文耗时、已观察区间并集和未归属时间，不用已知阶段凑出假总数。发送至本机接收的估算单独保存在 `senderToBotEstimateMs`。日志显示时间采用北京时间 `+08:00`；原始 Unix 时间戳与供应商 usage 保留协议值。

`stages.<name>.occupiedMs` 是该阶段区间的并集，`summedMs` 是各次调用之和。嵌套阶段与并行阶段会重叠，**不能把所有 occupiedMs 相加当作总耗时**。供应商 SDK 内部的重试细节并非所有协议都暴露；目前统一包含在 `model_request` 中，不能把它误称为纯模型计算时间。入站发送至本机接收的跨端等待只能依据原始 date 估算，不能细分为上传、Telegram 排队和设备网络耗时。

## 失败与重启

发送失败或提交状态未知留下 `telegram_delivery_error`，不会计为已确认成功；分块只成功一部分时标记 `partial_delivery_or_unknown`，不显示假完成时间。最终回复不再单独补发尾部。会话退出/切换给未完成的回合写 `interrupted_runtime_shutdown`。硬退出无法运行清理时，恢复该 session 会扫描已有开始/结束记录，把缺少结束记录的旧回合标记为 `interrupted_previous_runtime`；其最终投递结果和总耗时保持未知，不跨进程拼接单调时钟，也不自动重发旧消息。未恢复的 session 原有未完成记录保留，查询时不能当作成功。

## 安装包观察点维护

Pi 正式扩展事件没有提供原始供应商 usage 和 TG 队列/投递确认。为实现本次已授权的精确观测，本目录维护针对 **Pi 0.84.1、pi-telegram 0.27.12** 的项目内观察点补丁，限定为：

- pi-telegram 的 `lib/updates.ts`、`lib/queue.ts`、`lib/telegram-api.ts`：原始更新、真实队列、最终投递、API 尝试/确认/重试等待。
- 项目 Pi 内嵌 pi-ai 的 `dist/api/openai-responses-shared.js`、`dist/api/openai-completions.js`：归一化之前把 usage 关联到原 assistant 对象。Responses 公用解析器同时覆盖 SSE 和 WebSocket。
- 同一 pi-ai 的 `dist/api/openai-codex-responses.js`：记录 Codex 最终 SSE JSON／WebSocket 帧、连接复用、增量续接、HTTP 重试和 WS 回退；不修改请求参数或重试行为。

观察点通过进程内 `Symbol.for("bot.observability.telegram-turn")` 连接本目录，不改请求、提示词、模型配置或普通对话内容。原始 usage 只保存在原有私有 response.accounting.providerRawUsage 中。当前支持 Responses（包括 openai-codex）和 OpenAI 兼容 Completions；其他协议缺少原始证据时显示未知。

### 缓存与传输诊断

同一 session JSONL 的 `provider_transport` 按 `requestId` 关联普通请求，适用于本地 RPC／TUI 和 TG。`phase` 为 connect、send、headers、retry_wait、retry、failure 或 fallback，`transportAttempt` 为该逻辑请求的传输尝试序号，`requestElapsedMs` 为请求观察点起的本地单调耗时；各事件时间差不能当作精确供应商处理耗时。

- SSE send 保存压缩前的最终 JSON、内容编码和尝试次数；headers 仅保存 HTTP 状态、请求 ID、处理耗时、重试等待与日期的白名单字段，不保存认证或 Cookie。
- WebSocket send 保存传给 socket.send 的 JSON 帧，以及连接是否复用、完整与实际发送的 input 数量、previousResponseId。Pi 可能把完整输入改为 previous_response_id 加增量输入；SDK 前的 request.providerPayload 与传输边界快照因此可能不同。
- send 表示发起发送，不是供应商接收证明；不保留 TLS 字节或 zstd 二进制。WS 握手响应头及服务端路由／缓存机器状态仍未观测。没有独立 send 完成回执，最终响应才提供完成证据。
- Responses 的 response.providerResponseMetadata 保留供应商实际返回的 responseId、model、serviceTier、status 和 promptCacheDiagnostics。缺失字段为 null；promptCacheDiagnosticsPresent 区分字段未出现和显式返回 null。仅保存这些元数据，不复制完整输出到另一个文件。
- 未启用 comparison_response_id 或其他新缓存参数；ChatGPT Codex 后端是否支持官方 API 的诊断参数尚未验证。没有诊断时不能推断具体未命中原因，亦不能从 cache_write_tokens 为 0 推断没有建立物理缓存。
- 观察点写入失败不改变模型调用；仍使用私有写入和脱敏规则。用量解释与 TG 页脚保持原逻辑。

启动前 `start.sh` 执行 `--check`。重新安装依赖后，源码与记录的原版哈希完全一致时，在项目根目录运行：

```bash
node extensions/observability/telegram-turn/patch.mjs
```

脚本先核对所有目标的版本和 SHA-256，再写入；重复执行幂等，未知改动拒绝覆盖。不要用本补丁更新依赖，也不要应用到全局 Pi。`--restore` 仅反向恢复本补丁；恢复后当前启动校验会拒绝缺失的观察点，不能当作功能仍然可用。

Pi 事件口径依据 [0.84.1 官方扩展说明](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/docs/extensions.md) 和项目安装版源码；以后调整接口时先核对安装版本。

## 输入状态与网络诊断

`src/telegram/final-reply-only.ts` 对后台控制回合隐藏模型正文，但向安装版桥接传递空 messages 的 `agent_end`，让其照常停止 typing、清理活动状态并接续队列。不能通过跳过整个事件隐藏正文，否则会留下定时器。`patch.mjs` 同时维护 typing 的观察点和 capability-monitor 的会话代次围栏：停止后到达的 getMe 结果、能力转换内部 await 的后续步骤不能访问旧 ctx；新 session 可以建立自己的检查。

同一 session 观测文件可查 `telegram_typing_start`、`telegram_typing_stop`、`telegram_typing_api_confirmed` 和 `telegram_transport_error`。网络失败只保存方法、错误类型与底层 cause/aggregate code，不保存错误 message、请求正文或凭据 URL。正常取消与失败类型分别留证据，不将 aborted 自动归为网络故障。回归入口为 `tests/telegram/lifecycle.mjs`，不会调用模型或 Telegram。

## 后台任务完成通知

后台完成通知由 [.pi/extensions/background/notifications/relay-notify.ts](../../../.pi/extensions/background/notifications/relay-notify.ts) 调用本目录的观测实现，复用 `statistics.ts` 的格式化函数。这里的 `beginBackgroundReview()`、`prepareBackgroundDelivery()` 和 `confirmBackgroundDelivery()` 是项目自定义方法，不是 Pi 官方事件。没有增加独立扩展、模型工具或另一套统计配置。

- **关联范围**：从登记表的 `originalRequest` 读取原始 TG session、turn、chat、message 和发送时间；实际验收控制消息通过对象身份关联 `taskId/runId/reviewId`。原始派发回合与本次 run 的验收请求可以分属不同前台 session。其他聊天、其他 run、Coding Agent、记忆模型及压缩调用不混入箭头。
- **用量**：↑/↓ 累计原始 TG 派发回合和本 run 主 Pi 验收的实际请求，按 `requestId` 去重；ctx、模型和 thinking 来自最后一个真实验收请求。tools 按 session、requestId 和 toolCallId 去重。缺少对应请求/回复或原始缓存字段时，受影响的数字显示 `?`，不补零。
- **时间**：页脚截止到最终报告准备完成，起点是原始 TG 任务消息的 `message.date`，包含派发、后台等待与验收。接收锚点必须有 Telegram HTTP Date 校准；同一次系统启动使用保存的接收单调时钟加后续单调时间差，WSL 墙钟跳变不参与相减。换进程保留相同 boot_id 可继续；换系统启动需新的 Telegram 时钟校准，否则显示 `?`。Telegram 时间仍只有秒精度，也没有手机回执。
- **发送确认**：`background_delivery_end.confirmedTiming.elapsedMs` 截止到独立发送器解析真实 Telegram API 响应；发送器保存 Linux boot_id 和 monotonic_ns。它与页脚截止时刻不同，不能把页脚写成手机收到时间。
- **恢复**：来源、验收段和已准备的原始正文/统计快照放在现有 `runs/<task>/<run>/final-report-receipt.json.observability`。准备后正文、尾注和分块固定，恢复/重试沿用原内容；显示时间也不重算。实际重试后确认耗时另存日志。重启前尚未准备的 run 则合并已有验收段的请求，不能丢掉已发生的用量。
- **正文**：先把完整交付正文与尾注拼好，再沿用 Telegram HTML 渲染与分块，分隔线上方只有一个换行。超过单条限制时，各块有持久回执；全部块确认后才算交付，已成功的块不重发，unknown/sending 保留对账。取消了此前 3000 字符和只取第一块的截断。

同一 session JSONL 新增 `background_review_start`、`background_footer_prepared`、`background_delivery_end`。`background_footer_prepared.summary.stages` 保存初次派发回复 API 确认耗时 `dispatchReplyMs`、实际 Herdr 派发/等待耗时 `codingAgentMs`、验收到报告准备耗时 `reviewPreparationMs`；最后事件另存准备到最终 API 确认的 `finalDeliveryMs`。范围可能重叠，不能相加作为总耗时；旧证据或跨多次中断无法核实的阶段保留 null。

迟到结果使用独立的 `runs/<task>/<run>/late-<结果 hash 前16位>/final-report-receipt.json`，不会复用旧失败正文或已冻结的统计。此时 `codingAgentMs` 来自本轮 Codex 原生 `task_complete.duration_ms`，`codingAgentDurationSource` 标注来源；原超时监督等待证据仍保留。页脚的时间格式与截止点保持原来的发送前口径，不在发送后编辑。

回归入口为 [background-delivery.mjs](../../../tests/observability/background-delivery.mjs) 和 [delivery-footer-live.mjs](../../../tests/background/delivery-footer-live.mjs)。实际证据、失败尝试及校正后的独立复核见 [re.md](../../../re.md) 第 6 节。
