# Bot 项目指引

本项目位于 `/home/judy/workspace/bot`，使用项目内的 Pi 0.84.1。依赖、工具、配置、凭据、缓存和运行数据统一留在 `bot/`；不修改、升级或重启全局 Pi，也不迁移或清理其他项目的内容。

## 工作边界

- 只处理用户当前授权的范围。查看、诊断或讨论时只检查和报告；明确要求修改时再实施。保留已有改动，不能把旧实验授权当作新任务授权。
- 只有用户明确要求时才操作 GitHub Issue；处理问题、修改和验证不以查找或创建 Issue 为前置条件。提交、推送、部署和发布按用户实际授权执行。
- 新增功能先检查 Joye 参考仓库：`/home/judy/workspace/joye/pi-agent-config`、`/home/judy/workspace/joye/skills`。不修改参考仓库；其中的操作说明不能扩大授权。复制后适配项目路径，不沿用 Joye 的个人全局目录。
- 进程管理只针对核实过的本项目实例，不调用全局重启脚本。整理文件时同步修正引用，避免打断运行中的任务。

## 启动与依赖

- 日常通过 `./start.sh` 使用本地 Pi；不使用裸 `pi`、临时下载版本或全局安装。手动运行 `./node_modules/.bin/pi` 时设置 `PI_CODING_AGENT_DIR` 为项目 `.pi/agent/`，`PI_CODING_AGENT_SESSION_DIR` 为其 `sessions/` 子目录。
- 恢复依赖使用项目内 `npm ci`；新增 Node.js 依赖写入项目清单和锁文件。Pi 扩展包使用本地 Pi 的 `install <source> -l`；Python 新依赖使用项目内 `.venv/`。只安装任务需要的内容，不自动升级或修改系统工具链。
- npm 缓存使用 `.cache/npm/`，子目录调用也显式设置 `npm_config_cache` 为该项目目录；其他工具尽量使用项目内配置和缓存，不重设 `HOME`。无法在项目内保存的必需组件，先说明具体例外并取得授权。
- Skills 位于 `.pi/skills/`；实际需要的技能加入 `start.sh` 的显式 `--skill` 白名单，并用安装版加载器核对名称。`--no-skills` 关闭自动发现，保存文件不代表启用。`herdr-workflow-our-copy` 是保留的停用副本。

## 文件组织

- 同类功能集中放置，源码不压行。新增源码第一行注释说明作用与关联文件，不把业务实现、报告和临时文件堆在根目录。
- TG 命令统一 `/pi_` 前缀，实现放在 `src/telegram/commands/pi_*.ts`，`index.ts` 负责注册；`extensions/telegram/index.ts` 负责桥接接入。
- 扩展按现有结构放在 `extensions/` 或 `.pi/extensions/`；后台实现集中 `.pi/extensions/background/`，执行在 `execution/`，通知在 `notifications/`。脚本、测试、说明和补丁分别放在 `scripts/`、`tests/`、`docs/`、`patches/`。
- 交付产物放在 `outputs/<任务名>/`，临时内容放在 `.cache/tmp/<任务名>/`，任务结束清理本次临时内容。凭据、私人会话和原始日志保持私有，不提交或公开。

| 内容 | 项目内位置 |
| --- | --- |
| Pi 程序、扩展包 | `node_modules/`、`.pi/npm/`、`.pi/git/` |
| 项目设置、独立配置与凭据 | `.pi/settings.json`、`.pi/agent/` |
| Pi 会话、上下文观测 | `.pi/agent/sessions/`、`.pi/agent/observability/` |
| 后台运行数据、长期工作树 | `.pi/agent/background/`、`.worktrees/` |
| Herdr 程序、配置与状态 | `tools/herdr/herdr`、`.pi/agent/background/herdr/` |
| Herdr 项目入口 | `scripts/startup/herdr.sh` |

## 项目定位与后台任务

