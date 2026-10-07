# 项目归档离线回归：真实 Git、文件、SQLite、写锁和 CLI 验证成果保全、归档围栏与中断恢复；关联 background/projects/archive.py，不操作既有项目或调用模型/TG。
import copy
import fcntl
import json
import os
import signal
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

BOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(BOT / ".pi/extensions/background"))
from execution import codex, dispatch, health, runner, service
from notifications import task_protocol as notices
from projects import archive as lifecycle
from projects.registry import get, operation, register
from storage.registry import timestamp, transaction
from tasks import task_protocol as frontend
from worktrees.check import git, worktrees
from worktrees.manage import ensure


class Archive(unittest.TestCase):
    def setUp(self):
        temporary = BOT / ".cache/tmp"
        temporary.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="project-archive-", dir=temporary)
        self.base = Path(self.temp.name)
        self.root = self.base / "background"
        self.source = self.base / "original 项目"
        self.source.mkdir()
        subprocess.run(["git", "init", "-q", "-b", "main", str(self.source)], check=True)
        git(self.source, "config", "user.name", "Offline Archive Fixture")
        git(self.source, "config", "user.email", "archive-fixture@example.invalid")
        (self.source / "tracked.txt").write_text("initial\n")
        (self.source / ".gitignore").write_text("ignored/\n")
        git(self.source, "add", ".")
        git(self.source, "commit", "-qm", "isolated fixture")
        self.target = BOT / ".worktrees" / self.base.name
        self.project = {
            "projectId": "demo",
            "sourcePath": str(self.source),
            "worktreePath": str(self.target),
            "branch": "bot/archive-fixture",
            "agentKind": "codex",
        }
        register(self.root, self.project)
        ensure(self.root, "demo", "main")
        (self.target / "tracked.txt").write_text("staged\n")
        git(self.target, "add", "tracked.txt")
        (self.target / "tracked.txt").write_text("unstaged\n")
        (self.target / ".hidden").write_bytes(b"\x00\x01private fixture")
        (self.target / "ignored").mkdir()
        (self.target / "ignored/cache.bin").write_bytes(b"ignored but retained")
        (self.target / "empty").mkdir()
        (self.target / "external-link").symlink_to(self.source / "tracked.txt")
        self.before = lifecycle.inventory(self.target)
        self.source_head = git(self.source, "rev-parse", "HEAD")
        self.home = self.root / "codex/demo"
        self.home.mkdir(parents=True)
        self.sid = "offline-uuid-demo"
        self.rollout = self.home / "sessions/2026/10/07/rollout-demo.jsonl"
        self.rollout.parent.mkdir(parents=True)
        self.rollout.write_text(json.dumps({
            "type": "session_meta",
            "payload": {"id": self.sid, "cwd": str(self.target)},
        }) + "\n")
        (self.home / "config.toml").write_text('model_provider = "fixture"\n')
        with closing(sqlite3.connect(self.home / "state_5.sqlite")) as database, database:
            database.execute("CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, rollout_path TEXT)")
            database.execute("INSERT INTO threads VALUES (?, ?, ?)", (self.sid, "herdr-demo", str(self.rollout)))
        self.browser = self.root / "codex-session-browser"
        self.browser.mkdir()
        with closing(sqlite3.connect(self.browser / "state_5.sqlite")) as database, database:
            database.execute("CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, rollout_path TEXT)")
            database.executemany("INSERT INTO threads VALUES (?, ?, ?)", [
                (self.sid, "herdr-demo", str(self.rollout)),
                ("other-session", "herdr-other", "other-file"),
            ])
        link = self.browser / "sessions/rollout-demo.jsonl"
        link.parent.mkdir()
        link.symlink_to(self.rollout)
        runner.atomic_json(self.root / "tasks/task-a/spec.json", {"private": "original task"})
        runner.atomic_json(self.root / "runs/task-a/run-a/business.json", {"private": "original result"})
        with transaction(self.root) as registry:
            registry["projects"]["demo"].update({
                "sessionId": self.sid,
                "executionSettings": {"agent": {"home": str(self.home)}},
            })
            registry["projects"]["other"] = {
                "projectId": "other", "sourcePath": str(self.base / "other-source"),
                "worktreePath": str(BOT / ".worktrees" / (self.base.name + "-other")),
                "agentKind": "codex", "sessionId": "other-session",
            }
            registry["tasks"]["task-a"] = {
                "taskId": "task-a", "projectId": "demo", "status": "blocked",
                "run_id": "run-a", "runs": {"run-a": {}},
            }
            registry["tasks"]["other-task"] = {
                "taskId": "other-task", "projectId": "other", "status": "registered",
            }
            registry["outbox"] = {
                "owned-event": {"event_id": "owned-event", "task_id": "task-a", "run_id": "run-a", "phase": "blocked", "targets": {
                    "agent": {"state": "pending"}, "telegram": {"state": "failed"},
                }},
                "other-event": {"event_id": "other-event", "task_id": "other-task", "targets": {}},
            }
        with notices.transaction(self.root, "inbox.json") as box:
            box["owned-event"] = {
                "event_id": "owned-event", "task_id": "task-a", "run_id": "run-a",
                "phase": "blocked", "state": "pending", "ts": 1, "attempts": 0,
            }
        self.other = runner.read(self.root / "registry.json")["projects"]["other"]

    def tearDown(self):
        if self.target.exists():
            git(self.source, "worktree", "remove", "--force", str(self.target))
        self.temp.cleanup()

    def archive(self):
        return lifecycle.archive(self.root, "demo")

    def test_preserves_real_changes_native_home_and_other_project(self):
        original_home_inode = self.home.stat().st_ino
        result = self.archive()
        destination = Path(result["path"])
        self.assertEqual(result["state"], "archived")
        self.assertEqual(lifecycle.inventory(destination / "worktree"), self.before)
        self.assertEqual((destination / "worktree-index").read_bytes()[:4], b"DIRC")
        self.assertEqual((destination / "tasks/task-a/spec.json").read_bytes(), b'{\n  "private": "original task"\n}\n')
        self.assertTrue((destination / "runs/task-a/run-a/business.json").is_file())
        self.assertFalse(self.target.exists())
        self.assertFalse(any(entry["path"] == str(self.target) for entry in worktrees(self.source)))
        self.assertEqual(git(self.source, "rev-parse", "HEAD"), self.source_head)
        self.assertEqual((self.source / "tracked.txt").read_text(), "initial\n")
        self.assertEqual(git(self.source, "rev-parse", "bot/archive-fixture"), self.source_head)
        home = destination / "coding-agent-home"
        self.assertEqual(home.stat().st_ino, original_home_inode)
        self.assertEqual(codex.sessions(home, self.target)[0]["id"], self.sid)
        self.assertEqual(codex.title(home, self.sid), "herdr-demo")
        self.assertFalse(self.home.exists())
        registry = runner.read(self.root / "registry.json")
        self.assertEqual(registry["projects"]["other"], self.other)
        self.assertEqual(registry["outbox"]["other-event"]["targets"], {})
        self.assertEqual(registry["tasks"]["task-a"]["status"], "blocked")
        self.assertEqual(notices.freshness(registry, registry["outbox"]["owned-event"])[1], "project_archived")
        self.assertEqual(runner.read(self.root / "inbox.json")["owned-event"]["state"], "superseded")
        with closing(sqlite3.connect(self.browser / "state_5.sqlite")) as database:
            self.assertEqual(database.execute("SELECT id FROM threads").fetchall(), [("other-session",)])
        self.assertFalse((self.browser / "sessions/rollout-demo.jsonl").is_symlink())
        manifest = runner.read(destination / "manifest.json")
        self.assertTrue(manifest["finishedAt"].endswith("+08:00"))
        self.assertEqual((destination / "manifest.json").stat().st_mode & 0o777, 0o600)

    def test_repeat_is_idempotent_and_corrupt_evidence_is_refused(self):
        result = self.archive()
        self.assertEqual(self.archive()["path"], result["path"])
        self.assertTrue(self.archive()["alreadyArchived"])
        self.assertEqual(len(list((self.root / "archives").iterdir())), 1)
        (Path(result["path"]) / "manifest.json").write_text("{}")
        with self.assertRaisesRegex(ValueError, "证据缺失或变化"):
            self.archive()

    def test_all_dispatch_and_registration_paths_refuse_archived_project(self):
        self.archive()
        request = {**self.project, "projectId": "another-id", "worktreePath": str(self.target) + "-new"}
        with self.assertRaisesRegex(ValueError, "已归档"):
            register(self.root, request)
        with transaction(self.root) as registry:
            with self.assertRaisesRegex(ValueError, "已归档"):
                get(registry, "demo")
        with self.assertRaisesRegex(ValueError, "已归档"):
            dispatch.bind_project(self.root, "demo")
        with self.assertRaisesRegex(ValueError, "已归档"):
            health.retry(self.root, "task-a")
        with self.assertRaisesRegex(ValueError, "已归档"):
            frontend.prepare(self.root, "task-a")
        with self.assertRaisesRegex(ValueError, "已归档"):
            with notices.notification_receipts(self.root, "final-task-a-run-a"):
                self.fail("archived final sender admitted")
        visible = frontend.inspect(self.root)
        self.assertNotIn("demo", visible["projects"])
        self.assertNotIn("task-a", visible["tasks"])
        self.assertIn("demo", visible["archivedProjects"])
        with patch.object(service, "recover_project") as recover:
            service.recover(self.root)
        recover.assert_not_called()
        with patch.object(health, "probe") as probe:
            health.reconcile(self.root)
        probe.assert_not_called()

    def test_activity_and_unresolved_notifications_refuse_before_any_move(self):
        modifications = [
            lambda reg, box, ledger: reg["projects"]["demo"].update(activeExecution={"task_id": "task-a", "run_id": "run-a"}),
            lambda reg, box, ledger: reg["tasks"]["task-a"].update(status="ready_for_review"),
            lambda reg, box, ledger: reg["tasks"]["task-a"].update(status="verified"),
            lambda reg, box, ledger: reg["outbox"]["owned-event"]["targets"]["telegram"].update(state="sending"),
            lambda reg, box, ledger: box["owned-event"].update(state="enqueued"),
            lambda reg, box, ledger: box["owned-event"].update(attention_required="delivery_unknown"),
            lambda reg, box, ledger: ledger.update(uncertain={"event_id": "final-task-a-run-a:part-2", "state": "unknown"}),
        ]
        original = runner.read(self.root / "registry.json")
        original_box = runner.read(self.root / "inbox.json")
        for modify in modifications:
            with self.subTest(modify=modify):
                runner.atomic_json(self.root / "registry.json", original)
                runner.atomic_json(self.root / "inbox.json", original_box)
                runner.atomic_json(self.root / "telegram-receipts.json", {})
                with notices.registry_inbox(self.root) as (reg, box):
                    with notices.transaction(self.root, "telegram-receipts.json") as ledger:
                        modify(reg, box, ledger)
                with self.assertRaises(ValueError):
                    self.archive()
                self.assertNotIn("archive", runner.read(self.root / "registry.json")["projects"]["demo"])
                self.assertTrue(self.home.is_dir())
                self.assertEqual(lifecycle.inventory(self.target), self.before)

    def test_native_writer_lock_is_never_deleted_or_bypassed(self):
        path = self.home / "thread-writer-locks" / (self.sid + ".lock")
        path.parent.mkdir()
        with path.open("w+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            with self.assertRaisesRegex(ValueError, "客户端占用"):
                self.archive()
            self.assertTrue(path.exists())
            self.assertTrue(self.home.is_dir())
        self.assertEqual(self.archive()["state"], "archived")

    def test_mid_archive_failure_blocks_new_work_and_resumes_same_archive(self):
        real_git = lifecycle.git
        def fail_remove(directory, *args, **options):
            if "remove" in args:
                raise ValueError("offline interruption before Git removal")
            return real_git(directory, *args, **options)
        with patch.object(lifecycle, "git", side_effect=fail_remove):
            with self.assertRaisesRegex(ValueError, "interruption"):
                self.archive()
        marker = runner.read(self.root / "registry.json")["projects"]["demo"]["archive"]
        self.assertEqual(marker["state"], "archiving")
        self.assertFalse(self.home.exists())
        self.assertTrue(self.target.exists())
        with self.assertRaisesRegex(ValueError, "归档尚未完成"):
            register(self.root, self.project)
        completed = self.archive()
        self.assertEqual(completed["path"], marker["path"])
        self.assertEqual(len(list((self.root / "archives").iterdir())), 1)

    def test_interrupted_copy_resumes_without_losing_original_or_reusing_session(self):
        real_copy = shutil.copytree
        def partial_copy(source, destination, **options):
            Path(destination).mkdir()
            shutil.copyfile(Path(source) / "tracked.txt", Path(destination) / "tracked.txt")
            raise OSError("offline interruption during copy")
        with patch.object(lifecycle.shutil, "copytree", side_effect=partial_copy):
            with self.assertRaises(OSError):
                self.archive()
        marker = runner.read(self.root / "registry.json")["projects"]["demo"]["archive"]
        self.assertTrue(self.home.is_dir())
        self.assertEqual(lifecycle.inventory(self.target), self.before)
        with patch.object(lifecycle.shutil, "copytree", side_effect=real_copy):
            result = self.archive()
        self.assertEqual(result["path"], marker["path"])
        self.assertEqual(lifecycle.inventory(Path(result["path"]) / "worktree"), self.before)

    def test_close_only_exact_idle_native_client_and_verify_actual_exit(self):
        code = "\n".join([
            "import fcntl, pathlib, time",
            "lock = pathlib.Path('" + str(self.home / 'thread-writer-locks') + "')",
            "lock.mkdir(exist_ok=True)",
            "with (lock / '" + self.sid + ".lock').open('a+') as stream:",
            "    fcntl.flock(stream, fcntl.LOCK_EX)",
            "    pathlib.Path('" + str(self.base / 'client-ready') + "').touch()",
            "    try:",
            "        time.sleep(60)",
            "    except KeyboardInterrupt:",
            "        pass",
        ])
        process = subprocess.Popen([sys.executable, "-c", code], cwd=self.target, env={**os.environ, "CODEX_HOME": str(self.home)})
        import time
        deadline = time.monotonic() + 5
        while not (self.base / "client-ready").exists() and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertTrue((self.base / "client-ready").exists())
        agent = {
            "name": "herdr-demo", "agent": "codex", "workspace_id": "fixture-workspace",
            "pane_id": "fixture-pane", "cwd": str(self.target), "agent_status": "idle",
            "agent_session": {"kind": "id", "value": self.sid},
        }
        with transaction(self.root) as registry:
            registry["projects"]["demo"]["herdr"] = {
                "agent_name": agent["name"], "workspace_id": agent["workspace_id"], "pane_id": agent["pane_id"],
            }
        inputs = []
        def control(settings, *args):
            if args == ("agent", "list"):
                return {"result": {"agents": [agent] if process.poll() is None else []}}
            if args == ("agent", "get", "herdr-demo"):
                return {"result": {"agent": agent}}
            if args == ("agent", "send-keys", "herdr-demo", "ctrl+c", "ctrl+c"):
                inputs.append(args)
                process.send_signal(signal.SIGINT)
                return {"result": {"sent": True}}
            if args == ("pane", "process-info", "--pane", "fixture-pane"):
                return {"result": {"process_info": {
                    "shell_pid": 1, "foreground_process_group_id": 1, "foreground_processes": [{"pid": 1}],
                }}}
            self.fail(f"unexpected controller operation {args}")
        observed = {"agent": runner.pid_identity(process.pid), "children": [], "internal_processes": []}
        try:
            with patch.object(dispatch, "control", side_effect=control), patch.object(health, "worker_processes", return_value=observed):
                result = self.archive()
            self.assertEqual(result["state"], "archived")
            self.assertEqual(len(inputs), 1)
            self.assertEqual(process.wait(timeout=5), 0)
        finally:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=5)

    def test_changes_after_snapshot_refuse_removal_and_keep_both_versions(self):
        with patch.object(lifecycle, "detach_worktree", side_effect=ValueError("offline pause")):
            with self.assertRaises(ValueError):
                self.archive()
        (self.target / "tracked.txt").write_text("new edit after pause")
        with self.assertRaisesRegex(ValueError, "又有改动"):
            self.archive()
        self.assertEqual((self.target / "tracked.txt").read_text(), "new edit after pause")
        marker = runner.read(self.root / "registry.json")["projects"]["demo"]["archive"]
        self.assertEqual((Path(marker["path"]) / "worktree/tracked.txt").read_text(), "unstaged\n")

    def test_browser_and_project_operation_locks_refuse_concurrent_action(self):
        with (self.browser / "browser.lock").open("w+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            with self.assertRaisesRegex(ValueError, "浏览器仍打开"):
                self.archive()
        with operation(self.root, "demo"):
            with self.assertRaisesRegex(ValueError, "正在绑定、恢复或归档"):
                self.archive()
        self.assertNotIn("archive", runner.read(self.root / "registry.json")["projects"]["demo"])

    def test_real_business_process_is_preserved_and_archive_can_continue_after_exit(self):
        process = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"], cwd=self.target)
        try:
            with self.assertRaisesRegex(ValueError, "进程使用项目 worktree"):
                self.archive()
            self.assertIsNone(process.poll())
            self.assertTrue(self.target.is_dir())
        finally:
            process.terminate()
            process.wait(timeout=5)
        self.assertEqual(self.archive()["state"], "archived")

    def test_preview_and_real_cli_archive_do_not_initialize_or_dispatch(self):
        command = [sys.executable, str(BOT / ".pi/extensions/background/tasks/task_protocol.py"), "--root", str(self.root)]
        before = (self.root / "registry.json").read_bytes()
        preview = subprocess.run([*command, "project-archive", "demo", "--preview"], capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(preview.stdout)["sessionId"], self.sid)
        self.assertEqual((self.root / "registry.json").read_bytes(), before)
        result = subprocess.run([*command, "project-archive", "demo"], capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(result.stdout)["state"], "archived")
        self.assertEqual(lifecycle.inventory(Path(json.loads(result.stdout)["path"]) / "worktree"), self.before)
        spec = self.base / "project.json"
        spec.write_text(json.dumps(self.project))
        failure = subprocess.run([*command, "project-register", "demo", "--spec", str(spec)], capture_output=True, text=True)
        self.assertEqual(failure.returncode, 1)
        self.assertIn("已归档", json.loads(failure.stderr)["message"])

    def test_registered_only_project_can_archive_without_git_initialization(self):
        source = self.base / "not-started"
        source.mkdir()
        (source / "notes.txt").write_text("preserve existing content")
        request = {
            "projectId": "not-started",
            "sourcePath": str(source),
            "worktreePath": str(self.target) + "-not-started",
            "branch": "bot/not-started",
            "agentKind": "codex",
        }
        register(self.root, request)
        result = lifecycle.archive(self.root, "not-started")
        self.assertEqual(result["state"], "archived")
        self.assertFalse((source / ".git").exists())
        self.assertEqual((source / "notes.txt").read_text(), "preserve existing content")
        self.assertTrue(self.home.exists())
        self.assertEqual(lifecycle.inventory(self.target), self.before)

    def test_busy_unknown_and_mismatched_native_clients_are_not_closed(self):
        agent = {
            "name": "herdr-demo",
            "agent": "codex",
            "workspace_id": "fixture-workspace",
            "pane_id": "fixture-pane",
            "cwd": str(self.target),
            "agent_status": "idle",
            "agent_session": {"kind": "id", "value": self.sid},
        }
        with transaction(self.root) as registry:
            registry["projects"]["demo"]["herdr"] = {
                "agent_name": agent["name"],
                "workspace_id": agent["workspace_id"],
                "pane_id": agent["pane_id"],
            }
        for changes in (
            {"agent_status": "working"},
            {"agent_status": "blocked"},
            {"agent_status": "unknown"},
            {"agent_session": {"kind": "id", "value": "other-session"}},
            {"workspace_id": "other-workspace"},
            {"cwd": str(self.source)},
        ):
            current = {**copy.deepcopy(agent), **changes}
            def control(settings, *args):
                if args == ("agent", "list"):
                    return {"result": {"agents": [current]}}
                if args == ("agent", "get", "herdr-demo"):
                    return {"result": {"agent": current}}
                self.fail(f"unexpected controller operation {args}")
            with self.subTest(changes=changes), patch.object(dispatch, "control", side_effect=control):
                with self.assertRaises(ValueError):
                    self.archive()
            self.assertNotIn("archive", runner.read(self.root / "registry.json")["projects"]["demo"])
            self.assertTrue(self.home.is_dir())
            self.assertEqual(lifecycle.inventory(self.target), self.before)


if __name__ == "__main__":
    unittest.main(verbosity=2)
