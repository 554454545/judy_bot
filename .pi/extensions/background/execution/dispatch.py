# 前后台交接：task_protocol.py 的 run 通过项目 Herdr 真实 Shell 启动 runner.py；异步返回收据，result 只返回摘要与证据路径。
import copy
import json
import shlex
import subprocess
import sys
from pathlib import Path

from execution import runner
from storage.registry import ident, timestamp, transaction


def control(settings, *arguments):
    # 前台只是文件协议调用方；真正的监督程序由 Herdr pane 启动并继承真实 HERDR_ENV。
    command = [settings["herdrPath"], "--session", settings["herdrSession"], *arguments]
    process = subprocess.run(command, capture_output=True, text=True, timeout=15)
    if arguments[:2] == ("pane", "run") and process.returncode == 0 and not process.stdout.strip():
        # 0.9.3 的 pane run 成功不打印 JSON；保存真实 CLI 退出证据，不伪造原生 API 响应。
        return {
            "source": "herdr_cli_exit_status",
            "cli_exit_code": process.returncode,
            "stdout": process.stdout,
            "stderr": process.stderr,
        }
    try:
        result = json.loads(process.stdout or process.stderr)
    except ValueError as error:
        raise ValueError("Herdr 未返回可核对的 JSON；不盲目重发") from error
    if process.returncode != 0 or "error" in result:
        raise ValueError("Herdr 派发失败；保留本次 run 供查询和对账")
    return result


def launch(root, task_id, run_id, timeout=600):
    if type(timeout) is not int or timeout <= 0:
        raise ValueError("执行超时必须为正整数秒")
    tid = ident(task_id)
    rid = ident(run_id)
    with transaction(root) as registry:
        task = registry["tasks"].get(tid)
        if not task or task.get("run_id") != rid or task["status"] != "starting":
            raise ValueError("只有当前 starting run 可以派发")
        run = task["runs"][rid]
        if run.get("dispatch_requested") or run.get("runner_started"):
            raise ValueError("本次 run 已有派发意图；先查询对账，不重复发送")
        project = registry["projects"][task["projectId"]]
        if project.get("activeExecution") != {"task_id": tid, "run_id": rid}:
            raise ValueError("项目执行身份不同；停止派发")
        settings = copy.deepcopy(project["executionSettings"])

    workspaces = control(settings, "workspace", "list")["result"]["workspaces"]
    label = settings.get("runtimeWorkspace", "bot-runtime")
    runtime = [item for item in workspaces if item.get("label") == label]
    if len(runtime) != 1:
        raise ValueError("Herdr 执行 Shell workspace 不唯一或未启动；不猜 pane")
    panes = control(settings, "pane", "list", "--workspace", runtime[0]["workspace_id"])["result"]["panes"]
    if len(panes) != 1:
        raise ValueError("Herdr 执行 workspace 必须只有一个专用 Shell pane")
    pane = panes[0]
    agents = control(settings, "agent", "list")["result"]["agents"]
    if any(item["pane_id"] == pane["pane_id"] for item in agents):
        raise ValueError("执行 Shell 已被 Agent 占用；不向其发送 Shell 命令")
    process_info = control(settings, "pane", "process-info", "--pane", pane["pane_id"])["result"]["process_info"]
    foreground = process_info.get("foreground_processes", [])
    shell_pid = process_info.get("shell_pid")
    if not shell_pid or process_info.get("foreground_process_group_id") != shell_pid or len(foreground) != 1 or foreground[0].get("pid") != shell_pid:
        raise ValueError("执行 pane 的 Shell 不在前台；不把命令发送给未知进程")
    root = Path(root).resolve()
    run_directory = root / "runs" / tid / rid
    command = shlex.join([
        "nohup",
        sys.executable,
        str(Path(__file__).with_name("runner.py").resolve()),
        "--root", str(root),
        "execute", tid, rid,
        "--timeout", str(timeout),
    ])
    command += " > " + shlex.quote(str(run_directory / "dispatch.log")) + " 2>&1 < /dev/null &"
    with transaction(root) as registry:
        task = registry["tasks"][tid]
        run = task["runs"][rid]
        if task.get("run_id") != rid or task["status"] != "starting" or run.get("dispatch_requested"):
            raise ValueError("run 已变化或已申请派发；不重复发送")
        run["dispatch_requested"] = timestamp()
        run["dispatch_pane"] = pane["pane_id"]
        run["dispatch_shell_pid"] = shell_pid
        run["dispatch_command_hash"] = runner.digest(command.encode())
    try:
        receipt = control(settings, "pane", "run", pane["pane_id"], command)
    except (ValueError, subprocess.SubprocessError) as error:
        with transaction(root) as registry:
            registry["tasks"][tid]["runs"][rid]["dispatch_error"] = type(error).__name__
        raise
    runner.atomic_json(run_directory / "dispatch-receipt.json", receipt, immutable=True)
    return {
        "task_id": tid,
        "run_id": rid,
        "state": "starting",
        "receipt_path": str(run_directory / "dispatch-receipt.json"),
        "note": "Herdr 已接受监督程序启动命令；实际执行与业务完成以 result 为准",
    }


def result(root, task_id, run_id):
    tid = ident(task_id)
    rid = ident(run_id)
    with transaction(root) as registry:
        task = copy.deepcopy(registry["tasks"].get(tid))
    if not task or rid not in task.get("runs", {}):
        raise ValueError("task/run 尚未登记")
    run = task["runs"][rid]
    path = run.get("result_path")
    evidence = runner.read(path) if path else None
    business_path = Path(root) / "runs" / tid / rid / "business.json"
    business = runner.read(business_path, {}) if evidence else {}
    summary = str(business.get("summary", ""))[:1200]
    return {
        "task_id": tid,
        "run_id": rid,
        "status": task["status"] if task.get("run_id") == rid else "historical",
        "summary": summary,
        "reason": evidence.get("reason") if evidence else None,
        "error": evidence.get("error") if evidence else run.get("dispatch_error"),
        "result_path": path,
        "business_path": str(business_path) if evidence else None,
        "herdr_evidence": evidence.get("herdr_evidence") if evidence else None,
        "verification": task.get("verification") if task.get("verification", {}).get("run_id") == rid else None,
    }
