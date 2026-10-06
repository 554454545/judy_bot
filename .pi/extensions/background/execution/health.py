# 后台健康与取消恢复：适配 Joye probe/reconcile 的真实 PID、结果及状态围栏；关联 runner.py、task-watchdog.py 和 task_protocol.py。
import copy
import ctypes
import os
import platform
import signal
import time
from pathlib import Path

from execution import codex, dispatch, runner
from notifications.task_protocol import TERMINAL, epoch, handled_failure
from storage.registry import timestamp, transaction


def live(identity):
    if not identity or runner.pid_identity(identity.get("pid")) != identity:
        return False
    try:
        # 僵尸进程已停止，不因 ps 仍保留 PID 而无限等待。
        return Path(f"/proc/{identity['pid']}/stat").read_text().rsplit(")", 1)[1].split()[0] != "Z"
    except FileNotFoundError:
        return False


def inspect_agent(project):
    response = dispatch.control(project["executionSettings"], "agent", "get", project["herdr"]["agent_name"])
    agent = response.get("result", {}).get("agent", {})
    binding = project["herdr"]
    if any(agent.get(key) != binding[key] for key in ("workspace_id", "pane_id")):
        raise ValueError("Agent 与登记的 workspace/pane 不同")
    if agent.get("agent") != project["agentKind"] or Path(agent.get("cwd", "")).resolve() != Path(project["worktreePath"]):
        raise ValueError("Agent 类型或工作目录不同")
    matches = codex.sessions(project["executionSettings"]["agent"]["home"], project["worktreePath"])
    if len(matches) != 1 or matches[0]["id"] != project.get("sessionId"):
        raise ValueError("原生会话与项目登记不同")
    return agent, matches[0]


def process_table():
    """只记录内核身份、父子关系和进程组，不记录命令正文或进程环境中的凭据。"""
    boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    result = {}
    for directory in Path("/proc").iterdir():
        if not directory.name.isdigit():
            continue
        try:
            fields = (directory / "stat").read_text().rsplit(")", 1)[1].split()
            pid = int(directory.name)
            result[pid] = {
                "identity": {
                    "pid": pid,
                    "start_ticks": int(fields[19]),
                    "boot_id": boot,
                },
                "parent_pid": int(fields[1]),
                "process_group": int(fields[2]),
                "session": int(fields[3]),
                "state": fields[0],
            }
        except (OSError, ValueError, IndexError):
            continue
    return result


def descendants(identity, table):
    anchor = table.get(identity["pid"])
    if not anchor or anchor["identity"] != identity:
        raise ValueError("Coding Agent 内核进程身份变化；不接管替代客户端")
    found = []
    for pid, item in table.items():
        if item["state"] == "Z" or pid == identity["pid"]:
            continue
        current = item["parent_pid"]
        visited = set()
        while current in table and current not in visited:
            if current == identity["pid"]:
                leader = table.get(item["process_group"])
                found.append({
                    **item,
                    "group_leader": leader["identity"] if leader else None,
                })
                break
            visited.add(current)
            current = table[current]["parent_pid"]
    return sorted(found, key=lambda item: item["identity"]["pid"])


def worker_processes(project):
    response = dispatch.control(project["executionSettings"], "pane", "process-info", "--pane", project["herdr"]["pane_id"])
    actual = response["result"]["process_info"]
    foreground = actual.get("foreground_processes", [])
    if len(foreground) != 1 or foreground[0]["pid"] == actual.get("shell_pid"):
        raise ValueError("Coding Agent 前台进程不唯一；不猜测子进程归属")
    identity = runner.pid_identity(foreground[0]["pid"])
    if not identity or Path(f"/proc/{identity['pid']}/cwd").resolve() != Path(project["worktreePath"]).resolve():
        raise ValueError("Coding Agent 实际进程目录不同")
    table = process_table()
    children = descendants(identity, table)
    internal = codex.internal_processes(identity, children) if project.get("agentKind") == "codex" else []
    if runner.pid_identity(identity["pid"]) != identity:
        raise ValueError("采集期间 Coding Agent 进程被替换")
    return {
        "agent": identity,
        "children": children,
        "internal_processes": internal,
        "at": timestamp(),
    }


