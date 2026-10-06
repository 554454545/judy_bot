# 后台执行协议：复用 Joye task/run、runner、结果及验收逻辑；task_protocol.py 接入前台，经 herdr.py 真实执行。
import argparse
import copy
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from execution import herdr
from storage.registry import atomic, ident, timestamp, transaction
from worktrees.check import check, git


def digest(value):
    # Joye task_protocol.py 同一算法。
    return hashlib.sha256(value if isinstance(value, bytes) else json.dumps(value, sort_keys=True).encode()).hexdigest()


def read(path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except FileNotFoundError:
        return copy.deepcopy(default)


def atomic_json(path, value, immutable=False):
    # Joye 的 immutable os.link：相同结果幂等，冲突结果拒绝覆盖。
    path = Path(path)
    content = json.dumps(value, ensure_ascii=False, indent=2) + "\n"
    if not immutable:
        atomic(path, content)
        return
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix=".write-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as output:
            os.fchmod(output.fileno(), 0o600)
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        try:
            os.link(temporary, path)
        except FileExistsError:
            if read(path) != value:
                raise ValueError("不可变结果冲突；不覆盖")
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        os.unlink(temporary)


def summary(path):
    # Joye 的 size/mtime/hash 证据；缺失文件不会成为成功产物。
    path = Path(path)
    try:
        data = path.read_bytes()
        return {
            "path": str(path),
            "size": len(data),
            "mtime_ns": path.stat().st_mtime_ns,
            "sha256": digest(data),
        }
    except (OSError, ValueError):
        return {
            "path": str(path),
            "error": "unreadable",
        }


def pid_identity(pid):
    if not pid:
        return None
    try:
        # WSL/NTP 校时会改变 ps 推算的 lstart，不能把墙上时钟当作 PID 出生身份。
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        boot_id = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
        return {
            "pid": pid,
            "start_ticks": int(fields[19]),
            "boot_id": boot_id,
        }
    except (OSError, ValueError, IndexError):
        return None


def worktree_snapshot(directory):
    process = subprocess.run(
        ["git", "--no-optional-locks", "-C", directory, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        capture_output=True, check=True,
    )
    values = {}
    for raw in set(process.stdout.split(b"\0")) - {b""}:
        relative = os.fsdecode(raw)
        path = Path(directory) / relative
        if path.is_symlink():
            values[relative] = {"symlink": os.readlink(path)}
        elif path.is_file():
            values[relative] = {"sha256": digest(path.read_bytes())}
    return values


def result_status(result):
    # Joye 原规则：退出码、marker、新产物、reason 均须成立，才 ready_for_review。
    if result.get("exit_code_source") == "process_launch_exception" and result.get("error"):
        return "blocked"
    if result.get("exit_code") is None:
        return "needs_reconciliation"
    if result["exit_code"] != 0 or result.get("error"):
        return "blocked"
    if result.get("reason") in ("read_error", "http_error", "error", "time_budget", "page_budget", "budget_exhausted"):
        return "blocked"
    if not result.get("marker", {}).get("seen") or not result.get("pid_identity"):
        return "needs_reconciliation"
    artifacts = result.get("artifacts", [])
    if not artifacts or not all(item.get("fresh") and item.get("size", 0) > 0 and item.get("sha256") for item in artifacts):
        return "needs_reconciliation"
    if result.get("reason") == "batch_finished":
        return "batch_finished"
    return "ready_for_review" if result.get("reason") == "goal_complete" else "needs_reconciliation"


def emit(registry, task, phase):
    # Joye 的稳定身份与绑定围栏：同阶段重新进入时，不复用旧通知。
    event_id = digest([task["taskId"], task["run_id"], phase])
    stamp = {
        "binding": {key: copy.deepcopy(task.get(key)) for key in ("route", "type", "agent_name", "workspace_id", "pane_id")},
        "status_since": task.get("status_changed_at"),
    }
    old = registry.get("outbox", {}).get(event_id)
    if old and any(old.get(key) != value for key, value in stamp.items()):
        event_id = digest([task["taskId"], task["run_id"], phase + ":" + digest(stamp)[:16]])
    registry.setdefault("outbox", {}).setdefault(event_id, {
        "event_id": event_id,
        "task_id": task["taskId"],
        "run_id": task["run_id"],
        "phase": phase,
        "result_path": task["runs"][task["run_id"]].get("result_path"),
        "created_at": timestamp(),
        "route": copy.deepcopy(task.get("route", {"profile": "personal"})),
        **stamp,
        "visibility": "internal",
        "targets": {
            "agent": {
                "state": "pending",
                "attempts": 0,
                "next_at": 0,
            },
            "telegram": {
                "state": "internal",
                "reason": "internal_control",
            },
        },
    })
    return event_id


def start_run(root, spec_path, prompt_path, run_id):
    # 原生 Agent cwd 是 worktree；结果文件必须在交接前固定绝对位置，不能带调用方相对 root。
    root = Path(root).resolve()
    spec_bytes = Path(spec_path).read_bytes()
    prompt_bytes = Path(prompt_path).read_bytes()
    spec = json.loads(spec_bytes)
    project = spec["project"]
    task = spec["task"]
    tid = ident(task["taskId"])
    rid = ident(run_id)
    if task["projectId"] != project["projectId"] or not task.get("instruction") or not task.get("acceptance"):
        raise ValueError("交接稿身份、需求或验收标准缺失")
    directory = Path(project["worktreePath"])
    for field in ("scope", "artifacts"):
        if not isinstance(task.get(field), list) or not task[field]:
            raise ValueError("交接稿范围和产物不能为空")
        for relative in task[field]:
            path = Path(relative)
            if path.is_absolute() or ".." in path.parts or relative == "." or not (directory / path).resolve().is_relative_to(directory):
                raise ValueError("交接稿路径越出 worktree")
    preflight = check(project)
    if preflight["blockers"]:
        raise ValueError("；".join(preflight["blockers"]))
    marker = "DONE_" + digest([tid, rid])[:24].upper()
    run_directory = Path(root) / "runs" / tid / rid
    with transaction(root) as registry:
        bound = registry["projects"].get(project["projectId"])
        if not bound or not (bound.get("herdr") or {}).get("agent_name"):
            raise ValueError("项目尚未真实绑定 Herdr Agent")
        for field in ("sourcePath", "worktreePath", "branch", "agentKind"):
            if bound[field] != project[field]:
                raise ValueError("交接稿与真实项目绑定不同")
        if bound.get("activeExecution"):
            raise ValueError("该项目已有执行或待验收任务；保持串行，不重复派发")
        previous = registry["tasks"].get(tid)
        if previous and previous["status"] not in ("registered", "rework"):
            raise ValueError("任务已存在；不重复派发或覆盖历史结果")
        if previous and previous["status"] == "registered":
            # 连接前台已经登记的任务，原话、修订和交接绑定必须保持原值。
            if previous.get("specHash") != digest(spec_bytes) or previous.get("promptHash") != digest(prompt_bytes):
                raise ValueError("交接稿与登记 hash 不一致；重新准备，不派发旧稿")
            for field in ("taskId", "projectId", "originalRequest", "instruction", "scope", "acceptance", "artifacts"):
                if task.get(field) != previous.get(field):
                    raise ValueError("交接稿与已登记任务不同；不改写原话或需求")
            clarifications = list(previous.get("clarificationRequests", []))
            clarifications.extend(item["request"] for item in previous.get("revisions", []))
            if task.get("clarifications", []) != clarifications:
                raise ValueError("交接稿遗漏需求补充；停止派发")
        if previous and (rid in previous.get("runs", {}) or previous.get("iterations", 0) > 2):
            raise ValueError("run 已存在或返工次数耗尽")
        if run_directory.exists():
            raise ValueError("run 目录已存在；保留现场，不重复执行")
        snapshot = worktree_snapshot(project["worktreePath"])
        run_directory.mkdir(parents=True, mode=0o700)
        atomic(run_directory / "handoff-spec.json", spec_bytes.decode())
        atomic(run_directory / "handoff-prompt.md", prompt_bytes.decode())
        dispatch_prompt = (prompt_bytes.decode() + "\n" + "\n".join([
            "## 本次真实执行协议",
            "以上交接稿现在进入已授权执行阶段。只在指定 worktree 和允许范围内工作，保留已有改动。",
            "不提交、不推送、不合并、不安装全局依赖，不修改其他项目。",
            f"task_id = {tid}",
            f"run_id = {rid}",
            f"业务结果文件 = {run_directory / 'business.json'}",
            "此结果文件是允许范围以外唯一额外授权写入的文件。完成真实工作后，用 Python 写 UTF-8 JSON。",
            "必须包含 task_id、run_id、reason、error、summary、checks。",
            "达到目标用 reason=goal_complete，失败用 read_error/http_error/error 等真实原因；error 为 null 或错误说明。",
            "checks 记录实际执行的检查与结果。不要编造成功，不能完成也要写出结果。",
            "代码测试使用 PYTHONDONTWRITEBYTECODE=1，避免生成无关缓存。",
            f"最终回复末尾独立一行输出 {marker}。这是本次回复标记；失败仍如实报告原因。",
            "",
        ])).rstrip("\n")
        atomic(run_directory / "dispatch-prompt.md", dispatch_prompt)
        if previous:
            value = previous
            value.setdefault("iterations", 0)
            value.setdefault("runs", {})
        else:
            value = copy.deepcopy(task)
            value.update({
                "status": "registered",
                "iterations": 0,
                "runs": {},
            })
            registry["tasks"][tid] = value
        value["run_id"] = rid
        source = value.get("originalRequest", {}).get("telegram")
        value.setdefault("route", {"profile": "personal"})
        if source:
            value["route"]["target"] = {key: source[key] for key in ("chatId", "threadId") if key in source}
        value.update({
            "type": "herdr",
            "agent_name": bound["herdr"]["agent_name"],
            "workspace_id": bound["herdr"]["workspace_id"],
            "pane_id": bound["herdr"]["pane_id"],
        })
        for key in ("verification", "report", "report_intent", "user_request", "attention_required"):
            value.pop(key, None)
        value["status"] = "starting"
        value["status_changed_at"] = timestamp()
        value["runs"][rid] = {
            "run_id": rid,
            "started_at": timestamp(),
            "started_monotonic_ns": str(time.monotonic_ns()),
            "started_epoch": time.time(),
            "baseline": [summary(run_directory / "business.json")],
            "worktree_baseline": snapshot,
            "head_baseline": git(project["worktreePath"], "rev-parse", "HEAD"),
            "branch": project["branch"],
            "marker": marker,
            "spec_hash": digest(spec_bytes),
            "prompt_hash": digest(prompt_bytes),
            "dispatch_hash": digest(dispatch_prompt.encode()),
        }
        bound["activeExecution"] = {
            "task_id": tid,
            "run_id": rid,
        }
    return tid, rid


def commit_result(root, tid, rid, result):
    with transaction(root) as registry:
        task = registry["tasks"][tid]
        run = task["runs"][rid]
        if result["task_id"] != tid or result["run_id"] != rid or result["started_at"] != run["started_at"]:
            raise ValueError("执行结果身份不匹配")
        path = Path(root) / "runs" / tid / rid / "result.json"
        atomic_json(path, result, immutable=True)
        run["result_path"] = str(path)
        if task["run_id"] == rid and task["status"] not in ("verified", "reported", "cancelled", "rework"):
            task["status"] = result_status(result)
            task["status_changed_at"] = timestamp()
            emit(registry, task, task["status"])
    return str(path)


def run_command(root, tid, rid, timeout):
    command = [sys.executable, str(Path(__file__).with_name("herdr.py")), "--root", str(root), "--timeout", str(timeout)]
    with transaction(root) as registry:
        task = registry["tasks"][tid]
        run = task["runs"][rid]
        if task["run_id"] != rid or task["status"] != "starting" or run.get("runner_started"):
            raise ValueError("run 已开始；不重复启动")
        run["runner_started"] = timestamp()
        run["runner_started_monotonic_ns"] = str(time.monotonic_ns())
        run["runner_pid_identity"] = pid_identity(os.getpid())
        run["timeout_seconds"] = timeout
        run["command_hash"] = digest(command)
        snapshot = copy.deepcopy(task)
    run = snapshot["runs"][rid]
    business_path = Path(root) / "runs" / tid / rid / "business.json"
    environment = {
        **os.environ,
        "TASK_ID": tid,
        "TASK_RUN_ID": rid,
        "TASK_RESULT_PATH": str(business_path),
    }
    try:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=environment, umask=0o077)
    except OSError as error:
        atomic(business_path.parent / "runner.stderr", f"{type(error).__name__}: {error}\n")
        return commit_result(root, tid, rid, {
            "task_id": tid,
            "run_id": rid,
            "started_at": run["started_at"],
            "finished_at": timestamp(),
            "finished_monotonic_ns": str(time.monotonic_ns()),
            "pid_identity": None,
            "exit_code": None,
            "exit_code_source": "process_launch_exception",
            "marker": {"seen": False},
            "artifacts": [],
            "reason": "launch_error",
            "error": type(error).__name__,
        })
    identity = pid_identity(process.pid)
    with transaction(root) as registry:
        registry["tasks"][tid]["runs"][rid]["pid_identity"] = identity
        registry["tasks"][tid]["status"] = "running"
        registry["tasks"][tid]["status_changed_at"] = timestamp()
    output, error_output = process.communicate()
    atomic(business_path.parent / "runner.stdout", output.decode(errors="replace"))
    atomic(business_path.parent / "runner.stderr", error_output.decode(errors="replace"))
    try:
        business = read(business_path, {})
    except (ValueError, OSError):
        business = {"error": "invalid_business_result"}
    if not isinstance(business, dict):
        business = {"error": "invalid_business_result"}
    if business.get("task_id") != tid or business.get("run_id") != rid:
        business = {"error": "missing_or_mismatched_business_result"}
    artifacts = []
    for before in run["baseline"]:
        after = summary(before["path"])
        after["fresh"] = bool(
            after.get("size", 0) > 0
            and after.get("mtime_ns", 0) >= int(run["started_epoch"] * 1e9)
            and after.get("sha256") != before.get("sha256")
        )
        artifacts.append(after)
    result = {
        "task_id": tid,
        "run_id": rid,
        "started_at": run["started_at"],
        "finished_at": timestamp(),
        "finished_monotonic_ns": str(time.monotonic_ns()),
        "pid_identity": identity,
        "exit_code": process.returncode,
        "exit_code_source": "herdr_supervisor_process_wait",
        "marker": {
            "expected": run["marker"],
            "seen": run["marker"] in output.decode(errors="replace").splitlines(),
            "source": "runner_stdout_exact_line",
        },
        "artifacts": artifacts,
        "reason": business.get("reason", "unknown"),
        "error": business.get("error") or ("supervisor_exit_nonzero" if process.returncode != 0 else None),
        "stdout_hash": digest(output),
        "stderr_hash": digest(error_output),
        "herdr_evidence": str(business_path.parent / "herdr-evidence.json"),
    }
    supervision = read(result["herdr_evidence"], {})
    if (
        supervision.get("task_id") == tid
        and supervision.get("run_id") == rid
        and supervision.get("prompt_result", {}).get("cli_exit_code") != 0
        and supervision.get("prompt_result", {}).get("error", {}).get("code") == "timeout"
    ):
        # 只接受本 run 的真实 Herdr timeout 返回；不从时长或缺失业务文件猜测超时。
        result["reason"] = "time_budget"
        result["error"] = f"Herdr 等待预算 {timeout}s 已用尽；Coding Agent 尚未确认停止"
    return commit_result(root, tid, rid, result)


def verify(root, tid, rid, evidence_path, reject=False):
    proof = summary(evidence_path)
    evidence = read(evidence_path)
    if proof.get("size", 0) <= 0 or not isinstance(evidence, dict) or evidence.get("task_id") != tid or evidence.get("run_id") != rid:
        raise ValueError("必须提供匹配本次 task/run 的真实验收证据")
    with transaction(root) as registry:
        task = registry["tasks"][tid]
        if task["run_id"] != rid or task["status"] != "ready_for_review":
            raise ValueError("只有当前 ready_for_review run 可以验收")
        result = read(task["runs"][rid]["result_path"])
        if result_status(result) != "ready_for_review":
            raise ValueError("执行证据变化；停止验收")
        if not reject and (evidence.get("passed") is not True or not evidence.get("checks")):
            raise ValueError("验收未通过或缺少实际检查")
        task["verification"] = {
            "run_id": rid,
            "evidence": proof,
            "result_hash": digest(result),
            "at": timestamp(),
            "monotonic_ns": str(time.monotonic_ns()),
            "ok": not reject,
        }
        task["runs"][rid]["verification"] = copy.deepcopy(task["verification"])
        if reject:
            task["iterations"] = task.get("iterations", 0) + 1
            task["status"] = "rework" if task["iterations"] <= 2 else "blocked"
        else:
            task["status"] = "verified"
        task["status_changed_at"] = timestamp()
        project = registry["projects"][task["projectId"]]
        expected_identity = {
            "task_id": tid,
            "run_id": rid,
        }
        if project.get("activeExecution") == expected_identity:
            project.pop("activeExecution")
        emit(registry, task, task["status"])
        return copy.deepcopy(task["verification"])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True, type=Path, help="独立执行登记数据目录；当前不默认使用前台正式目录")
    sub = parser.add_subparsers(dest="operation", required=True)
    bind_parser = sub.add_parser("bind")
    bind_parser.add_argument("--project", required=True)
    bind_parser.add_argument("--settings", required=True)
    bind_parser.add_argument("--receipt")
    run_parser = sub.add_parser("run")
    run_parser.add_argument("--spec", required=True)
    run_parser.add_argument("--prompt", required=True)
    run_parser.add_argument("--run-id", required=True)
    run_parser.add_argument(
        "--timeout",
        type=int,
        default=1800,
        help="Coding Agent 等待预算（秒），默认 1800（30 分钟）；超时不代表 Agent 已停止",
    )
    execute_parser = sub.add_parser("execute")
    execute_parser.add_argument("task")
    execute_parser.add_argument("run")
    execute_parser.add_argument(
        "--timeout",
        type=int,
        default=1800,
        help="Coding Agent 等待预算（秒），默认 1800（30 分钟）；超时不代表 Agent 已停止",
    )
    verify_parser = sub.add_parser("verify")
    verify_parser.add_argument("task")
    verify_parser.add_argument("run")
    verify_parser.add_argument("--evidence", required=True)
    verify_parser.add_argument("--reject", action="store_true")
    sub.add_parser("inspect")
    args = parser.parse_args()
    root = args.root.resolve()
    if args.operation == "bind":
        try:
            result = herdr.bind(root, read(args.project), read(args.settings))
        except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
            if args.receipt:
                atomic_json(args.receipt, {
                    "state": "failed",
                    "error": type(error).__name__ + ": " + str(error),
                })
            raise
        if args.receipt:
            atomic_json(args.receipt, {
                "state": "ready",
                "projectId": result["project"]["projectId"],
                "reused": result["reused"],
            })
    elif args.operation == "run":
        tid, rid = start_run(root, args.spec, args.prompt, args.run_id)
        result = {
            "task_id": tid,
            "run_id": rid,
            "result_path": run_command(root, tid, rid, args.timeout),
        }
    elif args.operation == "verify":
        result = verify(root, ident(args.task), ident(args.run), args.evidence, args.reject)
    elif args.operation == "execute":
        result = {
            "task_id": ident(args.task),
            "run_id": ident(args.run),
            "result_path": run_command(root, ident(args.task), ident(args.run), args.timeout),
        }
    else:
        with transaction(root) as registry:
            result = copy.deepcopy(registry)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
