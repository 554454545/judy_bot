#!/usr/bin/env bash
set -euo pipefail

bot_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd -- "$bot_root"

umask 077
export PI_CODING_AGENT_DIR="$bot_root/.pi/agent"
export PI_CODING_AGENT_SESSION_DIR="$PI_CODING_AGENT_DIR/sessions"
export npm_config_cache="$bot_root/.cache/npm"
export TMPDIR="$bot_root/.cache/tmp"
export PI_OFFLINE=1
export PI_TELEMETRY=0

mkdir -p -- "$PI_CODING_AGENT_SESSION_DIR" "$npm_config_cache" "$TMPDIR"

# TG 精确观察点依赖已核对的本地源码；重新安装依赖后缺失补丁时明确停止，不显示假统计。
node "$bot_root/extensions/observability/telegram-turn/patch.mjs" --check >&2
# 中文粗体修复也须在启动前核对，防止重装桥接包后恢复错误渲染。
node "$bot_root/patches/telegram-rendering/patch.mjs" --check >&2

# --no-skills 只关闭自动扫描；下面逐个 --skill 显式启用当前流程实际需要的 Joye 本地副本。
exec "$bot_root/node_modules/.bin/pi" --approve \
  -e "$bot_root/extensions/telegram/index.ts" \
  -e "$bot_root/extensions/context/index.ts" \
  --no-skills \
  --skill "$bot_root/.pi/skills/joye/personal/skill-creator/SKILL.md" \
  --skill "$bot_root/.pi/skills/joye/personal/web-search/SKILL.md" \
  --skill "$bot_root/.pi/skills/joye/personal/herdr-workflow/SKILL.md" \
  --no-prompt-templates --no-themes --no-context-files \
  --append-system-prompt "$bot_root/AGENTS.md" "$@" \
  -e "$bot_root/extensions/observability/index.ts"
