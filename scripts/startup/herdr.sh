#!/usr/bin/env bash
# Bot 专用 Herdr 入口：使用 tools/herdr/herdr 与项目私有配置，固定 bot session；关联本目录 README.md 和 .pi/agent/background/herdr/config.toml。
set -euo pipefail

bot_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
herdr_root="$bot_root/.pi/agent/background/herdr"
herdr_binary="$bot_root/tools/herdr/herdr"
herdr_socket="$herdr_root/sessions/bot/herdr.sock"

if [[ ! -x "$herdr_binary" ]]; then
  printf '%s\n' 'Bot 项目 Herdr 尚未安装：tools/herdr/herdr' >&2
  exit 1
fi

if [[ ! -f "$herdr_root/config.toml" ]]; then
  printf '%s\n' 'Bot 项目 Herdr 配置缺失：.pi/agent/background/herdr/config.toml' >&2
  exit 1
fi

umask 077
cd -- "$bot_root"

# 外部 Herdr 的 pane ID 不能作为本项目当前 pane；本实例内的真实身份可以继续使用。
if [[ "${HERDR_SOCKET_PATH:-}" != "$herdr_socket" ]]; then
  unset HERDR_WORKSPACE_ID HERDR_TAB_ID HERDR_PANE_ID
fi
unset HERDR_SOCKET_PATH HERDR_CLIENT_SOCKET_PATH

export HERDR_SESSION=bot
export HERDR_CONFIG_PATH="$herdr_root/config.toml"
export XDG_CONFIG_HOME="$bot_root/.pi/agent/background"
export XDG_STATE_HOME="$bot_root/.pi/agent/background"
export XDG_CACHE_HOME="$bot_root/.cache"
export XDG_RUNTIME_DIR="$herdr_root/runtime"
export TMPDIR="$bot_root/.cache/tmp"
export HISTFILE="$herdr_root/sessions/bot/bash_history"
export PATH="$bot_root/scripts/startup:$bot_root/tools/herdr:$PATH"
export TZ=Asia/Shanghai

mkdir -p -- "$XDG_RUNTIME_DIR" "$XDG_CACHE_HOME" "$TMPDIR"

# 不设置或清除 HERDR_ENV；真实 pane 的 HERDR_ENV=1 由 Herdr 自己注入。
exec "$herdr_binary" --session bot "$@"