def run_commands(project, baseline):
    if not isinstance(baseline, dict) or not baseline.get("agent"):
        raise ValueError("本 run 缺少真实派发前子进程基线；保留占用，不盲目清理")
    current = worker_processes(project)
    if current["agent"] != baseline["agent"]:
        raise ValueError("原 Coding Agent 进程已变化；不清理新客户端的命令")
    previous = {(item["process_group"], item["session"]) for item in baseline["children"]}
    previous_identities = {runner.digest(item["identity"]) for item in baseline["children"]}
    internal = current.get("internal_processes", [])
    internal_identities = {runner.digest(item["identity"]) for item in internal}
    internal_groups = {(item["process_group"], item["session"]) for item in internal}
    commands = []
    for item in current["children"]:
        if runner.digest(item["identity"]) in internal_identities:
            continue
        group = (item["process_group"], item["session"])
        # 常驻 host 已在基线里时，同组新业务后代仍须检查；不能把整棵子树当内部进程忽略。
        if (
            group not in previous
            or (group in internal_groups and runner.digest(item["identity"]) not in previous_identities)
        ):
            commands.append(item)
    return commands


def signal_identity(identity, kind):
    # 当前 x86_64 Python/libc 没有 pidfd_open 包装；使用本机 Linux 头文件核对过的 syscall 434。
    if platform.machine() != "x86_64":
        raise ValueError("未核对此架构的 pidfd syscall；保留现场，不降级成 PID 盲杀")
    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long
    descriptor = libc.syscall(ctypes.c_long(434), ctypes.c_long(identity["pid"]), ctypes.c_long(0))
    if descriptor < 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))
    try:
        if runner.pid_identity(identity["pid"]) != identity:
            raise ValueError("发送取消信号前 PID 身份变化")
        signal.pidfd_send_signal(descriptor, kind)
    finally:
        os.close(descriptor)


def stop_commands(project, baseline, observed):
    """只清理本 run 新增的独立命令进程组；保留原 Agent 和派发前已有服务。"""
    groups = {}
    anchor = process_table().get(baseline["agent"]["pid"])
    if not anchor or anchor["identity"] != baseline["agent"]:
        raise ValueError("清理前原 Agent 身份变化；停止清理")
    current = worker_processes(project)
    if current["agent"] != baseline["agent"]:
        raise ValueError("清理前原 Coding Agent 进程已变化")
    protected = {(item["process_group"], item["session"]) for item in current.get("internal_processes", [])}
    for item in observed + run_commands(project, baseline):
        if item["process_group"] == anchor["process_group"]:
            raise ValueError("新增子进程与 Agent 共用进程组；保留现场，不自动扩大清理")
        if (item["process_group"], item["session"]) in protected:
            raise ValueError("业务命令与 Codex 内部进程共用进程组；保留现场，不终止内部 host")
        groups[(item["process_group"], item["session"])] = item.get("group_leader")
    actions = []

    def remaining():
        table = process_table()
        for (group, _session), identity in groups.items():
            leader = table.get(group)
            if leader and identity and leader["identity"] != identity:
                raise ValueError("命令进程组编号已复用；不发送信号")
        return [item for item in table.values() if item["state"] != "Z" and (item["process_group"], item["session"]) in groups]

    def terminate(items, kind):
        for item in items:
            identity = item["identity"]
            if not live(identity):
                continue
            try:
                signal_identity(identity, kind)
                actions.append({
                    "identity": identity,
                    "signal": kind.name,
                })
            except ProcessLookupError:
                continue

    terminate(remaining(), signal.SIGTERM)
    deadline = time.monotonic() + 5
    while remaining() and time.monotonic() < deadline:
        terminate(remaining(), signal.SIGTERM)
        time.sleep(.1)
    if remaining():
        terminate(remaining(), signal.SIGKILL)
    deadline = time.monotonic() + 5
    while remaining() and time.monotonic() < deadline:
        time.sleep(.1)
    if remaining() or run_commands(project, baseline):
        raise ValueError("本 run 的命令子进程尚未全部退出；保留占用")
    return {
        "baseline_hash": runner.digest(baseline),
        "observed": observed,
        "actions": actions,
        "remaining": [],
    }


