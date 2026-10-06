# 任务协议补充验证：原话、expected-hash 更新、修订历史和交接文件字节校验；隔离数据在 workspace/test，不派发。
import concurrent.futures
import copy
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

sys.dont_write_bytecode = True
BOT = Path(__file__).resolve().parents[2]
PROTOCOL = BOT / ".pi/extensions/background/tasks/task_protocol.py"
spec = importlib.util.spec_from_file_location("task_protocol", PROTOCOL)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def refuses(callback):
    try:
        callback()
    except ValueError:
        return
    raise AssertionError("expected refusal")


with tempfile.TemporaryDirectory(prefix=".bot-background-recording-", dir=BOT.parent / "test") as temporary:
    temp = Path(temporary)
    source = temp / "source"
    source.mkdir()
    root = temp / "private"
    module.register_project(root, {
        "projectId": "fixture",
        "sourcePath": str(source),
        "worktreePath": str(temp / "tree"),
        "branch": "background/fixture",
        "agentKind": "another-agent",
    })
    raw = {
        "text": "  帮 fixture 项目加个函数。\r\n原样留着 `引号` 和 $(原话)。  ",
        "source": "telegram",
        "sessionId": "fixture-session",
        "entryId": "entry-1",
        "receivedAt": "2026-10-05T21:00:01.000+08:00",
        "telegram": {
            "chatId": 123,
            "messageId": 456,
            "threadId": 7,
            "turnId": "fixture-turn-1",
            "sentAt": "2026-10-05T21:00:00.000+08:00",
        },
    }
    request = {
        "taskId": "fixture-task",
        "projectId": "fixture",
        "originalRequest": raw,
        "instruction": "增加一个函数并验证返回值。",
        "scope": ["function.py"],
        "acceptance": ["返回值可核对"],
        "artifacts": ["function.py"],
    }
    task = module.register_task(root, request)
    assert task["originalRequest"] == raw
    refuses(lambda: module.register_task(root, {**request, "taskId": "missing", "originalRequest": None}))
    refuses(lambda: module.register_task(root, {
        **request, "taskId": "bad-time", "originalRequest": {**raw, "receivedAt": "2026-10-05T13:00:00Z"},
    }))
    prepared = module.prepare(root, task["taskId"])
    files = [Path(value) for value in prepared["task"]["files"].values()]
    registry_bytes = (root / "registry.json").read_bytes()
    mtimes = [path.stat().st_mtime_ns for path in files]
    module.prepare(root, task["taskId"])
    assert [path.stat().st_mtime_ns for path in files] == mtimes
    assert (root / "registry.json").read_bytes() == registry_bytes
    saved = json.loads(files[0].read_bytes())
    assert saved["task"]["originalRequest"] == raw
    assert b"\r\n" in files[1].read_bytes()
    inspected = module.inspect(root)
    assert all(item["matches"] for item in inspected["handoffChecks"][task["taskId"]].values())
    assert (root / "registry.json").read_bytes() == registry_bytes
    assert "taskHashes" not in json.loads(registry_bytes)
    files[1].write_bytes(b"changed outside protocol")
    assert not module.inspect(root)["handoffChecks"][task["taskId"]]["prompt"]["matches"]
    module.prepare(root, task["taskId"])
    assert module.inspect(root)["handoffChecks"][task["taskId"]]["prompt"]["matches"]
    files[0].unlink()
    assert not module.inspect(root)["handoffChecks"][task["taskId"]]["spec"]["matches"]
    module.prepare(root, task["taskId"])

    latest = module.inspect(root)
    expected = latest["taskHashes"][task["taskId"]]
    supplement = {**raw, "text": "再加上负数的检查。", "entryId": "entry-2"}
    supplement["telegram"] = {**raw["telegram"], "messageId": 457, "turnId": "fixture-turn-2"}
    update = {
        "taskId": task["taskId"],
        "expectedHash": expected,
        "changes": {"acceptance": ["返回值可核对", "负数也返回正确结果"]},
        "changeRequest": supplement,
    }
    updated = module.update_task(root, update)
    assert updated["status"] == "registered"
    assert updated["originalRequest"] == raw
    assert updated["revisions"][0]["request"] == supplement
    assert updated["revisions"][0]["previousHash"] == expected
    assert updated["revisions"][0]["before"]["acceptance"] == ["返回值可核对"]
    assert all(key not in updated for key in ("files", "specHash", "promptHash"))
    assert task["taskId"] not in module.inspect(root)["handoffChecks"]
    refuses(lambda: module.update_task(root, update))
    refuses(lambda: module.update_task(root, {**update, "changes": {"status": "done"}}))
    refuses(lambda: module.update_task(root, {**update, "changes": {"scope": ["../escape"]}}))
    refuses(lambda: module.update_task(root, {**update, "changes": {}}))
    current = module.inspect(root)
    same = {**update, "expectedHash": current["taskHashes"][task["taskId"]]}
    before = (root / "registry.json").read_bytes()
    module.update_task(root, same)
    assert (root / "registry.json").read_bytes() == before
    prepared = module.prepare(root, task["taskId"])
    saved = json.loads(Path(prepared["task"]["files"]["spec"]).read_bytes())
    assert saved["task"]["clarifications"] == [supplement]
    assert prepared["preflight"]["dispatchEnabled"] is False
    prompt = Path(prepared["task"]["files"]["prompt"]).read_bytes()
    assert supplement["text"].encode() in prompt
    assert b"another-agent" in prompt
    assert "不得自行降低目标".encode() in prompt
    assert "可运行、测试通过或 worker 自述完成不等于原目标达到".encode() in prompt

    # 两个不同 CLI 写者拿到同一个旧 hash；只有一个成功，另一个必须重新核对。
    expected = module.inspect(root)["taskHashes"][task["taskId"]]
    def race(index):
        delta = temp / f"delta-{index}.json"
        delta.write_text(json.dumps({"instruction": f"修改需求 {index}", "changeRequest": supplement}))
        result = subprocess.run(
            [sys.executable, str(PROTOCOL), "--root", str(root), "update", task["taskId"],
             "--delta", str(delta), "--expected-hash", expected],
            text=True, capture_output=True,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
        )
        return result.returncode
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(race, (1, 2))) == [0, 1]
    current = module.inspect(root)
    assert len(current["tasks"][task["taskId"]]["revisions"]) == 2
    with module.transaction(root) as state:
        state["tasks"][task["taskId"]]["status"] = "running"
    running = module.inspect(root)
    refuses(lambda: module.update_task(root, {
        **update, "expectedHash": running["taskHashes"][task["taskId"]],
    }))
    with module.transaction(root) as state:
        old = copy.deepcopy(state["tasks"][task["taskId"]])
        old.update(taskId="legacy-task", status="registered")
        old.pop("originalRequest")
        state["tasks"]["legacy-task"] = old
    refuses(lambda: module.prepare(root, "legacy-task"))

    # spec 落盘后、prompt 写入前失败：不保存交接文件绑定，下一次可按真实任务重建。
    recovery_task = {**request, "taskId": "write-recovery"}
    module.register_task(root, recovery_task)
    write = module.atomic
    def fail_prompt(path, content):
        if Path(path).name == "prompt.md":
            raise OSError("synthetic interrupted write")
        return write(path, content)
    module.atomic = fail_prompt
    try:
        try:
            module.prepare(root, "write-recovery")
        except OSError:
            pass
        else:
            raise AssertionError("expected interrupted preparation")
    finally:
        module.atomic = write
    assert module.inspect(root)["tasks"]["write-recovery"]["status"] == "registered"
    assert module.prepare(root, "write-recovery")["task"]["status"] == "registered"
    assert module.inspect(root)["tasks"]["write-recovery"]["files"]

print("PASS: raw provenance, CRLF byte idempotence, file integrity, update audit and concurrent stale-hash refusal")
