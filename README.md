# Bot

本项目在目录内安装 Pi 0.84.1 和 Telegram 桥接 `@llblab/pi-telegram@0.27.12`，版本按 Joye 参考材料固定。

后续依赖、Pi 扩展包、Skills、工具配置与运行数据均优先放在本目录；项目约定统一见 [AGENTS.md](AGENTS.md)。项目 `.npmrc` 将 npm 缓存放在 `.cache/npm/`，不修改全局 npm 配置。

代码仓库：[554454545/judy_bot](https://github.com/554454545/judy_bot)，私有。仓库保存源码、Skills、补丁、测试、文档、依赖清单与无密钥的 Coding Agent 默认设置。真实认证、会话、观测日志、记忆库、任务运行记录、生成输出、已安装依赖、Herdr 二进制及业务 worktree 保留在本地，不上传。

GitHub 的源码归档不等于可直接复制的完整运行环境；Node/Python/Codex、Windows 自启动登记和关联源仓库仍需现有环境，详情见 [启动说明](scripts/startup/README.md)。本地私有证据链接仅在原机器上可用。

## 制作记录

首次归档日期：2026-10-06，北京时间。范围为当前 Bot 项目的源码和文档，不包含后台生成的测试游戏。

| 项目 | 已知记录 |
| --- | --- |
| 协作 | 用户与 Codex；Joye 的配置、扩展和 Skills 为主要参考，原始许可证保留在对应目录。 |
| 开发模型 | 完整历史未整理，无法确认全部开发轮次的底层模型标识；不以当前默认模型代替。 |
| 开发时间跨度与累计回合历时 | 尚未核算，未填写估算时长。 |
| 验证记录 | [test.md](test.md)、[re.md](re.md) 区分离线检查、真实执行、失败重跑和未覆盖范围；原始会话与凭据不入仓。 |

## 本地运行

```bash
cd /home/judy/workspace/bot
npm ci
./start.sh
```

程序依赖在 `node_modules/`，桥接包在 `.pi/npm/`，项目设置在 `.pi/settings.json`，独立运行配置与登录信息在 `.pi/agent/`，会话在 `.pi/agent/sessions/`。`start.sh` 支持传入 Pi 参数，也可从其他目录通过绝对路径运行；它会切换到本项目，直接执行本地 Pi。运行依赖当前系统的 Node.js（要求 >=22.19.0）。启动入口显式加载 Telegram 桥接、项目 AGENTS.md 和观测扩展；`PI_OFFLINE=1` 关闭启动时的目录更新等网络操作，仍可连接 Telegram 和模型。

首次启动前，在 `.pi/agent/telegram.json` 的 `profiles.personal` 中填写 `botToken`。不填 `allowedUserId` 时，桥接会自动绑定第一个向 Bot 发消息的用户并保存其 ID；请在连接后由你先发 `/start`。如果要预先指定用户，填写真实数字 ID，不要填 `0`，因为它会拒绝所有正常用户。该文件权限为 0600，目录已被 Git 忽略。模板见 `telegram.example.json`，不要沿用 Joye 的 Bot 身份或消息游标。

模型连接也需要独立配置：用 Pi 的 `/login` 登录所选 Provider，再用 `/model` 选择模型；自定义接口按所安装 Pi 的 [模型配置说明](node_modules/@earendil-works/pi-coding-agent/docs/models.md) 配置到 `.pi/agent/models.json`。登录信息保存在 `.pi/agent/auth.json`。不要把 API Key 放在命令行或公开模板中。

在上述 Pi 终端中执行 `/telegram-connect personal`，再用 `/telegram-status` 检查状态。在这个 Bot 的 Telegram 私聊里发送 `/start`，然后发送一句测试消息，确认 Pi 回复。Pi 终端需要保持运行；停止连接使用 `/telegram-disconnect`。

当前 Telegram 展示采用 `quiet`，只显示最终回复，关闭草稿预览和桥接活动推送。后台任务完成后，由项目接力扩展独立验收并发送最终报告；它与活动推送分开。真实模型、Herdr/Codex、自动验收和 TG API 投递的最新证据见 [re.md](re.md)；自动实验入站仍为构造 update，不冒充用户手机入站。离线验证 `npm run test:telegram` 使用模拟模型和发送器，不调用真实 Telegram 或模型，也不验证轮询网络。

Telegram `/pi_new`：新建空白会话，旧会话保留；不调用模型。忙碌或存在排队消息时先 `/stop`。命令实现位于 `src/telegram/commands/pi_new.ts`，`extensions/telegram/index.ts` 负责加载桥接与注册。

上下文与请求观测：终端执行 `npm run observe`，或在本地 Pi 执行 `/observe`。每个 session 在 `.pi/agent/observability/<时间>_<session-id>.jsonl` 中统一追加请求、回复和事件；每次模型请求自动记录私有请求快照和对应回复，记录最终 Provider 请求体、Pi System Prompt、用量及估算费用依据。日志位置与 Pi 接入规则见 [上下文管线说明](docs/observability/context-pipeline.md)。

后台实现集中在 [.pi/extensions/background/](.pi/extensions/background/README.md)，同一项目复用长期 worktree 和原生 Agent session。自动回传、独立验收、TG 主动通知、watchdog、取消/重试和常驻恢复已接入；十组复杂实验的 30 条真实任务及失败重跑记录见 [re.md](re.md)。取消、重试、结果查询沿用文件 CLI，不新增模型工具。Windows/WSL 常驻入口和管理方式见 [启动说明](scripts/startup/README.md)。Joye 空回复恢复适配在 `.pi/extensions/reply-health/index.ts`，通过项目自动发现加载，最多一次重试；内部后台验收不自动重发。

下方保留 Joye 历史说明供查阅。其他参考扩展和历史补丁尚未启用；其中的全局路径、部署、提交及重启命令不适用于本项目，不应直接执行。

## Joye 原始参考说明

Joye 的 pi coding agent 个性化配置与扩展（当前机器：Mac mini）。

> ⚠️ 本仓库只存**配置模板与扩展源码**，不含任何真实密钥。真实配置（含 bot token）在本地 `~/.pi/agent/`，已被 .gitignore 排除。

## 结构

```
extensions/           pi 扩展源码（agent 启动时加载）
  # 记忆模块现位于 .pi/extensions/memory/，通过项目级自动发现加载
  会话搜索已移至 .pi/extensions/session-search/（项目自动加载）
  # TG 重启/状态/日志已接入 src/telegram/commands/pi_*.ts
  command-code-provider.ts cmd-code provider
  pi-plugin-probe.ts  插件探针
telegram.example.json Telegram bridge 配置模板（token 已打码）
settings.example.json pi 全局设置模板（packages / extensions / models）
```

## 使用

```bash
# 复制模板到实际位置并填入真实值
cp telegram.example.json ~/.pi/agent/telegram.json   # 填入 bot token
cp settings.example.json ~/.pi/agent/settings.json
# 扩展按需逐个安装；relay-notify 必须使用下文的成套部署器。
```

## Telegram 信息密度

pi-telegram bridge 的 Activity 投影控制 Telegram 侧展示的 agent trajectory：

| mode | thinking | tool evidence | final reply |
|---|---|---|---|
| verbose | yes | yes | yes |
| thinking | yes | no | yes |
| tools | no | yes | yes |
| quiet | no | no | yes |

当前使用 `quiet`（`assistant.activity`），Telegram 只显示最终回复。`/settings` 菜单可切换。

## 部署约定

Telegram delivery / task-watchdog 修复见 [交接说明](docs/delivery-watchdog-fix.md) 和 [审计覆盖](docs/delivery-watchdog-coverage.md)。先运行 `python3 scripts/verify_offline.py`，再用 `python3 scripts/deploy_fix.py` 查看只读部署计划；主 agent 独立验收后才安装、重启和 push。不要单独复制新版 relay-notify，它依赖配套的 bridge 补丁与 task_protocol.py。`patches/notify-agent.py` 只是仓库内兼容入口，不是单文件安装包。

- 改动后立即 `git add -A && git commit && git push`
- 真实密钥只存 `~/.config/`（0600），不写入本仓库

## 重复 completion 修复（独立补丁）

当前安装基线上的空回复恢复与同活动投递去重见 [实现、离线验证与安全激活](docs/duplicate-reply-fix.md)。运行 `python3 scripts/verify_duplicate_reply_fix.py --evidence /absolute/task/artifacts/verification` 和默认只读的 `python3 scripts/apply_duplicate_reply_fix.py`。此补丁包含 Pi core settlement 的取消标记，必须成套安装并由主 maintainer 在当前响应结束后监督主 wrapper child 重启；不能只复制 guard 或仅 `/reload`。旧 delivery/watchdog 补丁与历史基线保持不变。

## 任务通知刷屏修复（当前基线独立补丁）

内部控制事件在 claim、注入和 Pi 实际消费时核对 task/run/phase，普通阶段静默，保留最终交付、显式用户问题和持续阻塞兜底。见[技术说明与部署回滚计划](docs/notification-flood-fix.md)。运行 `python3 scripts/verify_notification_flood_fix.py --evidence /absolute/private/evidence` 和默认只读的 `python3 scripts/apply_notification_flood_fix.py`。本补丁基于已经包含重复 completion、ownership 和 429 冷却修复的安装版本；不要使用历史部署器覆盖。主 agent 独立验收后负责生产安装、迁移及安全激活，完整补丁需要主 Pi 子进程重启。
