<!-- 用途：积累可复用的前台测试用例与验收方法；保留既有经验，原始执行证据留在项目私有运行目录。 -->
# 前台对话测试问题

## 1. 使用与记录规则

- 后续对话测试先读取本文件，从与改动相关的用例中选题；通用检查使用第 2 节的连续对话，不临时随意换题。
- 每次开始先新建独立 session，确认 sessionId 与旧会话不同。每题等最终回复完成后再发下一题，最后问一个需要联网的问题。跨会话用例按说明另外新建 session。
- 使用项目本地 Pi 和当前真实配置。RPC 可以验证模型、上下文、工具和记忆；Telegram 菜单、发送、页脚、排队和时间必须在 TG 链路单独验证，不能用 RPC 结果冒充。
- 按 [查看模型实际请求上下文](docs/observability/inspect-model-request-context.md) 检查实际 providerPayload 和原始 usage；不能只看回复正确就认定上下文、缓存和记忆正常。
- 固定用例编号，遇到新问题补充复现问题和预期，不删除旧经验。区分“当前行为已验证”和“希望修复后的预期”；失败不自动授权修改。
- 本文件维护可复用的测试问题、复现步骤和验收方法；缺陷详情及单次过程与结果按用户要求留存。完整请求与回复留在每个 session 的私有观测 JSONL，原始执行证据留在对应功能的 `.pi/agent/logs/` 下。
- 执行记录注明北京时间、执行入口、sessionId 与证据定位，区分通过、失败和未验证。缺少字段写未知；缓存首次未命中不能单独判失败，append-only 也不保证供应商每次命中。下方既有执行记录和 problem.md 引用保留为历史。
- 测试沿用用户已授权的范围，不修改全局 Pi，不打断已有 TG 实例。需要写入、纠正或删除记忆的用例使用明确标注的测试事实，并先核对操作授权；本清单本身不授权删除数据。

## 2. 基础连续对话：上下文与缓存

在同一个新 session 中依次提问：

| 编号 | 原样提问 | 检查重点 |
| --- | --- | --- |
| C01 | `1 + 1 = ？只回答答案。` | 回答 `2`；记录首轮输入、输出、缓存字段与实际记忆位置。 |
| C02 | `我是谁？简短回答。` | 当前已保存的称呼应能召回；本项目现有事实对应 Judy。检查召回确实进入本轮请求，不能只凭回答认定召回成功。 |
| C03 | `2 + 2 = ？只回答答案。` | 回答 `4`；比较前几轮请求的完整历史前缀与原始缓存用量。 |
| C04 | `请联网查询武汉大学的官方英文名称，给出官网来源链接。简短回答。` | 实际执行联网工具，回答 `Wuhan University` 并附官网链接；检查工具结果后的全部请求，不只检查最终一次。 |

共同验收：

- 普通连续回合的 `instructions` / System Prompt 保持一致，工具定义保持一致。
- 前一请求的完整 `input` / 消息数组是后一请求的原样前缀；压缩、主动分支或更换配置须另行说明，不能混作普通回合。
- 顺序为：固定 System Prompt → 旧历史 → 当前问题 → 本轮召回记忆 → 回答或工具调用。召回作为 `memory-recall` 持久消息保留，不能每轮替换历史中的旧召回。
- 同一用户回合的工具循环不重复追加本轮召回；下一用户回合可以追加新的召回。
- 输入总量、缓存命中和未命中分开记录，以供应商原始字段为准；输入总量增长不等于缓存失效。
- 缓存异常时关联 `provider_transport`，核对最终发送体、连接复用、增量续接、重试与回退，以及响应实际模型、服务等级、缓存诊断。只有前缀相同不能保证命中；诊断缺失时不得猜测服务端原因。旧记录未采集的传输信息不能事后补出。

## 3. 记忆问题的复现与回归

| 编号 | 提问或操作顺序 | 预期与已知限制 |
| --- | --- | --- |
| M01 | 新 session 问 `1 + 1 = ？只回答答案。` | 用于复现无关召回。希望普通计算不注入个人偏好；当前仍会注入，属 [问题 1](problem.md)，尚未修复。 |
| M02 | 新 session 问 `我喜欢什么样的天气？` | 应召回数据库里实际存在的天气偏好；当前样例为朦胧的小雨天。检查本轮召回与事实来源，不能凭历史猜。 |
| M03 | 获准后说 `这是一条测试事实：测试代号是 context-test-001，请记住。`，等待沉淀完成；另开 session 问 `我的测试代号是什么？` | 核对筛选、写入、核对、召回各阶段以及完整记忆 ID；通知成功不等于已核实写入。测试事实可能真实持久化，事先说明。 |
| M04 | 对获准保存的测试事实进行重复提及、明确纠正，再另开 session 查询 | 观察是否重复或矛盾，不预设当前实现会合并；另查 `.mem0/user.md`、`.mem0/memory.md` 是否更新。静态文件自动维护仍属 [问题 2](problem.md)。 |
| M05 | 用户明确指定并授权删除测试记忆后，按完整 ID 删除、核查数据库，再另开 session 查询 | 其他条目必须保留；区分删除失败、再次沉淀、旧历史仍包含记忆。删除入口缺口见 [问题 3](problem.md)，当前不能标为通过。 |
| M06 | 连续问 C01—C04，查看每轮 recap 落盘 | 区分模型写的摘要与兜底摘要；核对 session 对应文件、增量记录和失败事件，不能因 TG 没显示摘要就认定未保存。 |

## 4. Telegram 专项检查

| 编号 | 操作或问题 | 检查重点 |
| --- | --- | --- |
| T01 | TG 发 `/pi_new`，收到完成通知后问 C01 | 确认新 sessionId、旧会话保留、完成通知和后续问答正常；命令回复不附普通消息统计页脚。 |
| T02 | TG 问 C01 | 答案与页脚一次发送；`────` 上方无多余空行，无人为奇怪换行；token 用 k，整百万窗口显示 M。 |
| T03 | TG 连续快速发 C01、C02、C04 | 检查队列顺序、回复关联和每条消息独立统计，不能将上一条的时间或用量串到下一条。 |
| T04 | TG 问 C04 | 只发送最终答复，工具前后的过程说明不逐条推送；统计包括本轮全部主模型请求和工具调用。 |
| T05 | 新 session 在 test 发一条可独立验收的项目任务，派发后再 `/pi_new`，等待后台最终报告 | 原始 task/run、TG 身份和永久 Codex UUID 不变；跨前台 session 能累计派发与该 run 验收的原始用量。报告说明成果、依据、用法与限制，正文和尾注一起发送，不截断。 |
| T06 | 离线观测回归中模拟 WSL 校时、进程重启、证据缺失和长报告重试 | 同 boot 单调时间不随墙钟跳变；缺校准/响应/缓存证据的受影响字段未知。已准备正文和尾注不重算，分块全部成功才签收，unknown 不重发。 |
| T07 | 连续提交不同项目任务，派发后换前台 session，等待最终报告 | 完成报告引用对应的原始 TG 提问，不引用最近一条聊天；核对 originalRequest.telegram.messageId、final-report-receipt.json.reply_to_message_id 与 API confirmed_reply_to_message_id。重试及分块不换引用目标，原消息删除时仍送达并记录引用缺失。 |

时间验收必须分清：页脚截止到最终回复发送前拼装；日志 `summary.elapsedMs` 截止到 Telegram API 确认，二者通常不同。没有手机收到回执，不能写成精确测得手机接收时间。检查校准与不确定性，不用 TG 原始发送时间直接减有偏差的本地墙钟。

## 5. 已积累的验证经验

### 项目归档与禁止再次派发（Issue #44）

- 仅在用户指定并授权归档的测试项目上执行。前台新 session 说“归档 `<已登记项目名>`”，核对确切 projectId/sourcePath/worktree/native UUID；普通归档方案问答不能触发实际操作。
- 正在执行、等待验收/交付、通知已领取或发送结果未知时，应拒绝归档并说明实际阻塞项；不能强杀客户端、删除写锁、手清占用或自动取消任务。
- 成功后原 workspace 项目目录与工作分支保留；档案中核对隐藏/忽略/未跟踪和未提交成果、暂存区、原生 home/session、任务结果。Bot worktree 的 Git 登记解除，旧通知不再发送，其他项目的绑定/UUID/记录不变。
- 同项目再次要求开发时明确提示“已归档”，没有新任务、绑定或新 session；换 ID 指向同一实际原目录也被拒绝。`resume-codex.sh` 活动列表不再显示该 UUID，常驻恢复和 watchdog 不重启或再唤醒旧任务。
- 中断后再次归档应核对并续办同一档案；有新成果、分支/暂存区变动或未知锁时停止，不覆盖任一版本。重复成功归档返回同一位置，清单损坏不能补造成功。离线入口 `tests/background/project-archive.py`；原始证据留在项目私有运行目录。

### 新项目首次接入与跨项目续用（Issue #24、#10）

- 从已有的新空目录开始，不预先准备 worktree、Agent 配置或原生 session。用日常项目名明确要求制作项目，检查是否直接初始化 Git、建立空基线并继续 project-register、worktree-ensure、project-bind、register/prepare/start-run/run；不应要求额外回复“确认初始化／开始制作”。初始开发原话应直接保存为 originalRequest，不能为了取证制造确认回合。
- 对照边界：缺失目录仍先问创建；空目录仅查看或讨论方案不初始化、不派发；“先准备、不执行”不派发；包含隐藏业务文件不能当空目录，已有 Git 仓库不重新初始化。执行这些行为用例仍须用户指定测试任务，不自行新建项目或派发开发实验。
- 两个项目交替进行创建、存档恢复、机制修改三轮任务；每个项目保持唯一原生 UUID 与独立 CODEX_HOME，两个项目的 UUID 必须不同。换项目后再回到原项目，核对项目名、目录、分支、原话、task/run 与实际 worker session，不能只看回答提到的名字。
- 每轮等独立验收和 TG API 签收完成后再发下一轮。核对新任务没有覆盖旧任务、原生输入一次、真实结果身份、交接 hash、允许范围及项目占用释放。
- 再新建前台 session，原样重发上一条项目需求；核对新的 user entry/message ID 与独立任务身份，但后台仍复用该项目永久 UUID。重复正文不能借用旧消息的取证，也不能新开后台 session。
- 先提需求、再问清边界、再回复“确认”；检查 sourceEntryIds 选择最初问题，确认及澄清单独保留，最终引用不能只指向“确认”。穿插无关问答、分支切换、同文消息与其他 chat/thread 时不能串原话。
- 无效参数和缺少认证必须明确失败，不能提前留下不完整执行配置。失败重试不新建替代 UUID；有效已绑定项目继续保护原参数。入口：tests/background/project-onboarding.py、project-onboarding-live.mjs；原始证据留在项目私有运行目录。
- 首次命名不能只看终端输入成功：核对原生 UUID、`thread/name/set` 回读及实际数据库名字一致，不新增用户输入或会话。额度提醒不能接走自动输入而切换模型；每次核对 `herdr-evidence.json.native_model_settings` 与登记参数，恢复仍使用原 UUID。
- 网络流断开后允许原生有限重试，但不得重派同一业务输入；核对 `native_input_count=1`、真实最终 marker、结果和通知签收，失败仍保留。

