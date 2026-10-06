# Telegram 命令

`extensions/telegram/index.ts` 只加载项目内的 npm 桥接并接入命令模块、最终回复策略。`src/telegram/commands/index.ts` 通过公开的 `registerTelegramCommand` 注册项目命令，并管理会话上下文和连接后的菜单同步。实现放在 `src/telegram/commands/`，每个命令一个 TypeScript 文件，第一行注释说明用途。

| 命令 | 实现文件 | 作用 |
| --- | --- | --- |
| `/pi_new` | `pi_new.ts` | 使用 Pi 原生接口创建新会话，保留旧历史，发送开始及完成通知 |
| `/pi_restart` | `pi_restart.ts` | 回复后调用项目 Windows＋WSL 启动入口重启，继续当前会话 |
| `/pi_status` | `pi_status.ts` | 查看当前进程、会话、模型任务状态及桥接心跳 |
| `/pi_logs` | `pi_logs.ts` | 查看经过脱敏的项目启动日志尾部 |

`/pi_new` 不接受参数；空闲时调用 Pi 的 `ExtensionCommandContext.newSession`，创建空白 session，保留旧会话及观测记录，不调用模型，不重启进程。忙碌或 Pi 存在排队消息时提示先 `/stop`。菜单显示“🆕 新建会话”。

桥接的 Telegram 命令上下文只有回复和入队能力，没有 Pi 会话切换接口。命令模块 `src/telegram/commands/index.ts` 包装桥接的本地命令注册，在 `/telegram-connect personal` 等本地命令执行时获得正式 Pi command context。Pi 替换会话后旧 context 失效，必须使用 `newSession.withSession` 提供的新 context 更新进程内绑定。会话关闭时解除旧命令注册，新实例重新注册。进程内绑定只服务当前项目 Pi 实例，不跨进程持久化。

连接仍使用本地 `/telegram-connect personal`。启动入口只加载此接入入口，不再重复加载 npm 桥接。命令实现统一保存在 `src/telegram/commands/`；Joye 原始参考文件保留在项目外的参考仓库中。

验证记录：`npm run test:telegram:new` 使用实际安装的 Pi SDK、扩展加载器和 AgentSessionRuntime，验证菜单注册、参数检查、忙碌拦截、连续两次原生会话切换、空白历史、旧会话保留及分别生成观测文件；网络和模型调用禁止。未向真实 Telegram 发送 `/pi_new` 测试消息。

连接后由 `src/telegram/commands/menu.ts` 同步菜单。桥接 0.27.12 本身仅在 Telegram `/start` 或帮助操作时同步菜单；项目补上连接时同步。菜单清单沿用锁定桥接版本的内部构建器（公开 API 尚未提供该方法），升级桥接时需核对；发送失败提示本地警告，不输出 Token。

菜单修复验证：连接后 Telegram `getMyCommands` 返回 `new`，描述“🆕 新建会话”；保留原 session 重启并恢复轮询，未发送真实聊天测试消息。

/pi_new 轮询死锁修复：Telegram handler 运行在 getUpdates 循环内；await newSession 会在会话关闭时等待同一个轮询 Promise，导致互等。现在 handler 先安排下一次事件循环执行切换并返回，使轮询可正常退出。离线验证加入“切换等待命令回调返回”的回归场景，连续切换通过。原卡死进程 SIGTERM 无法退出后，仅针对已核实项目 PID 强制结束并保留原会话重新启动。

会话替换后的连接修复：npm 桥接新实例恢复默认 profile，因此在 withSession 中使用新实例的连接 handler 恢复 personal profile，并同步菜单。旧实例上下文不再用于连接。空白 session 在出现会话消息前 Pi 可能尚未落盘，不能据此认为丢失历史。

JSONL 命名调整：原生目录仍为 sessions 和 observability，已有文件名的时间换算为北京时间（UTC+8，文件名用 +08-00 标识），正文历史不改写。/pi_new 通过 setup 与 SessionManager.setSessionFile 接口采用同一命名，不修改 npm 源码；对应离线验证通过。

新会话完成通知：切换后通过公开 sendTelegramView 的 instance scope 使用当前桥接发送，避免调用旧轮询捕获的 reply（旧传输已失效）。通知包含会话 ID，发送失败记录 telegram-new 诊断，不再静默忽略。离线连续切换验证确认通知使用新实例并包含对应 ID。

入口整理验证：命令注册与连接逻辑从扩展入口移到命令模块；`test:telegram:new` 和 `tests/telegram/final-reply-only.mjs` 通过，未调用模型或发送 Telegram 对话。

项目命令统一使用 pi_ 前缀：/pi_new、/pi_restart、/pi_status、/pi_logs、/pi_model、/pi_search。旧的 /new、/restart 不再注册；桥接内置命令名称保持不变。/pi_model 打开按钮菜单：先选择供应商，再选择模型（每页8个），下方选择当前模型支持的思考强度。点击后更新同一条消息，✓ 标记当前选择；保留会话，设置由 Pi 保存为项目默认值。再次打开菜单或切换会话后，旧按钮失效；回答期间和消息排队时禁止切换。实现与按钮回调均在 src/telegram/commands/pi_model.ts，index.ts 仅传入当前上下文与 Telegram profile。
