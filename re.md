<!-- 用途：保留后台接入和真实实验的历史记录；后续调查、修改与验收写入 GitHub Issues，关联 plan.md 的问题处理流程。 -->
# 后台全链路健康验证记录

> 历史归档：自 2026-10-06 起，后续问题、处理过程与单次验收结果写入 [GitHub Issues](https://github.com/554454545/judy_bot/issues)，不再追加到本文件。既有记录原样保留，所述状态属于记录当时；私有原始证据继续留在项目运行目录。详见 [问题处理流程](plan.md#github-issues-问题处理流程)。

## 1. 记录规则与本次目标

- 本次开始时间：2026-10-06 00:41:59+08:00；全部项目记录使用北京时间。
- 用户授权接入：后台结果自动回传、独立验收与 TG 主动通知；项目 Herdr 常驻启动与恢复；watchdog、取消、重试及解除占用；真实 TG 网络链路验证。
- 对照 Joye 的 extensions、scripts、herdr-workflow；可复用的相关实现直接适配，不自动启用无关功能，不修改参考仓库和全局 Pi/Herdr。
- 实验目标：test 五组、test1 五组。每组一个复杂可验收的创建任务与至少两次修改，使用真实 Herdr/Codex、项目永久 session、长期 worktree。前台每组新 session。
- 实验组出现链路或验收问题即失败。修复后重新完整执行该组；失败尝试保留，不计入十组通过。
- 逐任务核对原话、整理需求、项目、worktree、session、task/run ID、hash、派发证据、结果、独立 review、真实投递回执、事件签收、占用释放和越界文件保护。
- 分别记录真实用户 TG 入站、构造入站、真实 TG API 投递及手机回执；缺少证据保持未验证，不能互相替代。
- 不记录凭据和完整私人会话。详细数据保存在 .pi/agent/background/verification/ 下，用链接引用；时间和通过结论必须来自实际运行。

## 2. 初始核查

- 已有：任务登记、原话取证、长期 worktree、项目内 Herdr 0.9.3、真实 Codex 派发、结果落盘、按查询进行独立验收。
- 缺失：outbox 消费与主动回传、自动验收通知、项目 Herdr 启动恢复、watchdog、失败取消/重试/解除占用完整流程；真实 TG 网络全链路尚未验收。
- Bot 根目录不是 Git 仓库；保留现有文件，按文件 hash 与定向检查核对改动。
- test 项目沿用正式绑定和已有永久 Codex session；test1 先核查用户新目录，实际登记后使用独立绑定，不借用 test 的身份。

## 3. 实现过程与缺陷

- 00:41—01:06：实现集中在 background/execution、notifications；移植 Joye 的 inbox/claim/ack、单次投递/receipt 和 watchdog；Pi 0.84.1 通过官方 sendMessage/agent_settled 唤醒独立验收，不加载旧 core patch，也不新增模型工具。
- 01:02:51：新目录 test1 确认为空后，仅创建授权的 Git 基准 README/初始提交，工作代码由真实 Codex 在 .worktrees/test1 编写。Herdr 为 herdr-test1，原生 UUID 为 01a10d04-b4a0-7ad2-8377-b5f8cb1d10a0，沿用永久会话。
- 01:06:40—01:06:45：项目 Pi 正常结束后已重启并连接 TG；Windows 任务仍 Running，项目 service PID/birth 已落盘。没有停止全局 Herdr。
- 已有离线边界校验：7 项通知/租约/重复/unknown/伪回执检查通过；旧登记和原话 CLI 回归通过。这些不计入十组真实复杂实验。
- 01:08：测试驱动发现 AgentSession.isIdle 是属性而非 ExtensionContext.isIdle() 方法，已修正驱动。已经启动的尝试仍按原代码完整记录；如因此失败，不计通过，重新完整跑。

- 2026-10-06T01:10:47+08:00：首轮真实运行发现 WSL 的 ps lstart 随校时漂移。同一 PID 2028240 的记录出生为 01:06:46，仍存活时 ps 推算为 01:06:59；watchdog 因此误报监督进程丢失。runner.pid_identity 改用内核 boot_id + /proc start_ticks，不使用墙上时钟作为身份；旧 birth-only 记录不猜测迁移。新增时区变化/错误启动 tick/错误 boot 身份回归并通过。
- SDK 测试结束后未清理 relay timer 会访问 stale ctx，已增加显式 dispose 和 ctx 失效防护；前台 dispose 前等待 abort 收尾。两份失败尝试均保留，不计通过；不会以修复后单独验收旧产物冒充完整重跑。

- 2026-10-06T01:11+08:00：首轮 worker 均正常完成，但实验已因健康误报失败；确认原 Agent done、监督进程 PID 已消失后，以正式 cancel 操作关闭旧占用，cleanup.json 留证。两项目均从新目录/新前台 session 开始尝试 2，Codex 原 UUID 不变。

- 01:14:20：真实结束本项目 service（精确 PID/start_ticks/boot_id），既有 Node 入口自动重启为新 PID；TG Pi 和两个 Codex 原 UUID 保留，证据 service-crash-recovery.json。
- 01:15:00—01:15:04：仅空闲 herdr-test1 正常 /quit，服务通过真实 bot-runtime Shell 恢复同 pane、同 CODEX_HOME、同 UUID，实际 Agent idle。恢复证据 recovery/test1.json 和 worker-exit-intent.json；不是新建替代 session。

- 01:15:17/01:15:25：两项目的实际独立验收通过，Telegram API 分别返回 message_id 379/380，但 report 拒绝签收。原因是 notify-telegram 首次返回值遗漏落盘已有的 event_id/hash，无法和 sender ledger 绑定；已改成首次即返回完整持久回执，新增正向签收回归通过。两次尝试均记失败，重新从创建任务开始尝试 3，不补算旧任务。
- 验收目录预先由 relay 创建，避免模型使用 Python 写 review 时 FileNotFoundError；调用协议失败时补存 operation、stdout/stderr 私有证据路径，避免只剩 Error 名称。
- 墙上时钟在尝试 2 的实验 1 中记录 217.2s，而单调时钟测得 200.8s；本次后续耗时以单调时钟为准，绝对时间仍原样记录北京时间，并保留 wallSeconds 供核查。不把墙上时间漂移误当执行耗时。

- 01:18:20：实验 6 尝试 3 的派发回复遇到两项目并发通知的本地冷却（明确 failed/local_cooldown，未发生网络发送）。测试驱动此前未按 retry_at 退避，直接失败。现驱动对明确失败按真实 retry_at 有界重试，unknown 不重发，保存每次网络回执。待 worker 正常结束后已 cancel 留证，重新创建尝试 4；原失败不计通过。

- 01:32:47：实验 6 尝试 4 在第三阶段被真实前台独立验收拒绝。72 个 worker unittest 和共同接口检查均通过，但新的独立碰撞用例发现“反弹后仅扫掠起点到终点直线”，实体折返经过敌弹时漏碰撞。这是实际业务缺陷，不是传输故障；没有报成功。整个尝试不计，题库补入分段轨迹回归，重新从创建开始尝试 5，旧产物保留。
- 失败实验驱动此前在看到 rework 后立即 dispose，没等待失败通知；已改为继续观察真实失败投递与事件签收，再结束失败尝试。避免测试自身提前断开而隐藏失败处理链路。
- 确认已有报告含 Markdown 标记：后台发送现在复用项目 Telegram renderer 生成 HTML，发送器绑定并记录 parse_mode，不再让新通知把反引号/加粗符号原样显示。格式意图仍放现有 final-report-receipt.json，不增加独立配置文件；首次真实格式签收待后续实验核对。
- 新增各阶段单调时钟：start-run、runner、Herdr 派发起止、结果、verify、API 接收与 handled；绝对时间仍北京时间。早期未采集的字段保留缺失，不反推补造。

- 01:40:19：WSL 调用 Windows PowerShell 的 vsock accept 超时，Restart 尚未成功。随后精确正常退出本项目 Node（PID + 内核出生身份），既有 Windows 常驻循环重新拉起；01:41:35 核对 pollingActive、active here 和两个原 UUID，production-reload-confirmed.json 留证。
- 01:41:46：真实 SIGTERM 结束项目后台 service（正常退出 0），Node 在 2.252s 内拉起新的服务；避免将正常但非预期退出误判为无需恢复。代码同时核对启动器身份，防止启动器消失后留下孤儿服务锁。
- 01:43:06：原生 UUID 错误的私有登记副本在真实现有 Agent 前被拒绝，没有 resume 替代会话；recovery-identity-negative.json 留证。
- 取消和验收并发的代码核查：取消收尾现处于同一登记锁，不能覆盖 verified/reported；重复取消返回同一份已核对不可变 proof。两次重试上限使用 retry_count，与独立验收拒绝次数分开。12 项离线协议回归通过，真实取消/重试实验另行执行，不冒充已验证。
- 01:49:01：实验 3 的第一次铁路创建被独立验收拒绝：终局仍有在途列车时，继续推进时钟到旧 eta 会使 validate 失败，之后 step 也失败。真实失败通知和 handled 均已落盘，整个尝试不计通过；题库补入此边界，从新目录、新前台 session 重跑。
- 已适配 Joye 空回复恢复到 .pi/extensions/reply-health/index.ts，普通对话最多补一次，后台内部控制跳过。六项恢复/抢占/分支边界回归通过；不是增加新后台工具。测试接力端初始化曾遇到路径末尾双斜线判断及不存在的 runtime.dispose，已修正；这些初始化检查没有调用模型或 TG，不计复杂组。

- 01:57:38：实验 7 首次存档已 verified，但实际通知遇到明确 local_cooldown；驱动因历史 attention 文件立即结束，未等已记录 retry_at 的自动恢复。驱动改按当前 inbox 的 needs_attention 判定，正常 pending/退避继续等待，unknown 仍不重发。原尝试仍记失败。
- 02:00：针对上述失败根目录，用新的真实 Pi owner 恢复已验收通知，5.008s 后 API 返回 message_id 414，report/handled 成功；没有新增 worker 输入或重跑业务，原 group-7-attempt-1/result.json 保留 passed=false。已从新目录、新前台 session 开始整组尝试 2。
- 隔离 Herdr 冷启动前两次探针失败分别因测试路径超过 Unix socket 长度上限，以及 server stop 成功无 JSON 被通用查询解析器拒绝；不影响原 bot 实例。改用项目内短运行路径和实际 CLI 退出证据，02:00:09 命名测试实例冷启动/停止后恢复/唯一 Shell/原 bot 身份保护均实测通过；测试实例已正常 stop，证据 herdr-cold-start-attempt-3/result.json。没有停止 bot 或全局 server。

- 02:03—02:04：精确核对启动器身份后实际 SIGKILL，旧 Pi 和后台服务均退出；Windows 既有循环拉起新入口，单调时钟测得主进程恢复 28.5185s。TG 实际连接命令在 02:04:11+08:00 完成；该连接点未采集单调时钟，不能用 28.5s 冒充 TG 恢复时间。新 owner PID 与新 state 写入时间再次核对，排除旧 pollingActive 文件误判，详见 launcher-crash-recovery.json。
- 主 Pi 真实资源加载器核对：background/reply-health 自动发现，背景工具数量 0；skill-creator、web-search、herdr-workflow 已加载，actual-project-resources.json 无扩展错误。后台公共接力进一步要求当前进程实际持有 personal TG profile，核对 owner PID/cwd/心跳与 polling/锁状态，避免仅凭启动器父进程认领通知。

- 02:17：旧 pi-cli 离线夹具只复制 background 源码，未带新接力依赖的既有 TG renderer，导入失败。夹具改为只链接项目已安装 .pi/npm，未复制凭据或改变生产依赖；原生 bash/原话/修订回归重新执行。此类夹具修正不计复杂实验通过。

- 02:27：真实生命周期尝试 1 已核对缺文件 read_error、实际失败 TG message_id 439 与安全释放，但显式 retry 后 watchdog 重放旧 run 结果，把 registered 改回 blocked，阻止新 run。health.reconcile 不再对 registered 重放旧结果，保留历史等待新 run；新增真实文件竞争回归，13 项离线检查通过。旧生命周期尝试仍 passed=false，新目录从首次缺文件输入完整重跑；复杂十组不把额外故障实验计入通过数。

- 02:35—02:36：生命周期尝试 2 真实完成两次新 run 失败、第三次拒绝及监督超时通知（message_id 445）。实际 Codex 已执行 Python sleep(180)，但驱动仅匹配 function_call，漏掉当前原生 custom_tool_call；证据等待超时。本次 wait 进程的 CODEX_HOME、PID、hrtimer_nanosleep 实际核对后，精确 cancel 本 run 成功，native-format-cleanup.json 留证；修正驱动同时识别两种原生格式，新目录从首次输入完整重跑，旧尝试保留失败。

- 02:37：扑克尝试 1 创建被独立验收拒绝：31 个 unittest 与 1947 项共同属性通过，但累计短额全押达到完整加注增量后未重新开放加注。实际失败投递/handled 已留证；verify --reject 已准确释放占用，cancel 非当前占用按协议拒绝，旧产物未改变。题库加入正反公开 API 回归，从新目录、新前台 session 完整重跑尝试 2；规则核对 [Poker TDA 官方说明](https://www.pokertda.com/view-poker-tda-rules/) 的 Re-Opening the Bet，不以模型断言替代规则依据。

- 02:40：生命周期尝试 3 已核对真实 sleep 调用及 /proc 等待进程，错误 run 取消被拒绝；精确 ESC 后 watchdog 先把同 run 的失败占用释放，cancel 最终事务因占用消失而拒绝完成。这是真实状态竞争，旧尝试失败。reconcile 现在不对已有 cancel_intent 的 run 自动失败释放，取消流程负责核对退出、签收和释放；并发文件回归及共 14 项离线检查通过，另从新目录开始真实尝试 4。

- 02:43：扑克尝试 2 的累计短全押回归通过，但公开下一手测试发现短额大盲将翻牌前跟注额10错误降为5、最小加注目标20错误降为15。35 个 unittest/共同属性通过仍未冒充完成，独立 verify --reject、真实失败通知及处理签收齐全。题库再补短额大盲正反回归，完整尝试 3 从新目录开始；依据 [TDA 对短额大盲的直接说明](https://www.pokertda.com/forum/index.php?topic=1040.0)。

- 02:44—02:46：生命周期尝试 4 的超时通知出现真实 transport_or_response_unknown；API 签收未确认，sender ledger 未重发。finally 的精确 ESC、实际监督进程退出及取消占用释放成功，原尝试仍失败。接力又发现 attention_owner 保存派发前 leaf，自己的回复使 leaf 改变后误认“换分支”，将未知投递重新认领为 enqueued。现在 unknown/sending attention 明确保持 delivery_unknown，不因自身 leaf 或时间到期重新认领；attention 同时绑定当前合法 owner，15 项离线回归通过。新尝试 5 完整重跑。
- 监督超时 reason 现在仅按匹配 task/run 的真实 Herdr error.code=timeout 写 time_budget，不从耗时或缺失 business 推断；原 business/proof 字节保留。网络未知额外保存不含 URL/Token 的 exception_type、cause_type 与 errno，旧未知记录未采集这些字段，不反推补造。

## 4. 十组实验

全部十组已完整通过，汇总及验证边界见第 5 节；下面保留每次原始尝试与失败，不覆盖历史。


### 实验 1：test/lawn-defense，尝试 1

开始：2026-10-06T01:05:38.456+08:00。创建复杂规则引擎 → 存档/恢复 → 新机制/回放，三条真实任务。证据：[本次目录](.pi/agent/background/verification/full-chain/2026-10-06T00-56-25.090+08-00/group-1-attempt-1/result.json)。入站为构造 TG update 经正式桥接授权和队列，不冒充手机入站；模型、Herdr/Codex、自动验收和 TG API 投递均为真实。

### 实验 6：test1/orbital-battle，尝试 1

开始：2026-10-06T01:06:18.280+08:00。创建复杂规则引擎 → 存档/恢复 → 新机制/回放，三条真实任务。证据：[本次目录](.pi/agent/background/verification/full-chain/2026-10-06T00-56-25.090+08-00/group-6-attempt-1/result.json)。入站为构造 TG update 经正式桥接授权和队列，不冒充手机入站；模型、Herdr/Codex、自动验收和 TG API 投递均为真实。

2026-10-06T01:08:51.091+08:00：本组尝试 1 失败，不计通过，192.6s。错误：Error: 阶段 0 失败：needs_reconciliation

2026-10-06T01:09:25.970+08:00：本组尝试 1 失败，不计通过，187.7s。错误：Error: 阶段 0 失败：needs_reconciliation

### 实验 6：test1/orbital-battle，尝试 2

开始：2026-10-06T01:11:26.471+08:00。创建复杂规则引擎 → 存档/恢复 → 新机制/回放，三条真实任务。证据：[本次目录](.pi/agent/background/verification/full-chain/2026-10-06T00-56-25.090+08-00/group-6-attempt-2/result.json)。入站为构造 TG update 经正式桥接授权和队列，不冒充手机入站；模型、Herdr/Codex、自动验收和 TG API 投递均为真实。

### 实验 1：test/lawn-defense，尝试 2

开始：2026-10-06T01:11:40.989+08:00。创建复杂规则引擎 → 存档/恢复 → 新机制/回放，三条真实任务。证据：[本次目录](.pi/agent/background/verification/full-chain/2026-10-06T00-56-25.090+08-00/group-1-attempt-2/result.json)。入站为构造 TG update 经正式桥接授权和队列，不冒充手机入站；模型、Herdr/Codex、自动验收和 TG API 投递均为真实。

2026-10-06T01:15:18.163+08:00：本组尝试 2 失败，不计通过，200.8s。错误：Error: 阶段 0 验收或投递未确认，必须检查 attention 证据

2026-10-06T01:15:26.095+08:00：本组尝试 2 失败，不计通过，239.6s。错误：Error: 阶段 0 验收或投递未确认，必须检查 attention 证据

### 实验 1：test/lawn-defense，尝试 3

开始：2026-10-06T01:17:11.150+08:00。创建复杂规则引擎 → 存档/恢复 → 新机制/回放，三条真实任务。证据：[本次目录](.pi/agent/background/verification/full-chain/2026-10-06T00-56-25.090+08-00/group-1-attempt-3/result.json)。入站为构造 TG update 经正式桥接授权和队列，不冒充手机入站；模型、Herdr/Codex、自动验收和 TG API 投递均为真实。

### 实验 6：test1/orbital-battle，尝试 3

开始：2026-10-06T01:17:12.325+08:00。创建复杂规则引擎 → 存档/恢复 → 新机制/回放，三条真实任务。证据：[本次目录](.pi/agent/background/verification/full-chain/2026-10-06T00-56-25.090+08-00/group-6-attempt-3/result.json)。入站为构造 TG update 经正式桥接授权和队列，不冒充手机入站；模型、Herdr/Codex、自动验收和 TG API 投递均为真实。

2026-10-06T01:18:20.013+08:00：本组尝试 3 失败，不计通过，64.0s。错误：AssertionError [ERR_ASSERTION]: 真实 TG 回执 front-6-3-506031

### 实验 6：test1/orbital-battle，尝试 4

开始：2026-10-06T01:19:56.160+08:00。创建复杂规则引擎 → 存档/恢复 → 新机制/回放，三条真实任务。证据：[本次目录](.pi/agent/background/verification/full-chain/2026-10-06T00-56-25.090+08-00/group-6-attempt-4/result.json)。入站为构造 TG update 经正式桥接授权和队列，不冒充手机入站；模型、Herdr/Codex、自动验收和 TG API 投递均为真实。

- 2026-10-06T01:20:13.938+08:00：阶段 1 通过；task lawn-create / run lawn-create-r1；170.3s；TG message_id 382；属性检查 1946 项，真实业务测试通过，项目占用已释放。

- 2026-10-06T01:23:33.951+08:00：阶段 1 通过；task orbital-create / run orbital-create-r1；202.0s；TG message_id 385；属性检查 1947 项，真实业务测试通过，项目占用已释放。

- 2026-10-06T01:23:42.309+08:00：阶段 2 通过；task lawn-save / run lawn-save-r1；194.5s；TG message_id 386；属性检查 1990 项，真实业务测试通过，项目占用已释放。

- 2026-10-06T01:27:44.372+08:00：阶段 2 通过；task orbital-save / run orbital-save-r1；235.1s；TG message_id 389；属性检查 1991 项，真实业务测试通过，项目占用已释放。

- 2026-10-06T01:28:31.578+08:00：阶段 3 通过；task lawn-replay / run lawn-replay-r1；269.5s；TG message_id 390；属性检查 1998 项，真实业务测试通过，项目占用已释放。

2026-10-06T01:28:31.811+08:00：本组尝试 3 完整通过，计入十组，636.3s。三个阶段均通过，实际 API 投递和处理签收已核对。

### 实验 2：test/dungeon-tactics，尝试 1

开始：2026-10-06T01:28:33.367+08:00。创建复杂规则引擎 → 存档/恢复 → 新机制/回放，三条真实任务。证据：[本次目录](.pi/agent/background/verification/full-chain/2026-10-06T00-56-25.090+08-00/group-2-attempt-1/result.json)。入站为构造 TG update 经正式桥接授权和队列，不冒充手机入站；模型、Herdr/Codex、自动验收和 TG API 投递均为真实。

2026-10-06T01:32:47.975+08:00：本组尝试 4 失败，不计通过，722.3s。错误：Error: 阶段 2 失败：rework

- 2026-10-06T01:34:45.571+08:00：阶段 1 通过；task dungeon-create / run dungeon-create-r1；347.4s；TG message_id 393；属性检查 1947 项，真实业务测试通过，项目占用已释放。

### 实验 6：test1/orbital-battle，尝试 5

开始：2026-10-06T01:36:27.084+08:00。创建复杂规则引擎 → 存档/恢复 → 新机制/回放，三条真实任务。证据：[本次目录](.pi/agent/background/verification/full-chain/2026-10-06T00-56-25.090+08-00/group-6-attempt-5/result.json)。入站为构造 TG update 经正式桥接授权和队列，不冒充手机入站；模型、Herdr/Codex、自动验收和 TG API 投递均为真实。

- 2026-10-06T01:38:15.722+08:00：阶段 2 通过；task dungeon-save / run dungeon-save-r1；195.9s；TG message_id 396；属性检查 1991 项，真实业务测试通过，项目占用已释放。

- 2026-10-06T01:39:46.682+08:00：阶段 1 通过；task orbital-create / run orbital-create-r1；183.5s；TG message_id 398；属性检查 1947 项，真实业务测试通过，项目占用已释放。

- 2026-10-06T01:43:06.213+08:00：阶段 2 通过；task orbital-save / run orbital-save-r1；185.5s；TG message_id 400；属性检查 1991 项，真实业务测试通过，项目占用已释放。

- 2026-10-06T01:43:20.855+08:00：阶段 3 通过；task dungeon-replay / run dungeon-replay-r1；284.3s；TG message_id 401；属性检查 1999 项，真实业务测试通过，项目占用已释放。

2026-10-06T01:43:21.237+08:00：本组尝试 1 完整通过，计入十组，829.7s。三个阶段均通过，实际 API 投递和处理签收已核对。

### 实验 3：test/rail-network，尝试 1

开始：2026-10-06T01:43:24.289+08:00。创建复杂规则引擎 → 存档/恢复 → 新机制/回放，三条真实任务。证据：[本次目录](.pi/agent/background/verification/full-chain/2026-10-06T00-56-25.090+08-00/group-3-attempt-1/result.json)。入站为构造 TG update 经正式桥接授权和队列，不冒充手机入站；模型、Herdr/Codex、自动验收和 TG API 投递均为真实。

- 2026-10-06T01:48:16.624+08:00：阶段 3 通过；task orbital-replay / run orbital-replay-r1；288.7s；TG message_id 404；属性检查 1999 项，真实业务测试通过，项目占用已释放。

2026-10-06T01:48:16.783+08:00：本组尝试 5 完整通过，计入十组，660.1s。三个阶段均通过，实际 API 投递和处理签收已核对。

### 实验 7：test1/maze-defense，尝试 1

开始：2026-10-06T01:48:18.682+08:00。创建复杂规则引擎 → 存档/恢复 → 新机制/回放，三条真实任务。证据：[本次目录](.pi/agent/background/verification/full-chain/2026-10-06T00-56-25.090+08-00/group-7-attempt-1/result.json)。入站为构造 TG update 经正式桥接授权和队列，不冒充手机入站；模型、Herdr/Codex、自动验收和 TG API 投递均为真实。

2026-10-06T01:49:01.288+08:00：本组尝试 1 失败，不计通过，313.0s。错误：Error: 阶段 0 失败：rework；真实失败通知和事件签收已保存

### 实验 3：test/rail-network，尝试 2

开始：2026-10-06T01:50:35.736+08:00。创建复杂规则引擎 → 存档/恢复 → 新机制/回放，三条真实任务。证据：[本次目录](.pi/agent/background/verification/full-chain/2026-10-06T00-56-25.090+08-00/group-3-attempt-2/result.json)。入站为构造 TG update 经正式桥接授权和队列，不冒充手机入站；模型、Herdr/Codex、自动验收和 TG API 投递均为真实。

- 2026-10-06T01:53:25.044+08:00：实验 3 / 尝试 2 / 阶段 1 通过；task rail-create / run rail-create-r1；155.5s；TG message_id 408；属性检查 1947 项，真实业务测试通过，项目占用已释放。

- 2026-10-06T01:53:44.021+08:00：实验 7 / 尝试 1 / 阶段 1 通过；task maze-defense-create / run maze-defense-create-r1；302.4s；TG message_id 409；属性检查 1946 项，真实业务测试通过，项目占用已释放。

- 2026-10-06T01:56:44.153+08:00：实验 3 / 尝试 2 / 阶段 2 通过；task rail-save / run rail-save-r1；187.0s；TG message_id 412；属性检查 1991 项，真实业务测试通过，项目占用已释放。

2026-10-06T01:57:38.125+08:00：实验 7 / 尝试 1 失败，不计通过，521.3s。错误：Error: 阶段 1 验收或投递未确认，必须检查 attention 证据

- 2026-10-06T02:00:58.352+08:00：实验 3 / 尝试 2 / 阶段 3 通过；task rail-replay / run rail-replay-r1；234.8s；TG message_id 415；属性检查 1999 项，真实业务测试通过，项目占用已释放。

2026-10-06T02:00:58.643+08:00：实验 3 / 尝试 2 完整通过，计入十组，579.6s。三个阶段均通过，实际 API 投递和处理签收已核对。

### 实验 4：test/conveyor-factory，尝试 1

开始：2026-10-06T02:00:58.935+08:00。创建复杂规则引擎 → 存档/恢复 → 新机制/回放，三条真实任务。证据：[本次目录](.pi/agent/background/verification/full-chain/2026-10-06T00-56-25.090+08-00/group-4-attempt-1/result.json)。入站为构造 TG update 经正式桥接授权和队列，不冒充手机入站；模型、Herdr/Codex、自动验收和 TG API 投递均为真实。

### 实验 7：test1/maze-defense，尝试 2

开始：2026-10-06T02:01:13.964+08:00。创建复杂规则引擎 → 存档/恢复 → 新机制/回放，三条真实任务。证据：[本次目录](.pi/agent/background/verification/full-chain/2026-10-06T00-56-25.090+08-00/group-7-attempt-2/result.json)。入站为构造 TG update 经正式桥接授权和队列，不冒充手机入站；模型、Herdr/Codex、自动验收和 TG API 投递均为真实。

- 2026-10-06T02:03:43.365+08:00：实验 7 / 尝试 2 / 阶段 1 通过；task maze-create / run maze-create-r1；137.6s；TG message_id 418；属性检查 1946 项，真实业务测试通过，项目占用已释放。

- 2026-10-06T02:06:20.330+08:00：实验 7 / 尝试 2 / 阶段 2 通过；task maze-save / run maze-save-r1；144.7s；TG message_id 420；属性检查 1990 项，真实业务测试通过，项目占用已释放。

- 2026-10-06T02:06:58.160+08:00：实验 4 / 尝试 1 / 阶段 1 通过；task conveyor-create / run conveyor-create-r1；332.8s；TG message_id 421；属性检查 1947 项，真实业务测试通过，项目占用已释放。

- 2026-10-06T02:09:44.330+08:00：实验 4 / 尝试 1 / 阶段 2 通过；task conveyor-save / run conveyor-save-r1；153.9s；TG message_id 424；属性检查 1991 项，真实业务测试通过，项目占用已释放。

- 2026-10-06T02:10:49.185+08:00：实验 7 / 尝试 2 / 阶段 3 通过；task maze-replay / run maze-replay-r1；249.2s；TG message_id 426；属性检查 1998 项，真实业务测试通过，项目占用已释放。

2026-10-06T02:10:49.377+08:00：实验 7 / 尝试 2 完整通过，计入十组，533.4s。三个阶段均通过，实际 API 投递和处理签收已核对。

### 实验 8：test1/city-epidemic，尝试 1

开始：2026-10-06T02:10:50.243+08:00。创建复杂规则引擎 → 存档/恢复 → 新机制/回放，三条真实任务。证据：[本次目录](.pi/agent/background/verification/full-chain/2026-10-06T00-56-25.090+08-00/group-8-attempt-1/result.json)。入站为构造 TG update 经正式桥接授权和队列，不冒充手机入站；模型、Herdr/Codex、自动验收和 TG API 投递均为真实。

- 2026-10-06T02:14:04.117+08:00：实验 4 / 尝试 1 / 阶段 3 通过；task conveyor-mechanisms / run conveyor-mechanisms-r1；241.9s；TG message_id 428；属性检查 1999 项，真实业务测试通过，项目占用已释放。

2026-10-06T02:14:04.488+08:00：实验 4 / 尝试 1 完整通过，计入十组，730.8s。三个阶段均通过，实际 API 投递和处理签收已核对。

### 实验 5：test/cascade-puzzle，尝试 1

开始：2026-10-06T02:14:07.832+08:00。创建复杂规则引擎 → 存档/恢复 → 新机制/回放，三条真实任务。证据：[本次目录](.pi/agent/background/verification/full-chain/2026-10-06T00-56-25.090+08-00/group-5-attempt-1/result.json)。入站为构造 TG update 经正式桥接授权和队列，不冒充手机入站；模型、Herdr/Codex、自动验收和 TG API 投递均为真实。

- 2026-10-06T02:15:25.482+08:00：实验 8 / 尝试 1 / 阶段 1 通过；task city-epidemic-create / run city-epidemic-create-r1；255.5s；TG message_id 430；属性检查 1947 项，真实业务测试通过，项目占用已释放。

- 2026-10-06T02:18:50.610+08:00：实验 8 / 尝试 1 / 阶段 2 通过；task city-epidemic-save / run city-epidemic-save-r1；190.3s；TG message_id 432；属性检查 1991 项，真实业务测试通过，项目占用已释放。

- 2026-10-06T02:19:02.106+08:00：实验 5 / 尝试 1 / 阶段 1 通过；task cascade-create / run cascade-create-r1；268.8s；TG message_id 433；属性检查 1947 项，真实业务测试通过，项目占用已释放。

- 2026-10-06T02:21:37.828+08:00：实验 5 / 尝试 1 / 阶段 2 通过；task cascade-save / run cascade-save-r1；144.2s；TG message_id 436；属性检查 1991 项，真实业务测试通过，项目占用已释放。

- 2026-10-06T02:26:09.091+08:00：实验 5 / 尝试 1 / 阶段 3 通过；task cascade-special-replay / run cascade-special-replay-r1；248.7s；TG message_id 438；属性检查 1999 项，真实业务测试通过，项目占用已释放。

2026-10-06T02:26:09.409+08:00：实验 5 / 尝试 1 完整通过，计入十组，664.4s。三个阶段均通过，实际 API 投递和处理签收已核对。

### 额外真实生命周期实验：2026-10-06T02:27:38.317+08:00

82.5s；失败。证据：[lifecycle-negative-attempt-1](.pi/agent/background/verification/full-chain/2026-10-06T00-56-25.090+08-00/lifecycle-negative-attempt-1/result.json)。AssertionError: {"error": "ValueError", "message": "任务已存在；不重复派发或覆盖历史结果"}


- 2026-10-06T02:29:31.757+08:00：实验 8 / 尝试 1 / 阶段 3 通过；task city-epidemic-replay / run city-epidemic-replay-r1；586.6s；TG message_id 440；属性检查 1999 项，真实业务测试通过，项目占用已释放。

2026-10-06T02:29:31.929+08:00：实验 8 / 尝试 1 完整通过，计入十组，1034.5s。三个阶段均通过，实际 API 投递和处理签收已核对。

### 实验 9：test1/poker-tournament，尝试 1

开始：2026-10-06T02:29:31.994+08:00。创建复杂规则引擎 → 存档/恢复 → 新机制/回放，三条真实任务。证据：[本次目录](.pi/agent/background/verification/full-chain/2026-10-06T00-56-25.090+08-00/group-9-attempt-1/result.json)。入站为构造 TG update 经正式桥接授权和队列，不冒充手机入站；模型、Herdr/Codex、自动验收和 TG API 投递均为真实。

### 额外真实生命周期实验：2026-10-06T02:36:52.193+08:00

426.1s；失败。证据：[lifecycle-negative-attempt-2](.pi/agent/background/verification/full-chain/2026-10-06T00-56-25.090+08-00/lifecycle-negative-attempt-2/result.json)。TimeoutError: 等待真实故障证据超时

2026-10-06T02:37:11.833+08:00：实验 9 / 尝试 1 失败，不计通过，426.1s。错误：Error: 阶段 0 失败：rework；真实失败通知和事件签收已保存

### 实验 9：test1/poker-tournament，尝试 2

开始：2026-10-06T02:39:13.703+08:00。创建复杂规则引擎 → 存档/恢复 → 新机制/回放，三条真实任务。证据：[本次目录](.pi/agent/background/verification/full-chain/2026-10-06T00-56-25.090+08-00/group-9-attempt-2/result.json)。入站为构造 TG update 经正式桥接授权和队列，不冒充手机入站；模型、Herdr/Codex、自动验收和 TG API 投递均为真实。

### 额外真实生命周期实验：2026-10-06T02:40:38.103+08:00

192.5s；失败。证据：[lifecycle-negative-attempt-3](.pi/agent/background/verification/full-chain/2026-10-06T00-56-25.090+08-00/lifecycle-negative-attempt-3/result.json)。AssertionError: {"error": "ValueError", "message": "取消完成时项目占用已变化；保留现场"}


2026-10-06T02:43:26.400+08:00：实验 9 / 尝试 2 失败，不计通过，234.2s。错误：Error: 阶段 0 失败：rework；真实失败通知和事件签收已保存

### 实验 9：test1/poker-tournament，尝试 3

开始：2026-10-06T02:44:21.668+08:00。创建复杂规则引擎 → 存档/恢复 → 新机制/回放，三条真实任务。证据：[本次目录](.pi/agent/background/verification/full-chain/2026-10-06T00-56-25.090+08-00/group-9-attempt-3/result.json)。入站为构造 TG update 经正式桥接授权和队列，不冒充手机入站；模型、Herdr/Codex、自动验收和 TG API 投递均为真实。

### 额外真实生命周期实验：2026-10-06T02:46:55.112+08:00

281.4s；失败。证据：[lifecycle-negative-attempt-4](.pi/agent/background/verification/full-chain/2026-10-06T00-56-25.090+08-00/lifecycle-negative-attempt-4/result.json)。TimeoutError: 等待真实故障证据超时

- 2026-10-06T02:48:21.074+08:00：实验 9 / 尝试 3 / 阶段 1 通过；task poker-create-attempt-3 / run poker-create-run-1；218.6s；TG message_id 457；属性检查 1947 项，真实业务测试通过，项目占用已释放。

- 2026-10-06T02:51:19.254+08:00：实验 9 / 尝试 3 / 阶段 2 通过；task poker-save-attempt-3 / run poker-save-run-1；166.5s；TG message_id 459；属性检查 1991 项，真实业务测试通过，项目占用已释放。

### 额外真实生命周期实验：2026-10-06T02:53:26.781+08:00

169.3s；失败。证据：[lifecycle-negative-attempt-5](.pi/agent/background/verification/full-chain/2026-10-06T00-56-25.090+08-00/lifecycle-negative-attempt-5/result.json)。TimeoutError: 等待真实故障证据超时

- 2026-10-06T02:55:16.739+08:00：实验 9 / 尝试 3 / 阶段 3 通过；task poker-replay-attempt-3 / run poker-replay-run-1；221.0s；TG message_id 465；属性检查 1999 项，真实业务测试通过，项目占用已释放。

2026-10-06T02:55:16.860+08:00：实验 9 / 尝试 3 失败，不计通过，608.1s。错误：AssertionError [ERR_ASSERTION]: 十组稳定验收没有中途工具异常

### 实验 9：test1/poker-tournament，尝试 4

开始：2026-10-06T08:25:43.970+08:00。创建复杂规则引擎 → 存档/恢复 → 新机制/回放，三条真实任务。证据：[本次目录](.pi/agent/background/verification/full-chain/2026-10-06T00-56-25.090+08-00/group-9-attempt-4/result.json)。入站为构造 TG update 经正式桥接授权和队列，不冒充手机入站；模型、Herdr/Codex、自动验收和 TG API 投递均为真实。

### 2026-10-06T08:25:45.134+08:00：取消子进程与扑克第三次失败的核查

扑克尝试 3 三阶段均有真实产物、独立验收与 TG 签收，但前台在阶段 3 查询时拼错 Python 单行字典，CLI 管道出现 SyntaxError/BrokenPipeError；整组按中途工具异常失败保留，不计通过。查询约定补充直接使用已有 inspect 有界输出；新前台 session、全新业务目录进行尝试 4，后续生态组继续等待整组通过。没有把原失败改成通过。

生命周期尝试 5 在真实 ESC 后 Codex 已 idle，但 Python sleep(180) 子进程仍存活。现场身份 2463593 / start_ticks 5423201 及人工精确清理证据保留 residual-child-cleanup.json。health.py 现在在真实派发前记录 Coding Agent 及已有子进程基线，取消时只清理该 run 新增的独立进程组，逐 PID 用内核 pidfd 验证出生身份；已有服务、Agent 自身与其他客户端不清理。watchdog 只有确认本轮没有遗留命令后才释放失败占用，缺失基线的旧 run 保留占用。项目 Python 没有 os.pidfd_open，libc 也缺少对应包装；已核对本机 x86_64 Linux 头文件 syscall 434，通过 ctypes 调用，信号用 signal.pidfd_send_signal。其他架构保持明确拒绝，不降级盲杀。两次本地包装探针失败保留工具输出，未投入真实派发；最终 16 项离线回归通过，包含真实创建的两个 sleep 进程、新进程退出、旧进程与父进程保留。开始完整生命周期尝试 6；它是额外健康实验，不计十组。

### 额外真实生命周期实验：2026-10-06T08:28:50.054+08:00

186.0s；通过。证据：[lifecycle-negative-attempt-6](.pi/agent/background/verification/full-chain/2026-10-06T00-56-25.090+08-00/lifecycle-negative-attempt-6/result.json)。

- 2026-10-06T08:28:50.530+08:00：实验 9 / 尝试 4 / 阶段 1 通过；task poker-attempt4-create / run poker-attempt4-create-r1；184.1s；TG message_id 471；属性检查 1947 项，真实业务测试通过，项目占用已释放。

### 2026-10-06T08:29:02+08:00：生命周期完整重跑与正式前台加载

生命周期尝试 6 完整通过，186.0s，16 条真实检查，observer 正常退出 0。实际首次 read_error 与两次新 run 失败分别 API message_id 467/468/469；第三次 retry 明确拒绝。真实 Herdr 5s 超时仍保留正在工作 Agent 和占用，失败 API message_id 470；原生实际 sleep(180) 进程 3817675 经 pidfd 清理退出，错误 run 未中断，正确取消重复得到相同证据；原 UUID、既有业务文件和永久客户端保留。前五次完整失败仍不计通过。详细证据见 [result.json](.pi/agent/background/verification/full-chain/2026-10-06T00-56-25.090+08-00/lifecycle-negative-attempt-6/result.json)。

正式 TG/Pi 经原有 Windows 重启循环重新加载；仅向确认过的本项目 Node 进程发送 SIGTERM，没有重启 Herdr/Codex。35.304s 后实际新 owner PID 3819267、原主 Pi UUID、最新 heartbeat/pollingActive/active here、真实连接完成日志与 relay owner_ready(explicitOwnerOverride=false) 同时核实，旧 Pi/Node 已退出。该 35.304s 是重载到确认新 owner/连接的单调时钟，不是任务耗时或 WSL 开机时间。证据：[production-final-reload.json](.pi/agent/background/verification/full-chain/2026-10-06T00-56-25.090+08-00/production-final-reload.json)。

- 2026-10-06T08:31:22.279+08:00：实验 9 / 尝试 4 / 阶段 2 通过；task poker-attempt4-save / run poker-attempt4-save-r1；151.7s；TG message_id 473；属性检查 1991 项，真实业务测试通过，项目占用已释放。

### 2026-10-06T08:33:48.939+08:00：扑克第四次前台调用错误

尝试 4 的阶段 3 首次 bash 把 prepare 追加为 register 参数，被 argparse 在执行前拒绝，之后模型自行改正并真实派发，但此整组仍按中途工具异常失败，不补算通过。已有 Joye Skill 本地副本新增逐操作调用约定与实跑验证的多行 Python 有界 inspect 示例，避免单行字典语法错误和直接输出全表；没有改 CLI 接口、增加模型工具或写新 Skill。示例在正式空任务表实跑退出 0，约 2.5KB，只含项目身份、当前任务状态和交接校验。待本轮在途任务完成及失败证据落盘后，新 session/新目录重跑尝试 5；生态组继续门控。

- 2026-10-06T08:34:36.386+08:00：实验 9 / 尝试 4 / 阶段 3 通过；task poker-attempt4-replay / run poker-attempt4-replay-r1；194.1s；TG message_id 475；属性检查 1999 项，真实业务测试通过，项目占用已释放。

2026-10-06T08:34:36.514+08:00：实验 9 / 尝试 4 失败，不计通过，532.5s。错误：AssertionError [ERR_ASSERTION]: 十组稳定验收没有中途工具异常

### 实验 9：test1/poker-tournament，尝试 5

开始：2026-10-06T08:34:53.878+08:00。创建复杂规则引擎 → 存档/恢复 → 新机制/回放，三条真实任务。证据：[本次目录](.pi/agent/background/verification/full-chain/2026-10-06T00-56-25.090+08-00/group-9-attempt-5/result.json)。入站为构造 TG update 经正式桥接授权和队列，不冒充手机入站；模型、Herdr/Codex、自动验收和 TG API 投递均为真实。

2026-10-06T08:37:18.424+08:00：实验 9 / 尝试 5 失败，不计通过，144.5s。错误：Error: 阶段 0 失败：blocked；真实失败通知和事件签收已保存

### 2026-10-06T08:39:56.001+08:00：相对 root 跨工作目录的真实缺陷

扑克尝试 5 使用合法相对 --root。start-run 未规范化 root，dispatch-prompt 中业务结果路径为相对 Bot 目录；真实 Codex cwd 是 test1 worktree，按该路径写入了错误位置。Herdr 原生输入一次、最终 marker 和业务程序均实际完成，但收集端找不到正确 business，scope 检查也发现额外文件；真实 blocked 通知和 handled 已保存，失败占用在确认无子命令后释放。本组不计通过。CLI 入口及 start_run 现在在生成路径前解析绝对 root，保留相对调用接口、不增加参数或工具；补相对 root 的真实 CLI/交接回归。误写 business 按原 SHA256 记证并归档为 mislocated-business.json；仅删除本轮确定新增的误写文件及其空父目录，不给原失败补结果或改证据。新目录/新前台 session 开始尝试 6。

### 实验 9：test1/poker-tournament，尝试 6

开始：2026-10-06T08:40:28.240+08:00。创建复杂规则引擎 → 存档/恢复 → 新机制/回放，三条真实任务。证据：[本次目录](.pi/agent/background/verification/full-chain/2026-10-06T00-56-25.090+08-00/group-9-attempt-6/result.json)。入站为构造 TG update 经正式桥接授权和队列，不冒充手机入站；模型、Herdr/Codex、自动验收和 TG API 投递均为真实。

- 2026-10-06T08:43:21.906+08:00：实验 9 / 尝试 6 / 阶段 1 通过；task poker-create / run poker-create-r1；170.9s；TG message_id 479；属性检查 1947 项，真实业务测试通过，项目占用已释放。

- 2026-10-06T08:45:57.691+08:00：实验 9 / 尝试 6 / 阶段 2 通过；task poker-save / run poker-save-r1；155.8s；TG message_id 481；属性检查 1991 项，真实业务测试通过，项目占用已释放。

- 2026-10-06T08:48:48.933+08:00：实验 9 / 尝试 6 / 阶段 3 通过；task poker-replay / run poker-replay-r1；171.2s；TG message_id 483；属性检查 1999 项，真实业务测试通过，项目占用已释放。

2026-10-06T08:48:49.134+08:00：实验 9 / 尝试 6 完整通过，计入十组，500.9s。三个阶段均通过，实际 API 投递和处理签收已核对。

### 实验 10：test1/ecosystem-world，尝试 1

开始：2026-10-06T08:48:49.391+08:00。创建复杂规则引擎 → 存档/恢复 → 新机制/回放，三条真实任务。证据：[本次目录](.pi/agent/background/verification/full-chain/2026-10-06T00-56-25.090+08-00/group-10-attempt-1/result.json)。入站为构造 TG update 经正式桥接授权和队列，不冒充手机入站；模型、Herdr/Codex、自动验收和 TG API 投递均为真实。

2026-10-06T08:53:22.348+08:00：实验 10 / 尝试 1 失败，不计通过，273.0s。错误：Error: 阶段 0 失败：rework；真实失败通知和事件签收已保存

### 2026-10-06T08:54:08.253+08:00：生态模拟首次领域验收拒绝

尝试 1 的 29 个实际 unittest 和 1947 项共同属性断言通过；同步捕食、能量、繁殖和路径规则独立核对通过。但明确非法的 plant 水域命令在 running 抛 ValueError，在 win/loss 被提前终局分支静默忽略，违反非法命令须拒绝的既有验收。前台实际复现后 verify --reject；真实失败通知与 handled 均留证，项目占用已准确释放。题库补入终局语义校验正反公开 API 回归，从新前台 session、新目录重新完整执行尝试 2；根代理不修改业务引擎、不补算原尝试。

### 实验 10：test1/ecosystem-world，尝试 2

开始：2026-10-06T08:54:08.359+08:00。创建复杂规则引擎 → 存档/恢复 → 新机制/回放，三条真实任务。证据：[本次目录](.pi/agent/background/verification/full-chain/2026-10-06T00-56-25.090+08-00/group-10-attempt-2/result.json)。入站为构造 TG update 经正式桥接授权和队列，不冒充手机入站；模型、Herdr/Codex、自动验收和 TG API 投递均为真实。

- 2026-10-06T08:57:50.749+08:00：实验 10 / 尝试 2 / 阶段 1 通过；task ecosystem-create-20261006-085410 / run create-01；219.8s；TG message_id 487；属性检查 1947 项，真实业务测试通过，项目占用已释放。

- 2026-10-06T09:01:39.900+08:00：实验 10 / 尝试 2 / 阶段 2 通过；task ecosystem-save-20261006-085750 / run save-01；229.2s；TG message_id 489；属性检查 1991 项，真实业务测试通过，项目占用已释放。

### 2026-10-06T09:06:23.533+08:00：生态第二次前台猜测文件名

尝试 2 的第三阶段已真实完成，前台读取未实际存在的 test_mechanisms.py 返回 ENOENT；Codex 实际将新增回归补在原测试文件内。即使模型随后自行列目录并继续验收，整组仍按中途工具异常失败，不计通过。已有 Joye herdr-workflow 本地副本和测试驱动明确要求先列任务范围的实际文件或核对业务产物，再读取确认存在的路径；不新增工具、接口或 Skill，不改业务程序。待真实通知/handled 收尾后从新 session、新目录完整重跑尝试 3，原失败证据保留。

- 2026-10-06T09:06:46.602+08:00：实验 10 / 尝试 2 / 阶段 3 通过；task ecosystem-replay-20261006-090139 / run replay-01；306.7s；TG message_id 491；属性检查 1999 项，真实业务测试通过，项目占用已释放。

2026-10-06T09:06:46.726+08:00：实验 10 / 尝试 2 失败，不计通过，758.4s。错误：AssertionError [ERR_ASSERTION]: 十组稳定验收没有中途工具异常

### 实验 10：test1/ecosystem-world，尝试 3

开始：2026-10-06T09:06:58.433+08:00。创建复杂规则引擎 → 存档/恢复 → 新机制/回放，三条真实任务。证据：[本次目录](.pi/agent/background/verification/full-chain/2026-10-06T00-56-25.090+08-00/group-10-attempt-3/result.json)。入站为构造 TG update 经正式桥接授权和队列，不冒充手机入站；模型、Herdr/Codex、自动验收和 TG API 投递均为真实。

- 2026-10-06T09:09:52.237+08:00：实验 10 / 尝试 3 / 阶段 1 通过；task ecosystem-create / run ecosystem-create-r1；171.7s；TG message_id 493；属性检查 1947 项，真实业务测试通过，项目占用已释放。

- 2026-10-06T09:12:54.559+08:00：实验 10 / 尝试 3 / 阶段 2 通过；task ecosystem-save / run ecosystem-save-r1；182.3s；TG message_id 495；属性检查 1991 项，真实业务测试通过，项目占用已释放。

- 2026-10-06T09:16:19.375+08:00：实验 10 / 尝试 3 / 阶段 3 通过；task ecosystem-replay / run ecosystem-replay-r1；204.8s；TG message_id 497；属性检查 1999 项，真实业务测试通过，项目占用已释放。

2026-10-06T09:16:19.594+08:00：实验 10 / 尝试 3 完整通过，计入十组，561.2s。三个阶段均通过，实际 API 投递和处理签收已核对。

## 5. 最终结果

复核时间：2026-10-06T09:20:25.429+08:00。test 五组、test1 五组完整通过；每组创建加两次修改，共 **30 条真实任务**。**15 次失败尝试**单独保留，不计通过；生命周期尝试 1—5 亦保留失败，尝试 6 完整通过，另算故障实验。

[十组逐任务复核](.pi/agent/background/verification/full-chain/2026-10-06T00-56-25.090+08-00/final-chain-audit.json)核对原话/Pi 用户条目、整理需求、交接原字节/hash、一次原生输入、永久 UUID、业务结果、独立 review、报告正文/目标/验收 hash、API message_id、inbox handled、占用释放及文件范围。实际主模型请求/回复共 435 对，通过组没有工具错误、模型 error/aborted 或扩展错误；没有读取完整 worker 历史回灌主 Pi。读取必要业务代码及验收输出仍会占上下文。

### 5.1 十组完整通过记录

全部时间为 2026-10-06 北京时间。耗时来自单调时钟，包含根代理的独立复核；不是模型计算时间。开始/结束的墙上时间保留原值，WSL 校时导致的差异不得用日期反推覆盖。API 列仅列三次最终报告，不包含派发确认或失败通知。

| 组 | 项目/内容 | 通过尝试 | 开始 → 结束 | 整组耗时 | 最终报告 API ID | 证据 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | test / 草坪防御 | 3 | 01:17:11 → 01:28:31 | 636.3s | 382 / 386 / 390 | [result](.pi/agent/background/verification/full-chain/2026-10-06T00-56-25.090+08-00/group-1-attempt-3/result.json) |
| 2 | test / 地牢战术 | 1 | 01:28:33 → 01:43:21 | 829.7s | 393 / 396 / 401 | [result](.pi/agent/background/verification/full-chain/2026-10-06T00-56-25.090+08-00/group-2-attempt-1/result.json) |
| 3 | test / 铁路调度 | 2 | 01:50:35 → 02:00:58 | 579.6s | 408 / 412 / 415 | [result](.pi/agent/background/verification/full-chain/2026-10-06T00-56-25.090+08-00/group-3-attempt-2/result.json) |
| 4 | test / 传送带工厂 | 1 | 02:00:58 → 02:14:04 | 730.8s | 421 / 424 / 428 | [result](.pi/agent/background/verification/full-chain/2026-10-06T00-56-25.090+08-00/group-4-attempt-1/result.json) |
| 5 | test / 连锁消除 | 1 | 02:14:07 → 02:26:09 | 664.4s | 433 / 436 / 438 | [result](.pi/agent/background/verification/full-chain/2026-10-06T00-56-25.090+08-00/group-5-attempt-1/result.json) |
| 6 | test1 / 轨道弹射战斗 | 5 | 01:36:27 → 01:48:16 | 660.1s | 398 / 400 / 404 | [result](.pi/agent/background/verification/full-chain/2026-10-06T00-56-25.090+08-00/group-6-attempt-5/result.json) |
| 7 | test1 / 迷宫塔防 | 2 | 02:01:13 → 02:10:49 | 533.4s | 418 / 420 / 426 | [result](.pi/agent/background/verification/full-chain/2026-10-06T00-56-25.090+08-00/group-7-attempt-2/result.json) |
| 8 | test1 / 城市疫情模拟 | 1 | 02:10:50 → 02:29:31 | 1034.5s | 430 / 432 / 440 | [result](.pi/agent/background/verification/full-chain/2026-10-06T00-56-25.090+08-00/group-8-attempt-1/result.json) |
| 9 | test1 / 扑克锦标赛 | 6 | 08:40:28 → 08:48:49 | 500.9s | 479 / 481 / 483 | [result](.pi/agent/background/verification/full-chain/2026-10-06T00-56-25.090+08-00/group-9-attempt-6/result.json) |
| 10 | test1 / 生态世界 | 3 | 09:06:58 → 09:16:19 | 561.2s | 493 / 495 / 497 | [result](.pi/agent/background/verification/full-chain/2026-10-06T00-56-25.090+08-00/group-10-attempt-3/result.json) |

业务代码保留在 `.worktrees/test/health-experiments/` 和 `.worktrees/test1/health-experiments/` 各组对应目录。失败产物仍保留；没有将业务合并回源项目。test1 的唯一初始 README/Git 提交属于用户授权的空目录基线，随后代码均由真实 Codex 在 worktree 完成。

### 5.2 失败、修复与重新完整执行

| 组 | 未计入的尝试 | 实际原因 |
| --- | --- | --- |
| 1 | 1、2 | WSL 墙上时间导致监督 PID 误判；首次 TG 回执缺 event_id/hash。 |
| 3 | 1 | 铁路终局继续推进时钟后在途列车 eta 失效，独立验收拒绝。 |
| 6 | 1、2、3、4 | PID 误判、首次回执、驱动未等待明确本地冷却、分段反弹碰撞漏检。 |
| 7 | 1 | 驱动把历史 attention 当作当前失败，未等已记录的冷却恢复。 |
| 9 | 1、2、3、4、5 | 扑克累计短全押/短额大盲规则错误；前台 Python 查询语法、CLI 操作拼接错误；相对 root 跨 cwd 误写。 |
| 10 | 1、2 | 终局非法种植被静默忽略；前台猜测不存在的测试文件名。 |

每次均从新前台 session、新业务目录重新完整执行；同项目原生 UUID 保持不变。修复后的单次检查不替代整组重跑。各失败详情及当时时间见前面的原始记录和私有 result.json；未知网络投递保留 unknown，不改成成功。

### 5.3 四部分接入与真实健康覆盖

| 部分 | 当前实现位置 | 实际覆盖 |
| --- | --- | --- |
| 结果自动回传、独立验收 | `.pi/extensions/background/notifications/relay-notify.ts`、`task_protocol.py`，`execution/runner.py` | 30 条任务逐一 verified/reported/handled；结果摘要有界，完整 worker 历史不回灌。 |
| 项目常驻恢复 | `execution/service.py`、`scripts/startup/telegram.mjs` | 实际 service SIGKILL/正常退出后恢复；命名 Herdr 冷启动/恢复 Shell；空闲 Codex /quit 后 resume 原 UUID；主启动器崩溃清理和 Windows 既有循环恢复。 |
| watchdog、取消与有限重试 | `execution/health.py`、`notifications/task-watchdog.py` | 真缺文件、两次重试、第三次拒绝、Herdr 5s 真超时、180s 真命令、错误 run 拒绝、准确取消及幂等、子进程退出与占用释放。 |
| 真实 TG API 投递 | `notifications/notify-telegram.py` | 正文/目标/hash/验收绑定与真实 message_id；明确冷却退避；unknown 不自动重发。 |

故障实验：[真实生命周期尝试 6](.pi/agent/background/verification/full-chain/2026-10-06T00-56-25.090+08-00/lifecycle-negative-attempt-6/result.json)。常驻恢复：[service 异常恢复](.pi/agent/background/verification/full-chain/2026-10-06T00-56-25.090+08-00/service-crash-recovery.json)、[正常退出恢复](.pi/agent/background/verification/full-chain/2026-10-06T00-56-25.090+08-00/service-normal-exit-recovery.json)、[命名 Herdr 冷启动](.pi/agent/background/verification/full-chain/2026-10-06T00-56-25.090+08-00/herdr-cold-start-attempt-3/result.json)、[主启动器崩溃恢复](.pi/agent/background/verification/full-chain/2026-10-06T00-56-25.090+08-00/launcher-crash-recovery.json)、[正式主 Pi 重载](.pi/agent/background/verification/full-chain/2026-10-06T00-56-25.090+08-00/production-final-reload.json)。

服务正常退出后的 2.252s、主启动器崩溃后的 28.519s、正式主 Pi 重载到新 owner/连接确认的 35.304s分别是不同观察范围，不能互相替代。主启动器崩溃时 TG 连接点没有单调时间，保留未采集。

[本地回归记录](.pi/agent/background/verification/full-chain/2026-10-06T00-56-25.090+08-00/final-local-checks.json)、[相对 root 回归](.pi/agent/background/verification/full-chain/2026-10-06T00-56-25.090+08-00/relative-root-local-checks.json)与真实组分开：17 项 lifecycle、6 项空回复恢复、项目 TG 验证、CLI/原话与登记检查以及 Python/Node 语法检查。没有 CI 运行记录；本目录未初始化 Git 仓库。

### 5.4 现场、来源与观测边界

[最终现场复核](.pi/agent/background/verification/full-chain/2026-10-06T00-56-25.090+08-00/final-runtime-audit.json)：两个原生 Agent 均 idle/done，原 UUID、分支和 HEAD 保留，正式任务表为 0、无占用；本轮命令和监督进程均退出，保留 Coding Agent 原有子进程。TG 实际 owner、fresh heartbeat、pollingActive、active here、后台服务身份和原 Herdr server 已核对。主 Pi 恢复原 UUID，没有重启永久 Codex 或全局 Herdr。

早期成功 run 尚未采集后来增加的 worker_process_baseline；最终检查 test 子进程归属采用随后真实生命周期实验基线，test1 采用最后一组基线，不反填早期数据。缺基线旧 run 的取消和自动失败释放仍保守拒绝。现场检查首次误要求早期字段而产生 KeyError，只修正证据选择，未改旧结果或放宽身份检查。

Joye 的 [25 个扩展/脚本来源清单](.pi/agent/background/verification/full-chain/2026-10-06T00-56-25.090+08-00/joye-file-inventory.json)与最终 hash 核对保持原样；复用/适配/保留参考分类见 [后台说明](.pi/extensions/background/README.md)。新增源码和注释/关联文件见 [最终源码清单](.pi/agent/background/verification/full-chain/2026-10-06T00-56-25.090+08-00/final-source-manifest.json)。没有新增后台模型工具、新工作流 Skill或生产依赖；已有 herdr-workflow 副本补本项目阶段/路径/查询/实际文件发现规则，start.sh 白名单已启用。

空回复恢复副本从 `extensions/empty-reply-guard.ts` 移至 `.pi/extensions/reply-health/index.ts` 并通过项目自动发现加载；旧副本已移除，避免两份注册。其他后台实现仍集中 background/execution/ 与 notifications/，不是拆到 src/ 的另一套后台。

**真实覆盖限制：**十组入站为构造 TG update 经实际授权/队列，模型、原生 bash、Herdr/Codex、业务修改、验收和发往已配对聊天的 TG API 均真实；未验证手机网络入站和手机收到时刻。隔离前台只加载 background、reply-health、observability 与 skill-creator/web-search/herdr-workflow，不运行记忆和邮箱副作用。正式安装版加载器另核对八个扩展无错误及实际主 Pi owner，但没有把八个扩展同时执行后台任务计作十组证据。未做 Windows/WSL 整机重启，不承诺未登录、睡眠或断网时可回复。

## 6. 2026-10-06：后台交付正文、统计尾注与时间核查

### 6.1 已确认的问题和改动

用户要求后台最终交付带普通回复的统计尾注，并参考 Joye 的回复形式说明本次成果、事实依据、原因/影响、用法和限制。实际 `test-fast-power-20261006/run-1` 的初次派发有 43.2s 尾注，后台验收通过后由独立通知发送器交付，原流程没有关联尾注；验收请求 telegramTurnId 为 null。另有正文 3000 字符和只取第一渲染块的截断。

实现集中在现有模块：

- `notifications/relay-notify.ts`：按本次需求生成有依据的交付正文；调用既有观测模块，完整正文加尾注后一起渲染、持久化和发送。
- `extensions/observability/telegram-turn/index.ts`：登记原始 TG 来源及真实验收段，跨前台 session 按 requestId 累计原始用量；按 task/run 关联，排除其他聊天与 Coding Agent、记忆及压缩调用。
- `telegram-turn/statistics.ts`：缺工具证据显示未知，沿用既有 k/M、模型、thinking、ctx 与分隔线格式。
- `notifications/notify-telegram.py`：完整分块签收、成功块复用、unknown 防重；实际 API 响应解析后记录 Linux boot_id 和单调时间。

没有新增模型工具、Skill、依赖或业务状态。没有改 Pi npm 源码、默认模型、认证、启动参数或 Joye 参考仓库；完整 worker 历史仍不回灌。时钟/来源/显示快照仍放现有 final-report-receipt.json.observability，详情见 [回合统计说明](extensions/observability/telegram-turn/README.md)。

### 6.2 时间与统计口径

页脚起点为原始 TG 任务 message.date，终点为最终报告准备，包含派发、后台等待和验收。Telegram HTTP Date 校准收到消息的锚点，同 boot 内的后续时间差来自 CLOCK_MONOTONIC，不用 WSL 墙钟相减。重启进程不丢原起点；换 boot 只有新的 Telegram 校准才能重建，否则未知。prepared 后正文和显示数字固定，重试后实际确认时间另存，不因等待重写已准备正文/hash。

↑/↓ 是原始 TG 派发回合加本 run 主 Pi 验收的实际原始用量；ctx 取最后一个验收请求。缺原始缓存字段或配对响应的受影响字段显示 ?。这不是后台 Codex 的消耗，也不是整个项目总费用。

初次派发回复、真实 Herdr 派发/等待、验收到报告准备及最终投递分别保留阶段范围，重叠区间不相加；中断或旧证据缺字段时保留 null。新增阶段字段通过离线回归及真实 result/herdr-evidence 结构核对；已准备的历史显示快照不反填。

### 6.3 三次真实业务运行与保留的驱动失败

每次业务均由真实永久 herdr-test Codex 在新的允许子目录编写 C++17 批量模快速幂程序，再由不同前台 session 独立验收和实际 TG API 投递。原 UUID 为 01a10c65-a2c6-7132-8c78-61c6833d81d7。三个原 result.json 均保留 passed=false；不能称为三组完整通过，也不加入第 5 节十组的计数。

| 首次开始（北京时间） | 原失败原因 | 实际业务结果与报告 | 证据 |
| --- | --- | --- | --- |
| 11:45:55.663 | 驱动使用安装版不存在的 session.newSession()；worker 继续完成。改为创建新原生 SessionManager/SDK session，恢复后交付；旧失败不覆盖。 | reported，API 522；准备耗时 320516.074624ms，包含驱动中断到恢复的真实等待，不能当 worker 执行时长。 | [原结果](.pi/agent/background/verification/delivery-footer/2026-10-06T11-45-55.658+08-00/result.json) |
| 11:51:42.342 | 投递/签收成功后，驱动误用 SHA256(正文) 核对协议 hash。协议实际对 JSON 编码的正文做 SHA256。 | reported，API 524；准备耗时 124117.170753ms；该次入站没有后续严格要求的真实 HTTP Date 校准，不作为校准验收证据。 | [原结果](.pi/agent/background/verification/delivery-footer/2026-10-06T11-51-42.339+08-00/result.json) |
| 11:54:19.486 | 首次进程已加载纠正前的 hash 断言，投递成功后同样误判；原失败保留。 | reported，API 526；真实 getMe HTTP Date 校准，准备耗时 120603.0181285ms。 | [原结果](.pi/agent/background/verification/delivery-footer/2026-10-06T11-54-19.483+08-00/result.json)、[独立复核](.pi/agent/background/verification/delivery-footer/2026-10-06T11-54-19.483+08-00/recovery-result.json) |

11:57:42.287—11:57:46.606 的校正复核只读取第三次已有证据，未重派 Codex、调用模型或重发 TG。20 对主 Pi 请求/回复、原话身份、review、report 的 canonical hash、API 526、handled、占用释放及保护文件 hash 均已核对。未命中输入 52122、输出 3135、工具 21；最近上下文 22526/1050000，均来自实际请求。

独立单调测量为 120603.90625ms，与显示快照相差小于 1ms；日志真实 API 确认耗时为 122075.0283725ms。这个对照验证本地计算一致，不能提高 Telegram 的秒精度，不能当手机收到证据。三次入站均为构造 update，真实的是模型、Herdr/Codex、业务改动、验收和最终 Telegram API 返回。

### 6.4 离线回归与生产重载

[后台统计回归](.pi/agent/logs/observability/background-delivery-verification.json) 核对墙钟跳变、跨 session/进程、请求/工具去重、控制对象身份、未知缓存/回复、重启校准与阶段范围。lifecycle.py 共 19 项通过（含完整分块和 unknown）；普通 TG 回合、reply-health 6 项及 npm run test:observability 通过。上下文故障隔离的 EEXIST 为故意注入，并非新增生产错误。常规回归没有模型或 TG 网络调用；没有 CI 或整机重启覆盖。

12:01:41 项目 Pi 结束，12:01:48 重新连接 TG。PowerShell 调用已完成，但 Python 驱动使用 UTF-8 解码 Windows 输出报 UnicodeDecodeError；随后按实际进程与日志核实重载，不因驱动解码错误重复重启。新 owner PID 621673，原 session 01a10f2a-1807-7a5d-9430-470b834365f3，受管 Node 父进程、fresh heartbeat、pollingActive 和 active here 均核对；正式 test/test1 没有执行占用。没有结束 Herdr 或永久 Codex。现场证据见 [production-reload.json](.pi/agent/background/verification/delivery-footer/production-reload.json)。

### 6.5 后台最终报告引用原始提问

用户要求问题较多时能看出报告对应哪条提问。普通桥接已使用 reply_parameters；Joye 原始 notify-telegram.py/relay-notify.ts 没有原始消息引用功能。本项目补在现有通知模块，不加扩展或模型工具。

- relay-notify.ts 从原始 task/run 的 originalRequest.telegram 选择消息，先核对 chatId，再将 reply_to_message_id 与准备正文一起固定。换前台 session 及重试不选择最近的聊天；无 TG 来源或其他 chat 的 ID 不使用。
- notify-telegram.py 使用官方 reply_parameters，长报告各块仍引用原问题；发送账本拒绝同一事件改引用目标。API 实际返回的 confirmed_reply_to_message_id 与计划引用 ID 分开保存；原问题已删除时按普通桥接的 allow_sending_without_reply 行为保留报告送达，实际引用为 null。
- 统计、时钟、模型用量和正文 hash 计算不变，引用信息不注入模型上下文。已有 prepared/success/unknown 意图不改写，也不为旧报告补引用而重发。

[实际 relay 核查](.pi/agent/background/verification/reply-to-original/relay-verification.json) 通过跨前台 session、不同 chat、无 TG 来源三个边界；协议和发送器受控，非网络全链路。lifecycle.py 21 项通过，覆盖真实文件签收、引用 ID 固定、非法 ID、缺原消息与分块/unknown；没有模型调用。

[真实 Telegram API 回执](.pi/agent/background/verification/reply-to-original/live-receipt.json) 确认消息 527 引用了原任务消息 509，计划 ID 和实际返回 ID 相同。只发送一条明确标记的关联验证消息，没有重派 Codex 或改变原任务结果；这不是手机显示回执，也不计入十组复杂实验。

12:20:18 本项目 Pi 正常退出，12:20:54 再次连接 TG。12:21:01.945 的 [重载核查](.pi/agent/background/verification/reply-to-original/production-reload.json) 确认新 PID 720647、受管 Node 父进程、fresh heartbeat、pollingActive 和 active here；test/test1 原生 UUID 与空占用保持。Windows 调用退出码 0；WSL 代理提示仍是既有警告，未修改全局代理或启动设置。

**耗时与未知结果：**各任务的单调阶段链及输入到 API 确认耗时在 final-chain-audit.json，缺字段保持 not_collected；不从墙上时间、消息内容或旧结果反推。unknown/sending 需要人工对账，不能自动重新发送。多轮澄清原话合并、其他 Coding Agent 等既有缺口未在本次扩展。

### 6.6 真实用户任务：雷霆战机小游戏的完整交付核查

本次只读取既有记录，不派发新任务、不调用模型、不发送 TG、不重启运行进程。核查对象为用户真实 TG 提问「在test/ 下做个雷霆战机小游戏」，task `test-thunder-20261006` / run `run-1`；与前面构造入站实验分开。[逐项证据及复核时间](.pi/agent/background/verification/reply-to-original/production-task-audit.json)。

**主链路已走完。**原消息 533 → 原话/整理需求与交接 hash → herdr-test 永久 Codex 会话一次原生输入 → business/result → 主 Pi 独立浏览器验收 → 最终消息 539 → inbox handled。最终 API 返回明确引用消息 533；正文和尾注同一条 HTML 消息发送，分隔线上方没有新增空白行。不是引用期间询问进度的其他消息，也没有重复派发。验收后的重复 verified 事件因 task_terminal 标记 superseded，未再次通知。

同项目 UUID 仍为 `01a10c65-a2c6-7132-8c78-61c6833d81d7`。worktree 的既有文件 hash 与 HEAD 均保持，改动仅在 thunder-fighter 的五个文件中；没有合并、提交或部署。监督与 runner 已退出，项目执行占用已释放。正式主 Pi PID 720647 存活，心跳新鲜，pollingActive、active here 均核对。当前手机触摸只经过 Chromium 模拟，未计作实体手机验收。

**数字重新从原始响应核算。**原任务派发加本 run 主 Pi 验收共 21 对请求/响应，未命中输入 44,214、输出 2,157、缓存读取 356,736、工具 19；尾注 ↑44.2k / ↓2.2k / tools 19 正确。ctx 为最后验收请求的 27,689 / 1,050,000，显示 2.6% / 1050k 正确。其他普通聊天、后台 Codex、记忆与压缩调用未混入这些数字。

**时间计算一致，但显示终点仍未完全满足用户要求。**同 boot 的单调时间独立核算得到发送前 293.136799s，API 确认 294.649221s，发送阶段 1.512422s。尾注显示 293.1s，到报告准备为止；不是 API 确认，更不是手机收到的时刻。实际 API 确认耗时已存在 background_delivery_end，不能把这两种终点说成相同。Telegram message.date 与 HTTP Date 只有秒精度，本地毫秒数不代表手机端精度。派发初次回复 48.9s、Herdr 派发/等待 189.3s、验收到准备 58.9s 是有重叠的范围，不能相加当总耗时。

**尚需补充的关联与观测：**

- 附件工具对 index.html 和 desktop.png 返回 Sent 2 Telegram attachment(s)，且安装版实现会等待两次 API 成功后才返回；未发现附件发送错误。但后台直接附件分支没有 reply_parameters，并丢弃实际 API Message 结果，观测钩子此时又没有普通 TG deliveryScope，所以没有逐附件 message_id、实际引用与确认时间证据。最终文字引用已生效，附件关联尚未覆盖；不能猜测附件 ID 或当作手机签收。
- 独立验收将完整 task（含 worktree_baseline）回显到主 Pi。实际 provider 对这一项归因 5,459 个输入 token；相邻请求总输入从 20,845 升到 26,475。没有读取完整 Codex 历史，但登记信息仍有不必要的上下文开销。另有一次实际响应 cached_tokens=0，按原值计入 ↑，本次不推断供应商缓存原因。
- 业务 check.cjs 第 6 行写死已有系统 Playwright 缓存路径，README 也依赖该环境；当前验收成功，游戏本体无需依赖，但验证脚本不能直接搬到其他环境运行。这是产物可迁移性限制，未在本次修改。

以上缺口只记录，没有修改尾注、通知、任务协议或业务代码，也没有把这条单次真实任务算进前述十组实验。