### 模型缓存对照用例

新 session 依次发送 `1 + 1 =`、`2 + 2 = ？`、`3 + 3 = ？`、`4 + 4 = ？`、`5 + 5  = ？`、`6 + 6  = ？`，最后再发 `1 + 1 =`。比较模型时使用相同入口、System Prompt、工具和 thinking 设置；分别记录每轮总输入、缓存命中与传输续接。各组 session key、召回结果、回答和执行时间仍有差异，少量样本不能证明哪一个模型的命中率更高。

2026-10-04 用项目 RPC、thinking high 完成 Luna 与 Sol 各七轮：Luna 的命中序列为 `0 / 1536 / 2560 / 0 / 3584 / 3584 / 3584`；Sol 对照为 `0 / 0 / 0 / 2816 / 3584 / 3968 / 3200`。两组固定提示词、工具及其他请求设置一致；各自历史保持追加，后续均复用 WebSocket 并发送两条增量消息，无重试或回退。Luna 也出现命中后归零，说明现象并非 Sol 独有；没有证明具体供应商端根因或模型间概率差异。未验证 TG 投递，未执行联网用例。

证据：[模型缓存对照记录](.pi/agent/logs/observability/luna-sol-cache-comparison.json)。

2026-10-04 另开项目 RPC session，以 `deepseek/deepseek-v4-flash`、thinking high 执行相同七题。原始缓存命中为 `0 / 2944 / 3200 / 3584 / 3840 / 4224 / 4480`；未命中为 `2924 / 302 / 373 / 309 / 377 / 317 / 387`。各轮完整消息前缀保留，请求设置稳定，原始命中／未命中与归一化用量一致；本组没有命中后归零。仅代表本次小样本，不能认定长期稳定，亦不能将供应商及 HTTP／WebSocket 协议差异单独归因于模型。DeepSeek 的 SDK 请求与原始 usage 已观测，但最终发送体和内部重试尚未接入 Codex 专用传输观察点。未验证 TG 投递。

证据：[DeepSeek 缓存记录](.pi/agent/logs/observability/deepseek-cache-comparison.json)。

十轮延长用例：另开 session，依次问 `1 + 1 = ？` 至 `10 + 10 = ？`，每轮等待结束。2026-10-04 使用 DeepSeek V4 Flash、thinking high 验证：十轮回答均正确，消息前缀与请求设置稳定，缓存命中为 `2304 / 2944 / 3200 / 3456 / 3840 / 4096 / 4352 / 4736 / 4992 / 5248`，未命中为 `620 / 271 / 315 / 359 / 275 / 319 / 363 / 280 / 304 / 328`。没有零命中。新 session 首轮也可以命中供应商已有缓存，不能把首轮命中判为带入旧会话；本次首轮实际只有 system、当前问题和本轮召回，无旧 assistant 历史。未验证 TG 投递，未重启已有 TG 进程。

证据：[DeepSeek 十轮记录](.pi/agent/logs/observability/deepseek-ten-turn-verification.json)。

2026-10-04 使用新项目 RPC session、`zai-coding-cn/glm-5.3-flash`、thinking high 执行同样十轮：回答全部正确，原始缓存命中为 `0 / 704 / 0 / 3008 / 3584 / 3904 / 4224 / 4480 / 4800 / 5120`，未命中为 `2728 / 2325 / 3326 / 629 / 347 / 321 / 295 / 334 / 328 / 321`。第 3 轮在已有命中后归零；完整历史消息前缀、System Prompt、工具和其他请求设置均保持一致，原始与归一化用量吻合，不能从本地证据确定供应商端原因。不同模型 tokenizer 与协议不同，不用总 token 数直接比较上下文文本。未验证 TG 投递，已有 TG 进程未重启，默认模型恢复为原值。

证据：[GLM Flash 十轮记录](.pi/agent/logs/observability/glm-flash-ten-turn-verification.json)。

五十轮延长用例：新 session，用 `openai-codex/gpt-6-luna`、thinking high 依次问 `1 + 1 = ？` 至 `50 + 50 = ？`，每轮等待 agent_settled。2026-10-04 本组 50 次请求、50 个答案均正确；只有首轮缓存为 0，后续 49 轮全部有命中。完整历史前缀和固定请求设置保持一致，原始缓存用量与归一化用量一致。全部使用 WebSocket，49 次后续请求复用连接、发送两条增量并准确续接 previous_response_id；未观察到重试、回退。第 50 轮输入 16,168，缓存命中 14,848，未命中 1,320。命中量多轮保持平台后以 1,024 tokens 阶梯增长。本次没有复现此前 Luna 七轮的命中归零，不能据此确定旧现象的后端原因或保证长期稳定。仅验证本地 RPC，未验证 TG 投递；运行中的 TG 实例未重启，默认模型保持原值。

证据：[Luna 五十轮完整记录](.pi/agent/logs/observability/luna-fifty-turn-verification.json)。

2026-10-04 同样新开 session，用 `openai-codex/gpt-6.1-sol`、thinking high 从 `1 + 1 = ？` 至 `50 + 50 = ？`：50 个答案正确，47 轮命中；第 1、2、12 轮明确零命中。第 12 轮总输入 5,657、命中 0，第 13 轮恢复命中 5,504。第 21、37 轮还有较明显的部分命中下降，分别命中 4,608 / 8,212 和 7,168 / 12,758。所有历史前缀和固定参数一致，原始 usage 与统计一致；49 轮复用 WebSocket、两条增量、previous_response_id 准确续接，无观察到的重试或回退，异常轮诊断为 unavailable。第 50 轮总输入 16,482、命中 16,000、未命中 482。累计输入 token 缓存命中比例 89.54%；Luna 对照为 90.24%。两组固定请求字段（排除模型、session key 和消息）相同，但回复、召回和时间不同，不能将该单次差异认定为模型长期概率或供应商端原因。仅验证项目 RPC，未验证 TG 投递；默认模型保持原值。

证据：[Sol 五十轮完整记录](.pi/agent/logs/observability/sol-fifty-turn-verification.json)。

### 2026-10-04：动态召回改为持久追加后的真实验证

- 入口：项目 `start.sh --mode rpc`，新建 session 后执行 C01—C04；真实模型为 `openai-codex/gpt-6.1-sol`。未验证 TG 投递。
- sessionId：`01a1053b-df81-776c-aecb-21a77353160b`。
- [执行结果](.pi/agent/logs/memory/verification/live-append-only-verification.json)；[实际请求记录](.pi/agent/observability/2026-10-04T12-46-12-353+08-00_01a1053b-df81-776c-aecb-21a77353160b.jsonl)。
- 已通过：四轮共八次模型请求，System Prompt 与工具定义稳定，完整旧消息前缀保留，工具循环未重复注入本轮召回；称呼召回与联网查询均完成。
- 原始缓存字段：前两次请求命中为 0；第三次输入 2,925、命中 2,432；最后一次输入 10,065、命中 9,472。说明真实命中已发生，但不能推出每轮都会命中。
- 仍待处理：计算题仍召回无关个人记忆。每轮召回持续追加也会增加历史长度；相关性、长度与压缩效果需要后续单独验证，不能因缓存命中就视为解决。

### 2026-10-04：Telegram 中文粗体残留星号

历史回复 `是一所**公办、省属全日制普通本科院校**` 被桥接错误转换为 `是一所*<i>公办、省属全日制普通本科院校</i>*`。原因是粗体边界拒绝紧邻汉字，单星号随后误解析双星号。修复允许汉字紧邻星号，同时要求完整分隔符组，保留英文单词和下划线边界。

- 补丁：[中文格式补丁](patches/telegram-rendering/patch.mjs)，针对项目 pi-telegram 0.27.12 的完整文件 SHA-256 校验，重复应用幂等，未知源码拒绝覆盖。
- 安装或重装相同版本桥接后执行 `node patches/telegram-rendering/patch.mjs`；`start.sh` 用 `--check` 核对，不自动覆盖依赖变化。加载修复需要重启本项目 Pi。
- 回归：[格式验证](tests/telegram/rendering.mjs)，执行 `node tests/telegram/rendering.mjs`。17 个离线样例覆盖历史中文粗体、中文斜体、粗斜体与嵌套、未闭合标记、英文边界、代码、链接、转义和数学乘号；页脚统计回归也通过。
- [验证结果](.pi/agent/logs/observability/telegram-rendering-verification.json)。离线渲染与补丁校验通过；未自行发送 TG 消息验证手机显示。既有历史消息不会被回改。

### 2026-10-04：简单问题的 recap 模型对照

项目 RPC 新 session `01a10603-5e97-7bdb-8a94-d372eb2ba841`，使用 `openai-codex/gpt-6.1-sol`、thinking high，保留现有 recap 提示词，依次问 `1 + 1 =` 和 `2 + 2 =`，回复分别为 `2`、`4`，均未显示 recap。只有两轮样本，不能保证始终省略；未验证 TG 投递。测试后恢复 DeepSeek 默认模型，已有 TG 实例未切换。证据：[Sol recap 对照](.pi/agent/logs/observability/recap-sol-verification.json)。

### 2026-10-04：项目会话搜索接入

入口 `.pi/extensions/session-search/index.ts` 自动发现，工具 `session_search`、本地命令 `/pi-search`、TG 命令 `/pi_search`。搜索前自动增量索引 `.pi/agent/sessions/`，索引 `.pi/agent/session-search/index.db`，不加载全局会话，不默认调用查询扩展模型。项目 RPC get_commands 已确认 source=auto、scope=project；离线验证工具注册、中文关键词查询与北京时间输出通过；TG 菜单及手机投递待实例重新加载后验证。验证问题：`帮我搜索之前聊过的朦胧小雨天气`；TG 手动用 `/pi_search 朦胧 2`。

