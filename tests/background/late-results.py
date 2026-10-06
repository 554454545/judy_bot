# 迟到结果与失败通知回归：验证真实文件协议、原生记录、状态围栏和独立验收；关联 execution/late_result.py、health.py、notifications/task_protocol.py，不调用模型或 TG。
import copy
import json
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

BOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(BOT / ".pi/extensions/background"))
from execution import codex, health, late_result, runner
from notifications import task_protocol as notices
from storage.registry import timestamp, transaction


class LateResults(unittest.TestCase):
    def setUp(self):
        temporary = BOT / ".cache/tmp/late-results"
        temporary.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=temporary)
        self.root = Path(self.temporary.name)
        self.worktree = self.root / "worktree"
        self.worktree.mkdir()
        subprocess.run(["git", "init", "-q", str(self.worktree)], check=True)
        self.directory = self.root / "runs/task/run"
        self.directory.mkdir(parents=True)
        self.native = {"id": "native-fixed", "path": str(self.root / "rollout.jsonl")}
        self.prompt = "完成用户原始目标\nDONE_FIXTURE\n"
        self.marker = "DONE_FIXTURE"
        self.commands = []
        self.agent = {"agent_status": "done"}
        self.records = [
            {"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"text": self.prompt}]}},
            {"type": "turn_context", "payload": {"turn_id": "turn-fixed", "model": "fixture-model", "effort": "low"}},
            {"type": "response_item", "payload": {"type": "message", "role": "assistant", "phase": "final_answer", "content": [{"text": "成果\nDONE_FIXTURE"}], "internal_chat_message_metadata_passthrough": {"turn_id": "turn-fixed"}}},
            {"type": "event_msg", "payload": {"type": "task_complete", "turn_id": "turn-fixed", "duration_ms": 10000}},
        ]
        self.write_native()
        business = self.directory / "business.json"
        before = runner.summary(business)
        started = timestamp()
        self.original = {"task_id": "task", "run_id": "run", "started_at": started, "exit_code": 1, "exit_code_source": "herdr_supervisor_process_wait", "pid_identity": {"pid": 999999, "start_ticks": 1, "boot_id": "fixture"}, "reason": "time_budget", "error": "timeout", "marker": {"seen": False}, "artifacts": []}
        runner.atomic_json(self.directory / "result.json", self.original, immutable=True)
        runner.atomic_json(business, {"task_id": "task", "run_id": "run", "reason": "goal_complete"})
        (self.directory / "dispatch-prompt.md").write_text(self.prompt)
        with transaction(self.root) as registry:
            registry["projects"]["project"] = {
                "projectId": "project", "sessionId": self.native["id"], "worktreePath": str(self.worktree),
                "herdr": {"agent_name": "herdr-project", "session_name": "herdr-project"},
                "executionSettings": {"herdrPath": "fixture-herdr", "herdrSession": "bot", "agent": {"home": str(self.root), "model": "fixture-model", "reasoningEffort": "low"}},
                "activeExecution": {"task_id": "task", "run_id": "run"},
            }
            registry["tasks"]["task"] = {
                "taskId": "task", "projectId": "project", "run_id": "run", "status": "blocked", "status_changed_at": started,
                "route": {"profile": "personal"}, "scope": ["**/*"],
                "runs": {"run": {"started_at": started, "started_epoch": time.time() - 10, "dispatch_hash": runner.digest(self.prompt.encode()), "marker": self.marker, "baseline": [before], "worktree_baseline": {}, "worker_process_baseline": {"agent": "fixture"}, "result_path": str(self.directory / "result.json")}},
            }
            self.event_id = runner.emit(registry, registry["tasks"]["task"], "blocked")
            self.project = copy.deepcopy(registry["projects"]["project"])
        runner.atomic_json(self.directory / "dispatch-intent.json", {"task_id": "task", "run_id": "run", "binding": self.project["herdr"], "prompt_hash": runner.digest(self.prompt.encode()), "session_id": self.native["id"], "message_count_before": 0})

    def tearDown(self):
        self.temporary.cleanup()

    def write_native(self):
        Path(self.native["path"]).write_text("".join(json.dumps(item) + "\n" for item in self.records))

    def wait(self, command, **_kwargs):
        self.commands.append(command)
        return SimpleNamespace(returncode=0, stdout='{"result":{"status":"done"}}', stderr="")

    def reconcile(self, wait=None):
        with (
            patch.object(health, "inspect_agent", return_value=(self.agent, self.native)),
            patch.object(health, "run_commands", return_value=[]),
            patch.object(codex, "title", return_value="herdr-project"),
            patch.object(late_result, "subprocess", SimpleNamespace(run=wait or self.wait)),
        ):
            health.reconcile(self.root)
        return runner.read(self.root / "registry.json")

    def test_late_result_preserves_failure_and_waits_for_review(self):
        original_bytes = (self.directory / "result.json").read_bytes()
        registry = self.reconcile()
        task = registry["tasks"]["task"]
        self.assertEqual(task["status"], "ready_for_review")
        self.assertEqual((self.directory / "result.json").read_bytes(), original_bytes)
        self.assertEqual(registry["projects"]["project"]["activeExecution"], {"task_id": "task", "run_id": "run"})
        self.assertEqual(len(self.commands), 1)
        self.assertIn("wait", self.commands[0])
        self.assertNotIn("prompt", self.commands[0])
        collected = runner.read(task["runs"]["run"]["result_path"])
        self.assertEqual(collected["exit_code_source"], "herdr_late_wait_process")
        self.assertEqual(runner.result_status(collected), "ready_for_review")
        self.reconcile()
        self.assertEqual(len(self.commands), 1, "已收集的原 run 不再次 wait 或派发")
        review = self.root / "review.json"
        runner.atomic_json(review, {"task_id": "task", "run_id": "run", "passed": True, "checks": ["实际独立检查"]})
        runner.verify(self.root, "task", "run", review)
        registry = runner.read(self.root / "registry.json")
        self.assertEqual(registry["tasks"]["task"]["status"], "verified")
        self.assertNotIn("activeExecution", registry["projects"]["project"])

    def test_incomplete_marker_or_completion_is_not_success(self):
        for change in ("marker", "complete", "later_input"):
            original = copy.deepcopy(self.records)
            if change == "marker":
                self.records[2]["payload"]["content"] = [{"text": "没有标记"}]
            elif change == "complete":
                self.records.pop()
            else:
                self.records.append({"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"text": "另一任务"}]}})
            self.write_native()
            registry = self.reconcile()
            self.assertEqual(registry["tasks"]["task"]["status"], "blocked", change)
            self.assertIn("activeExecution", registry["projects"]["project"])
            self.assertFalse((self.directory / "late-result.json").exists())
            self.records = original
        self.assertEqual(self.commands, [])

    def test_wait_failure_and_changed_registry_cannot_promote(self):
        registry = self.reconcile(lambda *_args, **_kwargs: SimpleNamespace(returncode=1, stdout='{"error":{"code":"timeout"}}', stderr=""))
        self.assertEqual(registry["tasks"]["task"]["status"], "blocked")

        def replaced(command, **kwargs):
            with transaction(self.root) as current:
                current["projects"]["project"]["activeExecution"] = {"task_id": "new", "run_id": "new"}
            return self.wait(command, **kwargs)

        registry = self.reconcile(replaced)
        self.assertEqual(registry["tasks"]["task"]["status"], "blocked")
        self.assertEqual(registry["projects"]["project"]["activeExecution"]["task_id"], "new")
        self.assertFalse((self.directory / "late-result.json").exists())

    def test_changed_late_result_rejected_by_review(self):
        registry = self.reconcile()
        file = Path(registry["tasks"]["task"]["runs"]["run"]["result_path"])
        file.write_text(file.read_text() + " ")
        review = self.root / "review.json"
        runner.atomic_json(review, {"task_id": "task", "run_id": "run", "passed": True, "checks": ["fixture"]})
        with self.assertRaises(ValueError):
            runner.verify(self.root, "task", "run", review)

    def test_handled_failure_suppresses_overdue_but_not_unknown_or_new_state(self):
        event = runner.read(self.root / "registry.json")["outbox"][self.event_id]
        notices.enqueue(self.root, "失败", event=event)
        owner = {"main": True, "idle": True, "profile": "personal"}
        notice = notices.claim(self.root, owner)
        delivery = {"state": "success", "event_id": "final-task-run", "message_id": 123, "target": {"chatId": 1}, "hash": "fixture"}
        runner.atomic_json(self.root / "telegram-receipts.json", {"final-task-run": delivery})
        proof = self.root / "handled.json"
        runner.atomic_json(proof, {"event_id": self.event_id, "task_id": "task", "run_id": "run", "status": "blocked", "receipt": delivery})
        notices.receipt(self.root, self.event_id, notice["claim_id"], "handled", str(proof))
        with transaction(self.root) as registry:
            task = registry["tasks"]["task"]
            self.assertTrue(notices.handled_failure(self.root, registry, task))
            registry["projects"]["project"].pop("activeExecution")
            task["review_timeout"] = 0
        health.reconcile(self.root)
        self.assertNotIn("attention_required", runner.read(self.root / "registry.json")["tasks"]["task"])
        with transaction(self.root) as registry:
            task = registry["tasks"]["task"]
            overdue = runner.emit(registry, task, "blocked_overdue")
            registry["outbox"][self.event_id]["targets"]["agent"]["state"] = "success"
        notices.enqueue(self.root, "旧失败提醒", event=runner.read(self.root / "registry.json")["outbox"][overdue])
        sends = []
        notices.drain(self.root, lambda *args: sends.append(args))
        self.assertEqual(sends, [], "已签收的旧失败不再次排入前台")
        self.assertIsNone(notices.claim(self.root, owner))
        self.assertEqual(runner.read(self.root / "inbox.json")[overdue]["disposition"]["reason"], "failure_already_notified")
        with transaction(self.root) as registry:
            task = registry["tasks"]["task"]
            task["status_changed_at"] = timestamp()
            self.assertFalse(notices.handled_failure(self.root, registry, task), "新失败阶段不能被旧签收吞掉")
        runner.atomic_json(self.root / "telegram-receipts.json", {"final-task-run": {**delivery, "state": "unknown"}})
        self.assertFalse(notices.handled_failure(self.root, runner.read(self.root / "registry.json"), task))


if __name__ == "__main__":
    unittest.main(verbosity=2)
