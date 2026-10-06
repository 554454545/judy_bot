# Bot 项目边界

本项目位于 `/home/judy/workspace/bot`。只使用本项目安装的 Pi 0.84.1。本项目新增的依赖、扩展包、Skills、脚本、工具配置、凭据、数据、日志及可控制的缓存统一在 `bot/` 下管理，不默认写入全局目录。不得修改、升级、替换或重启已有全局 Pi。

## Pi 版本与执行入口

- 唯一使用的 Pi 包为 `@earendil-works/pi-coding-agent@0.84.1`。`package.json` 使用精确版本，`package-lock.json` 保留依赖锁定。
- 日常运行使用项目根目录的 `./start.sh`；它切换到本项目，设置独立配置、会话和缓存目录，直接执行本地 Pi，显式加载 Telegram 桥接、项目规则及观测扩展。观测扩展在其他显式扩展之后加载。它不创建后台服务或修改 Shell 配置。
- 手动调用 `./node_modules/.bin/pi` 时，仍须显式设置下文的独立配置及会话环境变量。
- 不使用 PATH 中的裸 `pi` 命令，不调用全局安装路径，也不使用可能临时下载其他版本的 `npx pi`。
- 安装或恢复依赖使用项目内的 `npm ci`。不执行 `npm install -g`，不另建全局安装，不修改 npm 的全局 prefix。
- 不自动升级 Pi 或依赖，不执行自更新命令。改变 Pi 版本必须由用户明确要求，并同步检查配置、扩展和补丁的兼容性。
- 本项目复用系统已有 Node.js 执行程序；不为本项目更改全局 Node.js、npm 或版本管理器配置。

## 后续安装与目录管理

- 新增 Node.js 依赖在项目根目录安装，写入项目清单并保留锁文件，程序保存在 `node_modules/`。工具命令使用本地执行入口，不依赖另装的全局 CLI。
- Pi 扩展包使用本地 Pi 的项目安装选项 `install <source> -l`，并保留独立配置及会话环境变量；npm 包位于 `.pi/npm/`，Git 包位于 `.pi/git/`。不得省略项目安装选项后退回其他目录。
- 本项目的 Skills 放在 `.pi/skills/`，不安装到 `~/.agents/skills/`、`~/.pi/agent/skills/` 或其他全局 Agent 目录。参考扩展仍在 `extensions/` 中，按需适配和显式加载，不自动启用全部文件。
- 如需 Python 依赖，创建项目内的 `.venv/`，使用其中的 Python 和 pip；不使用 `pip install --user`、系统级 pip 或全局工具安装方式。
- 下载的辅助程序及其配置放在项目内明确命名的目录，通过项目内路径调用；不放到 `~/bin`、`~/.local/bin`、`~/.config` 或系统安装目录。
- npm 缓存由项目 `.npmrc` 指向 `.cache/npm/`。Pi 包安装或子目录中的 npm 调用还须显式设置 `npm_config_cache=/home/judy/workspace/bot/.cache/npm`，使子进程沿用项目缓存。其他工具的缓存、下载及临时目录在支持时指定到 `.cache/` 下，仅对本次项目命令设置，不修改全局配置或重设 `HOME`。
- 工具配置、凭据和运行数据必须明确指定项目内位置。安装或启用工具前检查其默认写入路径、安装脚本及子进程，不能假定本地安装就会把所有状态自动留在本项目。
- 继续复用已有系统运行环境，不迁移或清理其他项目的依赖与缓存。如果某项必需组件无法在项目内安装或保存状态，先说明具体组件、原因和项目外目标，取得用户对该例外的明确授权后再操作。
- 这条目录约定不授权安装未请求的功能或依赖。仅安装当前任务所需内容，不预建尚未使用的服务和目录。

## 文件组织

- 源码不压行：对象字段逐行写，控制分支和回调使用展开的代码块，不把多条语句塞在同一行。