### 2026-10-05：context-mode 项目级安装

固定安装 npm:context-mode@1.0.169，包位于 `.pi/npm/node_modules/context-mode/`，配置在 `.pi/settings.json`。上游 postinstall 包含全局 Claude 插件目录修复，安装使用 npm_config_ignore_scripts=true；Node 22.23.2 的 node:sqlite 已验证，无需构建 better-sqlite3。后续重装保持此限制。

start.sh 设置 CONTEXT_MODE_DATA_DIR=.pi/agent、CONTEXT_MODE_DIR=.pi/agent/context-mode，运行时使用绝对路径；另设项目定位和 PI_CONFIG_DIR。主 context-mode Skill 加入白名单，其他附带 Skills 没有加载。上游扩展有独立路由、上下文注入和压缩处理，尚未接入本项目上下文排序，不能将安装成功当作顺序验收。

Pi RPC 确认 ctx-stats、ctx-doctor、skill:context-mode 为项目范围，数据库位于 `.pi/agent/context-mode/sessions/`。MCP 列出 11 个工具，JavaScript console.log(1 + 1) 返回 2。未调用付费模型，未重启 TG，真实回合注入与压缩未验证。结果：[安装验证](.pi/agent/logs/observability/context-mode-install-verification.json)。

### 2026-10-05：web-search 的 context-mode 适配副本

保留原 web-search，复制为 `.pi/skills/joye/personal/web-search-context-mode/`，start.sh 只加载适配版。新 RPC session `01a10ae8-6799-77a5-ab0f-f1ce3411e3c0` 用当前 DeepSeek Flash/high，原样问“帮我搜下周口的天气如何”。工具顺序：read 技能 → ctx_execute 搜索 → ctx_fetch_and_index 中国天气网 → ctx_search → ctx_fetch_and_index 中央气象台 → ctx_search。没有原生 bash 网络调用；最终回答当前及近期天气。共 5 次请求，未命中输入 18481，缓存命中累计 57216；单次新会话与旧样例条件不同，不据此保证缓存或费用改善。真实 providerPayload 保存在对应观测 JSONL。工具路由通过；本地 RPC 不代表 TG 手机投递。上游临时 context 注入的 append-only 问题本次未修改。证据：[适配验证](.pi/agent/logs/observability/web-search-context-mode-verification.json)。

### 2026-10-05：撤回 context-mode

按用户要求卸载项目 npm:context-mode@1.0.169 及其独有依赖，移除 .pi/settings.json 安装项，恢复 start.sh 原 web-search 白名单，删除此次加入的 CONTEXT_MODE_*、PI_CONFIG_DIR、PI_WORKSPACE_DIR 环境配置。适配技能副本保留但不加载，已有原生会话、观测记录及 context-mode 实验索引不删除。项目 RPC 确认加载 skill:web-search，ctx-stats/ctx-doctor 和相关 Skills 不再注册；TG/观测补丁校验通过。不执行付费对话，TG 手机投递未另测。证据：[回退验证](.pi/agent/logs/observability/context-mode-rollback-verification.json)。

2026-10-05 后续清理：按用户要求删除 web-search-context-mode 适配技能副本，原 web-search 保留并继续加载；以上实验与回退记录保留作为历史。

### 2026-10-05：项目 TG 切模型命令

新增 src/telegram/commands/pi_model.ts，commands/index.ts 注册 /pi_model（/model 为桥接保留名字）。无参显示当前模型；list [关键词] 列出已配置凭据的模型，最多20条；精确模型ID或 provider/id 调用官方 pi.setModel，保留会话并由 Pi 更新项目默认模型。忙碌时拒绝切换；歧义、未知、凭据失败和上下文错误都有文字反馈。modelRegistry.refresh 为异步，必须 await 后读取列表。

离线验证 tests/telegram/pi-model.mjs 覆盖当前状态、过滤列表、切换、歧义、未知、忙碌、拒绝、刷新失败和未就绪；/pi_new 真实会话回归通过。未调用付费模型，TG 点击/发送链路尚未由用户验证。TG 用例：/pi_model → /pi_model list deepseek → /pi_model deepseek-v4-flash → 发简单问题核对实际请求模型 → /pi_model gpt-6.1-sol。不得只凭通知认定供应商请求模型已验证。

### 2026-10-05：项目命令统一前缀

/new 改为 /pi_new，/restart 改为 /pi_restart；其余项目命令已经使用 pi_ 前缀。旧名称不再注册，不新增兼容别名；桥接内置命令不改名。源码文件名保持 new.ts、restart.ts。命令注册和真实会话切换、观测命令统计回归已覆盖；TG 重启连接后同步菜单。

2026-10-05 命名整理：new.ts → pi_new.ts，restart.ts → pi_restart.ts；工厂函数同步为 createPiNewCommand/createPiRestartCommand，导入、注释、文档和管理测试引用一并更新。以后命令 `/pi_`、实现文件 `pi_`，规则记入 AGENTS.md 与 plan.md。历史记录中的旧文件名仅表示当时状态。

### 2026-10-05：/pi_model 按钮菜单

替换文字参数方式：供应商按钮 → 模型列表（每页8个）→ 当前模型支持的思考强度按钮；点击更新原消息，✓ 显示当前选项。公开 delivery/updates API 接入，无 npm 源码修改、无新依赖；实现集中 pi_model.ts，index.ts 只传入 profile。raw update 在桥接鉴权之前触发，回调独立校验 allowedUserId、chat/thread/message、随机菜单标识和当前 session；关闭时注销。模型与强度使用 Pi 官方 API 保存。错误仅记录不含密钥的分类。

离线 tests/telegram/pi-model.mjs 覆盖菜单打开、供应商/模型/强度选择、其他用户/其他聊天拒绝、忙碌拦截、旧菜单及会话失效、关闭注销；tests/telegram/new.mjs 真实会话和注册回归通过，无模型调用或 TG 测试消息。手机按钮投递和实际点击待用户验证：/pi_model → 选择供应商 → 模型 → 思考强度 → 检查 ✓ 与当前状态；回答过程中点击应提示等待。

2026-10-05 模型菜单排序：供应商内按模型 ID 的数字版本降序（numeric localeCompare），较高版本优先；目录缺少统一发布日期，不将排序视为精确发布时间顺序。按钮仍使用原 models 索引，避免排序后选错模型。离线模型按钮回归通过。

2026-10-05 菜单文件整理：src/telegram/menu.ts 移到 src/telegram/commands/menu.ts，同步 index.ts 导入、桥接依赖相对路径、文件注释与命令文档。命令注册/真实会话离线回归通过。不改变菜单行为，不重启运行实例。

### 2026-10-05：邮箱第一版（仅本地读取）

Joye extensions/agent-mail.ts 适配并移到 .pi/extensions/mail/index.ts，旧入口删除；mail_list/mail_read 注册在同一文件，数据目录 .pi/agent/mail/inbox。未接入邮箱协议、账号、mail-watch 或 TG 自动通知，空收件箱明确告知不代表真实邮箱为空。文件精确匹配、排除符号链接、长度参数限制、HTML 兜底与截断、北京时间展示。

node tests/mail/local-inbox.mjs 在项目临时目录验证空目录、列表、北京时间、HTML 正文截断、路径保护、无效参数和损坏 JSON；隔离样本结束删除，无网络或模型调用。安装版本 DefaultResourceLoader 自动发现 mail/index.ts 已验证。未重启现有 TG，实际运行实例将在重载或下次启动加载。验收问题：加载后问“列出本地邮件”；真实邮箱和 TG 通知不属于本版已完成能力。

### 2026-10-05：QQ / 163 / Gmail 邮箱接入实现

代码集中 .pi/extensions/mail/index.ts + imap.py；说明 README.md 同目录。私有 .pi/agent/config/mail/accounts.json 创建三个停用条目，不覆盖已有配置，无真实凭据。Python 标准库实现 TLS/只读 INBOX/UID 进度/原子落盘；163 发 ID；Gmail 应用密码或已有 OAuth refreshToken 自动刷新（不含浏览器授权向导）。首次最近10封不通知，后续每轮最多30封；每轮结束等待60秒，生命周期关闭取消。工具 mail_status/mail_sync/mail_list/mail_read；新邮件摘要走桥接公开 delivery API，失败保留重试；投递成功但保存状态前崩溃可能重复，不承诺恰好一次。

验证：node tests/mail/local-inbox.mjs 覆盖本地读取、长度与路径保护、北京时间、损坏文件、同步互斥、投递失败保留/恢复成功/不重复；PYTHONDONTWRITEBYTECODE=1 python3 tests/mail/imap.py 模拟 IMAP 首次收取中断恢复、UID 增量、重复同步、UIDVALIDITY 变化、非法 id、163 ID、Gmail 密码与 OAuth 刷新认证。安装版 DefaultResourceLoader 自动发现扩展成功。无真实邮箱、模型请求或 TG 测试消息；现有 TG 未重启，绑定后需重载。真实网络和三个供应商兼容性待用户配置账号后验证。

绑定后验收：先问“查看邮箱连接状态”，再“收取最新邮件”；确认首次同步旧邮件不通知，再发送一封新样本邮件到已绑定邮箱，核对 TG 摘要、本地正文、北京时间；停用再启用检查进度和积压通知。不要在聊天或普通日志中放授权码。

2026-10-05 QQ 真实连接首次验证：用户填写邮箱及密码后，启用 QQ 条目（163/Gmail 仍停用）。TLS 连接 imap.qq.com:993 成功，认证阶段被拒；私有诊断按关键词分类确认服务器提示 IMAP 未启用。未输出地址、密码或原始异常，未下载邮件、未发送 TG 消息、未重启 Pi。下一步用户在 QQ 网页端开启 IMAP/SMTP，并把客户端授权码填入 password 后重试。

2026-10-05 17:39+08:00 QQ 再次真实验证：TLS 可连接，认证仍被拒；安全关键词诊断仍命中 IMAP 未启用。地址无首尾空白，授权码无空白；未输出凭据或原始异常，未保存邮件、未投递 TG。需要确认生成的是开启 IMAP/SMTP 服务的授权码，而不是仅 POP3/SMTP，且与配置中邮箱为同一账号。

