# 项目后台常驻服务：监督本地 Herdr、恢复登记的原生会话并独立运行 Joye watchdog；由 scripts/startup/telegram.mjs 启动，不操作其他实例。
import argparse
import copy
import fcntl
import json
import os
import shlex
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from execution import codex, dispatch, herdr, runner
from storage.registry import DEFAULT_ROOT, atomic, timestamp, transaction

BOT = Path(__file__).resolve().parents[4]
SETTINGS = {
    "herdrPath": str(BOT / "scripts/startup/herdr.sh"),
    "herdrSession": "bot",
    "runtimeWorkspace": "bot-runtime",
}


def record(root, stage, **fields):
    file = Path(root) / "logs/service.jsonl"
    file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with file.open("a") as stream:
        os.chmod(file, 0o600)
        stream.write(json.dumps({"at": timestamp(), "stage": stage, **fields}, ensure_ascii=False) + "\n")


def ensure_server(root):
    try:
        return dispatch.control(SETTINGS, "workspace", "list")
    except (ValueError, OSError, subprocess.SubprocessError):
        file = Path(root) / "logs/herdr-server.log"
        file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with file.open("a") as log:
            os.chmod(file, 0o600)
            process = subprocess.Popen(
                [SETTINGS["herdrPath"], "--session", SETTINGS["herdrSession"], "server"],
                stdout=log,
                stderr=log,
                cwd=BOT,
                start_new_session=True,
            )
        record(root, "herdr_start_requested", pid=process.pid)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            try:
                value = dispatch.control(SETTINGS, "workspace", "list")
                record(root, "herdr_available")
                return value
            except (ValueError, OSError, subprocess.SubprocessError):
                if process.poll() is not None:
                    break
                time.sleep(0.25)
        raise ValueError("项目 Herdr 尚未可用；不接管其他 server")


def runtime_pane(root):
    workspaces = ensure_server(root)["result"]["workspaces"]
    matches = [item for item in workspaces if item.get("label") == SETTINGS["runtimeWorkspace"]]
    if len(matches) > 1:
        raise ValueError("执行 workspace 不唯一")
    if not matches:
        created = dispatch.control(SETTINGS, "workspace", "create", "--cwd", str(BOT), "--label", SETTINGS["runtimeWorkspace"], "--no-focus")
        matches = [created["result"]["workspace"]]
    panes = dispatch.control(SETTINGS, "pane", "list", "--workspace", matches[0]["workspace_id"])["result"]["panes"]
    if len(panes) != 1:
        raise ValueError("恢复 Shell 必须有唯一 pane")
    pane = panes[0]
    agents = dispatch.control(SETTINGS, "agent", "list")["result"]["agents"]
    if any(agent["pane_id"] == pane["pane_id"] for agent in agents):
        raise ValueError("恢复 Shell 被 Agent 占用")
    info = dispatch.control(SETTINGS, "pane", "process-info", "--pane", pane["pane_id"])["result"]["process_info"]
    foreground = info.get("foreground_processes", [])
    if info.get("foreground_process_group_id") != info.get("shell_pid") or len(foreground) != 1 or foreground[0]["pid"] != info.get("shell_pid"):
        raise ValueError("恢复 Shell 正在执行其他前台程序")
    return pane


def recover_project(root, project_id):
    if os.environ.get("HERDR_ENV") != "1":
        raise ValueError("恢复必须由真实 Herdr pane 执行")
    with transaction(root) as registry:
        project = copy.deepcopy(registry["projects"][project_id])
    settings = project["executionSettings"]
    binding = project["herdr"]
    agents = herdr.require(settings, "agent", "list")["result"]["agents"]
    native = codex.sessions(settings["agent"]["home"], project["worktreePath"])
    if len(native) != 1 or native[0]["id"] != project.get("sessionId"):
        raise ValueError("原会话丢失或不唯一；不创建替代 session")
    matches = [agent for agent in agents if agent.get("name") == binding["agent_name"]]
    if matches:
        current = herdr.agent(settings, binding)["result"]["agent"]
        if Path(current["cwd"]).resolve() != Path(project["worktreePath"]) or current["agent"] != project["agentKind"]:
            raise ValueError("已有 Agent 身份不同；不接管")
        return {"project_id": project_id, "state": "already_running", "session_id": project["sessionId"]}
    codex.check_writer_lock(settings["agent"]["home"], native[0]["id"])
    codex.prepare(settings["agent"], project["worktreePath"])
    pane_info = herdr.require(settings, "pane", "process-info", "--pane", binding["pane_id"])["result"]["process_info"]
    foreground = pane_info.get("foreground_processes", [])
    if pane_info.get("foreground_process_group_id") != pane_info.get("shell_pid") or len(foreground) != 1 or foreground[0]["pid"] != pane_info.get("shell_pid"):
        raise ValueError("原 pane 不是空闲 Shell；不发送恢复命令")
    # Herdr 的持久 workspace 保留启动环境；只在原 pane resume 原 UUID。
    resumed = herdr.require(settings, "agent", "start", binding["agent_name"], "--kind", project["agentKind"], "--pane", binding["pane_id"], "--timeout", "90000", "--",
        "resume", native[0]["id"], "--no-daemon", "--no-alt-screen", "--strict-config", "--dangerously-bypass-approvals-and-sandbox", timeout=100)
    current = herdr.agent(settings, binding)["result"]["agent"]
    with transaction(root) as registry:
        bound = registry["projects"][project_id]
        if bound["sessionId"] != native[0]["id"] or bound["herdr"] != binding:
            raise ValueError("恢复期间项目绑定变化")
        bound["herdr"]["lastRecovery"] = {
            "at": timestamp(),
            "session_id": native[0]["id"],
            "evidence_hash": runner.digest(resumed),
            "agent_status": current["agent_status"],
        }
    return {"project_id": project_id, "state": "resumed", "session_id": native[0]["id"], "agent": current}


