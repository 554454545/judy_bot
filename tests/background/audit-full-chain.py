# 十组最终证据复核：逐任务核对真实登记/原生执行/独立验收/TG 签收/上下文观察点，并区分未采集时间；关联 full-chain.mjs、re.md。
import argparse
import collections
import hashlib
import json
import sys
from datetime import datetime
from pathlib import Path

BOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(BOT / ".pi/extensions/background"))
from execution import runner
from notifications.task_protocol import delivery_hash
from storage.registry import timestamp


def main(base):
    completed = collections.defaultdict(list)
    failures = []
    for file in base.glob("group-*-attempt-*/result.json"):
        result = runner.read(file)
        if result["passed"]:
            completed[result["group"]].append((file.parent, result))
        else:
            failures.append({key: result.get(key) for key in ("group", "attempt", "seconds", "error")})
    assert set(completed) == set(range(1, 11)), f"尚未完成全部十组：{sorted(completed)}"
    assert all(len(items) == 1 for items in completed.values()), "同一组不能重复计入"
    summary = {"at": timestamp(), "passed": False, "groups": [], "failedAttempts": failures, "realUserTelegramIngress": False, "realTelegramApiDelivery": True, "handsetReceipt": False}
    seen_frontends = set()
    projects = {}
    messages = set()
    for number in sorted(completed):
        directory, result = completed[number][0]
        assert result["frontendSessionId"] not in seen_frontends
        seen_frontends.add(result["frontendSessionId"])
        assert len(result["steps"]) == 3 and all(step["passed"] for step in result["steps"])
        registry = runner.read(directory / "background/registry.json")
        conversation = runner.read(directory / "conversation.json")
        baseline = runner.read(directory / "baseline.json")
        final_audit = runner.read(directory / "final-audit.json")
        assert all(item["passed"] for item in final_audit["checks"])
        binding = registry["projects"][result["projectId"]]
        assert not binding.get("activeExecution")
        assert binding["sessionId"] == result["workerSessionId"]
        assert binding["herdr"]["agent_name"] == "herdr-" + result["projectId"]
        projects.setdefault(result["projectId"], binding["sessionId"])
        assert projects[result["projectId"]] == binding["sessionId"]
        assert runner.worktree_snapshot(binding["sourcePath"]) == baseline["sourceBefore"]
        for relative, fingerprint in baseline["treeBefore"].items():
            assert final_audit["finalTree"][relative] == fingerprint
        assert all(relative.startswith(result["directory"] + "/") for relative in final_audit["finalTree"] if relative not in baseline["treeBefore"])
        for relative, fingerprint in baseline["protectedHashes"].items():
            assert hashlib.sha256((BOT / relative).read_bytes()).hexdigest() == fingerprint
        session_files = list((directory / "frontend/sessions").rglob("*.jsonl"))
        assert len(session_files) == 1
        session_entries = [json.loads(line) for line in session_files[0].read_text().splitlines()]
        assert session_entries[0]["id"] == result["frontendSessionId"]
        inbox = runner.read(directory / "background/inbox.json")
        ledger = runner.read(directory / "background/telegram-receipts.json")
        metrics = []
        for step in result["steps"]:
            tid, rid = step["taskId"], step["runId"]
            task = registry["tasks"][tid]
            assert task["projectId"] == result["projectId"]
            original = task["originalRequest"]
            assert original["source"] == "telegram" and original["sessionId"] == result["frontendSessionId"]
            message = next(item for item in conversation["inputs"] if item["message"]["message_id"] == original["telegram"]["messageId"])
            entry = next(item for item in session_entries if item.get("id") == original["entryId"])
            assert original["text"] == message["message"]["text"]
            assert entry["message"]["content"][0]["text"] == message["inputText"]
            assert datetime.fromisoformat(original["receivedAt"]) == datetime.fromisoformat(entry["timestamp"].replace("Z", "+00:00"))
            assert datetime.fromisoformat(original["telegram"]["sentAt"]).timestamp() == message["message"]["date"]
            assert original["telegram"]["chatId"] == message["message"]["chat"]["id"]
            assert task["status"] == "reported" and task["verification"]["ok"]
            assert task["report"]["message_id"] not in messages
            messages.add(task["report"]["message_id"])
            run_directory = directory / "background/runs" / tid / rid
            run = task["runs"][rid]
            for field, copied in (("spec", "handoff-spec.json"), ("prompt", "handoff-prompt.md")):
                original_bytes = Path(task["files"][field]).read_bytes()
                assert original_bytes == (run_directory / copied).read_bytes()
                fingerprint = hashlib.sha256(original_bytes).hexdigest()
                assert fingerprint == task[field + "Hash"] == run[field + "_hash"]
            assert hashlib.sha256((run_directory / "dispatch-prompt.md").read_bytes()).hexdigest() == run["dispatch_hash"]
            spec = runner.read(task["files"]["spec"])["task"]
            for field in ("taskId", "projectId", "originalRequest", "instruction", "scope", "acceptance", "artifacts"):
                assert spec[field] == task[field]
            execution = runner.read(run_directory / "result.json")
            assert execution["reason"] == "goal_complete" and execution["task_id"] == tid and execution["run_id"] == rid
            assert execution["exit_code"] == 0 and execution["marker"]["seen"] and not execution["error"]
            assert task["verification"]["result_hash"] == runner.digest(execution)
            assert run["verification"] == task["verification"] and run["report"] == task["report"]
            proof = runner.read(run_directory / "herdr-evidence.json")
            assert proof["native_input_count"] == 1 and proof["session_id"] == binding["sessionId"]
            assert proof["session_name"] == binding["herdr"]["agent_name"]
            assert proof["prompt_result"]["cli_exit_code"] == 0 and run["marker"] in proof["native_final_message"]["text"].splitlines()
            assert not proof["outside_scope"]
            review = runner.read(task["verification"]["evidence"]["path"])
            assert runner.summary(task["verification"]["evidence"]["path"]) == task["verification"]["evidence"]
            assert review["passed"] and review["task_id"] == tid and review["run_id"] == rid
            receipt = runner.read(run_directory / "final-report-receipt.json")
            assert receipt["state"] == "success" and receipt["message_id"] == task["report"]["message_id"]
            assert receipt["target"] == {"chatId": original["telegram"]["chatId"]}
            assert receipt["hash"] == delivery_hash((run_directory / "final-report.txt").read_text()) == task["report_intent"]["hash"]
            assert task["report"]["verification_hash"] == runner.digest(task["verification"]) == task["report_intent"]["verification_hash"]
            assert any(item.get("state") == "success" and item.get("event_id") == receipt["event_id"] and item.get("hash") == receipt["hash"] for item in ledger.values())
            assert any(item["state"] == "handled" and item["task_id"] == tid and item["run_id"] == rid for item in inbox.values())
            raw = step.get("stageEvidence", {}).get("monotonic", {})
            stages = []
            chain = [
                ("input", step.get("inputMonotonicNs")),
                ("runStarted", raw.get("runStarted")),
                ("runnerStarted", raw.get("runnerStarted")),
                ("dispatchStarted", raw.get("dispatchStarted")),
                ("dispatchFinished", raw.get("dispatchFinished")),
                ("resultWritten", raw.get("resultWritten")),
                ("verified", raw.get("verified")),
                ("sent", raw.get("sent")),
                ("handled", raw.get("handled")),
            ]
            for (previous, left), (current, right) in zip(chain, chain[1:]):
                seconds = None if left is None or right is None else (int(right) - int(left)) / 1e9
                assert seconds is None or seconds >= 0, "阶段单调时钟顺序错误"
                stages.append({"from": previous, "to": current, "seconds": seconds, "status": "not_collected" if seconds is None else "measured_monotonic"})
            independent = runner.read(directory / f"independent-phase-{step['phase']}.json")
            assert independent["passed"] and independent["checkCount"] > 1900
            delivery_seconds = None if step.get("inputMonotonicNs") is None or raw.get("sent") is None else (int(raw["sent"]) - int(step["inputMonotonicNs"])) / 1e9
            metrics.append({"taskId": tid, "runId": rid, "messageId": receipt["message_id"], "parseMode": receipt.get("parse_mode"), "secondsIncludingIndependentChecks": step["seconds"], "inputToTelegramApiSeconds": delivery_seconds, "inputToTelegramApiTimeStatus": "not_collected" if delivery_seconds is None else "measured_monotonic", "independentCheckCount": independent["checkCount"], "stages": stages})
        observations = [json.loads(line) for file in (directory / "frontend/observability").glob("*.jsonl") for line in file.read_text().splitlines()]
        requests = [record for record in observations if record.get("stage") == "request"]
        responses = [record for record in observations if record.get("stage") == "response"]
        assert len(requests) > 0 and len(requests) == len(responses)
        assert {r["requestId"] for r in requests} == {r["requestId"] for r in responses}
        assert not any((r.get("assistantMessage") or {}).get("stopReason") in ("error", "aborted") for r in responses), "通过组仍有主模型失败或中断响应"
        system_hashes = {hashlib.sha256(r["systemPrompt"].encode()).hexdigest() for r in requests}
        tools = {item["name"] for record in requests for item in record["providerPayload"].get("tools", [])}
        assert not any(tool.startswith("background_") for tool in tools)
        tool_events = runner.read(directory / "tool-events.json")
        assert not any(event.get("isError") for event in tool_events)
        forbidden_reads = []
        for event in tool_events:
            if event["type"] != "tool_execution_start":
                continue
            content = json.dumps(event.get("args", {}))
            if any(marker in content for marker in ("herdr-transcript.txt", "runner.stdout", "/background/codex/", "rollout-")):
                forbidden_reads.append(event.get("toolCallId"))
        assert not forbidden_reads, "主 Pi 读取了 worker 的完整历史或终端输出"
        summary["groups"].append({"group": number, "attempt": result["attempt"], "projectId": result["projectId"], "game": result["game"], "startedAt": result["startedAt"], "finishedAt": result["finishedAt"], "seconds": result["seconds"], "frontendSessionId": result["frontendSessionId"], "workerSessionId": result["workerSessionId"], "tasks": metrics, "mainModelRequests": len(requests), "systemPromptVersions": len(system_hashes), "newBackgroundTools": 0, "workerHistoryReads": len(forbidden_reads)})
    summary.update(passed=True, projects=projects, verifiedTasks=len(messages), mainModelRequests=sum(group["mainModelRequests"] for group in summary["groups"]))
    runner.atomic_json(base / "final-chain-audit.json", summary)
    print(json.dumps({"passed": True, "groups": len(summary["groups"]), "verifiedTasks": summary["verifiedTasks"], "failedAttempts": len(failures), "mainModelRequests": summary["mainModelRequests"]}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", type=Path)
    args = parser.parse_args()
    base = args.base or Path((BOT / ".pi/agent/background/verification/full-chain/current.txt").read_text().strip())
    main(base)
