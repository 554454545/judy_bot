# Herdr 执行适配：真实创建/核对项目 Agent，按文件派发和内置等待；runner.py 调用，Codex 细节交给 codex.py。
import copy
import argparse
import json
import os
import re
import subprocess
import time
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from execution import codex, settings as default_settings
from storage.registry import ident, timestamp, transaction
from worktrees.check import check


class HerdrError(ValueError):
    def __init__(self, operation, result):
        self.operation = operation
        self.result = result
        super().__init__(f"Herdr {operation} 失败：{result.get('error', {}).get('code', 'cli_error')}")


def command(settings, *args, timeout=15):
    if os.environ.get("HERDR_ENV") != "1":
        raise ValueError("必须在真实 Herdr 环境中执行，不伪造 HERDR_ENV")
    command_line = [settings["herdrPath"]]
    if settings.get("herdrSession"):
        command_line.extend(["--session", settings["herdrSession"]])
    command_line.extend(str(value) for value in args)
    process = subprocess.run(command_line, capture_output=True, text=True, timeout=timeout)
    try:
        data = json.loads(process.stdout or process.stderr)
    except ValueError:
        data = {"error": {"code": "invalid_cli_response"}}
    data["cli_exit_code"] = process.returncode
    return data


def require(settings, *args, timeout=15):
    data = command(settings, *args, timeout=timeout)
    if data["cli_exit_code"] != 0 or "error" in data:
        raise HerdrError(" ".join(str(arg) for arg in args[:2]), data)
    return data


def agent(settings, binding):
    data = require(settings, "agent", "get", binding["agent_name"])
    value = data["result"]["agent"]
    if value.get("name") != binding["agent_name"] or any(
        value.get(field) != binding[field]
        for field in ("workspace_id", "pane_id")
    ):
        raise ValueError("Herdr Agent 身份与项目绑定不同；停止派发")
    return data


def ready_agent(settings, project, wait_ms=0):
    observed_at = time.monotonic()
    data = agent(settings, project["herdr"])
    value = data["result"]["agent"]
    if value.get("agent") != project["agentKind"] or Path(value.get("cwd", "")).resolve() != Path(project["worktreePath"]).resolve():
        raise ValueError("Herdr Agent 类型或工作目录与项目不同；不接管")
    if value.get("agent_status") == "unknown" and wait_ms > 0:
        remaining_ms = wait_ms - int((time.monotonic() - observed_at) * 1000)
        if remaining_ms <= 0:
            raise ValueError("Herdr 启动等待预算已用尽；保留原绑定，不新建替代会话")
        # 启动检测可能先于状态识别；用 Herdr 原生有限等待，不重开 Agent。
        waited = require(
            settings, "agent", "wait", project["herdr"]["agent_name"],
            "--timeout", str(remaining_ms), timeout=remaining_ms / 1000 + 5,
        )
        # 等待结果不能代替身份检查；重新核对 name/pane/cwd 和实际状态。
        current = ready_agent(settings, project)
        current["startupWaitEvidence"] = waited
        return current
    if value.get("agent_status") not in ("idle", "done"):
        raise ValueError("Herdr Agent 尚未就绪：" + str(value.get("agent_status")) + "；保留原绑定，不新建替代会话")
    return data