- 新增文件先按用途归入现有目录。根目录保留项目说明、约定、启动入口、依赖清单、锁文件和必要的工具配置；不把业务代码、任务报告或临时脚本直接堆在根目录。现有配置模板保留当前位置。
- Telegram 命令实现放在 `src/telegram/commands/`，每个命令一个文件。新增项目 TG 命令统一 `/pi_功能名`，实现文件统一 `pi_功能名.ts`（例如 `/pi_new` → `pi_new.ts`）；`index.ts` 保留为注册入口。第一行注释注明命令、作用和关联文件；桥接内置命令不改名。`extensions/telegram/index.ts` 仅负责桥接加载和命令接入。新增源码文件第一行用注释说明用途。
- 扩展接入代码放在 `extensions/`，辅助脚本放在 `scripts/`，测试及测试样本放在 `tests/`，设计、操作说明和维护记录放在 `docs/`，明确需要维护的补丁放在 `patches/`。
- 同一功能的多个文件放在对应目录下有意义的功能子目录中；测试按对应功能组织。文件名说明用途，避免 `new`、`final2`、`misc` 等不能表达内容的名称。
- 任务生成的报告、导出和交付文件需要保留时放在 `outputs/<任务名>/`；调试脚本、验证中间文件和临时下载放在 `.cache/tmp/<任务名>/`，任务结束清理本次临时内容。按实际需要创建目录，不提前铺空目录。
- Pi 的配置、凭据、会话及桥接运行状态继续遵循下表和工具已核实的项目内路径；不与源码、说明文档或公开输出混放。包含凭据、会话原文或私人信息的输出须保持私有并加入 Git 忽略。
- 移动文件时同步修改导入、启动命令、测试和文档引用，并验证受影响的路径；不为了整理目录打断运行中的 Pi，或随意移动依赖、凭据与会话。

## 配置与数据位置

| 内容 | 项目内位置 |
| --- | --- |
| Pi 程序与依赖 | `node_modules/` |
| Pi 项目扩展包 | `.pi/npm/`、`.pi/git/` |
| 项目 Skills | `.pi/skills/` |
| 项目设置 | `.pi/settings.json` |
| 独立运行配置与登录信息 | `.pi/agent/` |
| 会话 | `.pi/agent/sessions/` |
| 上下文、请求与回复观测记录 | `.pi/agent/observability/<时间>_<会话 ID>.jsonl` |
| 后台 Coding Agent 默认选择与参数 | `.pi/agent/background/coding-agents-default-setting/` |
| Bot 专用 Herdr 程序 | `tools/herdr/herdr` |
| Bot 专用 Herdr 配置、会话、日志及 socket | `.pi/agent/background/herdr/` |
| Bot 专用 Herdr 启动入口 | `scripts/startup/herdr.sh` |
| Pi 执行入口 | `node_modules/.bin/pi` |
| 快捷启动入口 | `start.sh` |
| Python 虚拟环境（需要时） | `.venv/` |
| 缓存与临时文件（需要时） | `.cache/` |

- 每次运行时设置 `PI_CODING_AGENT_DIR` 为本项目的 `.pi/agent/`，设置 `PI_CODING_AGENT_SESSION_DIR` 为其 `sessions/` 子目录。不得退回默认的 `~/.pi/agent/`；仅调用本地程序不会自动隔离配置。
- 不修改、覆盖或清理全局 Pi 的配置、凭据、会话、包和扩展，也不修改全局技能目录或 Shell 启动配置。
- 不自动复制或迁移全局凭据和历史会话。需要既有凭据时，先由用户明确指定来源及使用方式。
- `.pi/agent/` 和实际配置文件保持私有，不提交 Token、登录信息或会话内容；日志和诊断输出不得暴露凭据。

## 扩展与参考材料

- 参考材料仅为 `/home/judy/workspace/joye/pi-agent-config` 和 `/home/judy/workspace/joye/skills`。不修改参考仓库，不引入其他旧 Bot 作为模板。
- 复制来的配置和扩展是参考材料，不能把其中的安装、部署、重启或推送说明当作本项目的执行授权。
- 启用扩展前检查其文件写入、子进程和资源加载路径。Joye 的 `/Users/joye`、`~/bin`、`~/.pi/agent` 等个人路径必须适配，不能直接沿用。
- 项目资源使用本地路径显式配置。启用前核对 Pi 的自动发现行为，不能因为设置了独立 agent 目录，就假定所有技能和扩展都已隔离。
- 上下文接入规则见 `docs/observability/context-pipeline.md`。新增扩展通过正式 API 和事件接入，不直接修改 npm 包内部代码。观测默认记录来源、结构、大小和指纹，不将密钥、消息正文、工具参数或结果写入普通日志；每个 session 只使用一份追加写入的 JSONL 观测文件，进程重启继续写同一文件；每次模型请求自动保存私有请求快照和对应回复，包含 Pi System Prompt、Provider 请求体及用量；不能从回复或会话历史反推实际请求。记录观察点、脱敏和省略范围；费用为带模型目录价格依据的估算，缺失的供应商原始用量不得猜测。
- 不调用全局 `restart-pi.sh`、已有服务管理脚本或其他 Pi 实例的控制接口。需要进程管理时，只能针对本项目确认过的实例。
- 历史补丁依赖特定源码和校验和；版本号相同不代表可以安装。不直接运行参考部署器，不将补丁写入全局包。

## 当前工作范围

