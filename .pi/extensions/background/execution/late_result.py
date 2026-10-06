# 超时后的结果收集：保留 runner 原失败，核对原生完成与真实 Herdr wait；关联 health.py、runner.py、codex.py。
import json
import subprocess
import time
from pathlib import Path

from execution import codex, herdr, runner
from storage.registry import timestamp


def collect(root, task, project, actual, native):
    tid, rid = task["taskId"], task["run_id"]
    run = task["runs"][rid]
    directory = Path(root) / "runs" / tid / rid
    original = runner.read(directory / "result.json")
    intent = runner.read(directory / "dispatch-intent.json")
    prompt = (directory / "dispatch-prompt.md").read_text()
    if original.get("reason") != "time_budget":
        return None
    if task["status"] not in ("blocked", "needs_reconciliation") or run.get("cancel_intent"):
        raise ValueError("任务状态已变化或正在取消")
    if not intent or any(intent.get(key) != value for key, value in {
        "task_id": tid,
        "run_id": rid,
        "binding": project["herdr"],
        "prompt_hash": run["dispatch_hash"],
    }.items()):
        raise ValueError("缺少匹配的真实派发意图")
    if runner.digest(prompt.encode()) != intent["prompt_hash"]:
        raise ValueError("派发正文已变化")
    if intent.get("session_id") not in (None, native["id"]) or native["id"] != project["sessionId"]:
        raise ValueError("原生会话身份变化")
    messages = codex.messages(native["path"])[intent["message_count_before"]:]
    inputs = [item for item in messages if item["role"] == "user"]
    if len(inputs) != 1 or inputs[0]["text"] != prompt:
        raise ValueError("原 run 之后已出现其他输入；不接管新任务的成果")
    finals = [item for item in messages if item["role"] == "assistant" and item["phase"] == "final_answer"]
    final = finals[-1] if finals else None
    if not final or run["marker"] not in final["text"].splitlines() or not final.get("turn_id"):
        raise ValueError("缺少真实最终回复与独立完成标记")
    completions = []
    with Path(native["path"]).open() as stream:
        for line in stream:
            record = json.loads(line)
            payload = record.get("payload", {})
            if record.get("type") == "event_msg" and payload.get("type") == "task_complete" and payload.get("turn_id") == final["turn_id"]:
                completions.append({"timestamp": record.get("timestamp"), "payload": payload})
    if not completions:
        raise ValueError("原生 turn 尚无 task_complete")
    settings = project["executionSettings"]["agent"]
    calls = [item for item in codex.turn_settings(native["path"]) if item["turn_id"] == final["turn_id"]]
    if not calls or any(item["model"] != settings["model"] or item["effort"] != settings["reasoningEffort"] for item in calls):
        raise ValueError("原生调用参数与登记不同")
    if codex.title(settings["home"], native["id"]) != project["herdr"]["session_name"]:
        raise ValueError("原生会话名称变化")
    business = runner.read(directory / "business.json", {})
    expected_business = {
        "task_id": tid,
        "run_id": rid,
    }
    if any(business.get(key) != value for key, value in expected_business.items()):
        raise ValueError("业务结果身份不同")
    if business.get("reason") not in ("goal_complete", "read_error", "http_error", "error"):
        raise ValueError("业务结果尚未明确收尾")
    snapshot = runner.worktree_snapshot(project["worktreePath"])
    baseline = run["worktree_baseline"]
    changed = sorted(path for path in set(baseline) | set(snapshot) if baseline.get(path) != snapshot.get(path))
    if any(not herdr.within_scope(path, task["scope"]) for path in changed):
        raise ValueError("产物修改越出任务允许范围")
    artifacts = []
    for before in run["baseline"]:
        after = runner.summary(before["path"])
        after["fresh"] = bool(
            after.get("size", 0) > 0
            and after.get("mtime_ns", 0) >= int(run["started_epoch"] * 1e9)
            and after.get("sha256") != before.get("sha256")
        )
        artifacts.append(after)
    if not artifacts or not all(item["fresh"] for item in artifacts):
        raise ValueError("缺少本轮新产物")
    # 只观察原 Agent，不发送 prompt；退出码来自这一次实际 wait 进程，绝不补造旧监督退出码。
    runtime = project["executionSettings"]
    command = [
        runtime["herdrPath"],
        "--session", runtime["herdrSession"],
        "agent", "wait", project["herdr"]["agent_name"],
        "--until", "idle",
        "--until", "done",
        "--timeout", "1000",
    ]
    observed = subprocess.run(command, capture_output=True, text=True, timeout=5)
    wait = json.loads(observed.stdout or observed.stderr)
    if observed.returncode != 0 or wait.get("error"):
        raise ValueError("迟到收集未获得 Herdr wait 正常退出证据")
    from execution.health import inspect_agent
    after, after_native = inspect_agent(project)
    if after.get("agent_status") not in ("idle", "done") or after_native["id"] != native["id"]:
        raise ValueError("迟到收集后原 Agent 或会话状态变化")
    if runner.worktree_snapshot(project["worktreePath"]) != snapshot or codex.messages(native["path"])[intent["message_count_before"]:] != messages:
        raise ValueError("收集期间原生输入或产物变化")
    evidence = {
        "task_id": tid,
        "run_id": rid,
        "session_id": native["id"],
        "original_result": runner.summary(directory / "result.json"),
        "dispatch_intent": runner.summary(directory / "dispatch-intent.json"),
        "agent": actual,
        "after": after,
        "native_final_message": final,
        "native_completion": completions[-1],
        "native_model_settings": calls,
        "changed_paths": changed,
        "worktree_snapshot_hash": runner.digest(snapshot),
        "wait_result": wait,
        "wait_exit_code": observed.returncode,
        "collected_at": timestamp(),
    }
    result = {
        **original,
        "exit_code": observed.returncode,
        "exit_code_source": "herdr_late_wait_process",
        "pid_identity_source": "original_herdr_supervisor",
        "stdout_hash": runner.digest(observed.stdout.encode()),
        "stderr_hash": runner.digest(observed.stderr.encode()),
        "reason": business["reason"],
        "error": business.get("error"),
        "marker": {
            "expected": run["marker"],
            "seen": True,
            "source": "native_final_answer_exact_line",
        },
        "artifacts": artifacts,
        "finished_at": timestamp(),
        "finished_monotonic_ns": str(time.monotonic_ns()),
        "herdr_evidence": str(directory / "late-herdr-evidence.json"),
    }
    return {
        "result": result,
        "evidence": evidence,
        "snapshot": snapshot,
        "messages": messages,
        "native": native,
        "intent": intent,
    }
