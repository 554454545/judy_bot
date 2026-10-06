#!/usr/bin/env bash
# 作用：打开 test 的项目级 Codex 会话列表；关联：.pi/agent/background/codex/test/ 中的配置与会话。
set -euo pipefail

BOT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

exec env CODEX_HOME="$BOT_ROOT/.pi/agent/background/codex/test" \
  codex resume --all --no-daemon