def probe(root, task, project, now):
    run = task.get("runs", {}).get(task.get("run_id"))
    if not run:
        return {"observed": "not_started"}
    directory = Path(root) / "runs" / task["taskId"] / task["run_id"]
    path = Path(run.get("result_path") or directory / "result.json")
    if path.parent.resolve() != directory.resolve():
        return {"observed": "result_identity_mismatch"}
    if path.name == "late-result.json" and runner.summary(path) != run.get("late_result"):
        return {"observed": "result_identity_mismatch"}
    try:
        result = runner.read(path)
    except (OSError, ValueError):
        return {"observed": "result_unreadable"}
    if result is not None:
        if not isinstance(result, dict) or any(result.get(key) != value for key, value in {
            "task_id": task["taskId"],
            "run_id": task["run_id"],
            "started_at": run["started_at"],
        }.items()):
            return {"observed": "result_identity_mismatch"}
        return {"observed": "result", "result": result, "result_path": str(path)}
    # 监督进程和实际等待进程的出生身份同时核对；PID 复用不算仍在执行。
    if live(run.get("runner_pid_identity")) or live(run.get("pid_identity")):
        return {"observed": "running", "evidence": "runner_pid_birth"}
    if now - run["started_epoch"] < 120:
        return {"observed": "runner_starting"}
    try:
        agent, native = inspect_agent(project)
        status = agent.get("agent_status")
        observed = {
            "working": "running_unsupervised",
            "blocked": "herdr_blocked",
            "idle": "herdr_idle_unverified",
            "done": "herdr_done_unverified",
        }.get(status, "herdr_unknown")
        return {
            "observed": observed,
            "agent_status": status,
            "session_id": native["id"],
            "snapshot_hash": runner.digest(agent),
        }
    except Exception as error:
        return {"observed": "herdr_unavailable", "error": type(error).__name__}


