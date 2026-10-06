<!-- 项目启动说明：Windows + WSL 的 TG 常驻入口，以及独立的 Bot Herdr 环境、目录和验证范围。 -->

# Windows + WSL 下的 TG 常驻启动

## 1. 启动顺序和文件

Windows 当前账户登录 → 任务计划程序 → `windows-hidden.vbs` → `windows.ps1` → WSL `Ubuntu-22.04` → `telegram.mjs` → 项目根目录 `start.sh` → 本地 Pi → TG `personal`。

| 文件 | 作用 |
| --- | --- |
| [windows-hidden.vbs](windows-hidden.vbs) | 无窗口宿主，等待 PowerShell 常驻入口并将退出码交给任务计划程序。 |
| [windows.ps1](windows.ps1) | 注册、管理 Windows 登录任务；保持 WSL 调用，进程退出后等待 30 秒重试。 |
| [telegram.mjs](telegram.mjs) | 启动项目 Pi RPC，保持输入管道，执行 TG 连接命令。 |
| [../../start.sh](../../start.sh) | 设置项目配置、缓存及会话目录，加载本地 Pi 和扩展。 |

所有启动程序均在此目录管理。Windows 入口隐藏运行，并显式禁止 `wsl.exe` 子进程创建控制台，代理提示不会弹出终端窗口。Windows 侧只注册任务 `Workspace-Bot-Telegram`，引用这里的 VBS 宿主和 PowerShell 文件，不复制脚本，也不修改全局 Pi。

原先的 `workspace-bot-telegram.service` 及两个用户 systemd 注册链接已移除，避免两套入口同时运行。本方案不依赖此前无法连接的用户 systemd 总线。

## 2. 常驻的含义

- 当前 Windows 账户进入桌面后自动启动，不需要打开终端。
- 锁屏、关闭显示器不会主动停止任务；任务不限运行时长，不要求空闲，使用电池也允许运行。
- 睡眠、休眠、关机期间无法回复；电源设置由用户维护，本脚本不修改。
- 注销 Windows 账户会结束交互式任务；下次登录再次启动。
- 尚未登录 Windows、电脑停留在登录界面时不会启动。这是登录触发，不是未登录的系统启动触发。

