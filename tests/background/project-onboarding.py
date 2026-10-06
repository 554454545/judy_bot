# 新项目接入回归：验证默认运行参数、失败不留登记及多轮原话身份；关联 execution/settings.py、herdr.py、tasks/task_protocol.py，真实链路另见 project-onboarding-live.mjs。
import copy
import fcntl
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from contextlib import closing
from unittest.mock import patch

sys.dont_write_bytecode = True
BOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(BOT / ".pi/extensions/background"))
from execution import codex, herdr, settings
from storage.registry import transaction
from tasks import task_protocol


class Onboarding(unittest.TestCase):
    def browser_fixture(self, root):
        background = root / ".pi/agent/background"
        projects = {}
        for name, session_id in (
            ("alpha", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
            ("beta", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
            ("empty", None),
            ("unregistered", "cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
        ):
            home = background / "codex" / name
            home.mkdir(parents=True)
            (home / "config.toml").write_text('model_provider = "fixture"\n')
            rollout = None
            with closing(sqlite3.connect(home / "state_5.sqlite")) as database, database:
                database.execute("CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, archived INTEGER)")
                if session_id:
                    folder = home / ("archived_sessions" if name == "beta" else "sessions/2026/10/06")
                    folder.mkdir(parents=True)
                    rollout = folder / ("rollout-" + session_id + ".jsonl")
                    rollout.write_text(json.dumps({
                        "type": "session_meta",
                        "payload": {
                            "id": session_id,
                            "cwd": str(root),
                        },
                    }) + "\n")
                    database.execute("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)", (
                        session_id, "herdr-" + name, str(rollout), 100, 200, int(name == "beta"),
                    ))
            projects[name] = {
                "agentKind": "codex",
                "sessionId": session_id,
                "sessionFile": str(rollout) if rollout else None,
                "executionSettings": {
                    "agent": {
                        "home": str(home),
                        "binary": "fixture-codex",
                    },
                },
            }
        # 未登记 home 和同一已登记 home 的其他 UUID 都不应进入原生列表。
        del projects["unregistered"]
        (background / "codex/unregistered/config.toml").write_text('model_provider = "unused-provider"\n')
        unrelated_id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
        unrelated = background / "codex/alpha/sessions/2026/10/06" / ("rollout-" + unrelated_id + ".jsonl")
        unrelated.write_text(json.dumps({
            "type": "session_meta",
            "payload": {
                "id": unrelated_id,
                "cwd": str(root),
            },
        }) + "\n")
        with closing(sqlite3.connect(background / "codex/alpha/state_5.sqlite")) as database, database:
            database.execute("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)", (
                unrelated_id, "unrelated-alpha", str(unrelated), 100, 200, 0,
            ))
        (background / "registry.json").write_text(json.dumps({
            "projects": projects,
        }))
        return background

    def test_native_browser_keeps_only_registered_sessions_and_real_writer_lock(self):
        with tempfile.TemporaryDirectory(dir=BOT / ".cache/tmp") as directory:
            root = Path(directory)
            background = self.browser_fixture(root)
            original = background / "codex/alpha"
            source_database = (original / "state_5.sqlite").read_bytes()
            home, binary = codex.browser_index(root)
            self.assertEqual(binary, "fixture-codex")
            with closing(sqlite3.connect(home / "state_5.sqlite")) as database:
                rows = database.execute("SELECT name,updated_at,archived FROM threads ORDER BY name").fetchall()
            self.assertEqual(rows, [("herdr-alpha", 200, 0), ("herdr-beta", 200, 1)])
            self.assertEqual(source_database, (original / "state_5.sqlite").read_bytes())
            session_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
            with (original / "thread-writer-locks" / (session_id + ".lock")).open("w+") as writer:
                fcntl.flock(writer.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                with self.assertRaises(ValueError):
                    codex.check_writer_lock(home, session_id)
            with closing(sqlite3.connect(original / "state_5.sqlite")) as database, database:
                database.execute("UPDATE threads SET name='changed-native-name',updated_at=300")
            codex.browser_index(root)
            self.assertEqual(codex.title(home, session_id), "changed-native-name")

    def test_native_browser_removes_stale_entries_without_deleting_source_history(self):
        with tempfile.TemporaryDirectory(dir=BOT / ".cache/tmp") as directory:
            root = Path(directory)
            background = self.browser_fixture(root)
            home, _ = codex.browser_index(root)
            registry = background / "registry.json"
            data = json.loads(registry.read_text())
            project = data["projects"].pop("beta")
            source = Path(project["sessionFile"])
            source_database = background / "codex/beta/state_5.sqlite"
            before = source_database.read_bytes()
            link = home / source.relative_to(background / "codex/beta")
            lock = home / "thread-writer-locks" / (project["sessionId"] + ".lock")
            registry.write_text(json.dumps(data))
            codex.browser_index(root)
            with closing(sqlite3.connect(home / "state_5.sqlite")) as database:
                names = database.execute("SELECT name FROM threads").fetchall()
            self.assertEqual(names, [("herdr-alpha",)])
            self.assertFalse(link.is_symlink())
            self.assertFalse(lock.is_symlink())
            self.assertTrue(source.is_file())
            self.assertEqual(before, source_database.read_bytes())

    def test_native_browser_rejects_mismatched_uuid_and_provider(self):
        for failure in ("uuid", "provider"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory(dir=BOT / ".cache/tmp") as directory:
                root = Path(directory)
                background = self.browser_fixture(root)
                if failure == "uuid":
                    project = json.loads((background / "registry.json").read_text())["projects"]["alpha"]
                    filename = Path(project["sessionFile"])
                    data = json.loads(filename.read_text())
                    data["payload"]["id"] = "wrong-id"
                    filename.write_text(json.dumps(data) + "\n")
                else:
                    (background / "codex/beta/config.toml").write_text('model_provider = "another-provider"\n')
                with self.assertRaises(ValueError):
                    codex.browser_index(root)

    def readiness_fixture(self, state):
        project = {
            "agentKind": "codex",
            "worktreePath": str(BOT),
            "herdr": {
                "agent_name": "herdr-fixture",
                "workspace_id": "w-fixture",
                "pane_id": "w-fixture:p1",
            },
        }
        response = {
            "cli_exit_code": 0,
            "result": {
                "agent": {
                    "name": "herdr-fixture",
                    "workspace_id": "w-fixture",
                    "pane_id": "w-fixture:p1",
                    "agent": "codex",
                    "cwd": str(BOT),
                    "agent_status": state,
                },
            },
        }
        return project, response

    def test_startup_unknown_waits_and_rechecks_the_same_agent(self):
        project, unknown = self.readiness_fixture("unknown")
        _, idle = self.readiness_fixture("idle")
        waited = {"cli_exit_code": 0, "result": {"state": "idle"}}
        with patch.object(herdr, "command", side_effect=[unknown, waited, idle]) as command, patch.object(herdr.time, "monotonic", return_value=0):
            result = herdr.ready_agent({}, project, wait_ms=90000)
        self.assertEqual(result["result"]["agent"]["agent_status"], "idle")
        self.assertEqual(result["startupWaitEvidence"], waited)
        self.assertEqual(command.call_args_list[1].args[1:], (
            "agent", "wait", "herdr-fixture", "--timeout", "90000",
        ))
        self.assertTrue(all(call.args[1] == "agent" for call in command.call_args_list))

    def test_startup_wait_deducts_the_initial_query_time(self):
        project, unknown = self.readiness_fixture("unknown")
        _, idle = self.readiness_fixture("idle")
        waited = {"cli_exit_code": 0, "result": {"state": "idle"}}
        with patch.object(herdr, "command", side_effect=[unknown, waited, idle]) as command, patch.object(herdr.time, "monotonic", side_effect=[0, 7, 7]):
            herdr.ready_agent({}, project, wait_ms=90000)
        self.assertEqual(command.call_args_list[1].args[-1], "83000")

    def test_startup_expired_budget_does_not_wait_again(self):
        project, unknown = self.readiness_fixture("unknown")
        with patch.object(herdr, "command", return_value=unknown) as command, patch.object(herdr.time, "monotonic", side_effect=[0, 91]):
            with self.assertRaisesRegex(ValueError, "预算已用尽"):
                herdr.ready_agent({}, project, wait_ms=90000)
        self.assertEqual(command.call_count, 1)

    def test_startup_wait_does_not_accept_blocked_or_changed_identity(self):
        project, unknown = self.readiness_fixture("unknown")
        _, blocked = self.readiness_fixture("blocked")
        waited = {"cli_exit_code": 0, "result": {"state": "blocked"}}
        observed_states = [blocked]
        for field, value in (
            ("name", "another-agent"),
            ("pane_id", "other-pane"),
            ("workspace_id", "other-workspace"),
            ("cwd", str(BOT / ".cache")),
            ("agent", "claude"),
        ):
            _, foreign = self.readiness_fixture("idle")
            foreign["result"]["agent"][field] = value
            observed_states.append(foreign)
        for observed in observed_states:
            with self.subTest(observed=observed):
                with patch.object(herdr, "command", side_effect=[unknown, waited, observed]):
                    with self.assertRaises(ValueError):
                        herdr.ready_agent({}, project, wait_ms=90000)

    def test_startup_wait_timeout_preserves_the_failure(self):
        project, unknown = self.readiness_fixture("unknown")
        expired = {"cli_exit_code": 1, "error": {"code": "agent_wait_timeout"}}
        with patch.object(herdr, "command", side_effect=[unknown, expired]) as command:
            with self.assertRaisesRegex(herdr.HerdrError, "agent_wait_timeout"):
                herdr.ready_agent({}, project, wait_ms=90000)
        self.assertEqual(command.call_count, 2)

    def test_ready_or_blocked_agents_do_not_wait_or_restart(self):
        for state in ("idle", "done", "blocked", "working"):
            project, response = self.readiness_fixture(state)
            with patch.object(herdr, "command", return_value=response) as command:
                if state in ("idle", "done"):
                    herdr.ready_agent({}, project, wait_ms=90000)
                else:
                    with self.assertRaises(ValueError):
                        herdr.ready_agent({}, project, wait_ms=90000)
            self.assertEqual(command.call_count, 1)

    def test_resume_preserves_registered_model_and_disables_switch_popup(self):
        arguments = codex.launch_arguments({
            "model": "saved-model",
            "reasoningEffort": "high",
            "serviceTier": "fast",
        }, "exact-native-uuid")
        self.assertEqual(arguments[:2], ["resume", "exact-native-uuid"])
        self.assertEqual(arguments[arguments.index("--model") + 1], "saved-model")
        self.assertIn('model_reasoning_effort="high"', arguments)
        self.assertIn("notice.hide_rate_limit_model_nudge=true", arguments)

    def test_actual_turn_settings_do_not_use_default_model(self):
        with tempfile.TemporaryDirectory(dir=BOT / ".cache/tmp") as directory:
            filename = Path(directory) / "native.jsonl"
            filename.write_text(json.dumps({
                "type": "turn_context",
                "payload": {
                    "turn_id": "native-turn",
                    "model": "different-model",
                    "effort": "medium",
                },
            }) + "\n")
            self.assertEqual(codex.turn_settings(filename), [{
                "turn_id": "native-turn",
                "model": "different-model",
                "effort": "medium",
            }])

    def test_native_auth_interpreter_survives_launcher_change(self):
        with tempfile.TemporaryDirectory(dir=BOT / ".cache/tmp") as directory:
            options = settings.runtime_options({
                "projectId": "fixture",
                "agentKind": "codex",
            }, {"home": directory})
            with patch.object(codex, "credential", return_value=("unused-test-token", "fixture-account")):
                codex.prepare(options, directory)
                before = (Path(directory) / "config.toml").read_bytes()
                with patch.object(sys, "executable", "/usr/bin/python3"):
                    codex.prepare(options, directory)
                self.assertEqual((Path(directory) / "config.toml").read_bytes(), before)

    def test_blocked_or_foreign_agent_is_not_ready(self):
        project = {
            "agentKind": "codex",
            "worktreePath": str(BOT),
            "herdr": {},
        }
        for state in ("blocked", "unknown", "working"):
            response = {
                "result": {
                    "agent": {
                        "agent": "codex",
                        "cwd": str(BOT),
                        "agent_status": state,
                    },
                },
            }
            with patch.object(herdr, "agent", return_value=response):
                with self.assertRaises(ValueError):
                    herdr.ready_agent({}, project)
        response = {
            "result": {
                "agent": {
                    "agent": "codex",
                    "cwd": "/tmp",
                    "agent_status": "idle",
                },
            },
        }
        with patch.object(herdr, "agent", return_value=response):
            with self.assertRaises(ValueError):
                herdr.ready_agent({}, project)

    def test_default_runtime_paths_are_project_specific(self):
        project = {
            "projectId": "test3",
            "agentKind": "codex",
        }
        first = settings.runtime_options(project, {})
        second = settings.runtime_options({
            **project,
            "projectId": "test4",
        }, {})
        self.assertNotEqual(first["home"], second["home"])
        self.assertEqual(first["home"], str(BOT / ".pi/agent/background/codex/test3"))
        self.assertEqual(first["model"], "gpt-6.1-sol")
        self.assertEqual(first["reasoningEffort"], "low")
        self.assertEqual(first["serviceTier"], "fast")
        self.assertTrue(Path(first["binary"]).is_file())
        retained = {
            **first,
            "model": "saved-model",
            "reasoningEffort": "high",
        }
        self.assertEqual(settings.runtime_options(project, retained), retained)

    def test_invalid_runtime_configuration_is_rejected(self):
        project = {
            "projectId": "fixture",
            "agentKind": "codex",
        }
        for overrides in ({"home": ""}, {"home": "/tmp/outside-bot"}, {"home": ".pi/{unknown}"}, {"binary": "missing-coding-agent-863745"}, {"authFile": "../outside"}):
            with self.subTest(overrides=overrides):
                with self.assertRaises(ValueError):
                    settings.runtime_options(project, overrides)

    def test_frontend_bind_cannot_persist_partial_settings(self):
        with tempfile.TemporaryDirectory(dir=BOT / ".cache/tmp") as directory:
            root = Path(directory)
            with transaction(root) as registry:
                registry["projects"]["fixture"] = {"projectId": "fixture"}
            before = (root / "registry.json").read_bytes()
            with patch.dict(os.environ, {"HERDR_ENV": ""}):
                with self.assertRaisesRegex(ValueError, "project-bind"):
                    herdr.bind(root, {"projectId": "fixture"}, {})
            self.assertEqual((root / "registry.json").read_bytes(), before)

    def test_multi_turn_sources_preserve_initial_question(self):
        with tempfile.TemporaryDirectory(dir=BOT / ".cache/tmp") as directory:
            filename = Path(directory) / "session.jsonl"
            raw = {
                "text": "给 test3 做任务",
                "source": "telegram",
                "sessionId": "fixture-session",
                "entryId": "u1",
                "receivedAt": "2026-10-06T15:00:01.000+08:00",
                "telegram": {
                    "chatId": 1,
                    "messageId": 10,
                    "sentAt": "2026-10-06T15:00:00.000+08:00",
                },
            }
            confirm = copy.deepcopy(raw)
            confirm.update(text="确认", entryId="u2")
            confirm["telegram"]["messageId"] = 12
            entries = [{
                "type": "session",
                "id": "fixture-session",
            }]
            for source, parent, custom_id in ((raw, None, "s1"), (confirm, "s1", "s2")):
                entries.extend([{
                    "type": "message",
                    "id": source["entryId"],
                    "parentId": parent,
                    "message": {
                        "role": "user",
                        "content": [{
                            "type": "text",
                            "text": source["text"],
                        }],
                    },
                }, {
                    "type": "custom",
                    "id": custom_id,
                    "parentId": source["entryId"],
                    "customType": "background-original-request",
                    "data": {
                        "entryId": source["entryId"],
                        "originalRequest": source,
                    },
                }])
            def save():
                filename.write_text("\n".join(json.dumps(row) for row in entries) + "\n")
            save()
            with patch.dict(os.environ, {"PI_SESSION_ID": "fixture-session", "PI_SESSION_FILE": str(filename)}):
                self.assertEqual(task_protocol.registration_sources({"sourceEntryIds": ["u1"]}), [raw, confirm])
                self.assertEqual(task_protocol.registration_sources({"sourceEntryIds": ["u2", "u1"]}), [raw, confirm])
                self.assertEqual(task_protocol.registration_sources({}), [confirm])
                for selected in (["missing"], ["u1", "u1"], ["s1"]):
                    with self.assertRaises(ValueError):
                        task_protocol.registration_sources({"sourceEntryIds": selected})
                entries[2]["data"]["originalRequest"]["telegram"]["chatId"] = 2
                save()
                with self.assertRaisesRegex(ValueError, "chat/thread"):
                    task_protocol.registration_sources({"sourceEntryIds": ["u1"]})
                entries[-1]["parentId"] = "u2"
                entries[3]["parentId"] = None
                save()
                with self.assertRaises(ValueError):
                    task_protocol.registration_sources({"sourceEntryIds": ["u1"]})


if __name__ == "__main__":
    unittest.main(verbosity=2)