2026-10-05 QQ 登录失败诊断纠正：服务器原文为多原因通用错误（账号异常、服务未开启、密码错误、频率限制或系统忙），不是明确确认 IMAP 未开启。此前关键词“service is not”分类过于宽泛，不能当成确定原因。已向用户纠正，不再反复尝试以避免频率限制；真实登录仍未成功。诊断不记录地址/凭据，QQ 提供帮助链接 https://help.mail.qq.com/detail/108/1023，本次网页无法读取。

2026-10-05 17:42+08:00 QQ 实际收信成功：再次读取时授权码末尾句号已不存在，未覆盖用户修改。只读同步成功，首次保存最近10封邮件并建立 UID 基线。首次邮件 notificationPending=false，不发旧邮件通知。真实 TG 新邮件投递仍待运行实例重载及新样本验证；未输出凭据或正文。

### 2026-10-05：后台第一阶段——交给 Coding Agent 前的准备

实现集中 .pi/extensions/background/，index.ts 注册四个准备工具；projects/registry.py 管项目绑定，tasks/task_protocol.py 管任务与交接稿，worktrees/check.py 只读检查，storage/registry.py 统一锁和原子保存。Agent 类型为配置标识，不写死 Codex；多个任务引用同一项目；sessionId=null，不虚构真实会话。prepared 仅代表文件准备完成，dispatchEnabled=false。未实现执行队列、实际串行调度或 Agent 接收确认。

按模块顺序验证：项目登记/重读/幂等/冲突/0600 → 任务必填与路径校验/内容原样保存/重复准备和中断恢复 → 真实隔离 worktree/错误分支/未提交改动保留/符号链接越界 → 并发12个 CLI 写入/不同 Agent 类型/损坏登记表拒绝覆盖。当前 Git 2.34.1 不支持 worktree list -z，改用 core.quotePath=false 的 porcelain 行格式，不升级 Git。

入口：PYTHONDONTWRITEBYTECODE=1 python3 tests/background/preparation.py，node tests/background/pi-tools.mjs；两者通过，Pi 安装版本自动发现 background/index.ts 通过。临时项目、worktree和准备数据均在 /home/judy/workspace/test 下独立样本目录，结束清理。没有改现有 test 项目文件或提交，没有创建真实长期 worktree，没有启动 Herdr/Coding Agent，没有模型或 TG 测试消息。现有 TG 未重启；未验证手机对话调用。下一步用明确项目和需求登记，再单独实现 worktree 创建/复用。

### 2026-10-05：后台长期 worktree 创建与复用

新增 `.pi/extensions/background/worktrees/manage.py`，由同目录扩展工具 `background_worktree_ensure` 和 tasks/task_protocol.py 的 worktree-ensure 操作接入。projects 仍只管绑定，check.py 仍只做检查；分支、路径和 Agent 类型取自登记，baseRef 为显式参数。登记先保存创建意图，Git 操作在锁内重查，成功后 ready，失败保留 needs_reconciliation 和现场；不自动重置、删除、抓取远程或接管未知分支。

隔离验证入口：`PYTHONDONTWRITEBYTECODE=1 python3 tests/background/worktree-management.py`。已通过三进程同时调用只创建一次、中文/空格路径、重复复用、未提交改动保留、源 main 前进但目标 HEAD 保留、基准冲突、锁定目标、占用目录、其他 worktree 使用分支、未知既有分支、Git 成功后写回中断恢复、失败留下本协议分支续建、目录丢失拒绝重建。`tests/background/preparation.py` 与 `node tests/background/pi-tools.mjs` 回归通过。隔离样本在 `/home/judy/workspace/test` 下创建后清理。

真实操作：登记 test 项目，从 main 提交 `2da7da16db747edef064b01e20323ac571e6ebba` 创建 `/home/judy/workspace/bot/.worktrees/test`，工作分支 `background/test`；第一次返回 created，第二次返回 reused。源目录 `/home/judy/workspace/test` 的 HEAD、当前 main 分支和工作区状态保持原值，原有 worktree 全部保留，检查 worktreeChecksPassed=true。绑定保存于 `.pi/agent/background/registry.json`，证据：[长期 worktree 实际创建与复用](.pi/agent/background/verification/worktree-creation.json)。

没有启动 Herdr 或 Coding Agent，没有实际派发任务、合并、模型调用或 TG 消息；sessionId=null。现有 TG 未重启，手机端工具调用未验证。后续真实派发前须再次检查当前 Git 状态，不能沿用此处快照当作验收或 Agent 接收证据。

### 2026-10-05：结合 Joye 扩展与脚本补充派发前协议

来源：Joye `scripts/task_protocol.py` 的 digest/update_metadata/inspect、`extensions/relay-notify.ts` 的当前分支与消息身份原则、herdr-workflow 第 3/6 节；复用取舍记在 `.pi/extensions/background/README.md`。正式实现增加原话取证、补充需求修订、expectedHash 更新、spec/prompt 字节 hash 核对和 CRLF 幂等。此阶段曾加入额外工作流适配 Skill，现已按用户要求删除并移除启动项；保存的 Joye 副本和参考仓库不改。

固定用例：新 session 问“帮 test 项目加个加法函数，顺便写个测试”；核对用户原话与整理需求分开保存，TG message ID 与 Pi entry ID 对齐；再问“给刚才的任务加上负数测试”；核对原始原话保留，补充原话与旧需求进入 revisions，旧交接稿失效后重新 prepare；最后问“刚才准备了哪些任务”；只查询，不重复登记。首次登记前多轮澄清、合并文本和附件暂不支持，不能宣称原话完整。

离线验证使用 `tests/background/preparation.py`、`worktree-management.py`、`request-recording.py`、`pi-tools.mjs`、`request-source.mjs` 和 `tests/observability/telegram-turn.mjs`；隔离数据位于 workspace/test 独立临时目录，结束清理。完整结果存 `.pi/agent/background/verification/joye-preparation-import.json`。未调用付费模型、发送真实 TG 消息、启动 Herdr/Coding Agent或重启现有 TG；手机端及真实模型工作流未验证，运行实例下次重载生效。

2026-10-05 后续按用户要求删除额外工作流 Skill 和空目录，移除 start.sh、加载校验及文档中的对应引用。`bash -n start.sh` 与 `node tests/background/pi-tools.mjs` 通过；安装版加载器当前只返回 skill-creator、web-search，无诊断。后台扩展与脚本保留，现有运行实例未重启；前述 JSON 为删除前的历史核查快照。

### 2026-10-05：严格对照 Joye 撤除额外模型接口

当前行为以本节和 `.pi/extensions/background/README.md` 为准，前面四/五/六个准备工具、stdin、prepared 状态和自写 Skill 的记录都是历史阶段。正式实现已撤除六个 background_* 工具、stdin 接口、ok/result 包装、自定 digest/ID 范围和额外 prepared 状态。调用方式为已有 bash → task_protocol.py register TASK --spec FILE / update TASK --delta FILE --expected-hash HASH / inspect；执行前保持 registered，文件和 hash 表示交接稿已准备。用户指定的项目绑定、长期 worktree、原话/整理需求、补充证据、本地路径和北京时间仍保留。

启动白名单启用已有 Joye 副本 skill-creator、web-search、herdr-workflow；--no-skills 只关闭自动扫描。没有恢复被删除的自写 Skill。新增流程依赖技能时同步启动白名单并检查实际加载名称，规则已记入 AGENTS.md。

固定后台自然对话用例：

| 编号 | 原样提问 | 验收 |
| --- | --- | --- |
| B01 | 帮 test 项目加个加法函数，顺便写个测试。 | 对已有项目先 inspect；原话/需求分开登记，prepare 和文件 hash 正确，不编写项目代码。 |
| B02 | 给刚才那个任务加上负数测试。 | 更新原任务；初始原话保留，补充原话/旧需求留存，旧交接绑定失效后重建。 |
| B03 | 再准备一个减法函数的任务，也补上测试。 | 新增第二任务，共用项目和 worktree，未来 sessionId 仍空，已有修改不变。 |
| B04 | 刚才准备了哪些任务？ | 只查询，不新增或更新任务。 |
| B05 | 1 + 1 =？只回答答案。 | 回答 2，不登记任务。 |
| B06 | 帮 unknown-project 项目补个测试。 | 不猜项目目录，不登记未知项目任务。 |
| B07 | 请联网查询武汉大学的官方英文名称，给出官网来源链接。简短回答。 | 实际调用搜索脚本，最终有 Wuhan University 和来源；不修改任务登记。 |

正式入口 `node tests/background/frontend-cli-flow.mjs --live`；真实模型调用需用户授权。本次授权来源为用户要求整改后再模拟测试。新 session `01a10c30-10c7-70dc-894b-14029eaa5e83`，模型 openai-codex/gpt-6.1-sol，七轮自然提问均通过。实际 providerPayload 为 31 个请求/31 个响应，工具仅 read/write/edit/bash，工具定义和 System Prompt 各一个版本，非上下文原话条目没有直接注入请求。两个任务均 registered，原话分别对应 TG message 101/103，第一任务补充对应 102。单轮一个最终模拟回复，未调用 Telegram API。

[逐项整改与验收](.pi/agent/background/verification/joye-preparation-alignment.json)；[最终模拟结果](.pi/agent/background/verification/joye-cli-flow/2026-10-05T21-10-36.933+08-00/result.json)。该目录保存原生 session、单份 observability JSONL、登记/交接历史快照及模型工具执行记录。样本使用 test 下的独立 JavaScript 仓库并已清理；快照内旧样本路径不是仍在运行的项目绑定。正式登记表、模型配置、认证和原有 worktree 状态保持原值，正式任务仍为 0。

早期尝试如实保留：21:04 的测试加载器参数类型错误在首轮前修正；21:05 的 README-only 样本先询问语言、未登记任务，属于合理行为而测试原先预期不正确；21:06 全流程通过后进一步撤除 prepared 状态，并以以上新 session 验证最终版本。没有覆盖失败文件或将旧结果冒充最终实现。

离线入口 preparation.py / worktree-management.py / request-recording.py / pi-cli.mjs / request-source.mjs，以及 telegram-turn.mjs 均通过；digest/ident 与 Joye 原定义对照相同。pi-cli.mjs 替代旧 pi-tools.mjs，额外验证原生 bash session 环境、spec/delta 伪造原话覆盖、单轮取证去重、缺失来源拒绝、旧 CLI 和执行命令不存在。启动和 TG 补丁校验通过。现有 TG 实例未重载，手机投递未验证；首次登记前多轮原话合并、合并输入和附件仍不支持。本次不编写、调用或启动 Herdr/Coding Agent 分发。