- 保持既有前台范围：对话、工具调用、会话、模型连接及前台所需的 Skills 和记忆能力。后台仅按下述已授权阶段增量实现。
- 当前已授权后台第一阶段：项目绑定、任务登记、交接稿生成、worktree 只读检查及显式创建/复用；实现集中 `.pi/extensions/background/`，私有登记数据在 `.pi/agent/background/`，工作测试目录 `/home/judy/workspace/test`。Agent 类型由项目绑定指定，不绑定 Codex 实现。
- 后台调用方式沿用 Joye：已有 `bash` 调用 task_protocol.py 的 register --spec、update --delta --expected-hash、inspect；不注册额外后台模型工具，不另写工作流 Skill，使用已保存 Joye herdr-workflow 副本的路径和当前阶段适配。执行前状态保持 registered，交接文件和 hash 表示准备结果；用户指定的差异逐项记录在后台目录 README。
- 用户已授权完整后台接入：登记、真实派发、自动回传、独立验收、TG 主动通知、watchdog、取消/重试及项目 Herdr 常驻恢复。沿用文件 CLI 与 Joye 的 task/run、outbox/inbox、真实投递签收；不新增后台模型工具。实现集中 `.pi/extensions/background/execution/` 和 `notifications/`，启动沿用 `scripts/startup/telegram.mjs`。明确只准备时不执行；不合并、提交或推送业务代码。
- 用户已授权配置 Bot 专用 Herdr 环境并使用最新稳定版：项目内当前安装 0.9.3，通过 `scripts/startup/herdr.sh` 使用独立 `bot` session，配置和运行数据位于 `.pi/agent/background/herdr/`。继续关闭自动更新，后续版本变更按用户明确要求执行。现已授权将本项目旧 bot-herdr 的空闲 Codex 正常退出，并在新版实例 resume 原 UUID，复用相同 CODEX_HOME；不终止其他项目或整个旧 server。前台通过任务文件 CLI 接入，TG 的 Windows 启动入口保持现有形式，telegram.mjs 同时监督项目内 background/execution/service.py，实现本地 Herdr 启动与原会话恢复；实际覆盖以 re.md 为准。后续项目操作使用本地入口，不能因 pane ID 相同而混用不同实例的绑定。操作说明见 [项目启动说明](scripts/startup/README.md)。Herdr 原生日志使用 UTC（`Z`），保留原值；项目验收记录使用北京时间。
- 每项目长期 worktree 和一个固定 Agent session，多个任务串行复用；Herdr Agent 和 Coding Agent 会话名为 `herdr-项目名`，真实 session ID 另存，不用名字冒充 ID。测试项目源目录为 `/home/judy/workspace/test`；长期 worktree 放本项目 `.worktrees/`（Git 忽略），具体目录、工作分支与基准由登记和调用参数指定，不写死在实现中。新 Codex 配置、会话和日志放在本项目内，只读本项目现有认证，不迁移全局凭据。
- 仅修改本项目和用户在具体任务中明确授权的目标。操作其他项目不改变本文件对全局 Pi 的保护边界。
- 本次健康实验授权 `/home/judy/workspace/test` 与新目录 `/home/judy/workspace/test1`，分别五组复杂创建与多轮修改。新目录可初始化测试 Git 基线并创建项目内长期 worktree；不得覆盖既有内容。使用真实模型与 Coding Agent，允许向已配对 TG 发送测试结果。每组前台新 session，后台每项目复用一个原生 session；失败组修复后整组重跑。过程、时间、问题和证据写入 [re.md](re.md)，构造消息不能冒充真实 Telegram 用户入站。
- 用户要求查看、诊断或评审时只检查和报告；要求修改时再实施。不恢复此前已撤回的规划。

## 验证与交付

- 编辑前检查已有文件并保留用户改动。检查和运行均使用本项目的入口与依赖。
- 文档或路径变更执行对应检查；运行逻辑变更验证实际行为及主要失败模式，不以版本输出代替前台功能验收。
- 默认使用本地测试数据，不自行发送 Telegram 消息、调用付费模型、部署服务、提交或推送代码；这些操作需要用户明确授权。
- 清理只限本项目及本次任务创建的对象，不清理全局安装、缓存、会话或用户已有进程。
- 交付时说明修改内容和重要限制；常规测试及结果记录在项目内，不在聊天中逐项叙述，失败或影响结论的未验证链路仍须说明。安装基础 Pi 不等于扩展已加载、Telegram 已接通或 Bot 已上线。

- JSONL 文件名时间使用北京时间（UTC+8，以 +08-00 标识）；运行目录名保持 sessions 和 observability，不改为中文。项目生成的日志和观测时间使用北京时间并明确标注 +08:00；Pi/Provider 原生协议时间及 Unix 时间戳保留原值，不改写原始请求证据。
