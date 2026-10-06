#!/usr/bin/env bash
# 作用：直接打开 Bot 已登记 Codex 会话的原生 resume 界面；关联 execution/codex.py 和私有 codex-session-browser 索引。
set -euo pipefail

bot_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

exec env PYTHONDONTWRITEBYTECODE=1 python3 \
  "$bot_root/.pi/extensions/background/execution/codex.py" browse "$@"
