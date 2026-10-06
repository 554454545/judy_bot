# 后台登记表存储：锁和原子保存统一入口；projects/tasks 调用，不启动 Agent；参考 Joye task_protocol.py。
import contextlib
import copy
import fcntl
import json
import os
import re
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

DEFAULT_ROOT = Path(__file__).resolve().parents[3] / "agent/background"


def timestamp():
    return datetime.now(timezone(timedelta(hours=8))).isoformat(timespec="milliseconds")


def ident(value):
    # Joye ident 的范围：保留点号和 120 位上限，拒绝 . / .. 路径标识。
    if not isinstance(value, str) or value in (".", "..") or not re.fullmatch(r"[A-Za-z0-9_.-]{1,120}", value):
        raise ValueError("ID 仅允许 1—120 位英文、数字、点号、下划线或连字符，不能为 . 或 ..")
    return value


def required(value, field):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} 不能为空")
    return value.strip()


def atomic(path, content):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix=".write-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf8") as output:
            os.fchmod(output.fileno(), 0o600)
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


@contextlib.contextmanager
def transaction(root=DEFAULT_ROOT):
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(root / "registry.lock", os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        path = root / "registry.json"
        if path.exists():
            try:
                value = json.loads(path.read_text(encoding="utf8"))
            except (ValueError, OSError) as error:
                raise ValueError("登记表损坏或无法读取；停止操作，不覆盖原文件") from error
        else:
            value = {"version": 1, "revision": 0, "projects": {}, "tasks": {}}
        if (not isinstance(value, dict) or value.get("version") != 1 or
                not isinstance(value.get("projects"), dict) or
                not isinstance(value.get("tasks"), dict) or
                not isinstance(value.get("revision"), int)):
            raise ValueError("登记表结构不兼容；停止操作")
        before = copy.deepcopy(value)
        yield value
        if value != before:
            value["revision"] += 1
            atomic(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)
