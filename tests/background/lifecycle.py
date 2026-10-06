# 后台生命周期离线回归：核对等待预算派发、真实文件协议的 inbox、并发领取、崩溃租约、签收和未知发送防重；关联 background/execution、notifications，不计入十组真实实验。
import copy
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

BOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(BOT / ".pi/extensions/background"))
from execution import runner
from notifications import task_protocol as notices
from storage.registry import transaction, timestamp


class Lifecycle(unittest.TestCase):
    def test_dispatch_timeout_reaches_supervisor_command(self):
        import contextlib
        import io
        import shlex
        from unittest.mock import patch
        from execution import dispatch
        from tasks import task_protocol as frontend

        commands = []

        def control(_settings, *args):
            responses = {
                ("workspace", "list"): {
                    "workspaces": [{
                        "label": "bot-runtime",
                        "workspace_id": "w-runtime",
                    }],
                },
                ("pane", "list"): {
                    "panes": [{"pane_id": "w-runtime:p1"}],
                },
                ("agent", "list"): {"agents": []},
                ("pane", "process-info"): {
                    "process_info": {
                        "shell_pid": 123,
                        "foreground_process_group_id": 123,
                        "foreground_processes": [{"pid": 123}],
                    },
                },
            }
            if args[:2] == ("pane", "run"):
                self.assertEqual(args[2], "w-runtime:p1")
                commands.append(shlex.split(args[3]))
                return {"cli_exit_code": 0}
            return {"result": responses[args[:2]]}

        for entry, arguments, expected in (
            ("frontend", [], 1800),
            ("frontend", ["--timeout", "73"], 73),
            ("direct", [], 1800),
        ):
            with self.subTest(entry=entry, arguments=arguments):
                with transaction(self.root) as registry:
                    task = registry["tasks"]["complex"]
                    task["status"] = "starting"
                    task["runs"]["run-1"] = {}
                    registry["projects"]["fixture"] = {
                        "executionSettings": {},
                        "activeExecution": {
                            "task_id": "complex",
                            "run_id": "run-1",
                        },
                    }
                argv = [
                    "task_protocol.py",
                    "--root", str(self.root),
                    "run", "complex", "run-1",
                    *arguments,
                ]
                with patch.object(dispatch, "control", side_effect=control):
                    if entry == "frontend":
                        output = io.StringIO()
                        with patch.object(sys, "argv", argv), contextlib.redirect_stdout(output):
                            frontend.main()
                        receipt = json.loads(output.getvalue())
                    else:
                        receipt = dispatch.launch(self.root, "complex", "run-1")
                command = commands[-1]
                execute_arguments = command[command.index("execute") + 1:command.index("--timeout")]
                self.assertEqual(execute_arguments, ["complex", "run-1"])
                self.assertEqual(command[command.index("--timeout") + 1], str(expected))
                self.assertEqual(receipt["state"], "starting")
                self.assertTrue(Path(receipt["receipt_path"]).is_file())
                stored_run = runner.read(self.root / "registry.json")["tasks"]["complex"]["runs"]["run-1"]
                self.assertNotIn("runner_started", stored_run)

    def test_runner_cli_keeps_default_and_explicit_wait_budget(self):
        import contextlib
        import io
        from unittest.mock import patch

        for operation, arguments in (
            ("run", [
                "--spec", "fixture-spec.json",
                "--prompt", "fixture-prompt.md",
                "--run-id", "run-1",
            ]),
            ("execute", ["complex", "run-1"]),
        ):
            for override, expected in (([], 1800), (["--timeout", "73"], 73)):
                with self.subTest(operation=operation, override=override):
                    argv = ["runner.py", "--root", str(self.root), operation, *arguments, *override]
                    with (
                        patch.object(sys, "argv", argv),
                        patch.object(runner, "start_run", return_value=("complex", "run-1")),
                        patch.object(runner, "run_command", return_value="fixture-result.json") as execute,
                        contextlib.redirect_stdout(io.StringIO()),
                    ):
                        runner.main()
                    execute.assert_called_once_with(self.root.resolve(), "complex", "run-1", expected)

    def test_unknown_delivery_remains_attention_across_own_leaf_and_timeout(self):
        claimed = notices.claim(self.root, self.owner)
        failure = self.root / "attention.json"
        latest = {**self.owner, "leaf_id": "leaf-after-own-reply"}
        runner.atomic_json(failure, {
            "receipt": {"state": "unknown"},
            "owner": latest,
        })
        notices.attention(self.root, self.eid, claimed["claim_id"], str(failure))
        current = runner.read(self.root / "inbox.json")[self.eid]
        self.assertEqual(current["attention_owner"], latest)
        self.assertEqual(current["attention_required"], "delivery_unknown")
        self.assertIsNone(notices.claim(self.root, latest))
        self.assertIsNone(notices.claim(self.root, {**latest, "leaf_id": "new-user-branch"}, time.time() + 7200))
        self.assertEqual(runner.read(self.root / "inbox.json")[self.eid]["state"], "needs_attention")

    def test_watchdog_does_not_release_run_during_cancel_finalization(self):
        from execution import health
        from unittest.mock import patch
        started = timestamp()
        active = {"task_id": "complex", "run_id": "run-1"}
        with transaction(self.root) as registry:
            registry["projects"]["fixture"] = {"activeExecution": active}
            task = registry["tasks"]["complex"]
            task["status"] = "blocked"
            task["runs"]["run-1"].update(started_at=started, cancel_intent={"task_id": "complex", "run_id": "run-1"})
        runner.atomic_json(self.root / "runs/complex/run-1/result.json", {
            "task_id": "complex",
            "run_id": "run-1",
            "started_at": started,
            "reason": "read_error",
            "error": "fixture missing",
            "exit_code": 0,
            "marker": {"seen": True},
            "artifacts": [],
        })
        # 单元边界提供已停 worker 状态；真实 Herdr/ESC 另在 live-lifecycle.py 验证。
        with patch.object(health, "inspect_agent", return_value=({"agent_status": "idle"}, {"id": "offline-session"})):
            health.reconcile(self.root)
        current = runner.read(self.root / "registry.json")
        self.assertEqual(current["projects"]["fixture"]["activeExecution"], active)
        self.assertNotIn("failure_cleanup", current["tasks"]["complex"]["runs"]["run-1"])

    def test_retry_registered_does_not_reapply_previous_run_result(self):
        from execution import health
        started = timestamp()
        with transaction(self.root) as registry:
            registry["projects"]["fixture"] = {}
            task = registry["tasks"]["complex"]
            task.update(status="registered", retry_count=1)
            task["runs"]["run-1"]["started_at"] = started
        runner.atomic_json(self.root / "runs/complex/run-1/result.json", {
            "task_id": "complex",
            "run_id": "run-1",
            "started_at": started,
            "reason": "read_error",
            "error": "actual fixture file missing",
            "exit_code": 0,
            "marker": {"seen": True},
            "artifacts": [],
        })
        before = runner.read(self.root / "registry.json")["tasks"]["complex"]
        self.assertEqual(health.reconcile(self.root)["checked"], 0)
        self.assertEqual(runner.read(self.root / "registry.json")["tasks"]["complex"], before)

    def test_watchdog_idle_worker_with_live_command_keeps_occupancy(self):
        from execution import health
        from unittest.mock import patch
        started = timestamp()
        active = {"task_id": "complex", "run_id": "run-1"}
        with transaction(self.root) as registry:
            registry["projects"]["fixture"] = {"activeExecution": active}
            task = registry["tasks"]["complex"]
            task["status"] = "blocked"
            task["runs"]["run-1"].update(started_at=started, worker_process_baseline={"agent": "unit-boundary"})
        runner.atomic_json(self.root / "runs/complex/run-1/result.json", {
            "task_id": "complex",
            "run_id": "run-1",
            "started_at": started,
            "reason": "time_budget",
            "error": "fixture budget expired",
            "exit_code": 1,
            "marker": {"seen": False},
            "artifacts": [],
        })
        with (
            patch.object(health, "inspect_agent", return_value=({"agent_status": "idle"}, {"id": "offline-session"})),
            patch.object(health, "run_commands", return_value=[{"identity": "still-live-command"}]) as commands,
        ):
            health.reconcile(self.root)
            commands.assert_called_once()
        current = runner.read(self.root / "registry.json")
        self.assertEqual(current["projects"]["fixture"]["activeExecution"], active)
        self.assertNotIn("failure_cleanup", current["tasks"]["complex"]["runs"]["run-1"])

    def test_cancel_repeat_returns_same_checked_proof(self):
        from execution import health
        file = self.root / "runs/complex/run-1/cancellation.json"
        proof = {
            "task_id": "complex",
            "run_id": "run-1",
            "session_id": "offline-session",
            "confirmed_at": timestamp(),
        }
        runner.atomic_json(file, proof, immutable=True)
        with transaction(self.root) as registry:
            registry["projects"]["fixture"] = {}
            task = registry["tasks"]["complex"]
            task["status"] = "cancelled"
            task["runs"]["run-1"]["cancellation"] = runner.summary(file)
        self.assertEqual(health.cancel(self.root, "complex", "run-1"), proof)
        runner.atomic_json(file, {**proof, "session_id": "changed"})
        with self.assertRaisesRegex(ValueError, "证据已变化"):
            health.cancel(self.root, "complex", "run-1")

    def test_cancel_cannot_overwrite_concurrent_verification(self):
        from execution import health
        from unittest.mock import patch
        with transaction(self.root) as registry:
            registry["projects"]["fixture"] = {
                "activeExecution": {"task_id": "complex", "run_id": "run-1"},
            }
            registry["tasks"]["complex"]["status"] = "running"
            registry["tasks"]["complex"]["runs"]["run-1"]["worker_process_baseline"] = {"agent": "unit-boundary"}
        reads = 0

        def snapshot(_project):
            nonlocal reads
            reads += 1
            if reads == 2:
                with transaction(self.root) as registry:
                    registry["tasks"]["complex"]["status"] = "verified"
                    registry["projects"]["fixture"].pop("activeExecution")
            return {"agent_status": "idle"}, {"id": "offline-session"}

        with (
            patch.object(health, "inspect_agent", snapshot),
            patch.object(health, "run_commands", return_value=[]),
            patch.object(health, "stop_commands", return_value={"remaining": []}),
        ):
            with self.assertRaisesRegex(ValueError, "验收已完成"):
                health.cancel(self.root, "complex", "run-1")
        self.assertEqual(runner.read(self.root / "registry.json")["tasks"]["complex"]["status"], "verified")
        self.assertFalse((self.root / "runs/complex/run-1/cancellation.json").exists())

    def test_actual_child_cleanup_preserves_agent_and_preexisting_process(self):
        from execution import health
        from unittest.mock import patch
        anchor = runner.pid_identity(os.getpid())
        existing = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"], start_new_session=True)
        created = None

        def actual_snapshot(_project):
            return {"agent": anchor, "children": health.descendants(anchor, health.process_table()), "at": timestamp()}

        try:
            baseline = actual_snapshot(None)
            created = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"], start_new_session=True)
            with patch.object(health, "worker_processes", actual_snapshot):
                observed = health.run_commands({}, baseline)
                self.assertEqual([item["identity"]["pid"] for item in observed], [created.pid])
                proof = health.stop_commands({}, baseline, observed)
            created.wait(timeout=5)
            self.assertEqual(proof["remaining"], [])
            self.assertTrue(proof["actions"])
            self.assertIsNone(existing.poll())
            self.assertTrue(health.live(anchor))
        finally:
            for process in (created, existing):
                if process is not None and process.poll() is None:
                    process.terminate()
                    process.wait(timeout=5)

    def test_process_identity_survives_timezone_change(self):
        from execution import health, runner
        import os
        original = os.environ.get("TZ")
        try:
            os.environ["TZ"] = "UTC"
            first = runner.pid_identity(os.getpid())
            os.environ["TZ"] = "Asia/Shanghai"
            self.assertEqual(first, runner.pid_identity(os.getpid()))
            self.assertTrue(health.live(first))
            self.assertFalse(health.live(dict(first, start_ticks=first["start_ticks"] + 1)))
            self.assertFalse(health.live(dict(first, boot_id="wrong-boot")))
            self.assertFalse(health.live({"pid": os.getpid(), "birth": "legacy-unstable-wall-clock"}))
        finally:
            if original is None:
                os.environ.pop("TZ", None)
            else:
                os.environ["TZ"] = original

    def test_real_process_launch_failure_is_persisted(self):
        import time
        from unittest.mock import patch
        with transaction(self.root) as registry:
            task = registry["tasks"]["complex"]
            task["status"] = "starting"
            task["runs"]["run-1"].update(started_at=timestamp(), started_epoch=time.time(), baseline=[])
        # 真正传入不存在的执行文件，触发系统 OSError，不伪造进程退出码。
        with patch.object(runner.sys, "executable", str(self.root / "missing-python")):
            result_path = runner.run_command(self.root, "complex", "run-1", 10)
        result = runner.read(result_path)
        self.assertEqual(result["reason"], "launch_error")
        self.assertEqual(result["error"], "FileNotFoundError")
        self.assertIsNone(result["exit_code"])
        self.assertEqual(result["exit_code_source"], "process_launch_exception")
        self.assertGreater(int(result["finished_monotonic_ns"]), 0)
        self.assertEqual(runner.read(self.root / "registry.json")["tasks"]["complex"]["status"], "blocked")
    def setUp(self):
        temporary = BOT / ".cache/tmp/background-lifecycle"
        temporary.mkdir(parents=True, exist_ok=True)
        self.directory = tempfile.TemporaryDirectory(dir=temporary)
        self.root = Path(self.directory.name)
        self.owner = {
            "pid": os.getpid(),
            "session_id": "offline-session",
            "profile": "personal",
            "target": {"chatId": 123},
            "generation": "offline-owner",
            "epoch": 1,
            "leaf_id": "leaf-a",
            "main": True,
            "idle": True,
        }
        with transaction(self.root) as registry:
            registry["tasks"]["complex"] = {
                "taskId": "complex",
                "projectId": "fixture",
                "run_id": "run-1",
                "status": "ready_for_review",
                "status_changed_at": timestamp(),
                "route": {"profile": "personal", "target": {"chatId": 123}},
                "type": "herdr",
                "agent_name": "herdr-fixture",
                "workspace_id": "w-example",
                "pane_id": "w-example:p-example",
                "runs": {"run-1": {"result_path": str(self.root / "runs/complex/run-1/result.json")}},
            }
            self.eid = runner.emit(registry, registry["tasks"]["complex"], "ready_for_review")
        self.event = runner.read(self.root / "registry.json")["outbox"][self.eid]
        self.event["text"] = "离线事件数据"
        notices.enqueue(self.root, self.event["text"], "offline-fixture", self.event)

    def tearDown(self):
        self.directory.cleanup()

    def test_one_claim_wrong_owner_and_busy(self):
        self.assertIsNone(notices.claim(self.root, {**self.owner, "main": False}))
        self.assertIsNone(notices.claim(self.root, {**self.owner, "idle": False}))
        self.assertIsNone(notices.claim(self.root, {**self.owner, "target": {"chatId": 456}}))
        first = notices.claim(self.root, self.owner)
        self.assertEqual(first["event_id"], self.eid)
        self.assertIsNone(notices.claim(self.root, self.owner))
        self.assertEqual(notices.validate_notice(self.root, self.eid, first["claim_id"], self.owner)["action"], "current")
        changed = {**self.owner, "leaf_id": "leaf-b"}
        self.assertEqual(notices.validate_notice(self.root, self.eid, first["claim_id"], changed)["action"], "owner_changed")

    def test_concurrent_real_cli_claimers(self):
        cli = BOT / ".pi/extensions/background/tasks/task_protocol.py"
        command = [sys.executable, str(cli), "--root", str(self.root), "claim", "--owner", json.dumps(self.owner)]
        children = [subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE) for _ in range(6)]
        receipts = []
        for child in children:
            out, error = child.communicate(timeout=20)
            self.assertEqual(child.returncode, 0, error.decode())
            receipts.append(json.loads(out))
        self.assertEqual(sum(receipt is not None for receipt in receipts), 1)

    def test_crash_lease_and_stale_ack(self):
        now = time.time()
        first = notices.claim(self.root, self.owner, now)
        second = notices.claim(self.root, self.owner, now + 121)
        self.assertNotEqual(first["claim_id"], second["claim_id"])
        with self.assertRaises(ValueError):
            notices.receipt(self.root, self.eid, first["claim_id"], "pending")
        notices.receipt(self.root, self.eid, second["claim_id"], "enqueued", "offline-session")
        proof = self.root / "handled.json"
        runner.atomic_json(proof, {"offline": True, "event_id": self.eid})
        notices.receipt(self.root, self.eid, second["claim_id"], "handled", str(proof))
        self.assertIsNone(notices.claim(self.root, self.owner, now + 9999))

    def test_reentered_phase_and_new_run_supersede(self):
        with transaction(self.root) as registry:
            task = registry["tasks"]["complex"]
            task["status_changed_at"] = "2026-10-06T01:20:00+08:00"
            next_id = runner.emit(registry, task, "ready_for_review")
        self.assertNotEqual(next_id, self.eid)
        self.assertIsNone(notices.claim(self.root, self.owner))
        self.assertEqual(runner.read(self.root / "inbox.json")[self.eid]["state"], "superseded")

    def test_receipt_requires_evidence_and_original_binding(self):
        first = notices.claim(self.root, self.owner)
        with self.assertRaises(ValueError):
            notices.receipt(self.root, self.eid, first["claim_id"], "handled")
        with transaction(self.root) as registry:
            registry["tasks"]["complex"]["pane_id"] = "different-pane"
        self.assertEqual(notices.validate_notice(self.root, self.eid, first["claim_id"], self.owner)["action"], "superseded")

    def test_durable_notify_agent_and_bounded_text(self):
        event = copy.deepcopy(self.event)
        event.pop("text")
        command = [sys.executable, str(BOT / ".pi/extensions/background/notifications/notify-agent.py"), "长" * 1200, "offline", "--root", str(self.root), "--task-id", "complex", "--run-id", "run-1", "--event-id", self.eid, "--route", json.dumps(event["route"]), "--result-path", event["result_path"]]
        for _ in range(2):
            response = subprocess.run(command, capture_output=True, text=True, timeout=20)
            self.assertEqual(response.returncode, 0, response.stderr)
        box = runner.read(self.root / "inbox.json")
        self.assertEqual(len(box), 1)
        self.assertEqual(box[self.eid]["task_id"], "complex")
        self.assertLessEqual(len(box[self.eid]["text"]), 500)

    def test_sender_unknown_not_repeated_and_report_not_forged(self):
        module_file = BOT / ".pi/extensions/background/notifications/notify-telegram.py"
        spec = importlib.util.spec_from_file_location("offline_notifier", module_file)
        notifier = importlib.util.module_from_spec(spec)
        # 文件脚本的 task_protocol 同名导入只在此隔离测试内指向项目通知协议。
        previous = sys.modules.get("task_protocol")
        sys.modules["task_protocol"] = notices
        try:
            spec.loader.exec_module(notifier)
        finally:
            if previous is None:
                sys.modules.pop("task_protocol", None)
            else:
                sys.modules["task_protocol"] = previous
        config = self.root / "agent/telegram.json"
        runner.atomic_json(config, {"profiles": {"personal": {"botToken": "OFFLINE-NOT-A-TOKEN", "allowedUserId": 123}}})
        calls = []

        def unknown_transport(*args, **kwargs):
            calls.append(True)
            raise TimeoutError("offline transport outcome unknown")

        for _ in range(2):
            result = notifier.durable_send(self.root, "offline-final", "正文", config, "personal", opener=unknown_transport, target={"chatId": 123})
            self.assertEqual(result["state"], "unknown")
        self.assertEqual(len(calls), 1)
        with transaction(self.root) as registry:
            task = registry["tasks"]["complex"]
            task["status"] = "verified"
            task["verification"] = {"ok": True, "run_id": "run-1", "evidence": "offline-check"}
        notices.prepare_report(self.root, "complex", "run-1", notices.delivery_hash("正文"), {"chatId": 123})
        with self.assertRaises(ValueError):
            notices.report(self.root, "complex", "run-1", {"status": "success", "message_id": 999, "target": {"chatId": 123}, "event_id": "offline-final"})
        self.assertEqual(runner.read(self.root / "registry.json")["tasks"]["complex"]["status"], "verified")

    def test_first_confirmed_delivery_returns_complete_report_receipt(self):
        import urllib.parse
        spec = importlib.util.spec_from_file_location("confirmed_notifier", BOT / ".pi/extensions/background/notifications/notify-telegram.py")
        notifier = importlib.util.module_from_spec(spec)
        previous = sys.modules.get("task_protocol")
        sys.modules["task_protocol"] = notices
        try:
            spec.loader.exec_module(notifier)
        finally:
            if previous is None:
                sys.modules.pop("task_protocol", None)
            else:
                sys.modules["task_protocol"] = previous
        config = self.root / "agent/telegram.json"
        runner.atomic_json(config, {"profiles": {"personal": {"botToken": "OFFLINE-NOT-A-TOKEN", "allowedUserId": 123}}})
        with transaction(self.root) as registry:
            task = registry["tasks"]["complex"]
            task["status"] = "verified"
            task["verification"] = {"ok": True, "run_id": "run-1", "evidence": "offline-check"}
        body = "<b>A &amp; B</b> <code>engine.py</code>"
        notices.prepare_report(self.root, "complex", "run-1", notices.delivery_hash(body), {"chatId": 123})

        class Response:
            status = 200
            def __enter__(self):
                return self
            def __exit__(self, *args):
                return False
            def read(self):
                return json.dumps({
                    "ok": True,
                    "result": {
                        "message_id": 901,
                        "reply_to_message": {"message_id": 71},
                    },
                }).encode()

        def opener(request, **kwargs):
            payload = urllib.parse.parse_qs(request.data.decode())
            self.assertEqual(payload["text"], [body])
            self.assertEqual(payload["parse_mode"], ["HTML"])
            self.assertEqual(json.loads(payload["reply_parameters"][0]), {
                "message_id": 71,
                "allow_sending_without_reply": True,
            })
            return Response()
        receipt = notifier.durable_send(
            self.root, "final-complex-run-1", body, config, "personal",
            opener=opener,
            target={"chatId": 123},
            parse_mode="HTML",
            reply_to_message_id=71,
        )
        self.assertEqual(receipt["event_id"], "final-complex-run-1")
        self.assertEqual(receipt["hash"], notices.delivery_hash(body))
        self.assertEqual(receipt["reply_to_message_id"], 71)
        self.assertEqual(receipt["confirmed_reply_to_message_id"], 71)
        notices.report(self.root, "complex", "run-1", receipt)
        self.assertEqual(runner.read(self.root / "registry.json")["tasks"]["complex"]["status"], "reported")

    def test_reply_target_is_fixed_across_retries_and_invalid_ids_are_rejected(self):
        notifier = self.load_notifier()
        config = self.root / "agent/telegram.json"
        runner.atomic_json(config, {
            "profiles": {
                "personal": {
                    "botToken": "OFFLINE-NOT-A-TOKEN",
                    "allowedUserId": 123,
                },
            },
        })
        calls = []

        def ambiguous(*args, **kwargs):
            calls.append(True)
            raise TimeoutError("offline unknown delivery")

        for _ in range(2):
            result = notifier.durable_send(
                self.root, "fixed-reply", "正文", config, "personal",
                opener=ambiguous,
                target={"chatId": 123},
                reply_to_message_id=71,
            )
            self.assertEqual(result["state"], "unknown")
        with self.assertRaisesRegex(ValueError, "reply target collision"):
            notifier.durable_send(
                self.root, "fixed-reply", "正文", config, "personal",
                opener=ambiguous,
                target={"chatId": 123},
                reply_to_message_id=72,
            )
        for invalid in (0, -1, True, "71"):
            with self.assertRaisesRegex(ValueError, "invalid reply message id"):
                notifier.durable_send(
                    self.root, "invalid-reply", "正文", config, "personal",
                    opener=ambiguous,
                    target={"chatId": 123},
                    reply_to_message_id=invalid,
                )
        self.assertEqual(len(calls), 1)

    def test_missing_original_message_does_not_lose_delivery_or_claim_a_reply(self):
        notifier = self.load_notifier()
        config = self.root / "agent/telegram.json"
        runner.atomic_json(config, {
            "profiles": {
                "personal": {
                    "botToken": "OFFLINE-NOT-A-TOKEN",
                    "allowedUserId": 123,
                },
            },
        })

        class Reply:
            status = 200

            def __enter__(reply):
                return reply

            def __exit__(reply, *args):
                return False

            def read(reply):
                return b'{"ok":true,"result":{"message_id":801}}'

        result = notifier.durable_send(
            self.root, "removed-question", "正文", config, "personal",
            opener=lambda *args, **kwargs: Reply(),
            target={"chatId": 123},
            reply_to_message_id=71,
        )
        self.assertEqual(result["state"], "success")
        self.assertEqual(result["reply_to_message_id"], 71)
        self.assertIsNone(result["confirmed_reply_to_message_id"])

    def load_notifier(self):
        module = importlib.util.spec_from_file_location(
            "chunk_notifier", BOT / ".pi/extensions/background/notifications/notify-telegram.py"
        )
        notifier = importlib.util.module_from_spec(module)
        previous = sys.modules.get("task_protocol")
        sys.modules["task_protocol"] = notices
        try:
            module.loader.exec_module(notifier)
        finally:
            if previous is None:
                sys.modules.pop("task_protocol", None)
            else:
                sys.modules["task_protocol"] = previous
        return notifier

    def test_long_report_known_cooldown_resumes_without_resending_first_chunk(self):
        from unittest.mock import patch
        import urllib.parse
        notifier = self.load_notifier()
        config = self.root / "agent/telegram.json"
        runner.atomic_json(config, {
            "profiles": {"personal": {"botToken": "OFFLINE-NOT-A-TOKEN", "allowedUserId": 123}}
        })
        chunks = ["A" * 3000, "B" * 2800 + "\n────\n⏱ 7.0s · tokens ↑1k ↓50"]
        body = "".join(chunks)
        body_file = self.root / "body.txt"
        body_file.write_text(body)
        with transaction(self.root) as registry:
            task = registry["tasks"]["complex"]
            task.update(status="verified", verification={"ok": True})
        notices.prepare_report(self.root, "complex", "run-1", notices.delivery_hash(body), {"chatId": 123})
        calls = []

        class Reply:
            status = 200

            def __enter__(reply):
                return reply

            def __exit__(reply, *args):
                return False

            def read(reply):
                return json.dumps({"ok": True, "result": {"message_id": 600 + len(calls)}}).encode()

        def opener(request, **kwargs):
            payload = urllib.parse.parse_qs(request.data.decode())
            calls.append(payload["text"][0])
            self.assertEqual(json.loads(payload["reply_parameters"][0])["message_id"], 71)
            return Reply()

        args = (self.root, "final-complex-run-1", body, config, "personal")
        first = notifier.durable_send(*args, opener=opener, target={"chatId": 123}, parse_mode="HTML", chunks=chunks, reply_to_message_id=71)
        self.assertEqual(first["state"], "failed")
        self.assertEqual(first["reason"], "local_cooldown")
        self.assertEqual(first["message_ids"], [601])
        next_time = time.time() + 10
        with patch.object(notifier.time, "time", return_value=next_time):
            final = notifier.durable_send(*args, opener=opener, target={"chatId": 123}, parse_mode="HTML", chunks=chunks, reply_to_message_id=71)
            again = notifier.durable_send(*args, opener=opener, target={"chatId": 123}, parse_mode="HTML", chunks=chunks, reply_to_message_id=71)
        self.assertEqual(calls, chunks)
        self.assertEqual(final["state"], "success")
        self.assertEqual(final["message_ids"], [601, 602])
        self.assertEqual(final["hash"], notices.delivery_hash(body))
        self.assertEqual(again, final)
        self.assertTrue(final["boot_id"])
        self.assertEqual(final["reply_to_message_id"], 71)
        notices.report(self.root, "complex", "run-1", final)
        self.assertEqual(runner.read(self.root / "registry.json")["tasks"]["complex"]["status"], "reported")

    def test_long_report_unknown_second_chunk_is_not_resent(self):
        notifier = self.load_notifier()
        config = self.root / "agent/telegram.json"
        runner.atomic_json(config, {
            "profiles": {"personal": {"botToken": "OFFLINE-NOT-A-TOKEN", "allowedUserId": 123}}
        })
        chunks = ["A" * 3000, "B" * 3000]
        calls = []

        class Reply:
            status = 200

            def __enter__(reply):
                return reply

            def __exit__(reply, *args):
                return False

            def read(reply):
                return b'{"ok":true,"result":{"message_id":701}}'

        def opener(*args, **kwargs):
            calls.append(True)
            if len(calls) == 2:
                raise TimeoutError("offline ambiguous second chunk")
            directory, key = notifier.cooldown_guard(config, "personal", "OFFLINE-NOT-A-TOKEN", 123)
            with notices.transaction(directory, "notification-cooldowns.json") as cooldowns:
                cooldowns[key] = 0
            return Reply()

        for _ in range(2):
            result = notifier.durable_send(self.root, "long-unknown", "".join(chunks), config, "personal", opener=opener, target={"chatId": 123}, parse_mode="HTML", chunks=chunks)
            self.assertEqual(result["state"], "unknown")
            self.assertEqual(result["message_ids"], [701])
        self.assertEqual(len(calls), 2)
        self.assertNotIn("status", result)
        self.assertNotIn("message_id", result)


if __name__ == "__main__":
    unittest.main(verbosity=2)