def bind(root, project, settings):
    if os.environ.get("HERDR_ENV") != "1":
        raise ValueError("首次绑定必须由项目 Herdr 的真实 Shell 执行；前台使用 project-bind")
    project = copy.deepcopy(project)
    startup_timeout_ms = 90_000
    name = "herdr-" + project["projectId"]
    if not re.fullmatch(r"[a-z][a-z0-9_-]{0,31}", name):
        raise ValueError("herdr-项目名 不符合 Herdr 的名字限制；不自动改名")
    preflight = check(project)
    if preflight["blockers"]:
        raise ValueError("；".join(preflight["blockers"]))
    with transaction(root) as registry:
        old = registry["projects"].get(project["projectId"])
        # 新绑定用集中默认选择；复用时保留已登记的类型与启动参数。
        agent_kind = project.get("agentKind")
        if agent_kind is None:
            agent_kind = old["agentKind"] if old else default_settings.default_agent()
        project["agentKind"] = ident(agent_kind)
        # 当前只接入 Codex；选未接入的 Agent 会明确失败，不悄悄换回 Codex。
        if project["agentKind"] != "codex":
            raise ValueError("当前执行阶段仅验证 codex；其他 Agent 类型尚未接入")
        previous_settings = old.get("executionSettings") if old else None
        previous_agent = (previous_settings or {}).get("agent", {})
        agent_options = default_settings.runtime_options(project, {
            **previous_agent,
            **settings.get("agent", {}),
        })
        agent_options = codex.options(agent_options)
        settings = {
            **settings,
            "agent": agent_options,
        }
        if old:
            for field in ("sourcePath", "worktreePath", "branch", "agentKind"):
                if old[field] != project[field]:
                    raise ValueError("项目绑定变化；不自动改绑")
            if previous_settings is not None and previous_settings != settings:
                # 只补齐还没有 pane/session 的失败首次绑定；已有字段和真实绑定不能改写。
                incomplete = not all(previous_agent.get(key) for key in ("home", "binary", "authFile", "baseUrl"))
                compatible = all(settings.get(key) == value for key, value in previous_settings.items() if key != "agent")
                compatible = compatible and all(agent_options.get(key) == value for key, value in previous_agent.items())
                if old.get("herdr") or old.get("sessionId") or old.get("activeExecution") or not incomplete or not compatible:
                    raise ValueError("项目执行配置变化；不自动覆盖")
        else:
            old = copy.deepcopy(project)
        for other in registry["projects"].values():
            if other["projectId"] != project["projectId"] and (other.get("executionSettings") or {}).get("agent", {}).get("home") == agent_options["home"]:
                raise ValueError("不同项目不能共用 Coding Agent 运行目录或 session")
        old = copy.deepcopy(old)
    # 参数、认证和既有原生配置都检查成功后，才保存完整执行配置。
    environment = codex.prepare(settings["agent"], project["worktreePath"])
    with transaction(root) as registry:
        current = registry["projects"].get(project["projectId"])
        if current is not None and current != old:
            raise ValueError("配置校验期间项目绑定变化；停止绑定")
        if current is None:
            registry["projects"][project["projectId"]] = copy.deepcopy(old)
        registry["projects"][project["projectId"]]["executionSettings"] = settings
        old = copy.deepcopy(registry["projects"][project["projectId"]])
    binding = old.get("herdr")
    if binding and binding.get("agent_name"):
        current = ready_agent(settings, old, wait_ms=startup_timeout_ms)
        return {
            "project": old,
            "agent": current,
            "reused": True,
        }
    if binding:
        # 创建意图已保存，重启后继续同一 pane；不创建第二个 workspace。
        workspace = require(settings, "workspace", "get", binding["workspace_id"])
    else:
        existing = require(settings, "agent", "list")["result"]["agents"]
        if any(item.get("agent_name") == name or item.get("name") == name for item in existing):
            raise ValueError("已有同名 Agent，但没有本项目的绑定证据；不接管")
        known = codex.sessions(settings["agent"]["home"], project["worktreePath"])
        if len(known) > 1:
            raise ValueError("同一项目存在多个 Codex session；不猜测或新建会话")
        if old.get("sessionId") and (not known or known[0]["id"] != old["sessionId"]):
            raise ValueError("已登记的 Codex session 与本地记录不同；停止绑定")
        if known:
            codex.check_writer_lock(settings["agent"]["home"], known[0]["id"])
            if codex.title(settings["agent"]["home"], known[0]["id"]) != name:
                raise ValueError("已有 Codex 会话名与 herdr-项目名 不同；不自动改名")
            with transaction(root) as registry:
                bound = registry["projects"][project["projectId"]]
                bound["sessionId"] = known[0]["id"]
                bound["sessionFile"] = known[0]["path"]
        project_root = Path(__file__).resolve().parents[4]
        environment["PATH"] = os.pathsep.join([
            str(project_root / "scripts/startup"),
            str(project_root / "tools/herdr"),
            str(Path(settings["agent"]["binary"]).parent),
            os.environ["PATH"],
        ])
        Path(environment["TMPDIR"]).mkdir(parents=True, exist_ok=True, mode=0o700)
        arguments = ["workspace", "create", "--cwd", project["worktreePath"], "--label", name, "--no-focus"]
        for key, value in environment.items():
            arguments.extend(["--env", key + "=" + value])
        workspace = require(settings, *arguments)
        binding = {
            "workspace_id": workspace["result"]["workspace"]["workspace_id"],
            "pane_id": workspace["result"]["root_pane"]["pane_id"],
            "session_name": name,
            "createdAt": timestamp(),
        }
        with transaction(root) as registry:
            registry["projects"][project["projectId"]]["herdr"] = binding
    known = codex.sessions(settings["agent"]["home"], project["worktreePath"])
    resume_arguments = codex.launch_arguments(settings["agent"], known[0]["id"] if len(known) == 1 else None)
    if len(known) > 1:
        raise ValueError("同一项目存在多个 Codex session；不新建替代会话")
    if known:
        codex.check_writer_lock(settings["agent"]["home"], known[0]["id"])
    startup_deadline = time.monotonic() + startup_timeout_ms / 1000
    started = command(
        settings, "agent", "start", name, "--kind", project["agentKind"], "--pane", binding["pane_id"],
        "--timeout", str(startup_timeout_ms), "--", *resume_arguments, timeout=100,
    )
    # blocked / unknown 的真实启动证据也留下；由操作者检查，不猜测已就绪。
    with transaction(root) as registry:
        bound = registry["projects"][project["projectId"]]
        bound["herdr"]["agent_name"] = name
        bound["herdr"]["startEvidence"] = started
    if started["cli_exit_code"] != 0:
        raise HerdrError("agent start", started)
    with transaction(root) as registry:
        bound = copy.deepcopy(registry["projects"][project["projectId"]])
    remaining_ms = max(0, int((startup_deadline - time.monotonic()) * 1000))
    return {
        "project": bound,
        "agent": ready_agent(settings, bound, wait_ms=remaining_ms),
        "reused": False,
    }


