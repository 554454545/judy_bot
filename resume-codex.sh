#!/usr/bin/env bash
# 作用：汇总 Bot 已登记及历史 Codex 会话，选择后恢复；关联 background/registry.json、项目 Codex home 和 execution/codex.py。
set -euo pipefail

bot_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

exec python3 - "$bot_root" "$@" <<'PY'
import json
import os
import sqlite3
import sys
from pathlib import Path

sys.dont_write_bytecode = True
bot_root = Path(sys.argv[1])
arguments = sys.argv[2:]
if arguments not in ([], ["--list"], ["--help"]):
    raise SystemExit("用法：./resume-codex.sh [--list]")
if arguments == ["--help"]:
    print("./resume-codex.sh：列出 Bot 全部 Codex 会话，输入编号恢复。")
    print("./resume-codex.sh --list：只查看，不打开客户端。")
    raise SystemExit(0)

sys.path.insert(0, str(bot_root / ".pi/extensions/background"))
from execution import codex, settings

background = bot_root / ".pi/agent/background"
registry_file = background / "registry.json"
registry = json.loads(registry_file.read_text()) if registry_file.exists() else {"projects": {}}
homes = {}
for project in registry["projects"].values():
    if project.get("agentKind") != "codex":
        continue
    saved = (project.get("executionSettings") or {}).get("agent", {})
    home = Path(saved["home"]) if saved.get("home") else Path(settings.runtime_options(project, {})["home"])
    home = home.resolve()
    if not home.is_relative_to(bot_root):
        raise SystemExit("已登记 Codex home 不在 Bot 内：" + str(home))
    if home in homes:
        raise SystemExit("多个项目共用 Codex home，先核对登记：" + str(home))
    homes[home] = project

# 历史会话即使不再登记也显示；只扫描 Bot 后台数据，不查询全局 Codex。
for filename in background.rglob("rollout-*.jsonl"):
    for parent in filename.parents:
        if parent.name in ("sessions", "archived_sessions"):
            home = parent.parent.resolve()
            if home.is_relative_to(bot_root):
                homes.setdefault(home, None)
            break

items = []
for home, project in sorted(homes.items(), key=lambda pair: pair[1]["projectId"] if pair[1] else str(pair[0])):
    seen = set()
    for folder in (home / "sessions", home / "archived_sessions"):
        for filename in sorted(folder.rglob("rollout-*.jsonl")):
            try:
                with filename.open() as stream:
                    record = json.loads(next(stream))
                if record.get("type") != "session_meta":
                    continue
                metadata = record["payload"]
                session_id = metadata["id"]
                cwd = metadata["cwd"]
            except (OSError, ValueError, StopIteration, KeyError):
                items.append({
                    "project": project["projectId"] if project else "历史项目：" + home.name,
                    "home": home,
                    "id": None,
                    "name": filename.name,
                    "state": "会话记录暂不可读取",
                })
                continue
            if session_id in seen:
                continue
            seen.add(session_id)
            try:
                name = codex.title(home, session_id) or "未命名"
            except sqlite3.Error:
                name = "名称暂不可读取"
            try:
                codex.check_writer_lock(home, session_id)
                state = "可恢复"
            except ValueError:
                state = "客户端占用"
            items.append({
                "project": project["projectId"] if project else "历史项目：" + home.name,
                "home": home,
                "id": session_id,
                "name": name,
                "cwd": cwd,
                "binary": (project.get("executionSettings") or {}).get("agent", {}).get("binary", "codex") if project else "codex",
                "state": state,
            })
    if project and project.get("sessionId") and project["sessionId"] not in seen:
        items.append({
            "project": project["projectId"],
            "home": home,
            "id": None,
            "name": project["sessionId"],
            "state": "登记会话文件缺失，不能恢复",
        })
    elif project and not seen:
        items.append({
            "project": project["projectId"],
            "home": home,
            "id": None,
            "name": "尚无原生会话",
            "state": "已登记",
        })

print("Bot Codex 会话（所有已登记项目及历史会话）")
for number, item in enumerate(items, 1):
    print(f"{number}. {item['project']} · {item['name']} · {item['state']}")
    if item["id"]:
        print("   session：" + item["id"])
    print("   home：" + str(item["home"]))
if arguments == ["--list"] or not items:
    raise SystemExit(0)

# Python 源码通过 heredoc 传入，选择和原生 TUI 的输入必须恢复到真实终端。
try:
    terminal = open("/dev/tty", "r")
except OSError:
    raise SystemExit("需要终端选择会话；只查看请使用 --list。")
try:
    with terminal:
        while True:
            print("输入编号恢复，q 退出：", end="", flush=True)
            selected = terminal.readline().strip()
            if selected.lower() == "q" or not selected:
                break
            if not selected.isdecimal() or not 1 <= int(selected) <= len(items):
                print("编号无效。")
                continue
            item = items[int(selected) - 1]
            if not item["id"]:
                print(item["state"] + "；没有可恢复的原生会话，不新建。")
                continue
            try:
                codex.check_writer_lock(item["home"], item["id"])
            except ValueError:
                print("原客户端仍持有会话，请先正常退出它再恢复；不会强行接管。")
                continue
            os.chdir(item["cwd"])
            os.dup2(terminal.fileno(), 0)
            environment = dict(os.environ)
            environment["CODEX_HOME"] = str(item["home"])
            for variable, folder in (("XDG_CACHE_HOME", "cache"), ("TMPDIR", "tmp")):
                directory = item["home"] / folder
                directory.mkdir(parents=True, exist_ok=True, mode=0o700)
                environment[variable] = str(directory)
            binary = item["binary"]
            os.execvpe(binary, [binary, "resume", item["id"], "--all", "--no-daemon"], environment)
except KeyboardInterrupt:
    raise SystemExit(130)
PY