任务持续等待 `wsl.exe`，保持 WSL 的前台调用。微软说明：单独的 systemd 服务不会保持 WSL 实例常驻。[WSL 官方说明](https://learn.microsoft.com/en-us/windows/wsl/systemd)。

## 3. 管理方式

在 Windows PowerShell 中执行以下命令。首次使用先定义脚本位置：

```powershell
$startupScript = '\\wsl.localhost\Ubuntu-22.04\home\judy\workspace\bot\scripts\startup\windows.ps1'

# 查看任务状态
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $startupScript -Action Status

# 注册或重新启用，并立即启动
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $startupScript -Action Install

# 重启本项目 TG
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $startupScript -Action Restart

# 停止当前运行，保留下次登录启动
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $startupScript -Action Stop

# 停止并禁用登录启动
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $startupScript -Action Disable
```

也可以在 Windows 任务计划程序中查看 `Workspace-Bot-Telegram`。停止时优先使用上述脚本：单独在任务计划程序中结束任务可能留下 WSL 子进程，脚本会同时正常结束本项目的入口。

任务使用当前账户的交互式登录和普通权限；不保存 Windows 密码。PowerShell 执行策略只对调用进程使用 `Bypass`，不改变系统策略。任务设置依据：[微软任务计划设置文档](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtasksettingsset)。

## 4. 退出恢复、会话和日志

Pi 或 WSL 调用退出后，Windows 入口等待 30 秒再启动。若 Windows 入口异常失败，任务计划程序设置每分钟重试，最多 999 次。显式停止或禁用不应依靠这个机制再次启动。

项目锁 `.pi/agent/logs/startup/runtime.lock` 防止同一任务重复启动两份入口。不要另行手动启动相同 TG profile；锁不能限制绕过本入口的其他启动方式。

Pi 使用 `--continue` 恢复最近会话及该会话的模型设置；无可继续会话时使用项目默认配置。TG 初始连接超过 90 秒或连接命令失败时退出，进入重试。

从项目根目录查看日志：

```bash
# 北京时间的启动、连接和退出状态，不保存 RPC 消息正文
tail -n 50 .pi/agent/logs/startup/runtime.log

# Pi 标准错误，按私有诊断日志管理
tail -n 50 .pi/agent/logs/startup/stderr.log
```

这些日志追加写入，当前未配置轮转。模型请求与回复仍存于 `.pi/agent/observability/`，会话仍存于 `.pi/agent/sessions/`。

## 5. 配置和验证范围

发行版、Linux 用户、项目绝对路径、已有 Node.js 路径均集中在 `windows.ps1` 顶部。更换其中任意一项后修改该文件；移动本目录还需重新注册 Windows 任务，因为任务引用脚本的原位置。

本次已登记并实际启动任务。当前状态和退出恢复验证见 [verification.json](../../.pi/agent/logs/startup/verification.json)。没有为验证而重启 Windows、关闭整个 WSL 或锁定用户桌面，用户已实际重启，2026-10-03 23:13:07 连接 TG；此前任务退出问题已改用无窗口宿主处理，该修复后的下一次登录尚待验证。

## 6. 语音日志修复

自动语音回复保持官方默认 `hidden`。此前文字回复报“所有语音供应商失败”，是桥接的空语音产物处理缺陷，不代表发生了实际语音合成。项目内 `@llblab/pi-telegram@0.27.12` 的 `lib/outbound.ts` 已增加空列表直接返回。

补丁及前后校验和保存在 [../../patches/pi-telegram-empty-voice/](../../patches/pi-telegram-empty-voice/)。重新安装桥接包可能覆盖此修复，需要按该版本与校验和重新核对，不能盲目应用。未修改全局包。

### Windows 代理与 WSL（2026-10-04）

Windows 自启动不会继承终端里设置的代理。若 Windows 当前账户启用了系统 HTTP 代理，`windows.ps1` 在每次启动项目进程前只读其地址；`telegram.mjs` 将 localhost 映射到 WSL 默认网关，并仅在 Pi 子进程启用 `NODE_USE_ENV_PROXY=1` 和 TG 的 auto 网络策略。地址来自 Windows 设置，端口不写死，不修改全局 Pi、系统代理或 DNS。当前解析支持单个 host:port，或按 http/https 分项的设置；仅有 PAC 或 SOCKS 配置不在本次适配范围。

2026-10-04 曾出现心跳正常但 getUpdates 持续 ETIMEDOUT：运行进程缺少代理环境，直连失败。继承现有代理后 TG 重新连接，保留重启前会话；验证记录在项目 `.pi/agent/logs/startup/proxy-recovery-verification.json`。Node 22.23 的环境代理可能输出 UNDICI-EHPA 实验性提醒，提醒本身不表示连接失败。心跳正常不能单独证明消息收发正常。

## 7. Bot 专用 Herdr 环境

项目内当前使用 Herdr **0.9.3**，为 2026-10-05 核实的最新稳定版。直接下载 [官方 Linux x86_64 release](https://github.com/herdrdev/herdr/releases/download/v0.9.3/herdr-linux-x86_64)，没有运行全局安装器。二进制大小为 29,962,088 字节，SHA-256 与官方 release asset 的 digest 一致：

```text
18a8dc65f1c2fa485884344356dea1cfd911c6f06cf46fa78e193f4087f4dba7
```

| 内容 | 项目内位置与作用 |
| --- | --- |
| [Herdr 程序](../../tools/herdr/herdr) | 官方二进制；Git 忽略，不替换全局 Herdr。 |
| [herdr.sh](herdr.sh) | 从自身位置定位 Bot，选择本地二进制、配置和 `bot` session。 |
| [herdr-shell.sh](herdr-shell.sh) | pane 的 Bash 入口；不加载全局 profile/bashrc，保留本地 PATH、缓存和历史位置。 |
| [config.toml](../../.pi/agent/background/herdr/config.toml) | 关闭更新检查和声音，使用项目 Shell；默认 worktree 目录为 `.worktrees`。 |
| `.pi/agent/background/herdr/sessions/bot/` | 原生状态、日志、socket 和 Shell 历史；历史文件由 Bash 在退出时保存。 |
| `.pi/agent/background/herdr/runtime/` | 本进程的 XDG runtime 目录。 |
| `.cache/`、`.cache/tmp/` | 本进程及继承环境的子进程的缓存、临时目录。 |

入口固定从 Bot 根目录启动，所以配置中的相对 worktree 目录解析为项目 `.worktrees/`。已有后台执行登记中的显式 worktree 路径保持原值。`HOME` 沿用当前用户；XDG、PATH、TMPDIR、HISTFILE 和时区仅设置在入口及其子进程，不修改全局 Shell 配置。真实 pane 的 `HERDR_ENV=1` 与 workspace/tab/pane 身份由 Herdr 注入，入口不会伪造。

从 Bot 根目录使用：

```bash
# 查看本项目的 server
./scripts/startup/herdr.sh status server

# 打开本项目的交互界面
./scripts/startup/herdr.sh

# 查看本项目 workspace
./scripts/startup/herdr.sh workspace list
```

本项目实例尚未运行时，可用 `./scripts/startup/herdr.sh server` 在前台启动无界面的 server。该命令本身不负责脱离终端或退出重试；当前 server 已运行，`bot-runtime` 中保留一个专用 Shell pane，`herdr-test` workspace 恢复原 Codex 会话。前台 run 核对 Shell 的真实前台进程后启动监督程序，不把 Shell 命令发送给 Agent。

本次将项目 server 从 0.8.2 正常停止后升级到 0.9.3，继续使用同一个 `bot` session 与原布局。原生状态检查显示 endpoint 与 private protocol 均兼容，当前 private protocol 为 22。真实 pane 内使用现有 execution/herdr.py 验证查询与错误处理，未修改后台实现。

test 的正式执行绑定已切换到 Bot 的 0.9.3 实例。旧 bot-herdr 中该项目的空闲 Codex 正常退出，新版以相同 CODEX_HOME resume 原 UUID；旧 server 和其他项目不动。前台使用已有任务文件 CLI 和 Joye Skill，Windows TG 入口现同时启动 execution/service.py，管理本项目 Herdr 和登记的原会话。

0.9.3 自带 Codex 检测规则缺少 idle 规则，已原样缓存 [官方 2026.10.01.1 规则](https://github.com/herdrdev/herdr/blob/07e3840bfb41f433cb7f14b4f93e2ff3fbaac6d7/src/detect/manifests/codex.toml) 到 `.pi/agent/background/herdr/agent-detection/remote/codex.toml`，并用 `./scripts/startup/herdr.sh server reload-agent-manifests` 加载。该文件为官方数据，未自定义状态；自动更新保持关闭。

Herdr 已通过 telegram.mjs 接入既有 Windows/WSL 常驻入口：service.py 启动本地 server、核对原 pane 和 UUID 后恢复 Codex；watchdog 处理 result/outbox，主 Pi 独立验收后主动通知。服务异常退出由 Node 退避重启，服务 flock 防重复。当前实现验证记录见 re.md；不以代码接入代替真实重启与消息证据。真实前后台联测的范围、失败和结果见 test.md；模拟 TG 入站/发送端口不能冒充 Telegram 网络投递。

入口设置 `TZ=Asia/Shanghai`，项目验收记录使用带 `+08:00` 的北京时间。Herdr 原生 server 日志仍输出 UTC（`Z`），保留原始格式，不能把它解释为北京时间。实际环境、子进程继承和保护检查见 [0.9.3 升级验收结果](../../.pi/agent/background/verification/herdr-environment/2026-10-05T23-36-19.001+08-00/result.json)；详细记录见 [test.md](../../test.md)。版本固定为已验收的 0.9.3，仍关闭自动更新；后续升级按用户明确要求执行。

## 8. 后台服务日志与边界

后台实现集中 `.pi/extensions/background/execution/service.py`，通知集中 `background/notifications/`；未增加 Windows 任务或全局服务。TG/Pi 退出时结束本入口的 service，Herdr 原 server 和 Coding Agent 保留。下次启动仍核对原 UUID，不创建替代会话。

`.pi/agent/background/service-pid.json` 记录 PID、内核 start_ticks 与 boot_id；墙上时间不用于判定进程身份。`logs/service.jsonl` 记录北京时间启动、恢复和错误；`recovery/PROJECT.json` 保存真实恢复证据；`logs/relay.jsonl` 记录事件入队、验收及投递确认；`attention/` 留存未确认原因。手机接收不能从 API message_id 推断。详细实验和本次范围见 [re.md](../../re.md)。
