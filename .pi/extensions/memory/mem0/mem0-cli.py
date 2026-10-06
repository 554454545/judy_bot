#!/usr/bin/env python3
# mem0 记忆读写 CLI：供记忆扩展调用；Joye 参考版本，通过项目 .mem0/venv/bin/python 调用，配置和数据位于项目 .mem0/。
"""mem0 CLI：add / search / list / task-add / task-check 统一入口（供 pi 扩展 child_process 调用）

用法:
  mem0-cli.py add "内容"
  mem0-cli.py search "查询" [N]
  mem0-cli.py list
"""
import os
import fcntl
from datetime import datetime, timezone, timedelta
import json
from pathlib import Path
import sys
# 支持 CLI 直接运行和测试通过 runpy 加载。
sys.path.insert(0, str(Path(__file__).resolve().parent))
from observability import instrument

PROJECT_ROOT = Path(__file__).resolve().parents[4]
CONFIG_PATH = PROJECT_ROOT / ".mem0" / "config" / "config.json"
DEFAULT_USER = "judy"

def get_memory():
    os.environ["MEM0_DIR"] = str(PROJECT_ROOT / ".mem0")
    os.environ["MEM0_TELEMETRY"] = "false"
    from mem0 import Memory
    cfg = json.loads(CONFIG_PATH.read_text())
    for container, key in [(cfg["vector_store"]["config"], "path"), (cfg, "history_db_path")]:
        value = Path(container[key])
        if not value.is_absolute():
            container[key] = str(PROJECT_ROOT / value)
    return instrument(Memory.from_config(config_dict=cfg))

def receipt_file(task_id):
    if not task_id or len(task_id) != 64 or any(ch not in "0123456789abcdef" for ch in task_id):
        raise ValueError("Invalid memory task ID")
    return PROJECT_ROOT / ".pi/agent/memory/receipts" / (task_id + ".json")


def save_receipt(path, receipt):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    receipt["updatedAt"] = datetime.now(timezone(timedelta(hours=8))).isoformat()
    temp = path.with_suffix(".tmp")
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as output:
        json.dump(receipt, output, ensure_ascii=False)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temp, path)


def check_task(task_id):
    path = receipt_file(task_id)
    if not path.exists():
        return {"status": "safe_retry", "ids": []}
    receipt = json.loads(path.read_text())
    if receipt["status"] in ("completed", "safe_retry", "blocked"):
        return receipt
    # 存在未完成的写入意图时，只查本地 metadata；发现部分条目也不证明整个 add 已完成。
    memory = get_memory()
    found = memory.get_all(filters={"user_id": DEFAULT_USER, "bot_memory_task_id": task_id}, top_k=100)
    return {"status": "unknown", "ids": [], "matches": [item["id"] for item in found.get("results", [])]}


def add_task(task_id, content, session_id, source_message):
    path = receipt_file(task_id)
    if path.exists():
        existing = json.loads(path.read_text())
        if existing["status"] != "safe_retry":
            return check_task(task_id)
    try:
        memory = get_memory()
    except Exception as error:
        kind = type(error).__name__
        receipt = {"status": "blocked" if kind in ("ValueError", "FileNotFoundError", "AuthenticationError", "PermissionDeniedError") else "safe_retry", "ids": [], "errorType": kind}
        save_receipt(path, receipt)
        return receipt
    save_receipt(path, {"status": "writing", "ids": []})
    try:
        result = memory.add(content, user_id=DEFAULT_USER, metadata={
            "bot_memory_task_id": task_id,
            "bot_source_session_id": session_id,
            "bot_source_message_id": source_message,
        })
        receipt = {"status": "completed", "ids": [item.get("id") for item in result.get("results", []) if item.get("id")], "result": result}
        save_receipt(path, receipt)
        return receipt
    except Exception as error:
        receipt = {"status": "unknown", "ids": [], "errorType": type(error).__name__}
        save_receipt(path, receipt)
        return receipt


def main():
    cmd = sys.argv[1]
    if cmd == "task-add":
        print(json.dumps(add_task(*sys.argv[2:6]), ensure_ascii=False))
    elif cmd == "task-check":
        print(json.dumps(check_task(sys.argv[2]), ensure_ascii=False))
    elif cmd == "add":
        content = sys.argv[2]
        m = get_memory()
        res = m.add(content, user_id=DEFAULT_USER)
        ids = [r.get("id", "")[:8] for r in res.get("results", [])]
        print(f"OK {ids}")
    elif cmd == "search":
        query = sys.argv[2]
        limit = int(sys.argv[3]) if len(sys.argv) > 3 else 5
        m = get_memory()
        res = m.search(query, filters={"user_id": DEFAULT_USER}, limit=limit)
        items = res.get("results", [])[:limit]
        if not items:
            print("（无相关记忆）")
            return
        for it in items:
            ts = it.get("created_at") or ""
            if ts:
                # ISO 时间戳 → 本地日期（YYYY-MM-DD），召回时展示新旧
                ts = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
                if ts.tzinfo is None:
                    ts = ts.replace(tzinfo=timezone.utc)
                ts = ts.astimezone(timezone(timedelta(hours=8))).date().isoformat()
            print(f"[{it.get('id','')[:8]}] (score={it.get('score',0):.2f}, date={ts}) {it.get('memory','')}")
    elif cmd == "list":
        m = get_memory()
        res = m.get_all(filters={"user_id": DEFAULT_USER}, top_k=100)
        items = res.get("results", [])
        if not items:
            print("（无记忆）")
            return
        for it in items:
            print(f"[{it.get('id','')[:8]}] {it.get('memory','')}")
    else:
        print("unknown command", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    with (PROJECT_ROOT / ".mem0" / "cli.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        main()
