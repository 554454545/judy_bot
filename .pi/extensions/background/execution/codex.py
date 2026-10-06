# Codex 项目适配：只读本项目 Pi 认证，隔离 Codex 配置与历史；herdr.py 调用，依据实际会话记录取执行证据。
import argparse
import base64
import fcntl
import json
import os
import sqlite3
import sys
import time
import tomllib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from execution.settings import agent_options
from storage.registry import atomic, required


def credential(path, account=None):
    path = Path(path)
    if path.stat().st_mode & 0o077:
        raise ValueError("项目认证文件必须为私有权限")
    entry = json.loads(path.read_text())["openai-codex"]
    token = entry["access"]
    payload = json.loads(base64.urlsafe_b64decode(token.split(".")[1] + "===").decode())
    identifier = payload["https://api.openai.com/auth"]["chatgpt_account_id"]
    if identifier != entry["accountId"] or (account and identifier != account):
        raise ValueError("项目认证账号变化；停止使用旧会话配置")
    if min(entry["expires"] / 1000, payload["exp"]) <= time.time() + 60:
        raise ValueError("项目认证已过期或即将过期；不自动刷新或读取全局认证")
    return token, identifier


def options(settings):
    # 默认值从 coding-agents-default-setting/codex.json 读取；明确指定的参数优先。
    settings = agent_options("codex", settings)
    for field in ("model", "reasoningEffort", "serviceTier"):
        settings[field] = required(settings.get(field), field)
    return settings


def prepare(settings, worktree):
    settings = options(settings)
    home = Path(settings["home"]).resolve()
    project_root = Path(__file__).resolve().parents[4]
    if not home.is_relative_to(project_root) or not Path(settings["authFile"]).resolve().is_relative_to(project_root):
        raise ValueError("Codex 新配置和认证来源必须留在本项目内")
    home.mkdir(parents=True, exist_ok=True, mode=0o700)
    _, account = credential(settings["authFile"])
    q = lambda value: json.dumps(str(value), ensure_ascii=False)
    lines = [
        "# 项目内 Codex 配置；由 execution/codex.py 管理，不含认证令牌。",
        f"model = {q(settings['model'])}",
        f"model_reasoning_effort = {q(settings['reasoningEffort'])}",
        f"service_tier = {q(settings['serviceTier'])}",
        'model_provider = "project_pi_codex"',
        'cli_auth_credentials_store = "file"',
        "check_for_update_on_startup = false",
        "",
        "[features]",
        "fast_mode = true",
        "",
        "[model_providers.project_pi_codex]",
        'name = "Project Pi Codex"',
        f"base_url = {q(settings['baseUrl'])}",
        'wire_api = "responses"',
        "request_max_retries = 2",
        "stream_max_retries = 1",
        f"http_headers = {{ \"ChatGPT-Account-ID\" = {q(account)} }}",
        "",
        "[model_providers.project_pi_codex.auth]",
        f"command = {q(sys.executable)}",
        "args = " + json.dumps([
            str(Path(__file__).resolve()), "token", "--file", settings["authFile"],
            "--account", account,
        ], ensure_ascii=False),
        "timeout_ms = 5000",
        "refresh_interval_ms = 300000",
        "",
        f"[projects.{q(worktree)}]",
        'trust_level = "trusted"',
        "",
    ]
    content = "\n".join(lines)
    config = home / "config.toml"
    if config.exists():
        existing = tomllib.loads(config.read_text())
        expected = tomllib.loads(content)

        def matches(actual, desired):
            for key, value in desired.items():
                if key not in actual:
                    return False
                if isinstance(value, dict):
                    if not isinstance(actual[key], dict) or not matches(actual[key], value):
                        return False
                elif key == "command":
                    if Path(actual[key]).resolve() != Path(value).resolve():
                        return False
                elif actual[key] != value:
                    return False
            return True

        # Codex 会保存自己的 tui 设置；核对受本项目管理的键，保留这些原生设置。
        if not matches(existing, expected):
            raise ValueError("已有项目 Codex 配置与本次参数不同；不覆盖")
    if not config.exists():
        atomic(config, content)
    return {
        "CODEX_HOME": str(home),
        "XDG_CACHE_HOME": str(home / "cache"),
        "TMPDIR": str(home / "tmp"),
    }


def sessions(home, worktree):
    result = []
    for path in (Path(home) / "sessions").rglob("*.jsonl"):
        try:
            with path.open() as stream:
                record = json.loads(next(stream))
            metadata = record.get("payload", {})
            if record.get("type") == "session_meta" and Path(metadata.get("cwd", "")).resolve() == Path(worktree).resolve():
                result.append({
                    "id": metadata["id"],
                    "path": str(path),
                    "metadata": metadata,
                })
        except (OSError, ValueError, StopIteration, KeyError):
            continue
    return result


def check_writer_lock(home, session_id):
    # 沿用 Codex 原生写锁，只检查占用，不删除锁、不终止持锁进程。
    path = Path(home) / "thread-writer-locks" / f"{session_id}.lock"
    if not path.exists():
        return
    with path.open("r+") as stream:
        try:
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ValueError("原 Codex 会话仍被客户端占用；先正常退出旧客户端，保留同一 session") from error
        finally:
            fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def messages(session_file):
    result = []
    with Path(session_file).open() as stream:
        for line in stream:
            record = json.loads(line)
            payload = record.get("payload", {})
            if record.get("type") == "response_item" and payload.get("type") == "message":
                content = payload.get("content", [])
                text = "\n".join(part.get("text", "") for part in content if isinstance(part, dict))
                result.append({
                    "role": payload.get("role"),
                    "phase": payload.get("phase"),
                    "text": text,
                    "timestamp": record.get("timestamp"),
                    "turn_id": payload.get("internal_chat_message_metadata_passthrough", {}).get("turn_id"),
                })
    return result


def title(home, session_id):
    database = Path(home) / "state_5.sqlite"
    if not database.exists():
        return None
    with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as connection:
        row = connection.execute("SELECT name FROM threads WHERE id = ?", (session_id,)).fetchone()
    return row[0] if row else None


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=["token"])
    parser.add_argument("--file", required=True)
    parser.add_argument("--account", required=True)
    args = parser.parse_args()
    try:
        token, _ = credential(args.file, args.account)
        # 仅 Codex 的 command-backed auth 子进程读取此 stdout；不要在诊断工具中直接运行 token 命令。
        print(token)
    except (OSError, ValueError, KeyError, TypeError):
        print("PROJECT_CODEX_AUTH_UNAVAILABLE", file=sys.stderr)
        sys.exit(1)