def native_session(root, project_id):
    with transaction(root) as registry:
        project = copy.deepcopy(registry["projects"][project_id])
    matches = codex.sessions(project["executionSettings"]["agent"]["home"], project["worktreePath"])
    if len(matches) != 1:
        raise ValueError("无法唯一核对真实 Codex session；不猜测或创建替代 session")
    observed = matches[0]
    if project.get("sessionId") not in (None, observed["id"]):
        raise ValueError("Codex 原生 session 与绑定不同")
    with transaction(root) as registry:
        bound = registry["projects"][project_id]
        if bound.get("sessionId") not in (None, observed["id"]):
            raise ValueError("项目 Codex session 变化；停止执行")
        bound["sessionId"] = observed["id"]
        bound["sessionFile"] = observed["path"]
    return observed


def within_scope(relative, scope):
    # **/* 表示当前 worktree 全部路径；其他条目保留原有文件/目录语义，不扩展到项目外。
    path = Path(relative)
    if path.is_absolute() or ".." in path.parts or path == Path("."):
        return False
    value = path.as_posix()
    return any(
        entry == "**/*"
        or value == Path(entry).as_posix()
        or value.startswith(Path(entry).as_posix().rstrip("/") + "/")
        for entry in scope
    )


def supervise(root, timeout):
    # 被 Joye 风格 runner 当作真实子进程运行；退出码是本次监督进程的退出码，不是长期 Codex 的退出码。
    from execution.runner import atomic_json, digest, read, worktree_snapshot
    tid = os.environ["TASK_ID"]
    rid = os.environ["TASK_RUN_ID"]
    directory = Path(os.environ["TASK_RESULT_PATH"]).parent
    with transaction(root) as registry:
        task = copy.deepcopy(registry["tasks"][tid])
        project = copy.deepcopy(registry["projects"][task["projectId"]])
    expected_identity = {
        "task_id": tid,
        "run_id": rid,
    }
    if task["run_id"] != rid or project.get("activeExecution") != expected_identity:
        raise ValueError("任务执行身份变化")
    settings = project["executionSettings"]
    binding = project["herdr"]
    before = agent(settings, binding)
    current = before["result"]["agent"]
    if current["agent"] != project["agentKind"] or Path(current["cwd"]).resolve() != Path(project["worktreePath"]):
        raise ValueError("实际 Agent 类型或目录与项目绑定不同")
    if current["agent_status"] not in ("idle", "done") or not current.get("interactive_ready"):
        raise ValueError("实际 Agent 未就绪；不发送新任务")
    known = codex.sessions(settings["agent"]["home"], project["worktreePath"])
    native = native_session(root, task["projectId"]) if known else None
    if not native and project.get("sessionId"):
        raise ValueError("绑定的 Codex 会话记录消失；保留现场")
    if native and codex.title(settings["agent"]["home"], native["id"]) != binding["session_name"]:
        raise ValueError("Codex 原生会话名不符合 herdr-项目名；先核对命名")
    prompt = (directory / "dispatch-prompt.md").read_text()
    if digest(prompt.encode()) != task["runs"][rid]["dispatch_hash"]:
        raise ValueError("派发文件已变化；停止执行")
    previous_messages = codex.messages(native["path"]) if native else []
    previous_settings = codex.turn_settings(native["path"]) if native else []
    from execution.health import worker_processes
    process_baseline = worker_processes(project)
    with transaction(root) as registry:
        current = registry["tasks"][tid]
        if current.get("run_id") != rid or registry["projects"][task["projectId"]].get("activeExecution") != {"task_id": tid, "run_id": rid}:
            raise ValueError("进程基线采集期间任务占用变化；不派发")
        current["runs"][rid]["worker_process_baseline"] = process_baseline
    intent = {
        "task_id": tid,
        "run_id": rid,
        "session_id": native["id"] if native else None,
        "binding": binding,
        "prompt_hash": digest(prompt.encode()),
        "message_count_before": len(previous_messages),
        "created_at": timestamp(),
        "worker_process_baseline": process_baseline,
    }
    atomic_json(directory / "dispatch-intent.json", intent, immutable=True)
    dispatch_started = time.monotonic_ns()
    result = command(settings, "agent", "prompt", binding["agent_name"], prompt, "--wait", "--timeout", str(timeout * 1000), timeout=timeout + 15)
    dispatch_finished = time.monotonic_ns()
    after = agent(settings, binding)
    transcript = subprocess.run(
        [settings["herdrPath"], "--session", settings["herdrSession"], "agent", "read", binding["agent_name"], "--source", "recent-unwrapped", "--lines", "160"],
        capture_output=True, text=True, timeout=15,
    )
    from storage.registry import atomic
    atomic(directory / "herdr-transcript.txt", transcript.stdout)
    native_after = native_session(root, task["projectId"])
    if native and native_after["id"] != native["id"]:
        raise ValueError("任务执行期间 session 被替换")
    if not native:
        rename = codex.set_title(settings["agent"], project["worktreePath"], native_after["id"], binding["session_name"])
        atomic_json(directory / "session-rename.json", rename, immutable=True)
    native = native_after
    actual_settings = codex.turn_settings(native["path"])[len(previous_settings):]
    messages = codex.messages(native["path"])[len(previous_messages):]
    inputs = [index for index, item in enumerate(messages) if item["role"] == "user" and item["text"] == prompt]
    assistant = []
    if len(inputs) == 1:
        assistant = [item for item in messages[inputs[0] + 1:] if item["role"] == "assistant" and item["phase"] == "final_answer"]
    final = assistant[-1] if assistant else None
    baseline = task["runs"][rid]["worktree_baseline"]
    snapshot = worktree_snapshot(project["worktreePath"])
    changed = sorted(path for path in set(baseline) | set(snapshot) if baseline.get(path) != snapshot.get(path))
    outside = [path for path in changed if not within_scope(path, task["scope"])]
    evidence = {
        "task_id": tid,
        "run_id": rid,
        "runtime_context": {
            "herdr_env": os.environ.get("HERDR_ENV"),
            "session": os.environ.get("HERDR_SESSION"),
            "pane_id": os.environ.get("HERDR_PANE_ID"),
        },
        "session_id": native["id"],
        "session_name": codex.title(settings["agent"]["home"], native["id"]),
        "session_file": native["path"],
        "before": before,
        "prompt_result": result,
        "after": after,
        "native_input_count": len(inputs),
        "native_model_settings": actual_settings,
        "native_final_message": final,
        "changed_paths": changed,
        "outside_scope": outside,
        "observed_at": timestamp(),
        "dispatch_started_monotonic_ns": str(dispatch_started),
        "dispatch_finished_monotonic_ns": str(dispatch_finished),
    }
    atomic_json(directory / "herdr-evidence.json", evidence, immutable=True)
    if result["cli_exit_code"] != 0 or after["result"]["agent"]["agent_status"] not in ("idle", "done"):
        raise ValueError("Herdr 没有确认本次等待正常结束；保留现场，不重发")
    if len(inputs) != 1 or not final or task["runs"][rid]["marker"] not in final["text"].splitlines():
        raise ValueError("缺少本次真实输入或最终 assistant 回复标记；不使用 prompt 回显")
    if evidence["session_name"] != binding["session_name"]:
        raise ValueError("实际 Codex 会话名与项目约定不同")
    if not actual_settings or any(item["model"] != settings["agent"]["model"] or item["effort"] != settings["agent"]["reasoningEffort"] for item in actual_settings):
        raise ValueError("本次 Codex 原生调用参数与项目登记不同；保留真实参数证据")
    business = read(directory / "business.json", {})
    if business.get("task_id") != tid or business.get("run_id") != rid:
        raise ValueError("业务结果缺失或身份不匹配")
    if outside:
        raise ValueError("Agent 修改了本次允许范围以外的文件")
    # 从实际 final_answer 取出独立 marker，进入监督进程的 stdout；保留原始来源证据。
    print(task["runs"][rid]["marker"])


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--timeout", type=int, required=True)
    args = parser.parse_args()
    try:
        supervise(args.root, args.timeout)
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
