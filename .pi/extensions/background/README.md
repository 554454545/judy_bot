# 后台任务：沿用 Joye 的脚本调用方式

本次 GitHub 快照加载我们编写的项目适配版 `.pi/skills/joye/personal/herdr-workflow/SKILL.md`，即切换到 Joye 原版之前的工作流；来源副本保存在 `herdr-workflow-our-copy/SKILL.md`，启动时只加载前者。保留当前代码及 AGENTS.md 约定，不恢复强制 GitHub Issue 流程。下方原版兼容性调查是历史参考，不描述此快照的启用版本。

前台通过已有 `bash` 调用文件 CLI，完成项目绑定查询、任务登记、交接、真实派发和独立验收。Pi 入口注册原话取证与后台事件接力，不新增模型工具；执行集中在 execution/，通知集中在 notifications/。每项目一个长期 worktree 和原生 Agent session，任务串行执行。仅准备的请求停在 prepare；自动回传、独立验收、主动通知、watchdog 和常驻恢复已接入。十组复杂实验的 30 条真实任务通过最终证据复核，15 次失败尝试单独保留；实际范围见 [re.md](../../../re.md)。不自行合并、提交或推送。


## Joye 原版路径适配后的兼容性

以下差异由本地源码、CLI 帮助和仅参数解析的检查确认，不代表真实派发已完成。路径适配仅修改 Skill，不改后台程序或既存登记数据。

| 原版内容 | 本地实际情况 |
| --- | --- |
| 直接创建工作区、启动 Agent、发送提示词 | 正式链路通过项目登记、长期 worktree、project-bind 和任务 run；直接操作不会自动建立这些关联或遵循集中 Agent 配置 |
| 登记规格使用 done_marker/type/route 等字段 | 本地要求 projectId/instruction/scope/acceptance/artifacts，原话由 Pi 扩展取证；不能直接套用原版规格 |
| register 后直接 start-run | 本地先完成项目绑定和 prepare，再核对交接；start-run 会拒绝未准备的任务 |
| run TASK RUN -- ABSOLUTE_COMMAND ARGS | 本地仅支持 run TASK RUN [--timeout SECONDS]，目标从项目绑定读取；原版参数在解析时被拒绝 |
| 主智能体自行 prepare-report/report/ack | 正式链路的结果接力扩展负责投递及签收；不能重复代替其执行 |
| launchd、adopt-legacy、close-legacy | 本地 watchdog 由 execution/service.py 驱动；本地 CLI 没有这两个历史迁移命令 |
| 示例使用 jq；报告发布使用 R2 | 当前未安装 jq，项目 R2 凭据未配置；发布脚本自身的 node_modules 目录不存在，未验证发布能力 |

Joye 的核心原则可继续参考，但仅加载原版路径适配后的 Skill，不足以让既有 TG→登记→Herdr→Coding Agent→验收通知流程按原版步骤直接运行。原版中的项目操作与协议调用仍需明确适配；该次调查未恢复旧 Skill 的长操作规程，也未新增模型工具、接口或依赖。

## 项目归档

用户明确要求归档已登记项目时，可调用同一文件 CLI；归档指引已包含在本快照启用的项目适配版 Skill 中；核心实现在 `projects/archive.py`，Codex home 的保全与浏览索引清理在 `execution/codex.py`。没有新增 Pi 模型工具或单独的 Skill。启动白名单已经包含该 Skill。

```bash
python3 .pi/extensions/background/tasks/task_protocol.py project-archive PROJECT --preview
python3 .pi/extensions/background/tasks/task_protocol.py project-archive PROJECT
```

预览只返回实际登记的 ID、目录、原生 UUID、任务/通知数量和占用。执行核对活动任务、监督进程、通知领取/未知签收、绑定启动结果、Herdr 身份、业务子进程及原生写锁；未明确停止工作时拒绝操作。正在打开的 Bot Codex 浏览器须先退出。正常关闭唯一匹配的空闲 Codex 客户端，不强杀进程，不删除锁，也不关闭 Herdr pane、workspace 或 server。

私有档案位于 `.pi/agent/background/archives/<北京时间>_<projectId>_<短ID>/`，包含 `manifest.json`、worktree 成果副本与暂存区、整个原生 Coding Agent home、任务/结果与绑定证据。隐藏、忽略、未跟踪、未提交文件和符号链接均核对保全；不跟随外部链接。先按内容/权限核对并保存，再由 Git 解除原 Bot worktree。原 workspace 项目目录和 Git 工作分支保留；混合的主 Pi 对话/观测、日志、GitHub Issues 和已发 TG 消息保留。

Codex home 整体原子移入档案，原生 UUID、rollout、SQLite 和历史保持原字节，不用修改一列 SQLite 冒充归档。清单保存原目录和新位置；这是 Bot 的私有历史保全，目前不提供归档恢复、自动解封或直接在原生浏览器恢复档案的入口。

项目操作锁与持久归档标记阻止派发/绑定/自动恢复竞争。归档未完成时保持禁入，重调同一命令核对并接续同一份档案；复制中断可续办，保存后成果或暂存区又变化时保留两份内容并停止。完成后只保留按 ID/sourcePath/worktreePath 匹配的归档标记，活动关联退出，旧通知 superseded，浏览派生行与链接移除。任务历史状态不改成“完成”，原始私有登记作为证据保留；`inspect.registry.projects/tasks/outbox` 只显示活动记录，归档项目另见 `registry.archivedProjects`。