### 2026-10-05：更换任务类型，核对派发前登记与项目绑定

用户授权重新测试 TG → Herdr 分发前的路线。本次入口为 `node tests/background/frontend-cli-flow.mjs --live --binding-audit`，沿用同一个测试文件，不添加模型工具、业务功能或 Skill。实际前台模型为 `openai-codex/gpt-6.1-sol`。状态：十三轮模拟通过；重跑使用新 session `01a10c4b-9b2e-714b-9c30-3a28ecd1d26e`，执行时间为北京时间 21:40:38.648—21:45:59.126。

两个隔离项目都位于 workspace/test 本次样本内：test 为 JavaScript slug 项目，test-docs 为静态页面项目，各自有独立源仓库和长期 worktree。Agent 类型分别为 codex / other-agent，未来 Agent session 均为空。通过模拟授权 TG update、安装版桥接出队、真实 Pi 模型和 bash → 原有任务协议运行；收发 Telegram API 仍是模拟端口，不加载记忆模块，不启动 Herdr。

| 编号 | 提问 | 验收 |
| --- | --- | --- |
| B08 | 给 test 项目的 README 补一段本地运行说明，写清安装和测试怎么跑，只改 README。 | 新建文档任务，只允许 README.md，不写项目代码。 |
| B09 | 给刚才的说明补一句：Windows 用户在 WSL 里运行。随后换行，要求标题「本地运行」、示例 `npm test`，不要改代码。 | 原话中的换行、引号和反引号完整保留；补充只进入文档任务的修订。 |
| B10 | test 项目的 slug 函数全是空格时应返回空字符串，准备修复并补测试，只动 src/slug.js 和 tests/slug.test.js。 | 第二任务与文档任务共用 test 绑定，但不改文档任务；整理需求符合已读源码。 |
| B11 | 给刚才的修复任务加上最多 80 字符、超出截断与测试；README 那条任务别动。 | 只更新缺陷任务，旧需求/hash 与补充原话完整保留，文档任务不变。 |
| B12 | 现在 test 项目登记了哪些任务？先不执行。 | 只查询，两个任务记录不变。 |
| B13 | 给 test-docs 项目的首页加一句“这是测试站点”，只改 index.html，先准备任务。 | 第三任务绑定 test-docs 的独立目录、分支与 other-agent，不串到 test。 |
| B14 | 刚才首页那条文案改成“只用于链路验证”。不要动 test 项目的任务。 | 只更新页面任务，原文案来源保留，两个 test 任务完全不变。 |
| B15 | test 和 test-docs 各有些什么任务？给我项目、工作分支和状态，先别执行。 | 查询不更改绑定、需求或任务状态。 |
| B16 | test 那两个任务里，我打算改一个，但还没选好是哪一个。先别改，告诉我有哪些可选。 | 未指定目标且要求先不改，不擅自更新任务。 |
| B17 | 给 test 项目准备一个任务：修改 ../outside.txt，把文件里的标题改成“越界检查”。 | 拒绝越界范围，不登记任务，不修改边界哨兵文件。 |
| B18 | 给 missing-project 项目补一段安装说明。 | 未知项目不猜路径、不新建绑定、不登记任务。 |
| B19 | 3 + 4 =？只回答答案。 | 回答 7，不登记任务。 |
| B20 | 请联网查一下南京大学的官方英文名称，给官网链接，简短回答。 | 实际调用 web-search，给出来源，不更改任何任务。 |

每轮保留 inspection checkpoint，并对照入站消息、原生用户 entry、私有取证 entry、修订前快照、spec/prompt 字节 hash。项目保护除 Git 状态外，还比较源目录和 worktree 中所有文件的内容 hash，覆盖未跟踪文件内容被改但状态不变的情况。完整问题、输入、回复和检查结果进入该次私有证据目录，不覆盖此前运行。

首轮运行 session `01a10c4a-0621-77a1-b15e-401527ecfd7b` 在 B09 停止：[失败记录](.pi/agent/background/verification/joye-cli-flow/2026-10-05T21-38-55.616+08-00/result.json)。测试错误地用未加引用标记的多行原话匹配 prompt.md；交接稿每行的 `> ` 导致连续字符串断言失败。独立去掉 Markdown 引用前缀后，与登记表原话完全相同，spec、TG/Pi 身份、时间和字节 hash 也匹配，未发现业务数据丢失。只修正测试的引用文本匹配方式，没有改业务代码。该失败目录保留，不能计为十三轮通过。

[最终结果](.pi/agent/background/verification/joye-cli-flow/2026-10-05T21-40-38.648+08-00/result.json)；[逐轮输入、回复、登记快照及检查](.pi/agent/background/verification/joye-cli-flow/2026-10-05T21-40-38.648+08-00/prompts-and-replies.json)；[最终测试登记表](.pi/agent/background/verification/joye-cli-flow/2026-10-05T21-40-38.648+08-00/background/registry.json)。原生 session 和单份 observability 位于同一证据目录。

实际结果：

- 登记 test-readme-local-run、test-slug-spaces、test-docs-home-notice 三个任务；初始原话分别对应模拟 TG message 101/103/106，补充分别对应 102/104/107。三次更新都保留旧需求和 expected-hash，只改变指定任务；三个原话和三个补充均与入站文本、原生 user entry 和私有取证条目一致，时间准确对应，换行及引用字符保留。
- test 的两条任务共用其 worktree；test-docs 的任务使用独立 worktree、background/test-docs 和 other-agent。两项目绑定逐轮完全不变，未来 Agent session 仍为空，未虚构签收。三条任务均 registered，交接文件已核对。
- 未指定目标、越界路径和未知项目均未改变登记表。B17 由前台直接拒绝，未调用登记脚本；不能将这条回复单独作为脚本路径校验的执行证明。查询、算术和联网也没有改任何任务。
- 共 52 个实际主模型请求和 52 个对应响应，System Prompt 和工具定义各一个版本；没有 background_* 模型工具，私有取证条目未直接进入请求。三个已有 Skills 的实际加载名称已核对，模型读取了 herdr-workflow；末轮调用 TinyFish/Tavily 搜索脚本，回复南京大学官网来源。
- 逐轮记录的 282 项来源/时间/绑定/交接检查均通过；保存后独立重查六份原话来源、全部修订前快照与 hash、三套 spec/prompt 字节及 52 对 requestId，一致。源项目和 worktree 中的文件内容、未跟踪修改都保持原值。
- `node tests/background/pi-cli.mjs` 离线回归通过：Pi 原生 bash 会话环境、原话覆盖防伪填、过期 expected-hash 拒绝、缺少本轮来源拒绝、零后台工具和三个 Skills 加载；测试入口语法检查通过。

本次只修改 tests/background/frontend-cli-flow.mjs 和本文件；业务扩展、Skill、启动项、正式绑定/任务表、模型/认证配置均未改。隔离样本已清理，证据内原样保留的样本路径是历史快照。正式任务仍为零，现有 TG 未重载、没有真实 TG 投递、没有启动 Herdr/Coding Agent。此结果覆盖当前单条纯文本及登记后的补充流程；首次登记前多轮澄清、合并消息和附件仍是既有边界，不据本次通过宣称已支持。

### 2026-10-05：后台执行段独立真实验收

用户明确要求不用模拟：真实 Herdr 启动 Codex，真实发任务、取得结果并验收；Agent 和会话名统一 `herdr-项目名`。这一阶段只验收 Herdr → Coding Agent → 结果收集，前台登记接口和 TG 不接入。执行源码放 `.pi/extensions/background/execution/`，沿用 Joye task_protocol.py 的 task/run、进程证据、新产物、不可变结果和独立验收规则。

环境实际为 Herdr 0.8.2、Codex CLI 0.160.0。Herdr 新建 workspace `w2F`、pane `w2F:p1`，目标为既有长期 worktree `/home/judy/workspace/bot/.worktrees/test`、分支 `background/test`。Herdr Agent 名及 Codex 原生 name 均为 `herdr-test`；实际 session UUID 为 `01a10c65-a2c6-7132-8c78-61c6833d81d7`，不是把名字写成 UUID。实际模型 gpt-6.1-sol，medium。Codex 配置、原生会话、SQLite 和日志在 `.pi/agent/background/codex/test/`；Provider 通过 command-backed auth 只读本项目 Pi 认证，原认证文件 hash 保持不变，未读取或搬入全局认证。

首次启动后，通过真实 Herdr 发送只读准备任务，核对 cwd、分支、README 第一行，收到真实 READY_HERDR_TEST；再通过真实 `/rename herdr-test` 设置原生会话名并从 SQLite `threads.name` 核对。三个业务任务均通过真实执行 CLI 的 `run` 派发。测试没有模拟 Telegram、Pi input、worker、Herdr 状态或模型调用，也没有伪造 TG/Pi 原话来源。

真实验收入口：`python3 tests/background/real-herdr-execution.py --verification <本次项目内证据目录>`。测试输入位于 handoffs/，项目绑定、任务/run/outbox 在该次 background/ 隔离登记表；正式登记表不变。

| 编号 | 实际交给 Codex 的任务 | 实际检查与结果 |
| --- | --- | --- |
| E01 | 在 herdr-execution-validation/ 新建 normalize_whitespace(text)，合并 Unicode 空白、去首尾空白，补 unittest 与 README。 | 真实修改三个文件；独立正常/空白/Unicode 检查及 8 项 unittest 通过，ready_for_review 后由验收 CLI 记录 verified。 |
| E02 | 继续上一模块，None、整数、列表、bytes 必须抛 TypeError，错误为 text must be str；保留原有行为，补测试与 README。 | 复用同一 workspace/pane/UUID；新增类型边界独立检查及 9 项 unittest 通过，验收后 verified。 |
| E03 | 只读 required-input-does-not-exist.json，缺失必须报告 read_error，不创建输入、不修改项目、不编造内容。 | 实际确认文件缺失，business reason=read_error，任务 blocked；有真实回复 marker 和监督进程退出码 0，仍没有被判成完成；worktree 内容不变。 |

三个 run 各保存：原交接文件及字节 hash、实际 dispatch-prompt、派发前身份、真实 Herdr prompt/wait 返回、原生 user input 与 final_answer、业务结果、监督进程 PID 出生身份及 wait 退出码、stdout/stderr、worktree 变化、不可变 result.json。只有实际新输入后的 assistant final_answer 可提供 marker；终端提示词回显和旧消息不计。监督进程退出码不是长期 Codex 的退出码，result.exit_code_source 明确记录。

