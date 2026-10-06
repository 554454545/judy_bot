# Bot 项目指引

本项目位于 `/home/judy/workspace/bot`，使用项目内安装的 Pi；依赖、配置和运行数据留在本目录，不修改全局 Pi。

如果对项目边界不清晰，先完整读取 [项目边界与约定](plan.md)。执行代码或配置修改、安装依赖、文件整理、进程管理、访问项目外路径或外部写入前，也必须先读取该文件并遵循其中约定。普通问答无需加载。

[plan.md](plan.md) 保存项目的详细边界、目录组织、参考材料和验证交付约定；不要根据记忆猜测或自行扩大任务范围。

本项目的新问题、改进需求、调查过程、解决方案与验收结果统一记录在 [GitHub Issues](https://github.com/554454545/judy_bot/issues)。执行这类任务前读取 [GitHub Issues 问题处理流程](plan.md#github-issues-问题处理流程)，先查已有 Issue，再建单或追加；记录问题不等于授权修复。

执行前台对话测试前读取 [测试问题与验收经验](test.md)，按相关用例新建 session 并测试；该文件只维护可复用用例，单次过程与结果写入对应 Issue。[problem.md](problem.md) 和 [re.md](re.md) 保留为历史，不再追加新问题与处理过程。

用户询问模型实际收到的上下文、System Prompt、历史、回复、工具、缓存或费用时，先读取 [查看模型实际请求上下文](docs/observability/inspect-model-request-context.md)，再按该规则查询本地观测记录。

编写或修改 Pi 扩展、`pi.on()` 事件处理、工具和命令注册、上下文注入或压缩逻辑前，先查阅 [Pi 0.84.1 官方扩展开发说明](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/docs/extensions.md)，按所用接口确认触发时机、参数和返回值。以本项目安装版本的源码和文档核对实际行为，不直接套用最新版接口；`registerSystemSource()` 等项目自定义函数需查阅本项目实现。

新增功能先检查 Joye 参考仓库是否已有实现。项目 TG 命令统一使用 `/pi_` 前缀，实现放在 `src/telegram/commands/pi_*.ts`，第一行注释注明作用和关联文件；`index.ts` 负责注册。

后台实现严格对照 Joye 的 Skill、扩展和脚本，沿用其已有调用方式；不能因拆分内部功能就自行增加模型工具、工作流 Skill 或协议状态。用户已授权完整链路、主动通知、watchdog、项目常驻恢复和十组复杂真实实验；适配差异和验收记录见 [后台说明](.pi/extensions/background/README.md) 与 [re.md](re.md)。已有 bash 调用 task_protocol.py；实际监督程序由 Herdr pane 启动，前台不等待整段任务。明确只准备时不执行；完整 worker 历史不能回灌主 Pi。实现集中 `.pi/extensions/background/execution/` 和 `notifications/`。Agent 和会话名用 `herdr-项目名`，同项目复用一个原生 session。

流程实际需要的 Skills 必须同步加入 start.sh 的显式 --skill 白名单，并用安装版加载器核对实际名称；只保存或修改 SKILL.md 不代表已启用。

后台 Coding Agent 的默认选择在 [defaults.json](.pi/agent/background/coding-agents-default-setting/defaults.json)，Codex 默认模型、思考强度和 Fast 参数在 [codex.json](.pi/agent/background/coding-agents-default-setting/codex.json)。新绑定读取默认配置；已有项目继续复用登记的 Agent、参数和 session。