def recover(root):
    directory = Path(root) / "recovery"
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    with transaction(root) as registry:
        projects = copy.deepcopy(registry["projects"])
    for project_id, project in projects.items():
        if not project.get("sessionId") or not project.get("executionSettings"):
            continue
        try:
            result = recover_project(root, project_id)
        except Exception as error:
            result = {"project_id": project_id, "state": "needs_reconciliation", "error": type(error).__name__}
        runner.atomic_json(directory / (project_id + ".json"), {"at": timestamp(), **result})
        if result["state"] != "already_running":
            record(root, "project_recovery", **result)


def serve(root):
    root = Path(root).resolve()
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = os.open(root / "service.lock", os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(lock)
        return 75
    stopping = threading.Event()
    for name in (signal.SIGTERM, signal.SIGINT):
        signal.signal(name, lambda *_: stopping.set())
    atomic(root / "service-pid.json", json.dumps({"identity": runner.pid_identity(os.getpid()), "at": timestamp()}) + "\n")
    record(root, "service_started", pid=os.getpid())
    parent_id = os.getppid()
    parent_identity = runner.pid_identity(parent_id)
    try:
        parent_is_launcher = str(BOT / "scripts/startup/telegram.mjs").encode() in Path(f"/proc/{parent_id}/cmdline").read_bytes().split(b"\0")
    except OSError:
        parent_is_launcher = False
    recovery_at = 0
    while not stopping.is_set():
        if parent_is_launcher and parent_identity != runner.pid_identity(parent_id):
            record(root, "launcher_exited", parent_pid=parent_id)
            break
        try:
            pane = runtime_pane(root)
            agents = dispatch.control(SETTINGS, "agent", "list")["result"]["agents"]
            with transaction(root) as registry:
                projects = copy.deepcopy(registry["projects"])
            missing = [project for project in projects.values() if project.get("sessionId") and project.get("herdr") and not any(agent.get("name") == project["herdr"]["agent_name"] for agent in agents)]
            if missing and time.monotonic() - recovery_at > 120:
                file = root / "logs/recovery.log"
                command = shlex.join(["nohup", sys.executable, str(Path(__file__).resolve()), "--root", str(root), "--recover"])
                command += " > " + shlex.quote(str(file)) + " 2>&1 < /dev/null &"
                dispatch.control(SETTINGS, "pane", "run", pane["pane_id"], command)
                recovery_at = time.monotonic()
                record(root, "recovery_requested", projects=[project["projectId"] for project in missing])
        except Exception as error:
            record(root, "runtime_error", type=type(error).__name__)
        # 即使 Herdr 查询失败，仍处理已经落盘的结果、事件和明确失败的通知重试。
        try:
            result = subprocess.run([sys.executable, str(BOT / ".pi/extensions/background/notifications/task-watchdog.py"), "--root", str(root)], capture_output=True, timeout=45)
            if result.returncode:
                record(root, "watchdog_error", code=result.returncode)
        except Exception as error:
            record(root, "watchdog_error", type=type(error).__name__)
        stopping.wait(5)
    record(root, "service_stopped", pid=os.getpid())
    os.close(lock)


if __name__ == "__main__":
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    parser.add_argument("--recover", action="store_true")
    args = parser.parse_args()
    if args.recover:
        recover(args.root)
    else:
        sys.exit(serve(args.root) or 0)