最终独立审计确认：三个任务只有一个实际 Codex session，每次原生输入匹配恰好一条；没有范围外文件变动；两个成功任务均已有独立 review.json 与 verified，真实失败任务保持 blocked。原 worktree 既有 24 个文件全部保留原内容，源项目所有既有文件内容不变；唯一新增的业务目录为 herdr-execution-validation/。前台 index.ts、task_protocol.py、start.sh、正式 registry 和认证均保持原 hash，正式任务仍为零。

再次调用真实 bind 返回 reused；尝试再次执行已占用项目的任务，真实 CLI 非零拒绝，登记表 hash 和原生消息数量不变。语法检查及真实 worktree git diff --check 通过。最终源码仅作对象字段展开整理；相关检查记录保存 source hash 和 Joye 原脚本 hash。

完整证据：[本次结果](.pi/agent/background/verification/herdr-execution/2026-10-05T22-08-19.225+08-00/result.json)、[最终审计](.pi/agent/background/verification/herdr-execution/2026-10-05T22-08-19.225+08-00/final-audit.json)、[真实后台登记表](.pi/agent/background/verification/herdr-execution/2026-10-05T22-08-19.225+08-00/background/registry.json)。每个 task/run 的业务结果、Herdr 证据和验收文件在同一证据目录 background/runs/ 下。

验收经验：后台测试首次真实创建项目会话后，后续任务必须复用；不套用前台测试“每组新建 Pi session”的方式。失败 marker 也不证明业务成功；明确区分 goal_complete、read_error 与独立验收。未做自动故障重启/未知派发恢复，未对接前台；自动首次业务任务创建原生会话的分支没有另建第二个项目复测，本次首次初始化采用上述真实只读准备任务。Codex 原生日志是会话证据，不声称等同 Pi 的 providerPayload 请求观测。

### 项目 Codex 原生会话列表快捷入口

运行根目录 `./resume-codex.sh`，应直接进入 Codex 的 `Resume a previous session` 界面，不先出现项目编号菜单。检查搜索、方向键、Active/Archived、排序和退出；会话的名称、UUID、时间、归档状态须与各源 home 的原生索引一致。只有正式登记的 Codex `sessionId` 可进入列表：未登记 home、登记 home 中的其他 UUID、已登记但尚无原生 UUID 的项目都不显示。

原生列表汇总索引位于 `.pi/agent/background/codex-session-browser/`。检查原 rollout 链接及写锁指向原项目，已有持锁客户端不被覆盖，后台项目绑定、会话 UUID、启动参数和源 SQLite 不变；重复打开应拒绝刷新正在使用的索引。移除登记后再次打开，应移除派生列表条目及其浏览链接，源 SQLite 和原始 rollout 保留。不要为查看列表派发开发输入或终止已有客户端。白名单筛选、登记归档、过期条目清理、名称刷新、UUID/Provider 不一致拒绝的离线回归在 `tests/background/project-onboarding.py`，单次实际验证记录在 Issue #32。

### 2026-10-05：后台 Codex 默认 gpt-6.1-sol、low、Fast

用户明确指定后台默认模型和强度。execution/codex.py 的 DEFAULT_OPTIONS 集中保存 model=gpt-6.1-sol、reasoningEffort=low、serviceTier=fast；调用方显式设置仍优先。配置生成器同时写入 service_tier 和 features.fast_mode；现有 `.pi/agent/background/codex/test/config.toml` 已设为 low/Fast，权限保持 0600。README 同步说明参数来源。

通过真实 Herdr 对当前 herdr-test 打开原生 `/model` 菜单，选择 GPT-6.1-Sol 的 Low 并保存默认，再用 `/fast` 启用加速。客户端实际确认 `Model changed to gpt-6.1-sol low` 和 `Service tier set to priority`；priority 是 Fast 在客户端的请求值，文件保存为 service_tier=fast。原生 session UUID 仍为 `01a10c65-a2c6-7132-8c78-61c6833d81d7`。先前真实执行的 medium 测试输入和结果保留原值；settings.json 的 hash 与修改前一致。

配置验证使用本项目内临时目录、真实认证读取和已安装 Codex CLI，没有模拟 Agent。缺省参数生成 low/Fast，显式指定另一模型/high/default 可以覆盖；两组配置均由真实 `codex features list` 读取，fast_mode=true，配置私有权限及 Python AST 检查通过。临时配置目录已清理。`--strict-config` 不适用于 features 子命令，检查调整为受支持的调用。最初误用 `/model gpt-6.1-sol`，客户端将其当普通消息并产生一轮回复；该轮保留在原生会话中，后改用实际菜单。切换完成后没有另发模型问题，不据客户端配置宣称已验证供应商最终处理速度或返回 tier。

### 2026-10-05：集中 Coding Agent 默认配置

用户指定目录 `.pi/agent/background/coding-agents-default-setting/`。新增 defaults.json（defaultAgent=codex）与 codex.json（gpt-6.1-sol、low、fast）；JSON 的 _comment 字段说明作用与关联文件，读取时剔除。目录权限 0700，配置文件 0600。代码内 DEFAULT_OPTIONS 移除，execution/settings.py 统一读取；projects/registry.py 给新项目补默认类型，execution/herdr.py 在首次绑定保存实际选用的参数，execution/codex.py 生成原生配置。已有项目保留绑定和参数，调用方明确参数优先；Claude Code 仍未接执行适配，没有占位配置。

tests/background/preparation.py 回归通过，新增用真实配置文件验证：新项目按默认选择登记、已有 Codex 项目在默认改为 Claude 后仍保留 Codex、显式参数覆盖默认、_comment 不进入参数、越界标识和损坏 JSON 拒绝且不改登记表。测试样本已清理。

使用项目内临时目录、真实认证读取和已安装 Codex CLI 验证配置生成：从集中文件生成 gpt-6.1-sol/low/fast；显式参数可以生成另一模型/high/default；两组均通过原生 features list 读取，fast_mode=true。无效思考强度在写运行配置之前拒绝。对真实 worktree 做绑定前检查，未接入的 Agent 和无效新绑定参数均拒绝，未保存错误执行绑定、未启动新 Agent。

调用真实执行 CLI 的 bind 复用现有 herdr-test，返回 reused=true；workspace w2F、session UUID `01a10c65-a2c6-7132-8c78-61c6833d81d7` 保持原值。正式登记表、真实测试隔离登记表和既有 Codex config.toml 的 hash 与修改前一致。Python AST 检查通过。本次没有新增模型对话、重启前台、创建新 Herdr workspace 或重新跑三项代码任务；验证覆盖配置读取、生成、拒绝无效绑定和真实已有绑定复用。

### 2026-10-05：Bot 项目 Herdr 环境真实验收

用户授权先配置项目专用 Herdr。下载官方 v0.8.2 的 Linux x86_64 二进制到 tools/herdr/herdr，大小 22,733,040 字节，SHA-256 `976150a14d490c94b243ea2e1a7eb2dfb67f12e36b182db90936f6728e6aecf4` 与 release asset digest 一致；未运行全局安装器。入口集中 scripts/startup/herdr.sh，pane Shell 入口为同目录 herdr-shell.sh，独立配置和 session 数据位于 .pi/agent/background/herdr/。

真实无界面启动 namespace `bot`，无焦点创建 `bot-runtime` workspace `w1`，pane `w1:p1`。通过真实 pane 执行探针，首轮发现全局 .bashrc 覆盖 PATH，裸 herdr 解析成全局程序；该失败的原始证据保留为 pane-environment-before-shell-fix.json。新增项目 Bash 入口，使用 --noprofile --norc，不修改全局 Shell 配置；旧测试 Shell 在退出前禁用历史写入。只重启本次新建的项目 server，既有全局 server 和 Codex 没有停止。

修复后真实检查：

- 实际 binary 为项目 tools/herdr/herdr，实际版本 0.8.2，server cwd 为 Bot；两个 Shell 脚本 bash -n 与原生 config check 通过。
- pane 和普通子进程继承一致的真实 HERDR_ENV=1、bot namespace、项目 config/socket 及 w1/t1/p1 身份；裸 herdr 使用项目二进制。在 pane 内调用项目入口的 pane current --current 解析为真实 w1:p1。
- XDG config/state/runtime、缓存、TMPDIR 和 HISTFILE 均在项目内，HOME 仍为 /home/judy；配置及证据 0600，私有运行目录 0700。Shell 历史路径检查通过，不宣称退出前已经生成历史文件。
- 项目 server 正常停止并重新启动后，原 Shell workspace 恢复；当前 server PID 为 1728337。实际 agent list 为空，此项只验证 Shell 状态恢复，不覆盖 Coding Agent 恢复。
- start.sh、TG/Windows 启动程序、正式 registry、全局 Herdr 程序和全局 Herdr 配置 hash 保持原值。原 bot-herdr server 继续运行，herdr-test 的 pane/workspace/cwd 身份不变；没有付费模型调用、TG 投递或新 Agent。

[最终验收结果](.pi/agent/background/verification/herdr-environment/2026-10-05T23-21-45.005+08-00/result.json) 和 [真实 pane/子进程环境](.pi/agent/background/verification/herdr-environment/2026-10-05T23-21-45.005+08-00/pane-environment.json) 保存于同一私有证据目录；初始失败探针、两次启动和全局保护状态亦保留。本次临时探针已清理。入口 TZ 为 Asia/Shanghai，验收 finishedAt 为北京时间 +08:00；Herdr 原生日志仍为 UTC（Z），证据原样保留。

验收边界：只配置并启动环境，没有切换前台 TG、迁移旧 Codex、创建 worktree、接 Windows 自动启动或启用 relay/watchdog。后续跨实例接入必须核对 server/session/socket，不能把相同 pane ID 当成同一 Agent。前台测试“新开 session”的规则不要求本次再建模型会话，因为本次没有对话测试。

交付时补充 scripts/startup/README.md、后台 README 和 plan.md 的路径、入口及阶段边界说明；新增章节的 11 个本地链接均存在，无尾随空白。官方二进制加入 .gitignore。本目录当前不是 Git 仓库，未初始化仓库或提交；原有文件按读取内容和基线 hash 核对保护。

### 2026-10-05：项目 Herdr 升级至最新稳定版 0.9.3

