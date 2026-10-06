# 新项目接入回归：验证默认运行参数、失败不留登记及多轮原话身份；关联 execution/settings.py、herdr.py、tasks/task_protocol.py，真实链路另见 project-onboarding-live.mjs。
import copy
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.dont_write_bytecode = True
BOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(BOT / ".pi/extensions/background"))
from execution import codex, herdr, settings
from storage.registry import transaction
from tasks import task_protocol


class Onboarding(unittest.TestCase):
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