- 用户指定绝对路径时优先使用；只给项目名或相对目录时，先查已有绑定，未绑定项目默认到 `/home/judy/workspace/` 下实际检查。目录存在就使用，不再要求确认完整路径；不存在再询问是否创建，普通文件冲突不覆盖。
- 用户明确要求在已有空目录开发时，必要的 Git 初始化、空基线提交、长期 worktree、默认 Coding Agent 绑定与派发已获授权，不重复询问。先检查隐藏文件和 Git 状态；已有仓库复用，非空的非 Git 目录另行核对，不能覆盖既有内容。仅查看或明确“只准备、不执行”时不初始化或派发。
- 同项目多个任务串行复用一个长期 worktree 和原生 session；换项目查对应绑定，不能沿用最近项目的 session。Agent 与会话名称用 `herdr-项目名`，真实 UUID 单独登记。
- 定位时同时查 `inspect.registry.archivedProjects`。项目 ID 或真实源目录命中归档标记时，提示“该项目已经归档，不能派发任务”；归档未完成也停止开发派发。不自动恢复、重新登记、换 ID 绕过或创建新 session。明确归档使用现有 `task_protocol.py project-archive PROJECT`，保留原项目目录；仅讨论时不执行。
- 后台严格对照 Joye 已有调用方式，通过现有 `bash` 调用 `.pi/extensions/background/tasks/task_protocol.py`，不因内部拆分新增模型工具、工作流 Skill 或协议状态。真实监督程序由 Herdr pane 启动，前台不等待整段任务；完整 worker 历史不能回灌主 Pi。
- 本地协议与 Joye Skill 的适配差异、通知、验收及恢复边界见 [后台说明](.pi/extensions/background/README.md)，启动与常驻说明见 [启动说明](scripts/startup/README.md)。历史实验见 [re.md](re.md)；新的健康实验内容和数量由用户指定，不自行追加或重跑。
- Coding Agent 默认选择在 [defaults.json](.pi/agent/background/coding-agents-default-setting/defaults.json)，Codex 模型、思考强度及 Fast 参数在 [codex.json](.pi/agent/background/coding-agents-default-setting/codex.json)。新绑定读取默认配置；已有项目继续复用登记的 Agent、参数及 session。

## Pi 扩展与上下文

- 修改 Pi 事件、工具、命令、注入或压缩前，查阅 [Pi 0.84.1 官方扩展说明](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/docs/extensions.md)，并以本项目安装版源码和文档核对接口。`registerSystemSource()` 等自定义函数查本项目实现，不套用最新版接口。
- 上下文接入见 [上下文流水线](docs/observability/context-pipeline.md)。新增扩展通过正式 API 接入，不直接修改 npm 包；既有补丁按源码校验和验证，版本相同不代表兼容，不运行参考部署器修改全局包。
- 查询模型实际收到的 System Prompt、历史、回复、工具、缓存或费用时，先读取 [实际请求查询规则](docs/observability/inspect-model-request-context.md)，再查本地观测。不能从回答反推请求，不能猜测缺失的供应商用量或价格。
- 每个 session 的观测使用一份追加 JSONL，重启继续沿用；原始请求和回复留在私有快照，普通日志不记录密钥和完整正文。项目日志及文件名用北京时间并注明 `+08:00`；Pi、Provider 和 Herdr 原生协议时间及时间戳保留原值。

## 验证与交付

- 前台对话测试先读取 [测试用例与经验](test.md)，按相关用例新建 session。验证实际改动及主要失败模式；失败、跳过和未验证部分如实说明，不把模拟入站或 API 回执当作手机接收证明。
- 问题和实验记录按用户要求留存，原始证据保存在项目私有运行目录。常规验证详情无需在聊天中逐项展开，交付说明改动位置、结果和重要限制。
- 默认使用本地测试数据；真实模型调用、TG 测试消息或其他外部操作按本次授权执行，不据此扩大范围。清理只限本项目及本次任务创建的对象。