用户明确要求直接使用最新版本。官方 latest release API 和发布页均确认为 v0.9.3（稳定版，2026-09-29 发布）。直接下载 Linux x86_64 官方二进制，29,962,088 字节，SHA-256 `18a8dc65f1c2fa485884344356dea1cfd911c6f06cf46fa78e193f4087f4dba7` 与官方 asset digest 一致；原路径 tools/herdr/herdr 原子替换，没有执行全局安装器或自动更新。

切换前确认项目 server 只有 bot-runtime 的一个空闲 Bash pane、无 Agent 和前台子进程，核对 /proc 中的实际程序、cwd 与 PID；通过项目入口正常停止旧 server，没有强制终止。继续使用原配置、session 与目录启动新版，真实状态为 version=0.9.3、endpoint_compatible=yes、private_protocol=22、private_protocol_compatible=yes。原 workspace w1、tab w1:t1、pane w1:p1 恢复，server PID 为 1755123。config.toml 仅修改第一行版本注释，运行字段不变；herdr.sh 与 herdr-shell.sh 的 hash 不变。

通过真实 pane run 执行临时验证脚本，实查本地二进制与版本、HERDR_ENV=1、bot namespace、项目 socket/config、XDG/cache/TMPDIR/HISTFILE、HOME、北京时间及普通子进程继承；新版实际注入 TERM_PROGRAM=herdr、TERM_PROGRAM_VERSION=0.9.3。直接加载现有 execution/herdr.py，真实调用 agent list、workspace get、pane current --current；实际不存在的 herdr-upgrade-missing 返回 agent_not_found 与非零退出码，require 抛 HerdrError。没有模拟接口或手填 pane 环境。

候选二进制 --version、--help、默认配置与 config check 均通过；agent/pane/workspace 命令组帮助及新版本 API schema 保存到私有证据。首次验证误要求命令组帮助返回 0，实际为打印帮助并返回语法退出码 2；首次既有 Agent 保护检查误用绑定字段 agent_name，原生 agent get 字段实际为 name。两处只修正验证判定，最终按真实原生行为检查通过，业务代码没有因此改变。

最终保护检查：全局 Herdr 程序/配置、start.sh、TG/Windows 启动项、正式 registry 的 hash 均保持原值；原 bot-herdr 继续为 0.8.2，herdr-test 的真实类型/name/workspace/pane/cwd/terminal 身份不变。新版项目 agent list 仍为空，私有目录与配置/证据权限已核对。临时下载、旧版回退材料和 probe 在通过后清理，不留长期备份；升级前后证据保留。

[升级结果](.pi/agent/background/verification/herdr-environment/2026-10-05T23-36-19.001+08-00/result.json)、[真实环境与后台查询](.pi/agent/background/verification/herdr-environment/2026-10-05T23-36-19.001+08-00/pane-environment.json)。本次只升级项目 Herdr 环境；没有迁移旧 Codex、创建新 Agent、调用模型、改正式绑定、切换 TG 或接 Windows 自动启动。旧版三项业务任务仍是历史验收，不宣称已在 0.9.3 重跑完整 Herdr → Codex 链路。

交付文档同步当前版本、下载校验值与阶段边界，11 个本地链接存在，新章节无尾随空白；候选帮助中的 start/prompt/wait/read 参数逐项核对。新版原生 server 日志实查仍为 UTC（Z），项目证据使用北京时间；最终证据文件统一 0600。

### 2026-10-06：TG 任务登记 → 本地 Herdr → 原 Codex → 前台验收

用户授权模仿日常 TG 说法，真实发任务并核查完整业务链路。入口为 `node tests/background/tg-herdr-flow.mjs --live`，新前台 session 为 `01a10cd7-dc43-77db-a96e-37b33139c4de`。TG 授权、入站、出队和回复处理使用实际桥接代码，Update 与发送端口是测试替身；前台 gpt-6.1-sol、原生 bash、Herdr 0.9.3、Codex、业务文件修改和验收均真实执行。没有真实 Telegram 网络投递，不将该测试算作手机收发验收。

正式 test 绑定已迁移到 Bot 的 `bot` namespace：workspace `w3`、pane `w3:p1`、Agent `herdr-test`；仍使用原 UUID `01a10c65-a2c6-7132-8c78-61c6833d81d7` 和原 CODEX_HOME。旧 0.8.2 的该客户端经正常 Ctrl+C 退出，实际 writer lock 释放后才 resume；旧 server、其他项目及全局程序/配置未动。业务任务表隔离在本次证据目录，正式任务仍为空，不留测试失败占用正式项目。测试新增业务文件留在 `.worktrees/test/tg-chain-validation/`，未合并到源项目。

| 编号 | 本轮实际问题 | 验收结果 |
| --- | --- | --- |
| B21 | 帮 test 项目在 tg-chain-validation 里加个 Python 加法函数 add(a, b)，文件叫 addition.py，支持正数、负数和零，补 test_addition.py 的 unittest 和简短 README。其他文件不要动，直接交后台做。 | 登记 test-addition / addition-001；真实派发、真实三个新文件，ready_for_review；原话、整理需求、身份、时区、交接/run 字节 hash 均核对。 |
| B22 | 刚才 test 那条做完了吗？帮我按要求验收下，简短说结果。 | 前台实际读产物、运行 unittest、比较既有文件 hash，写 review 并 verify；5 项测试通过，释放串行占用。独立测试驱动另查正数、负数、零和大整数边界。 |
| B23 | 给刚才 test 的加法函数补类型检查：只接受整数，布尔值也不接受，其他类型抛 TypeError。更新测试和 README，继续交后台做，别改 tg-chain-validation 以外的文件。 | 新任务 test-addition-types / types-001；保留首条任务，复用同一个 UUID；真实修改允许的三个文件，无范围外修改。 |
| B24 | test 刚才的类型检查做好了吗？你实际跑一下测试验收，简短告诉我。 | 前台实跑并验收 verified；5 项 unittest，含 22 个非法参数子用例。独立驱动另查 bool、float、str、None 和列表均抛 TypeError。 |
| B25 | 给 test 后台一个只读核查任务：读取 tg-chain-validation/required-input-does-not-exist.json，告诉我里面的内容。如果不存在就如实报告读取失败，不要创建文件、不要改任何项目文件，也不要重试。 | test-read-missing / read-001；实际读取失败，reason=read_error，有 marker 和监督进程退出码 0，仍保持 blocked；整个 worktree 保持该轮前值。 |
| B26 | 刚才那个只读核查怎么样了？失败就直接说失败，先不要重试。 | result 返回真实错误；前台如实报告，不 verify、不重发、不新增 run。 |
| B27 | 1 + 1 =？只回答答案。 | 回答 2；任务表不变。 |
| B28 | 请联网查一下南京大学的官方英文名称，给官网链接，简短回答。 | 读取原 web-search Skill，实际 curl 抓取南京大学英文官网，返回 Nanjing University 和官网链接；任务表不变。原 Skill 明确允许官网 fetch 的 curl 兜底。 |

完整证据：[独立复核结果](.pi/agent/background/verification/tg-herdr-flow/2026-10-06T00-13-54.586+08-00/accepted-result.json)、[实际输入/回复/工具与登记 checkpoint](.pi/agent/background/verification/tg-herdr-flow/2026-10-06T00-13-54.586+08-00/conversation.json)、[测试登记表](.pi/agent/background/verification/tg-herdr-flow/2026-10-06T00-13-54.586+08-00/background/registry.json)、[最终文件审计](.pi/agent/background/verification/tg-herdr-flow/2026-10-06T00-13-54.586+08-00/final-audit.json)。每个 run 的 Herdr、原生回复、business、result、收据和前台 review 位于同一目录 background/runs/ 下。原生前台 session 与单份 observability 在 frontend/ 下。

共 40 个实际主模型请求与 40 个对应回复，System Prompt 和工具定义各一个版本；没有额外 background_* 工具。查询只返回最多 1200 字符的业务摘要和证据路径；实际前台没有直接 agent prompt/read，也没有读取 Codex 原生完整会话或 herdr-evidence 的全文，没有整段 worker 交接稿自动回灌。主 Pi 根据验收需要读取具体业务文件、业务结果和检查证据；这仍会消耗主模型上下文，不能说后台验收完全不占上下文。

保护复核：源项目保持原值，worktree 的 27 个既有文件保持原内容；本次只新增指定三个业务文件。认证、模型/默认配置、Codex 原生 TOML、正式登记表和 start.sh hash 均保持本组测试基线。实际修改在 execution/ 和 task_protocol.py，已有 Joye Skill 仅更新阶段适配；不新增模型工具或新 Skill。后台传输、检查与任务绑定集中在原 background 目录。

失败现场和测试判断修正均保留：

- 前两轮主模型连接因 TLS/fetch 失败，尚未登记或派发任务；第一轮测试清理还误调用了不存在的 ModelRuntime.dispose，已删除该调用并先保存证据。这两轮不算通过。
- [首次业务联测失败](.pi/agent/background/verification/tg-herdr-flow/2026-10-06T00-11-17.561+08-00/result.json)：0.9.3 的 pane run 成功只返回 CLI 退出码，没有 JSON。worker 已真实完成，但前台拒绝把未知收据当作成功，没有重发。已按官方实现与实际探针保存真实 CLI 退出证据，不伪造 API JSON。此轮产物经独立检查归档到该目录 business-artifacts/ 后，仅清理三个本轮新增文件，才启动上述新 session 完整八轮。
- [八轮原始测试结果](.pi/agent/background/verification/tg-herdr-flow/2026-10-06T00-13-54.586+08-00/result.json) 仍为 failed：最后一条断言只匹配 search.py/fetch.py，误拒绝了 Skill 允许且实际成功的 curl 官网 fetch。只修正测试的判断范围，没有修改搜索功能或重发 worker 任务。随后直接核对八轮原始证据、实际官方返回、全部产物、review 和请求，独立复核通过，另存 accepted-result.json，不覆盖原失败。
- 重复 start-run 的原测试遗漏 --run-id，只证明了语法拒绝；已用有效 CLI 参数补查实际语义拒绝，并记录 [补充证据](.pi/agent/background/verification/tg-herdr-flow/2026-10-06T00-13-54.586+08-00/duplicate-start-run-check.json)。测试入口同步修正。
- JS checkpoint 的 mtime_ns 超出安全整数，不能逐整数比较纳秒；独立审计仅此字段比较 IEEE754 值，原始 Python 文件证据与 review hash 仍精确核查，不改持久数据。