def reconcile(root, now=None):
    now = time.time() if now is None else now
    with transaction(root) as registry:
        tasks = copy.deepcopy(registry["tasks"])
        projects = copy.deepcopy(registry["projects"])
    observations = []
    for task in tasks.values():
        # 显式 retry/update 后 registered 等待新 run；旧结果仅为历史，不能重新覆盖该准备状态。
        if task["status"] in TERMINAL or task["status"] == "registered" or not task.get("run_id"):
            continue
        observations.append((task, probe(root, task, projects[task["projectId"]], now)))
    for old, observation in observations:
        cleanup = None
        cleanup_observation = None
        late = None
        old_run = old["runs"][old["run_id"]]
        expected_execution = {
            "task_id": old["taskId"],
            "run_id": old["run_id"],
        }
        # 已持久化 cancel_intent 的 run 由取消流程收尾，watchdog 不能在 ESC 后抢先清空占用。
        if (
            not old_run.get("cancel_intent")
            and projects[old["projectId"]].get("activeExecution") == expected_execution
            and observation.get("result")
            and runner.result_status(observation["result"]) == "blocked"
            and not any(live(old_run.get(key)) for key in ("runner_pid_identity", "pid_identity"))
        ):
            step = "agent_identity"
            try:
                actual, native = inspect_agent(projects[old["projectId"]])
                step = "command_processes"
                children = run_commands(projects[old["projectId"]], old_run.get("worker_process_baseline"))
                if actual["agent_status"] in ("idle", "done") and not children:
                    if observation["result"].get("reason") == "time_budget":
                        from execution.late_result import collect
                        step = "late_completion"
                        late = collect(root, old, projects[old["projectId"]], actual, native)
                    if not late:
                        cleanup = {
                            "task_id": old["taskId"],
                            "run_id": old["run_id"],
                            "session_id": native["id"],
                            "result_hash": runner.digest(observation["result"]),
                            "agent_hash": runner.digest(actual),
                            "child_processes": children,
                            "process_baseline_hash": runner.digest(old_run["worker_process_baseline"]),
                            "at": timestamp(),
                        }
                else:
                    cleanup_observation = {
                        "reason": "commands_still_running" if children else "agent_not_idle",
                        "agent_status": actual["agent_status"],
                        "command_processes": children,
                        "at": timestamp(),
                    }
            except Exception as error:
                cleanup_observation = {
                    "reason": "inspection_failed",
                    "step": step,
                    "error_type": type(error).__name__,
                    "at": timestamp(),
                }
                if step == "late_completion":
                    cleanup_observation["detail"] = str(error)
        elif (
            observation.get("result")
            and runner.result_status(observation["result"]) == "blocked"
            and projects[old["projectId"]].get("activeExecution") == expected_execution
        ):
            cleanup_observation = {
                "reason": "cancellation_in_progress" if old_run.get("cancel_intent") else "supervisor_running",
                "at": timestamp(),
            }
        with transaction(root) as registry:
            task = registry["tasks"][old["taskId"]]
            project = registry["projects"][old["projectId"]]
            if runner.digest(task) != runner.digest(old) or runner.digest(project) != runner.digest(projects[old["projectId"]]):
                continue
            if late:
                # 登记锁内再核对：旧 run、取消或新项目占用不能被迟到结果覆盖。
                directory = Path(root) / "runs" / old["taskId"] / old["run_id"]
                if runner.worktree_snapshot(project["worktreePath"]) != late["snapshot"] or codex.messages(late["native"]["path"])[late["intent"]["message_count_before"]:] != late["messages"] or run_commands(project, old_run["worker_process_baseline"]):
                    continue
                evidence_path = directory / "late-herdr-evidence.json"
                result_path = directory / "late-result.json"
                stored = runner.read(evidence_path)
                if stored:
                    # 崩溃留下的不可变收集文件须重新验证关键证据，不能覆盖或盲目采纳。
                    keys = ("task_id", "run_id", "session_id", "original_result", "dispatch_intent", "native_final_message", "native_completion", "native_model_settings", "changed_paths", "worktree_snapshot_hash")
                    if any(stored.get(key) != late["evidence"].get(key) for key in keys):
                        continue
                    stored_result = runner.read(result_path)
                    if stored_result and stored_result.get("artifacts") != late["result"]["artifacts"]:
                        continue
                    if stored_result:
                        late["result"] = stored_result
                    late["evidence"] = stored
                runner.atomic_json(evidence_path, late["evidence"], immutable=True)
                runner.atomic_json(result_path, late["result"], immutable=True)
                task["runs"][old["run_id"]]["late_result"] = runner.summary(result_path)
                observation = {"observed": "late_result", "result": late["result"], "result_path": str(result_path)}
            task["last_checked"] = timestamp()
            task["observation"] = observation["observed"]
            task["observation_evidence"] = {key: value for key, value in observation.items() if key != "result"}
            rid = task["run_id"]
            if cleanup_observation:
                task["runs"][rid]["failure_cleanup_observation"] = cleanup_observation
            if cleanup:
                project = registry["projects"][task["projectId"]]
                if project.get("activeExecution") == {"task_id": task["taskId"], "run_id": rid}:
                    task["runs"][rid]["failure_cleanup"] = cleanup
                    project.pop("activeExecution")
            if "result" in observation and task["status"] not in ("verified", "reported", "rework"):
                status = runner.result_status(observation["result"])
                task["runs"][rid]["result_path"] = observation["result_path"]
                if task["status"] != status:
                    task.update(status=status, status_changed_at=timestamp())
                runner.emit(registry, task, status)
            elif task["status"] in ("starting", "running"):
                if observation["observed"] == "herdr_blocked":
                    task.update(status="blocked", status_changed_at=timestamp(), block_origin="herdr")
                    runner.emit(registry, task, "blocked")
                elif observation["observed"] not in ("running", "runner_starting"):
                    task.update(status="needs_reconciliation", status_changed_at=timestamp())
                    runner.emit(registry, task, "needs_reconciliation")
            # 每个阶段只产生稳定提醒；扫描与通知退避相互独立，不无限重发。
            since = epoch(task.get("status_changed_at", task["runs"][rid]["started_at"]))
            timeout = task.get("review_timeout", 1800)
            if task["status"] in ("ready_for_review", "blocked", "needs_reconciliation", "verified", "rework") and now - since >= timeout and not handled_failure(root, registry, task):
                phase = "review_overdue" if task["status"] == "ready_for_review" else task["status"] + "_overdue"
                task["attention_required"] = phase
                runner.emit(registry, task, phase)
    return {"checked": len(observations), "at": timestamp()}


def cancellation_proof(task, rid):
    stored = task["runs"][rid]["cancellation"]
    if runner.summary(stored["path"]) != stored:
        raise ValueError("取消证据已变化；不返回未经核对的签收")
    proof = runner.read(stored["path"])
    if proof.get("task_id") != task["taskId"] or proof.get("run_id") != rid:
        raise ValueError("取消证据身份不同")
    return proof