再次向已归档项目派发任务必须提示“项目已归档”，不初始化、改名登记、自动恢复或新建 session；同一原目录换 ID 也会被拒绝。`project-archive` 再次调用会校验清单证据并返回同一档案，不重复清理其他项目。

归档/恢复/通知边界的离线回归见 `tests/background/project-archive.py`；真实项目归档及 TG 自然语言链路按用户指定目标另行验收，不能把离线替身当作真实 Codex/Herdr 验收。[Issue #44](https://github.com/554454545/judy_bot/issues/44) 保存需求与单次验证记录。

## 与 Joye 逐项对照

参考仓库保持原样：`../joye/pi-agent-config` 和 `../joye/skills`。以下只使用已有的任务协议、原话身份原则和文件交接约定，相关执行和通知已获用户授权，保留原参考仓库。

| 内容 | Joye 的做法 | 本项目当前处理 |
| --- | --- | --- |
| 模型调用接口 | 既有 bash 调用 task_protocol.py | 相同；移除全部六个 background_* 工具 |
| 登记 | register TASK --spec PRIVATE_JSON；执行前 registered | 相同命令形式、成功输出 null 和状态；增加用户要求的 projectId、scope、原话 |
| 更新 | update TASK --delta PRIVATE_JSON --expected-hash HASH | 相同命令形式和成功输出；保留用户补充原话与旧需求，不直接改执行状态 |
| 查询 | inspect 返回 registry、task_hashes；result 返回本次结果 | 保留命令形式；result 只返回有界摘要和证据路径，完整结果留在文件 |
| hash / ID | digest 的 sorted JSON/bytes SHA256；ID 支持点号和 120 位 | 使用相同算法和字符范围，取消此前自定格式和 80 位限制 |
| 存储 | cooperating writer 的 flock、原子 replace、fsync、私有文件 | 保留同一原则；数据全部在 bot 下，保留已有 projects/tasks 结构 |
| 工作流说明 | 既有 herdr-workflow Skill | 加载我们编写的项目适配版；来源副本单独保留且不重复加载 |
| 输入身份 | relay-notify.ts 用真实消息对象、getBranch、appendEntry | 原话保留真实消息对象；relay 使用官方 custom message 记录内部控制身份，不增加工具 |
| Worktree | 原版通过 Herdr 创建 | 用户指定长期 worktree，保留本地 Git 创建/复用；Herdr 绑定其实际目录 |
| Agent / task-run / 签收 | Herdr、runner、outbox/inbox、relay、watchdog | 执行、通知、watchdog 已接入；Pi 0.84.1 用 sendMessage 唤醒验收，不依赖 Joye 的 core 补丁或 task_event_finish 工具 |

项目登记、长期同一个 worktree/未来固定 session、Agent 类型可替换、原话与整理需求分开保存、北京时间、本项目目录和派发前停止，都是用户指定的适配。原版没有独立 originalRequest 或项目固定会话表，所以存储结构不是原版逐字复制，也不迁移或丢弃现有数据。

已移除的额外接口：六个 Pi 模型工具、JSON stdin 操作协议、ok/result 输出包装、自定 digest 序列化和 ID 限制、额外 prepared 状态。旧 task-register/task-update 入口不保留兼容。额外工作流 Skill 此前已删除。

## 文件与边界

```text
.pi/extensions/background/
  index.ts                    接入原话与事件接力，不注册工具
  tasks/source.ts             TG/Pi 原话身份与 session 私有取证
  tasks/task_protocol.py      Joye 形式的文件 CLI、需求与交接稿
  projects/registry.py        用户指定的项目固定绑定
  worktrees/check.py          只读 Git/worktree/分支检查
  worktrees/manage.py         用户已授权的本地 Git 创建/复用
  storage/registry.py         统一锁与原子保存
  execution/dispatch.py       Herdr Shell 异步启动收据和有界结果查询
  execution/runner.py         task/run、进程证据、不可变结果和独立验收
  execution/herdr.py          核对真实 Agent、派发、内置等待和原生回复取证
  execution/late_result.py    超时后核对原生收尾，保留旧失败并收集迟到结果
  execution/codex.py          项目原生配置、认证连接和会话识别
  execution/settings.py       集中默认配置读取

.pi/agent/background/
  coding-agents-default-setting/
    defaults.json            新项目默认使用的 Coding Agent
    codex.json               Codex 默认模型、思考强度和服务等级
  registry.json              项目和任务登记
  registry.lock              所有读写统一锁
  tasks/<taskId>/spec.json    结构化交接稿
  tasks/<taskId>/prompt.md    可读交接稿
  verification/              实际核查记录
```

同一功能仍集中在本目录，不增加模型工具、TG 命令或另一套注册接口。index.ts 只连接事件实现；定时协调和通知在 notifications/relay-notify.ts。source.ts 不改变模型消息、System Prompt、bash 命令或工具定义。文件 CLI 和已有 Joye Skill 连接前后台；脚本从自身位置定位本项目私有目录，不回退全局。

## 调用方式

以下命令从项目根目录执行。先 inspect，按 registry.projects 中的名字查询绑定；用户说 test 项目即可，不要求用户提供完整路径，也不为未知项目猜目录。

```bash
python3 .pi/extensions/background/tasks/task_protocol.py inspect
python3 .pi/extensions/background/tasks/task_protocol.py register TASK --spec .cache/tmp/background/spec.json
python3 .pi/extensions/background/tasks/task_protocol.py update TASK --delta .cache/tmp/background/delta.json --expected-hash HASH
python3 .pi/extensions/background/tasks/task_protocol.py prepare TASK
python3 .pi/extensions/background/tasks/task_protocol.py start-run TASK --run-id RUN
python3 .pi/extensions/background/tasks/task_protocol.py run TASK RUN
python3 .pi/extensions/background/tasks/task_protocol.py result TASK RUN
python3 .pi/extensions/background/tasks/task_protocol.py verify TASK RUN --evidence PRIVATE_REVIEW_JSON
```

register 的私有 spec 需要 projectId、instruction、scope、acceptance、artifacts。update 的 delta 仅包含需要修改的 instruction/scope/acceptance/artifacts；expected-hash 从最新 inspect.task_hashes 获取。成功的 register/update 与 Joye 一样输出 null，通过退出码及随后 inspect 确认持久化。错误写 stderr 并返回非零退出码。

scope 的普通条目是相对 worktree 的文件或目录，目录包括其下全部路径；`**/*` 明确表示当前 worktree 的全部文件，包括根目录文件。除此之外不扩展通配符语法。登记与执行仍拒绝绝对路径和上级跳转，不能用该范围访问其他项目。

用户要求的管理操作也通过同一脚本：

```bash
python3 .pi/extensions/background/tasks/task_protocol.py project-register PROJECT --spec PRIVATE_PROJECT_JSON
python3 .pi/extensions/background/tasks/task_protocol.py worktree-ensure PROJECT --base main
```

project spec 保存 sourcePath、worktreePath、branch、agentKind，ID 由命令指定。新项目省略 agentKind 时读取 coding-agents-default-setting/defaults.json；已有项目省略时仍沿用登记的类型。既有绑定冲突拒绝覆盖；sessionId 在真实创建前为空。prepare 输出 spec/prompt 文件及当前 worktree 检查；仍保持 registered。dispatchEnabled 仅在项目已真实绑定且检查通过时为 true，表示允许显式派发，不是 Agent 接收证明。

首次接入按授权完成 `project-register PROJECT --spec FILE` → `worktree-ensure PROJECT --base main` → `project-bind PROJECT`。前台只调用 tasks/task_protocol.py，bash timeout 使用 120 秒；不能直接调用 runner bind 或猜 pane。project-bind 通过 execution/dispatch.py 核对专用 Shell，真实 bind 在 Herdr 环境中执行。ready 后重新 prepare；binding 表示启动结果尚不明确，按 receipt 查询，不能自动重发。首次业务执行取得原生 UUID，随后固定复用，名字不是 UUID。

新项目的 home/authFile/binary/baseUrl 与模型参数统一来自 coding-agents-default-setting/codex.json。home 支持 `{projectId}`，相对路径按 Bot 根目录解析，binary 按启动 PATH 查找；不同项目禁止共用 home。完整配置及认证预检成功后才写 executionSettings。仅对没有 Herdr/session/activeExecution 的失败首次绑定补齐缺失字段，保留已有参数；有效绑定的配置冲突仍拒绝。项目登记实现在 projects/registry.py，工作树实现在 worktrees/manage.py，不在 tasks/projects.py。

start-run 校验已登记任务的原话、修订、当前交接 hash，保存不可变本次副本并占用项目。run 在 Bot 专用 Herdr 的 bot-runtime Shell pane 启动监督程序后快速返回收据；前台不等待 worker、不轮询。重复 run 或项目尚未验收时的第二个 start-run 拒绝。收据只证明命令已交给 Shell，实际输入和结果由本次证据确认。

`run` 等待 Coding Agent 完成的默认预算为 1800 秒（30 分钟）；前台 CLI、dispatch.launch 与 runner 的 run/execute 入口保持一致。`--timeout SECONDS` 可显式覆盖单次预算，监督层转为毫秒传给 Herdr `agent prompt --wait`（默认 `--timeout 1800000`）。这不是前台 bash 的调用超时，也不是独立验收时限。超时只表示等待预算用尽，Agent 或业务命令可能仍在运行，继续沿用原有对账、取消和占用保护；修改默认值不延长已启动 run，也不改写历史失败结果。

CLI 的 --root 支持相对于调用方工作目录的路径；入口立即解析绝对目录，start_run 也在生成交接路径前再次固定它。交接稿中的业务结果文件始终是绝对路径，因为原生 Agent 的 cwd 是项目 worktree。不能把 Bot 相对路径原样交给 Agent，也不为已有失败 run 移动或补造结果。

result 只返回状态、最多 1200 字符的业务摘要和私有证据路径，不返回 worker 历史、完整终端日志或 diff。前台按 acceptance 读取具体产物并执行检查，写匹配 task/run 的私有 review，再 verify。成功验收释放项目占用；真实失败保持 blocked，不自动重试。

验收读取前先列当前任务范围内的实际文件，或核对本 run 业务产物；不能按修改阶段猜测试文件名。新增测试可以保留在原测试文件中。项目调用规则见启用的 herdr-workflow Skill。

隔离验证使用 `python3 .../task_protocol.py --root PRIVATE_DIRECTORY inspect`；--root 放在子命令之前。正文放私有 JSON 文件，不通过 Shell 参数拼接；文件/参数里的引号、中文、换行和反引号保持原值。

## 真实原话如何进入脚本

TG 授权消息实际出队时，现有观测点提供原始消息来源；source.ts 经 input/message_start 固定真实用户消息对象。工具执行前的官方 tool_call 事件保证 SessionManager 已同步到当前 assistant 调用；首次 bash 前通过 pi.appendEntry 保存 background-original-request 私有条目。agent_end 也保存尚未取证的用户条目，避免只问澄清、没有 bash 的回合丢失 TG 身份；同一用户条目不重复保存。该条目不进入模型上下文。

Pi 自带 bash 为每次子进程设置 PI_SESSION_ID 和 PI_SESSION_FILE。脚本从当前 session 文件按 parentId 追踪当前分支，核对最近真实 user entry 和取证条目身份；原始 TG text、message/chat/thread/turn ID 和发送时间来自实际入站消息，进入 Pi 时间来自实际用户条目。模型在 spec/delta 填写的原话会被运行时证据覆盖。

普通独立 CLI 不具备 Pi 环境，调用者必须在 spec 提供 originalRequest，update 提供 changeRequest，负责真实性；不会从整理需求补造原话。原话证据是合作写入协议，不声称能抵御具有完整文件修改权限的恶意调用者。

单条纯文本按本轮取证。首次登记前跨多轮澄清时，spec.sourceEntryIds 明确选择相关 user entry，脚本验证当前分支、session 与 TG chat/thread，并自动包括当前消息；最初问题保存为 originalRequest，后续相关消息保存为 clarificationRequests，prepare 将其与 revisions 一起放入交接。普通问答和其他项目消息不能自动归入任务。合并消息、附件仍未接入；不支持输入明确拒绝登记，不借用旧原话。bash 取证条目留在当前 session，不另建原话日志或额外模型提示。

## 已授权行为的保护

长期 worktree 保留现有修改和初始分支，不自动重置、切基准、拉远端或接管未知目录。创建意图先保存，中断后核对真实 Git 登记再恢复，失败保留 needs_reconciliation。路径仍拒绝上级跳转、绝对范围和符号链接越界。

update 使用同一登记锁比较 expected-hash，保存补充原话/旧需求后使旧交接绑定失效；prepare 重新生成并核对字节。specHash/promptHash 是内容校验，不是数字签名。损坏登记表停止，不写空表覆盖；数据和时区保持既有约定。

## 验证入口

本地模块与原话检查在 tests/background/preparation.py、worktree-management.py、request-recording.py、request-source.mjs；安装版 Pi 的 bash/session 与 CLI 验证在 pi-cli.mjs（替代旧 pi-tools.mjs）。真实模型的隔离 TG 模拟入口为 frontend-cli-flow.mjs，结果和完整请求保存在该次 session 私有目录；不发送真实 Telegram 消息，不启动 Herdr。测试与现有运行实例重载是不同事实，证据分别记录。

新项目首次接入回归在 tests/background/project-onboarding.py；真实全链路入口为 project-onboarding-live.mjs。首次从两个获准空目录开始，交替完成创建、存档与机制修改，核对独立 UUID、CODEX_HOME 和永久会话续用。失败后 `--resume-bindings` 仅复用上一尝试的真实项目绑定，前台重新开 session、业务另用新目录，保留旧结果。`--repeat-only --business-directory DIR` 原样重发既有需求；`--clarification-only` 验证先澄清、穿插问答、确认后仅准备。两者沿用原绑定。驱动的 TG 用户入站为构造消息，前台模型、Herdr/Codex、独立验收和 Telegram API 投递为真实调用；不能冒充手机入站或手机接收回执。原始过程与验收证据留在私有 verification/project-onboarding/。

## 执行实现与独立入口

执行段先独立通过真实 Herdr/Codex 验收，再由 tasks/task_protocol.py 接入前台。index.ts 连接原话事件和通知接力；Python 文件不会被 Pi 当作扩展自动加载。原独立入口保留用于绑定与诊断，前台使用上面的文件 CLI。

```text
.pi/extensions/background/execution/
  runner.py    独立 CLI、task/run、进程结果和验收；移植 Joye task_protocol.py 的相关逻辑
  herdr.py     真实 Herdr 创建/复用、派发、内置等待及结果收集
  codex.py     项目 Codex 配置、只读认证、原生 session 与回复取证
  settings.py  集中默认配置读取；项目登记、Herdr 绑定和 Codex 配置生成共用
  dispatch.py  前台异步启动、收据保存、有限摘要查询

tests/background/real-herdr-execution.py
               真实任务验收入口，没有模拟实现

.pi/agent/background/verification/herdr-execution/<北京时间>/
  project.json、settings.json、baseline.json
  handoffs/    本次直接执行的真实测试输入；不冒充 TG/Pi 原话来源
  background/  与前台相同存储形状的隔离登记表、runs 和内部 outbox
  result.json  独立验收结果

.pi/agent/background/codex/<项目名>/
               本项目 Codex 配置、原生 session、SQLite 与日志
```

复用范围：Joye 的 digest、summary、pid_identity、start_run、run_command、commit_result、result_status、verify，以及稳定 task/run/phase outbox、flock/原子保存和不可变结果。保持 starting/running/ready_for_review/verified/blocked/rework/needs_reconciliation/batch_finished 等原有语义；不增加模型工具、新 Skill 或另一份正式登记表。notify/relay/watchdog/report 已接入，真实投递凭据与独立验收缺一不可。

用户指定适配：长期 worktree/固定 session；Herdr Agent 与 Codex 原生会话均命名 `herdr-项目名`，真实 UUID 另存；同项目执行及待验收任务通过 activeExecution 串行约束；本地配置与北京时间。Herdr 名字受官方 `[a-z][a-z0-9_-]{0,31}` 限制，不悄悄截断或改名。

首次业务执行形成原生 rollout 后，`execution/codex.py` 使用安装版 Codex 0.160.0 的 [官方 `thread/name/set`](https://learn.chatgpt.com/docs/app-server) 命名。临时 stdio 客户端只读取摘要、设置已核对 UUID 的名字并回读，不 start/resume/turn，不向 TUI 输入 `/rename`，不改写原生 SQLite。完成或失败均关闭该临时客户端，保留 Herdr 中的原 TUI。

首次启动收据返回后若状态暂为 unknown，`herdr.py` 使用原生 `agent wait` 等待，再核对同一 name/workspace/pane、Agent 类型和 cwd。启动检测与状态等待共用 90 秒预算；blocked、working、身份变化或等待超时明确失败，保留现有 Agent 和证据。复用失败首次绑定时也核对原 Agent，等待只针对 unknown，不重新启动客户端。

Bot 根目录 [resume-codex.sh](../../../resume-codex.sh) 直接打开 Codex 原生 `resume --all --no-daemon` 界面，搜索、方向键、Active/Archived 和排序由 Codex 提供。`execution/codex.py` 的 browse 以正式 `registry.json` 中 Codex 项目的 `sessionId` 为白名单，只读对应 home 的原生 SQLite 元数据；不扫描未登记历史目录，同一 home 中的其他 UUID 也不显示。私有浏览 home 位于 `.pi/agent/background/codex-session-browser/`；名称、UUID、时间与归档状态沿用源索引，不制造未生成的 session。打开时移除浏览索引中的越界条目及过期链接，保留源历史。原 rollout 和写锁以链接保留在各项目 home，后台登记与启动参数不迁移；原生恢复仍使用原 UUID、原 rollout、原工作目录和同一写锁，已有客户端占用时不能强行恢复。浏览器配置继承已登记项目的 Provider，不同 Provider 配置拒绝混用；只保留一个浏览实例，下次打开刷新索引。浏览 home 是独立的原生配置/索引，不是后台项目绑定；UI 的偏好及索引操作属于浏览 home，后台的源索引保持不变。没有原生 UUID 的项目不显示；旧编号菜单及 `--list` 参数已移除。

启动和恢复都显式使用登记的模型、思考强度、Fast 参数及 [额度模型切换提醒开关](https://learn.chatgpt.com/docs/config-file/config-reference) `notice.hide_rate_limit_model_nudge=true`，避免提醒弹窗接收自动输入。`herdr-evidence.json.native_model_settings` 记录本次原生 `turn_context` 的实际模型与思考强度；不符合登记则 blocked，不以默认配置冒充实际调用。提示关闭不改变额度或网络重试策略。

输入仍为 spec.json 与 prompt.md。独立测试直接提供真实任务文件，不调用前台登记接口，不制造 TG update、Pi user entry 或原话证据。每次执行保存交接文件原字节及 hash，再生成本次 dispatch-prompt；通过 subprocess 参数数组发送文件内容，不做 Shell 字符串拼接。原登记和原交接文件不被执行阶段覆盖。

执行监督进程从 Joye 的 TASK_ID/TASK_RUN_ID/TASK_RESULT_PATH 获取本次身份。长期 Codex 不随任务退出：result.exit_code 来自本次 Herdr 监督进程的实际 wait，exit_code_source 明确注明来源；不是猜测 Codex 的退出码。Herdr 生命周期返回、原生会话输入与 final_answer、业务结果和 worktree 内容分别保存。只接受实际新输入之后的 final_answer marker，不使用 prompt 回显或旧回复。

Joye 的新产物规则用于本次新生成的 business.json；源码产物另按允许范围、实际文件内容及 acceptance 检查，因此无需强迫每个源码文件变化。执行成功先 ready_for_review，经独立检查并提供匹配 task/run 的证据才 verified。真实 read_error 即使收到 marker 也为 blocked，不等同完成。

Codex 使用已有 CLI，由真实 Herdr agent start --kind codex 启动，--no-daemon 与项目 CODEX_HOME 隔离新会话/日志。Provider 的 command-backed auth 只读本项目 `.pi/agent/auth.json`，校验账号、私有权限和有效期，不复制全局认证、不写令牌到配置、不刷新或切换账号。参数中的 Codex home、认证文件、模型、思考强度、base URL 和 Herdr 路径来自 settings，不写死项目目标。

用户维护的默认配置统一放在 `.pi/agent/background/coding-agents-default-setting/`：defaults.json 的 defaultAgent 当前为 codex；codex.json 保存 model=gpt-6.1-sol、reasoningEffort=low、serviceTier=fast。JSON 中首个 _comment 字段说明作用和关联实现，加载时不进入 Agent 参数。代码不再保存另一套默认模型值。

execution/settings.py 负责读取这两个文件。新项目未明确选择 Agent 时使用 defaultAgent；首次执行绑定将该 Agent 默认参数与 settings.agent 的明确参数合并，明确参数优先，并把实际选用的配置保存进 executionSettings。复用已有绑定时沿用保存的类型和参数，不因默认文件后来改变就换 Agent、模型或 session。未接入的 Agent 会明确报错，不自动切回 Codex；Claude Code 接入后再添加对应默认文件和执行适配，目前没有占位实现。

execution/codex.py 将读取的 Codex 参数生成项目原生 config.toml，使用 `service_tier = "fast"` 和 `[features].fast_mode = true`，遵循 [OpenAI 官方 Fast 说明](https://learn.chatgpt.com/docs/agent-configuration/speed)。运行目录 `.pi/agent/background/codex/<项目名>/` 继续保存生成的配置、认证连接信息、session、SQLite 和日志；默认配置目录只保存可编辑的默认选择和模型参数。修改默认文件不会热更新已打开的会话。先前真实测试使用 medium，历史测试输入与结果保留原值。

独立 CLI 示例（VERIFICATION 是项目内本次证据目录，命令从项目根目录运行）：

```bash
python3 .pi/extensions/background/execution/runner.py --root "$VERIFICATION/background" bind --project "$VERIFICATION/project.json" --settings "$VERIFICATION/settings.json"
python3 .pi/extensions/background/execution/runner.py --root "$VERIFICATION/background" run --spec "$VERIFICATION/handoffs/TASK/spec.json" --prompt "$VERIFICATION/handoffs/TASK/prompt.md" --run-id run-001
python3 .pi/extensions/background/execution/runner.py --root "$VERIFICATION/background" verify TASK run-001 --evidence "$VERIFICATION/background/runs/TASK/run-001/review.json"
python3 .pi/extensions/background/execution/runner.py --root "$VERIFICATION/background" inspect
```

不要自动重发已有 run；重复派发被拒绝，未知发送保留现场。service.py 仅恢复已登记原 UUID；状态不明时保留现场，发送 unknown 不自动重发。实际覆盖以 re.md 的证据为准。start.sh 已显式加载我们编写的 herdr-workflow 项目适配版。前台通过 CLI 派发，不直接控制 Agent。

## Bot 专用 Herdr 与原 Codex 会话

项目内当前安装 Herdr 0.9.3，使用 [项目入口](../../../scripts/startup/herdr.sh) 和 [独立配置](../../agent/background/herdr/config.toml)，运行 namespace 为 `bot`。程序、配置、原生状态和 socket 均留在 Bot 内；真实 pane 与子进程已核对使用本地二进制和真实 `HERDR_ENV=1`。Shell 使用项目入口保留 PATH 和历史位置，不修改全局 bashrc。具体操作和版本校验见 [启动说明](../../../scripts/startup/README.md)。

test 项目的正式绑定现使用本地入口和 bot namespace，真实 workspace/pane 从返回值登记。旧 bot-herdr 的空闲 Codex 正常退出后，新版恢复相同 CODEX_HOME 和原 UUID `01a10c65-a2c6-7132-8c78-61c6833d81d7`，没有新建替代会话或停止旧 server。恢复前检查原生 thread writer lock，不能同时启动两个写客户端。已有原生 TOML 的受管理配置必须一致；Codex 自己保存的 TUI 字段保留，不覆盖整个文件。

0.9.3 附带 Codex 检测规则没有 idle 条目，曾把正常客户端判为 unknown。现使用原样缓存的 [官方 2026.10.01.1 规则](https://github.com/herdrdev/herdr/blob/07e3840bfb41f433cb7f14b4f93e2ff3fbaac6d7/src/detect/manifests/codex.toml)，路径为 `.pi/agent/background/herdr/agent-detection/remote/codex.toml`，由原生 reload-agent-manifests 加载；没有把 unknown 当作 idle。自动更新仍关闭，具体来源和 hash 保存于迁移证据。

新的联测入口为 tests/background/tg-herdr-flow.mjs --live。它使用 TG 授权/入站/队列代码与模拟发送端口，前台模型、原生 bash、Herdr、Codex 和业务修改均为真实执行。测试任务表隔离，正式项目绑定不改；不能据此宣称验证了 Telegram 网络投递。详细结果记录在 test.md。新增 full-chain.mjs 验证自动回传与真实 API 投递；它的 TG 入站仍为构造 update，不能冒充手机入站。

## 自动回传、常驻和失败处理

```text
notifications/
  task_protocol.py       Joye outbox/inbox、claim/ack、路由、租约、report 签收
  notify-agent.py        Joye 私有 inbox 入队，不调用模型或网络
  notify-telegram.py     Joye 单次发送、冷却及 durable receipt；只发已配对 chat
  task-watchdog.py       Joye reconcile/drain，周期运行由 service/relay 驱动
  relay-notify.ts        Pi 官方 sendMessage 唤醒验收；核查后投递并记录 handled
execution/
  health.py             真实 PID/Agent/run 对账、取消、有限重试、失败释放
  service.py            本地 Herdr 启动监督；由真实 Shell 恢复原 Codex UUID
```

数据仍在同一 background 根目录：registry/outbox、inbox.json、telegram-receipts.json、runs、handled、attention、recovery、logs。所有登记 writer 共用 registry.lock，通知副表使用各自 flock，锁顺序固定。

链路：真实 result → ready_for_review outbox → watchdog 入 inbox → 空闲 TG 主 Pi claim → 持久 custom_message → 实际独立验收 → verify → 准备正文 hash/验收 hash → Telegram API message_id → report → handled。原话登记、执行完成、验收通过、API 接收与手机看到是不同证据。完整 worker 对话不作为事件正文或 result 返回值塞给前台。

Joye relay 依赖旧版本 core patch；本项目不盲改 0.84.1 core。使用该版本公开 sendMessage/agent_settled 和 session 分支检查，按真实对象识别控制回合。非 TG 启动的本地 Pi 不消费正式通知；隔离实验显式指定自己的 owner 和数据根目录。

投递失败保存 attention，不阻塞其他项目；429 按 retry_after，unknown/sending 保留现场，不能当作成功，也不能盲目重发。取消先核对原生输入和 Agent 身份，确认 Agent 空闲及监督进程退出后才释放项目。超时或未知状态不会清空占用；明确结果失败只有现场安全核对通过后才释放。retry 仅显式使用，最多两次，仍复用原 session。

Codex 的内部常驻 `codex-code-mode-host` 由 execution/codex.py 核对：必须是原 Codex 的直接子进程，实际 executable 与主程序位于同一安装目录，PID 出生身份仍一致。health.py 只排除该进程本身，继续检查其业务后代；host 已在派发前基线中也不能掩盖同组新命令。取消时业务命令若与 host 共用进程组，保留占用并拒绝扩大终止范围。

失败收尾受阻时，原因保存在对应 `runs[run_id].failure_cleanup_observation`：实际命令仍运行、Agent 未空闲、核对失败的阶段/错误类型、取消未收尾或监督进程仍活着。安全释放仍保存 failure_cleanup，保留旧结果、原生 UUID 和任务失败状态。针对性回归入口为 tests/background/failure-cleanup.py，使用本地真实 Linux 进程夹具，不调用模型、Herdr 或 TG。

```bash
python3 .pi/extensions/background/tasks/task_protocol.py reconcile
python3 .pi/extensions/background/tasks/task_protocol.py cancel TASK RUN
python3 .pi/extensions/background/tasks/task_protocol.py retry TASK
# retry 后重新 prepare/start-run/run，使用新的 RUN，旧证据保留。
```

Windows 既有入口启动本项目 service；服务异常退出由 telegram.mjs 有界退避恢复，不停止 Herdr/Codex。flock 防重复服务。原 pane 被其他进程占用、原 UUID 缺失、多份会话、绑定变化均需要对账，不新建替代身份。

取消须同时确认 Codex 停止回答、本 run 新启动的命令退出、监督进程退出，才释放占用。herdr.py 在实际派发前保存 worker_process_baseline；health.py 用真实 pane foreground PID、内核 start_ticks/boot_id 与子进程组核对，只清理本轮新增的独立组，保留 Agent 和基线中的既有服务。当前 x86_64 WSL Python/libc 缺少 pidfd_open 包装，使用本机头文件核对的 Linux syscall 434 与 pidfd_send_signal；其他架构或身份不明时明确拒绝，保留占用。缺少基线的旧 run 也不盲目清理。ESC 返回 idle 本身不足以证明命令结束。

失败释放同样需要原 Agent 空闲、监督进程退出、基线证明无本轮遗留命令；有 cancel_intent 时只由取消流程收尾，watchdog 不抢先释放。registered 重试不会读取旧 run 结果覆盖新准备状态。最多两次显式重试，旧 run 与证据保留。

Herdr 等待超时后，原 `result.json` 不改写。若原任务仍占用项目执行位置、监督进程已退出、原 Agent 已空闲且无本轮遗留命令，`late_result.py` 核对派发 hash、唯一原生输入、同一 session/turn 的最终独立 marker、`task_complete`、实际模型参数、业务身份和新产物范围，再执行一次有界的 Herdr `agent wait`（只观察，不发新 prompt）。核对完成后持久化 `late-herdr-evidence.json` 和 `late-result.json`，将当前结果指针转向迟到结果并进入原 `ready_for_review`。仍占用项目，直到独立验收或显式取消；证据不足则保留 blocked 与具体收集阶段，不补造成功。旧 run 已释放并出现后续任务时不自动采用历史迟到产物。

迟到结果的退出码来自新的真实 wait 进程，原监督的退出码、stderr 和超时证据完整保留。迟到交付保存到本 run 的 `late-<结果 hash 前16位>/`，正文、回执、发送 event_id 与观测元数据独立于旧失败通知；原问题引用保持不变。原生完成耗时使用 Codex `task_complete.duration_ms`，并记录来源，不能把原来耗尽的监督等待时间当成完整开发耗时。

原生收尾证据齐全但业务明确 read_error/http_error/error 时，迟到结果保持 blocked，安全释放已结束的执行占用，并生成新结果对应的失败事件；不会因旧失败已签收而吞掉新原因。缺少真实收尾证据的未知结果仍保留占用，不能据空闲或时间经过猜测失败完成。

已成功发送且有匹配 sender 账本和 handled 文件的同一 blocked 结果，不再产生或消费 `blocked_overdue`。新结果、状态重新进入、绑定变化和 unknown/sending 不复用旧签收；未知状态仍需对账。

交接稿和主 Pi 验收同时要求 instruction/acceptance 覆盖用户原话及明确补充，不擅自降低目标。可运行、测试通过和 worker 自述不代替原目标验收；无法达到或验证的部分需要拒绝验收并说明差距，改变目标须有用户明确同意。

发送账本 sending/unknown 需要人工对账；inbox 的 delivery_unknown 不会因自己的回复改变 leaf、租约到期或新用户分支而自动领取重发。只有明确未发送的本地冷却等失败才按记录退避重试。这保证不盲目重复投递，并不保证未知网络请求实际未送达。

Joye 文件按实际作用核对，参考仓库没有修改：

| Joye 内容 | 本项目对应实现或处理 |
| --- | --- |
| task_protocol.py | tasks/task_protocol.py、execution/runner.py、notifications/task_protocol.py；保持文件 CLI、task/run、锁与证据 |
| notify-agent.py、notify-telegram.py、task-watchdog.py | notifications/ 同名文件；持久 inbox、真实 TG API 回执、对账及有限退避 |
| relay-notify.ts | notifications/relay-notify.ts；适配 Pi 0.84.1 公共事件，不直接安装旧 core patch |
| empty-reply-guard.ts | ../reply-health/index.ts；保留一次重试、真实分支和抢占保护，适配本项目后台控制身份 |
| mem0-autosediment、memory-inject、session-recap | ../memory/；此前已接入，本次不改记忆策略 |
| agent-mail.ts | ../mail/；此前已接入实际邮箱，不重复创建收信程序 |
| pi-session-search.ts、pi-search.py | ../session-search/；此前已项目适配，不另装一套 |
| telegram-restart.ts | src/telegram/commands/pi_*.ts 与 scripts/startup/；前台命令已有接入，不恢复已撤回文件 |
| apply_delivery_patch、apply_duplicate_reply_fix、apply_notification_flood_fix | 提取当前协议的去重、状态/绑定围栏、一次恢复和 unknown 不重发规则；旧安装器不适用于本地 0.84.1，不运行全局部署器 |
| verify_*、deploy_fix.py | 其边界案例移入 tests/background/ 当前入口；旧测试依赖 Joye 安装位置，不能拿其全局通过结果替代本项目实测 |
| command-code-provider、openai-codex-agent、openrouter-provider | 当前已配置模型使用原生 Provider 与 models.json；未用的其他供应商保留参考，不启用无凭据服务 |
| pi-plugin-probe.ts | 当前 PID、扩展加载、请求与事件已由项目观测记录覆盖；不新增重复探针工具 |

原 extensions/、scripts/ 中的历史副本不作为新后台运行入口，勿混用。已替代的空回复副本移至 reply-health，不保留两个加载源。Joye Skill 的旧 Agent 权限、裸 Herdr 命令、自动发布及未接入迁移 CLI 只属历史参考；本项目执行段明确使用当前文件协议和已有授权。

十组实验入口为 tests/background/full-chain.mjs --live --case N --attempt N，题库 complex-cases.mjs、独立验收 independent-game-check.py。失败尝试不计通过，记录见 [re.md](../../../re.md)。

full-chain-series.py 仅在上一整组已落盘通过后启动同项目下一组；失败即停。live-lifecycle.py 和 live-lifecycle-observer.mjs 另测真实缺文件、超时、取消和两次重试，不计入复杂十组；audit-full-chain.py 最后核对所有任务/签收与实际观测请求。不要把离线 lifecycle.py/reply-health.mjs 回归算成真实复杂任务。

十组使用构造 TG update 经实际授权/队列，前台模型、Herdr/Codex、验收及发往已配对聊天的 Telegram API 均真实。隔离前台加载 background、reply-health、observability 和三个当前 Skills，未运行邮箱/记忆副作用；正式加载器另核对八个扩展无错误，真实主 Pi owner 已恢复。完整手机网络入站、手机收到回执、全部八个扩展同时执行后台任务及 WSL/Windows 整机重启未在这十组中验证。

## 最终报告正文与统计尾注

`notifications/relay-notify.ts` 的内部验收消息要求按本次原始需求说明结论、范围、事实依据、使用方法和关键限制，随任务复杂度调整篇幅；不混入其他 Agent 的成果，不仅给出完成状态。真实产物和必要报告按已有范围读取，完整 worker 历史仍不回灌主 Pi。

程序通过现有 `extensions/observability/telegram-turn/` 关联原始 TG 派发与本 run 验收请求，生成统一尾注，再一起渲染投递。时间、用量、上下文与工具统计来自实际证据，模型不自行填写。快照仍在现有 `final-report-receipt.json.observability`；不增加模型工具、状态协议或配置目录。独立发送器支持完整渲染分块与逐块签收，全部发送成功才 report/handled，未知发送不盲目重发。

页脚时间为原始 TG 任务发送到报告准备完成，API 确认另存观测；缺少可核实时钟则显示 `?`。箭头只累计主 Pi 原始派发与本 run 验收，不能当作 Codex 或整个项目的总消耗。详细范围和恢复规则见 [回合统计说明](../../../extensions/observability/telegram-turn/README.md)，真实任务证据与失败尝试见 [re.md](../../../re.md) 第 6 节。

新准备的后台报告使用 Telegram 原生回复，引用 `originalRequest.telegram.messageId` 对应的任务提问，先核对原始 chat 与投递目标一致。引用 ID 随正文保存在现有 final-report-receipt.json，换前台 session、重试及长报告分块仍引用同一条消息；发送账本拒绝同一事件换引用目标。发送器同时保存请求的 reply_to_message_id 和 API 实际返回的 confirmed_reply_to_message_id，不能仅凭请求参数声称引用成功。

沿用普通桥接的 [ReplyParameters](https://core.telegram.org/bots/api#replyparameters) 行为：原问题已删除时允许正常送达报告，真实引用 ID 为 null；没有 TG 来源的任务不猜测引用目标。已经准备或投递的旧报告保留原意图，不为补引用重发。