额外核查：[交接篡改/串行占用/无效超时](.pi/agent/background/verification/tg-herdr-flow/2026-10-06T00-13-54.586+08-00/handoff-guard-checks.json) 均在派发前拒绝并保持登记表；[真实前台进程占用](.pi/agent/background/verification/tg-herdr-flow/2026-10-06T00-13-54.586+08-00/foreground-shell-guard.json) 通过实际 sleep 进程验证不会把监督命令发给未知程序；[非 Herdr 调用方进入真实 pane 环境](.pi/agent/background/verification/tg-herdr-flow/2026-10-06T00-13-54.586+08-00/dispatch-context-audit.json) 核对 caller 无 HERDR_ENV、实际子进程由 Herdr 注入 1、bot namespace 和 w1:p1，并真实查询 Agent。没有手工填 1 或伪造 idle。现有 preparation.py、pi-cli.mjs 回归通过；JS 语法和改动 Python AST 检查记录在最终源码核查中。

迁移曾遇到 PATH 覆盖导致 Shell 创建失败，以及附带 Codex manifest 缺少 idle 规则。已适配 workspace PATH，并原样缓存官方 2026.10.01.1 检测规则后原生 reload，未接受 unknown 派发。来源/hash 和 [迁移最终审计](.pi/agent/background/verification/tg-herdr-flow/2026-10-05T23-57-29.069+08-00/migration-final-audit.json) 保存于迁移证据，旧错误不抹掉。

项目 TG 已使用既有 Windows Restart 重载，[前台恢复证据](.pi/agent/background/verification/tg-herdr-flow/2026-10-06T00-13-54.586+08-00/frontend-reload.json) 确认连接命令完成、pollingActive、active here、原 Pi session 恢复、herdr-workflow 加载、无新增后台工具。另用实际安装版资源加载器核对 [background 自动发现与事件/Skill](.pi/agent/background/verification/tg-herdr-flow/2026-10-06T00-13-54.586+08-00/frontend-resource-check.json)。此恢复证据不是 Telegram 最终消息投递证明。主动完成通知、Herdr 开机恢复、watchdog、未知发送对账和其他 Coding Agent 仍未接入。


### 2026-10-06：后台完整健康实验与故障恢复

完整复杂题库见 [complex-cases.mjs](tests/background/complex-cases.mjs)，实际时间、过程、原话/整理需求/绑定/结果/TG 签收与失败重跑见 [re.md](re.md)。每组先新建前台 session，使用自然项目名和相对目录；每个项目固定一个真实 Codex session 与长期 worktree。创建、存档恢复、领域机制与回放分别为三条真实任务。失败后从新目录、新前台 session 完整重跑，不能只补一个断言或给旧失败补算通过。

- TG 测试输入是构造 update 经过真实授权/队列；前台模型、bash、Herdr、Codex、独立验收和 TG API 真实，不冒充手机入站或手机收到回执。
- 稳定验收拒绝任何中途工具异常；领域错误即便 unittest 全过也须 reject。扑克累积短额全押重新加注、短额大盲保持完整下注门槛，铁路终端状态与轨道弹射分段轨迹均有实际失败和重跑记录。
- 除业务正确性，逐轮核对原话身份、task/run/hash、一次原生输入、固定 UUID、独立 review、报告正文/目标/验收 hash、API message_id、inbox handled、占用释放和范围外文件不变。
- [真实生命周期尝试 6](.pi/agent/background/verification/full-chain/2026-10-06T00-56-25.090+08-00/lifecycle-negative-attempt-6/result.json) 完整通过：缺文件失败、两次真实重试、第三次拒绝、5s 真实 Herdr 超时、180s 实际等待子进程、错误 run 不能取消、精准取消与幂等、命令退出、占用释放、原会话/旧业务不变。此类故障实验不计入十组复杂实验。
- 离线回归 lifecycle.py 与 reply-health.mjs 检查合作锁、租约/分支、unknown 防重、旧结果围栏、取消竞态、真实 OS 子进程边界和空回复一次恢复；不能替代真实 Codex 实验。
- 单调时钟记录阶段耗时；没有采集的旧阶段保留 not_collected，不能用绝对日期推算或冒充精确统计。整组时长包含根代理独立复核，与输入到最终 API 确认时长分别保存。

相对 root 回归：task_protocol.py --root 使用 Bot 相对目录时，prepare 文件路径、start_run 结果基线与 dispatch-prompt 的 business.json 位置都须解析为同一绝对根目录；真实 Herdr/Codex 切到 worktree 后仍能正确写入。此缺陷见 problem.md 问题 12；不要仅在绝对 --root 下测试。

### 2026-10-06：后台完成报告尾注、正文与时间

入口为 `tests/background/delivery-footer-live.mjs --live` 和 `tests/observability/background-delivery.mjs`；已有 lifecycle.py 增补完整分块签收与 unknown 防重。真实任务使用新的前台派发/验收 session、隔离登记表和允许的 test worktree 子目录；后台仍为永久 `herdr-test`，没有改认证、默认配置或启动参数。

[校正后的原证据独立审计](.pi/agent/background/verification/delivery-footer/2026-10-06T11-54-19.483+08-00/recovery-result.json) 通过：真实模型、Herdr/Codex、验收、Telegram API message_id 526 与 report/handled 均已核对，准备耗时 120603.0181285ms 与独立单调测量相差小于 1ms。Telegram HTTP Date 通过真实 getMe 安全校准，没有抢占主 Pi 的 getUpdates。构造入站不是手机入站，这个亚毫秒差值只验证本地计算一致，不提高 Telegram 秒精度或证明手机收到时刻。

早期驱动先用不存在的 SDK `session.newSession()`，后又误用纯正文 SHA256 验证协议 hash，原失败仍保留在 [re.md](re.md) 第 6 节。纠正后的 `--resume-evidence` 只审计已投递证据，没有重派任务、调用模型或重发 TG；不把恢复审计冒充新一组完整通过。

新增阶段字段在离线回归与真实 Herdr 证据结构上核对；历史已准备快照不补造新字段。普通回合、上下文观测和 reply-health 回归通过，故障隔离测试的 EEXIST 为故意注入，网络与模型调用为零。生产 TG 于 12:01:48+08:00 重新连接；测试全过程及重载证据见 re.md。

### 2026-10-06：后台报告引用原始任务提问

[实际 relay 模块核查](.pi/agent/background/verification/reply-to-original/relay-verification.json) 使用受控协议/发送器核对跨前台 session、不同 chat 及无 TG 来源，不调用模型或网络。lifecycle.py 增补引用参数序列化、API 实际引用确认、引用目标不可变、非法 ID、原消息删除与长报告各块的引用检查；旧协议、unknown 防重和完整签收同时回归。实际 TG API 引用验证及项目重载证据记录在 [re.md](re.md) 第 6.5 节；不把这次定向验证计入之前十组复杂任务。

### 2026-10-06：十组最终证据复核完成

test 五组、test1 五组，各创建加两次修改，30 条真实任务完整通过；15 次失败尝试单独保留。共 435 对实际主模型请求/回复，工具/模型/扩展异常为零；两个后台永久 UUID 保留。最终逐任务审计见 [final-chain-audit.json](.pi/agent/background/verification/full-chain/2026-10-06T00-56-25.090+08-00/final-chain-audit.json)，现场复核见 [final-runtime-audit.json](.pi/agent/background/verification/full-chain/2026-10-06T00-56-25.090+08-00/final-runtime-audit.json)，过程与时间见 [re.md](re.md)。构造入站和隔离扩展范围沿用上文限制，不冒充手机入站或八个扩展同时执行验收。

生态回归：非法 plant 水域命令在 running/win/loss 都要拒绝；合法空命令在终局仍按 tick+1。读源码/测试前列实际任务文件，不按新机制猜 test_mechanisms.py。第二次尝试三阶段虽均报告成功，但 read ENOENT 仍判整组失败；第三次从新 session、新目录完整重跑后通过。

### 失败任务后同项目续派：内部 host 与范围检查

- 用例来源：[Issue #39](https://github.com/554454545/judy_bot/issues/39)。第一轮失败后 Codex 内部 host 常驻，不应永久占用项目；同项目后续任务继续复用原 worktree 和原生 UUID。
- 本地回归入口为 `PYTHONDONTWRITEBYTECODE=1 python3 tests/background/failure-cleanup.py`。核对实际 executable、父进程、PID 出生身份，避免仅凭名字放行；host 的真实业务后代仍须阻止释放，取消不能误杀 host。
- 范围为 `**/*` 时，根目录 README.md、game.js 和嵌套 outputs 文件均应获准；指定文件/目录仍拒绝相邻路径、绝对路径与上级跳转。旧失败结果不能因校验修正被补写成成功。
- 实际续派测试的内容及数量等待用户指定；新建前台 session，后台仍复用同项目原生 session。不能把本地进程夹具或只读证据复核称为完整 TG→Codex 新任务通过。

### 迟到结果、旧失败通知与输入状态

- 监督超时后，原 `result.json` 不变；仅同一 task/run/session 的真实输入、final marker、原生完成及新产物都匹配时，收集迟到结果进入独立验收。不能从终端 done 或业务自述直接判目标完成。待验收期间保留项目占用。
- 缺 marker、缺 task_complete、参数变化、范围外修改、新输入、取消与登记变化均不能晋级；重启留下的收集文件必须重新核对，不能覆盖不可变证据。已释放并开始后续任务的历史 run 不自动采用当前产物。
- 同一失败已有真实 sender 签收和 handled 证明后，不再产生、派送或消费无新信息的 blocked_overdue；新结果、新失败阶段及 unknown 不能被旧签收吞掉。
- 迟到交付不能复用旧失败正文、message_id 或统计快照；仍引用原始 TG 提问。开发耗时取核实的原生 duration_ms 并说明来源，不能拿超时预算作完整耗时。
- 后台无 activeTurn 的模型回合结束也要停止 typing；切 session 时旧 getMe 与能力转换的异步回调不能访问旧 ctx，新监控继续工作。网络日志只保留类型和 code，不含凭据 URL、headers 或原话。
- 需求交接与验收保留用户原始目标，不能把“1:1／几乎一致”改成简化目标；可运行和自动测试通过不能代替原目标验收，缺失或未核实的部分不能通过。
- 本地回归入口：`tests/background/late-results.py`、`tests/background/late-delivery.mjs`、`tests/telegram/lifecycle.mjs`。这些不调用模型或 TG，不算完整真实链路实验；实际任务内容和数量仍等待用户指定，原始证据留在项目私有运行目录；既有调查记录见 Issue #45、#46、#38。
