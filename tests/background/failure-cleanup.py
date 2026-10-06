# 后台失败收尾回归：使用真实 Linux 进程验证内部 host、业务后代、取消保护与范围；关联 execution/{codex,health,herdr}.py，不调用模型或 TG。
import contextlib
import os
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

BOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(BOT / ".pi/extensions/background"))
from execution import codex, health, herdr, runner
from storage.registry import timestamp, transaction


class FailureCleanup(unittest.TestCase):
    def setUp(self):
        temporary = BOT / ".cache/tmp/background-failure-cleanup"
        temporary.mkdir(parents=True, exist_ok=True)
        self.directory = tempfile.TemporaryDirectory(dir=temporary)
        self.root = Path(self.directory.name)

    def tearDown(self):
        self.directory.cleanup()

    def line(self, process):
        self.assertTrue(select.select([process.stdout], [], [], 3)[0], "进程夹具启动超时")
        return process.stdout.readline().strip()

    @contextlib.contextmanager
    def processes(self, untrusted=False):
        # 本地 ELF 进程夹具；只替代 Herdr 读取边界，内核父子关系、exe 和进程组均为真实数据。
        binary = self.root / "bin"
        binary.mkdir()
        agent_file = binary / "codex"
        host_file = binary / "codex-code-mode-host"
        shutil.copyfile(Path("/bin/sh").resolve(), agent_file)
        shutil.copyfile(Path("/bin/sh").resolve(), host_file)
        agent_file.chmod(0o700)
        host_file.chmod(0o700)
        actual_host = host_file
        if untrusted:
            elsewhere = self.root / "business"
            elsewhere.mkdir()
            actual_host = elsewhere / host_file.name
            shutil.copyfile(host_file, actual_host)
            actual_host.chmod(0o700)
        host_script = r"""
read -r mode
if [ "$mode" = spawn ]; then
    sleep 60 &
    printf 'COMMAND %s\n' "$!"
elif [ "$mode" = isolated ]; then
    setsid sleep 60 &
    printf 'COMMAND %s\n' "$!"
fi
read -r done
wait
"""
        agent_script = r"""
printf 'READY\n'
read -r start
setsid "$1" -c "$2" <&"$3" &
printf 'HOST %s\n' "$!"
wait
"""
        read_fd, write_fd = os.pipe()
        host_input = os.fdopen(write_fd, "w")
        process = subprocess.Popen(
            [str(agent_file), "-c", agent_script, "fixture", str(actual_host), host_script, str(read_fd)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
            pass_fds=(read_fd,),
        )
        os.close(read_fd)
        host_pid = None
        host_identity = None
        spawned = []
        try:
            self.assertEqual(self.line(process), "READY")
            anchor = runner.pid_identity(process.pid)

            def snapshot(_project):
                children = health.descendants(anchor, health.process_table())
                return {
                    "agent": anchor,
                    "children": children,
                    "internal_processes": codex.internal_processes(anchor, children),
                    "at": timestamp(),
                }

            baseline = snapshot(None)
            self.assertEqual(baseline["children"], [])
            process.stdin.write("start\n")
            process.stdin.flush()
            label, value = self.line(process).split()
            self.assertEqual(label, "HOST")
            host_pid = int(value)
            host_identity = runner.pid_identity(host_pid)
            deadline = time.monotonic() + 3
            while Path(f"/proc/{host_pid}/exe").resolve() != actual_host:
                self.assertLess(time.monotonic(), deadline, "host executable 未就绪")
                time.sleep(0.01)
            yield process, host_pid, baseline, snapshot, host_input, spawned
        finally:
            for identity in spawned:
                if identity is not None and health.live(identity):
                    health.signal_identity(identity, signal.SIGTERM)
            if host_identity is not None and health.live(host_identity):
                try:
                    os.killpg(host_pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=3)
            process.stdin.close()
            process.stdout.close()
            process.stderr.close()
            host_input.close()

    def failed_run(self, baseline):
        started = timestamp()
        with transaction(self.root) as registry:
            registry["projects"]["fixture"] = {
                "agentKind": "codex",
                "sessionId": "fixed-session",
                "activeExecution": {"task_id": "old", "run_id": "run-1"},
            }
            registry["tasks"]["old"] = {
                "taskId": "old",
                "projectId": "fixture",
                "run_id": "run-1",
                "status": "blocked",
                "status_changed_at": timestamp(),
                "runs": {
                    "run-1": {
                        "started_at": started,
                        "worker_process_baseline": baseline,
                    },
                },
            }
            registry["tasks"]["next"] = {
                "taskId": "next",
                "projectId": "fixture",
                "status": "registered",
            }
        runner.atomic_json(self.root / "runs/old/run-1/result.json", {
            "task_id": "old",
            "run_id": "run-1",
            "started_at": started,
            "exit_code": 1,
            "reason": "error",
            "error": "actual failed result fixture",
        })

    def test_internal_host_releases_failed_slot_and_preserves_next_task(self):
        with self.processes() as (process, host_pid, baseline, snapshot, _host_input, _spawned):
            self.failed_run(baseline)
            with (
                patch.object(health, "worker_processes", snapshot),
                patch.object(health, "inspect_agent", return_value=({"agent_status": "done"}, {"id": "fixed-session"})),
            ):
                self.assertEqual(health.run_commands({}, baseline), [])
                health.reconcile(self.root)
            registry = runner.read(self.root / "registry.json")
            self.assertNotIn("activeExecution", registry["projects"]["fixture"])
            self.assertEqual(registry["projects"]["fixture"]["sessionId"], "fixed-session")
            self.assertEqual(registry["tasks"]["old"]["status"], "blocked")
            self.assertIn("failure_cleanup", registry["tasks"]["old"]["runs"]["run-1"])
            self.assertEqual(registry["tasks"]["next"]["status"], "registered")
            self.assertNotIn("runs", registry["tasks"]["next"])
            self.assertIsNone(process.poll())
            self.assertTrue(health.live(runner.pid_identity(host_pid)))

    def test_existing_host_does_not_hide_business_child_in_same_group(self):
        with self.processes() as (process, host_pid, _baseline, snapshot, host_input, _spawned):
            baseline = snapshot(None)
            self.assertEqual(len(baseline["internal_processes"]), 1)
            host_input.write("spawn\n")
            host_input.flush()
            label, child = self.line(process).split()
            self.assertEqual(label, "COMMAND")
            child_pid = int(child)
            with patch.object(health, "worker_processes", snapshot):
                commands = health.run_commands({}, baseline)
                self.assertEqual([item["identity"]["pid"] for item in commands], [child_pid])
                with self.assertRaisesRegex(ValueError, "不终止内部 host"):
                    health.stop_commands({}, baseline, commands)
            self.assertTrue(health.live(runner.pid_identity(host_pid)))
            self.assertTrue(health.live(runner.pid_identity(child_pid)))

    def test_same_named_business_executable_is_not_trusted(self):
        with self.processes(untrusted=True) as (_process, host_pid, baseline, snapshot, _host_input, _spawned):
            self.assertEqual(snapshot(None)["internal_processes"], [])
            with patch.object(health, "worker_processes", snapshot):
                commands = health.run_commands({}, baseline)
            self.assertEqual([item["identity"]["pid"] for item in commands], [host_pid])

    def test_live_business_child_keeps_slot_and_records_reason(self):
        with self.processes() as (process, _host_pid, baseline, snapshot, host_input, _spawned):
            host_input.write("spawn\n")
            host_input.flush()
            self.line(process)
            self.failed_run(baseline)
            with (
                patch.object(health, "worker_processes", snapshot),
                patch.object(health, "inspect_agent", return_value=({"agent_status": "idle"}, {"id": "fixed-session"})),
            ):
                health.reconcile(self.root)
            registry = runner.read(self.root / "registry.json")
            self.assertIn("activeExecution", registry["projects"]["fixture"])
            run = registry["tasks"]["old"]["runs"]["run-1"]
            self.assertNotIn("failure_cleanup", run)
            self.assertEqual(run["failure_cleanup_observation"]["reason"], "commands_still_running")
            self.assertEqual(len(run["failure_cleanup_observation"]["command_processes"]), 1)

    def test_cancel_stops_isolated_business_command_without_killing_host(self):
        with self.processes() as (process, host_pid, baseline, snapshot, host_input, spawned):
            host_input.write("isolated\n")
            host_input.flush()
            label, child = self.line(process).split()
            self.assertEqual(label, "COMMAND")
            child_pid = int(child)
            spawned.append(runner.pid_identity(child_pid))
            deadline = time.monotonic() + 3
            while health.process_table()[child_pid]["process_group"] != child_pid:
                self.assertLess(time.monotonic(), deadline)
                time.sleep(0.01)
            with patch.object(health, "worker_processes", snapshot):
                commands = health.run_commands({}, baseline)
                proof = health.stop_commands({}, baseline, commands)
            self.assertEqual(proof["remaining"], [])
            self.assertTrue(proof["actions"])
            self.assertTrue(health.live(runner.pid_identity(host_pid)))
            self.assertIsNone(process.poll())

    def test_parent_and_kernel_identity_are_required_for_internal_host(self):
        with self.processes() as (_process, _host_pid, baseline, snapshot, _host_input, _spawned):
            current = snapshot(None)
            item = current["children"][0]
            self.assertEqual(codex.internal_processes(baseline["agent"], [{**item, "parent_pid": 0}]), [])
            stale = {**item, "identity": {**item["identity"], "start_ticks": item["identity"]["start_ticks"] + 1}}
            self.assertEqual(codex.internal_processes(baseline["agent"], [stale]), [])
            with self.assertRaisesRegex(ValueError, "原 Codex 身份变化"):
                codex.internal_processes({**baseline["agent"], "boot_id": "wrong-boot"}, current["children"])

    def test_inspection_error_keeps_slot_and_records_stage(self):
        self.failed_run({"agent": "fixture"})
        with patch.object(health, "inspect_agent", side_effect=ValueError("identity mismatch")):
            health.reconcile(self.root)
        registry = runner.read(self.root / "registry.json")
        self.assertIn("activeExecution", registry["projects"]["fixture"])
        reason = registry["tasks"]["old"]["runs"]["run-1"]["failure_cleanup_observation"]
        self.assertEqual(reason["reason"], "inspection_failed")
        self.assertEqual(reason["step"], "agent_identity")
        self.assertEqual(reason["error_type"], "ValueError")

    def test_cancel_and_live_supervisor_keep_slot_without_inspection(self):
        for field, value, reason in (
            ("cancel_intent", {"run_id": "run-1"}, "cancellation_in_progress"),
            ("runner_pid_identity", runner.pid_identity(os.getpid()), "supervisor_running"),
        ):
            with self.subTest(reason=reason):
                self.failed_run({"agent": "fixture"})
                with transaction(self.root) as registry:
                    registry["tasks"]["old"]["runs"]["run-1"][field] = value
                with patch.object(health, "inspect_agent", side_effect=AssertionError("must not inspect")):
                    health.reconcile(self.root)
                registry = runner.read(self.root / "registry.json")
                self.assertIn("activeExecution", registry["projects"]["fixture"])
                run = registry["tasks"]["old"]["runs"]["run-1"]
                self.assertEqual(run["failure_cleanup_observation"]["reason"], reason)
                self.assertNotIn("failure_cleanup", run)

    def test_full_worktree_scope_and_existing_file_directory_boundaries(self):
        for path in ("README.md", "game.js", "outputs/gameplay.png"):
            self.assertTrue(herdr.within_scope(path, ["**/*"]))
        for path in ("/tmp/outside", "../outside", "src/../../outside", "."):
            self.assertFalse(herdr.within_scope(path, ["**/*"]))
        self.assertTrue(herdr.within_scope("src/game.js", ["src/"]))
        self.assertTrue(herdr.within_scope("README.md", ["./README.md"]))
        self.assertFalse(herdr.within_scope("README.md.bak", ["README.md"]))
        self.assertFalse(herdr.within_scope("src-other/game.js", ["src"]))
        self.assertFalse(herdr.within_scope("outputs/gameplay.png", ["src"]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