def cancel(root, tid, rid):
    tid = runner.ident(tid)
    rid = runner.ident(rid)
    with transaction(root) as registry:
        task = copy.deepcopy(registry["tasks"][tid])
        project = copy.deepcopy(registry["projects"][task["projectId"]])
        if task.get("run_id") != rid or task["status"] in ("verified", "reported"):
            raise ValueError("只能取消当前未交付 run")
        if task["status"] == "cancelled":
            return cancellation_proof(task, rid)
        if project.get("activeExecution") != {"task_id": tid, "run_id": rid}:
            raise ValueError("项目当前执行占用与取消目标不同")
    agent, native = inspect_agent(project)
    run = task["runs"][rid]
    if agent["agent_status"] not in ("idle", "done", "working"):
        raise ValueError("Agent 状态未知或在审批界面；保留占用，不能盲目取消")
    commands = run_commands(project, run.get("worker_process_baseline"))
    if agent["agent_status"] == "working":
        prompt = (Path(root) / "runs" / tid / rid / "dispatch-prompt.md").read_text()
        messages = codex.messages(native["path"])
        inputs = [message for message in messages if message["role"] == "user"]
        if not inputs or inputs[-1]["text"] != prompt:
            raise ValueError("正在执行的原生输入不是该 run；不终止其他任务")
    intent = {
        "task_id": tid,
        "run_id": rid,
        "session_id": native["id"],
        "before": agent,
        "command_processes": commands,
        "at": timestamp(),
    }
    with transaction(root) as registry:
        current = registry["tasks"][tid]
        if current.get("run_id") != rid or registry["projects"][task["projectId"]].get("activeExecution") != {"task_id": tid, "run_id": rid}:
            raise ValueError("取消期间目标变化")
        current["runs"][rid]["cancel_intent"] = intent
    if agent["agent_status"] == "working":
        dispatch.control(project["executionSettings"], "agent", "send-keys", project["herdr"]["agent_name"], "esc")
        dispatch.control(project["executionSettings"], "agent", "wait", project["herdr"]["agent_name"], "--timeout", "10000")
    after, _ = inspect_agent(project)
    if after["agent_status"] not in ("idle", "done"):
        raise ValueError("未确认 Coding Agent 停止；不释放项目")
    child_cleanup = stop_commands(project, run["worker_process_baseline"], commands)
    for key in ("pid_identity", "runner_pid_identity"):
        identity = run.get(key)
        if live(identity):
            try:
                signal_identity(identity, signal.SIGTERM)
            except ProcessLookupError:
                pass
    deadline = time.monotonic() + 10
    while any(live(run.get(key)) for key in ("pid_identity", "runner_pid_identity")):
        if time.monotonic() >= deadline:
            raise ValueError("监督进程仍在退出；保留现场，下次核对")
        time.sleep(0.1)
    proof = {
        **intent,
        "after": after,
        "child_cleanup": child_cleanup,
        "confirmed_at": timestamp(),
    }
    path = Path(root) / "runs" / tid / rid / "cancellation.json"
    with transaction(root) as registry:
        current = registry["tasks"][tid]
        if current.get("run_id") != rid:
            raise ValueError("取消完成时 run 已变化")
        if current["status"] == "cancelled":
            return cancellation_proof(current, rid)
        if current["status"] in ("verified", "reported"):
            raise ValueError("取消期间验收已完成；保留已验收结果")
        bound = registry["projects"][task["projectId"]]
        if bound.get("activeExecution") != {"task_id": tid, "run_id": rid}:
            raise ValueError("取消完成时项目占用已变化；保留现场")
        # 确认与落盘同处登记锁内；晚到的取消不能覆盖已验收或其他 run。
        runner.atomic_json(path, proof, immutable=True)
        current["runs"][rid]["cancellation"] = runner.summary(path)
        current.update(status="cancelled", status_changed_at=timestamp())
        bound.pop("activeExecution")
    return proof


def retry(root, tid):
    with transaction(root) as registry:
        task = copy.deepcopy(registry["tasks"][runner.ident(tid)])
        project = copy.deepcopy(registry["projects"][task["projectId"]])
    if task["status"] not in ("blocked", "cancelled", "rework"):
        raise ValueError("仅明确失败、已取消或验收返工任务可以重试")
    if task.get("retry_count", 0) >= 2:
        raise ValueError("两次返工已耗尽；需要明确新任务")
    if task["status"] != "cancelled" and project.get("activeExecution"):
        cancel(root, tid, task["run_id"])
    agent, _ = inspect_agent(project)
    if agent["agent_status"] not in ("idle", "done"):
        raise ValueError("原 Agent 未就绪；不重试")
    with transaction(root) as registry:
        current = registry["tasks"][tid]
        if current.get("run_id") != task["run_id"] or current["status"] not in ("blocked", "cancelled", "rework"):
            raise ValueError("重试期间状态变化")
        current["retry_count"] = task.get("retry_count", 0) + 1
        current["status"] = "registered"
        current["status_changed_at"] = timestamp()
    return {"task_id": tid, "previous_run_id": task["run_id"], "status": "registered"}
