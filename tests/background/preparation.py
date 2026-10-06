# 后台准备验证：项目绑定、任务登记、worktree 检查和并发恢复；隔离样本在用户指定 workspace/test 内，无 Coding Agent。
import concurrent.futures
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
from execution import settings as agent_settings
TEST_ROOT = BOT.parent / "test"


def git(directory, *args):
    return subprocess.check_output(["git", "-C", str(directory), *args], text=True).strip()


def cli(root, action, request):
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", dir=root.parent) as payload:
        json.dump(request, payload)
        payload.flush()
        command = ["python3", str(PROTOCOL), "--root", str(root), action]
        if action == "register":
            command.extend([request["taskId"], "--spec", payload.name])
        result = subprocess.run(command, capture_output=True, text=True,
                                env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
    return result.returncode, json.loads(result.stdout or result.stderr)


def rejects(call):
    try:
        call()
    except ValueError:
        return
    raise AssertionError("expected refusal")


with tempfile.TemporaryDirectory(prefix=".bot-background-validation-", dir=TEST_ROOT) as temporary:
    temp = Path(temporary)
    source = temp / "source"
    source.mkdir()
    git(source, "init", "-q")
    (source / "sample.txt").write_text("baseline\n")
    git(source, "add", "sample.txt")
    git(source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture")
    root = temp / "private"
    target = temp / "worktree"
    project = {
        "projectId": "test",
        "sourcePath": str(source),
        "worktreePath": str(target),
        "branch": "background/test",
        "agentKind": "codex",
    }
    first = module.register_project(root, project)
    assert first["sessionId"] is None
    assert module.register_project(root, project) == first
    assert cli(root, "inspect", {})[1]["registry"]["projects"]["test"] == first
    rejects(lambda: module.register_project(root, {**project, "agentKind": "claude"}))
    rejects(lambda: module.register_project(root, {**project, "projectId": "duplicate"}))
    rejects(lambda: module.register_project(root, {**project, "sourcePath": "relative"}))
    assert (root / "registry.json").stat().st_mode & 0o777 == 0o600
    print("PASS: project registration, restart read, idempotence, conflicts and permissions")

    # 使用真实配置文件核对默认选择；已有项目不能随默认值改变而换 Agent。
    saved_directory = agent_settings.DIRECTORY
    config_directory = temp / "agent-defaults"
    config_directory.mkdir()
    selector = config_directory / "defaults.json"
    selector.write_text(json.dumps({"defaultAgent": "claude"}))
    (config_directory / "codex.json").write_text(json.dumps({
        "_comment": "测试配置读取，不启动 Agent。",
        "model": "gpt-6.1-sol",
        "reasoningEffort": "low",
        "serviceTier": "fast",
    }))
    agent_settings.DIRECTORY = config_directory
    try:
        implicit = {key: value for key, value in project.items() if key != "agentKind"}
        assert module.register_project(root, implicit) == first
        default_source = temp / "default-source"
        default_source.mkdir()
        chosen = module.register_project(root, {
            **implicit,
            "projectId": "default-selected",
            "sourcePath": str(default_source),
            "worktreePath": str(temp / "default-tree"),
        })
        assert chosen["agentKind"] == "claude"
        options = agent_settings.agent_options("codex", {"reasoningEffort": "high"})
        assert options["reasoningEffort"] == "high" and options["serviceTier"] == "fast"
        assert "_comment" not in options
        rejects(lambda: agent_settings.agent_options("../outside", {}))
        selector.write_text("{invalid")
        before = (root / "registry.json").read_bytes()
        rejects(lambda: module.register_project(root, {
            **implicit,
            "projectId": "bad-default",
            "sourcePath": str(temp),
            "worktreePath": str(temp / "bad-tree"),
        }))
        assert (root / "registry.json").read_bytes() == before
        assert module.register_project(root, implicit) == first
        assert module.register_project(root, project) == first
    finally:
        agent_settings.DIRECTORY = saved_directory
    print("PASS: configured default Agent, existing binding preserved, explicit overrides and invalid config refusal")

    task = {
        "taskId": "task-1",
        "projectId": "test",
        "originalRequest": {
            "text": "帮 test 项目修改 sample.txt，补个检查。",
            "source": "pi-session",
            "sessionId": "fixture-session",
            "entryId": "fixture-user-entry",
            "receivedAt": "2026-10-05T21:00:00.000+08:00",
        },
        "instruction": "修改 sample.txt；反引号 `x`、换行\n以及 $(echo untouched) 原样保存",
        "scope": ["sample.txt"],
        "acceptance": ["文件包含目标文本"],
        "artifacts": ["sample.txt"],
    }
    registered = module.register_task(root, task)
    assert registered["status"] == "registered"
    assert module.register_task(root, task) == registered
    rejects(lambda: module.register_task(root, {**task, "instruction": "other"}))
    rejects(lambda: module.register_task(root, {**task, "taskId": "bad", "acceptance": []}))
    rejects(lambda: module.register_task(root, {**task, "taskId": "bad", "scope": ["../escape"]}))
    rejects(lambda: module.register_task(root, {**task, "taskId": "bad", "projectId": "missing"}))
    result = module.prepare(root, "task-1")
    assert result["task"]["status"] == "registered" and result["task"]["files"]
    assert not result["preflight"]["worktreeChecksPassed"]
    assert not result["preflight"]["dispatchEnabled"]
    assert not target.exists()
    files = result["task"]["files"]
    assert task["instruction"] in Path(files["prompt"]).read_text()
    before = (root / "registry.json").read_bytes()
    module.prepare(root, "task-1")
    assert (root / "registry.json").read_bytes() == before
    # 模拟仅派发稿落盘后中断：登记状态回 registered，准备操作应能恢复。
    with module.transaction(root) as state:
        state["tasks"]["task-1"]["status"] = "registered"
    assert module.prepare(root, "task-1")["task"]["status"] == "registered"
    print("PASS: task input, exact prompt text, blockers, repeat preparation and recovery")

    git(source, "worktree", "add", "-qb", "background/test", str(target))
    assert module.prepare(root, "task-1")["preflight"]["worktreeChecksPassed"]
    (target / "sample.txt").write_text("user edit\n")
    check = module.prepare(root, "task-1")["preflight"]
    assert check["warnings"] and not check["dispatchEnabled"]
    assert (target / "sample.txt").read_text() == "user edit\n"
    outside = temp / "outside"
    outside.mkdir()
    (target / "linked").symlink_to(outside, target_is_directory=True)
    module.register_task(root, {**task, "taskId": "linked", "scope": ["linked/file"]})
    assert module.prepare(root, "linked")["preflight"]["blockers"]
    with module.transaction(root) as state:
        state["projects"]["test"]["branch"] = "wrong-branch"
    assert module.prepare(root, "task-1")["preflight"]["blockers"]
    print("PASS: real isolated worktree, wrong branch, existing changes and symlink escape")

    # 另一类型的 Agent 不需要增加实现分支，也不调用其程序。
    another = temp / "another"
    another.mkdir()
    module.register_project(root, {**project, "projectId": "cc", "sourcePath": str(another), "worktreePath": str(temp / "cc-tree"), "agentKind": "claude"})
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(lambda index: cli(root, "register", {**task, "taskId": f"parallel-{index}"}), range(12)))
    assert all(code == 0 for code, _ in results)
    assert len(module.inspect(root)["tasks"]) == 14

    # 真实 CLI 使用相对 root；只验证交接文件，不启动假的 Herdr 或 Agent。
    from execution import runner
    with module.transaction(root) as state:
        state["projects"]["test"]["branch"] = project["branch"]
        state["projects"]["test"]["herdr"] = {
            "agent_name": "offline-fixture",
            "workspace_id": "offline-workspace",
            "pane_id": "offline-pane",
        }
    relative_root = os.path.relpath(root, BOT)
    response = subprocess.run([
        sys.executable,
        str(PROTOCOL),
        "--root", relative_root,
        "prepare", "task-1",
    ], cwd=BOT, capture_output=True, text=True)
    assert response.returncode == 0, response.stderr
    prepared = json.loads(response.stdout)["task"]
    assert all(Path(value).is_absolute() for value in prepared["files"].values())
    runner.start_run(relative_root, prepared["files"]["spec"], prepared["files"]["prompt"], "relative-root-check")
    run_directory = root / "runs/task-1/relative-root-check"
    protocol_text = (run_directory / "dispatch-prompt.md").read_text()
    assert f"业务结果文件 = {run_directory / 'business.json'}" in protocol_text
    assert Path(runner.read(root / "registry.json")["tasks"]["task-1"]["runs"]["relative-root-check"]["baseline"][0]["path"]).is_absolute()
    assert not (target / relative_root / "runs/task-1/relative-root-check/business.json").exists()
    print("PASS: relative CLI root and direct start-run preserve absolute handoff/result paths across worker cwd")

    registry = root / "registry.json"
    registry.write_text("{damaged")
    rejects(lambda: module.register_task(root, {**task, "taskId": "after-corrupt"}))
    assert registry.read_text() == "{damaged"
    print("PASS: agent-neutral binding, concurrent CLI writers, corruption preserved")
print("Background preparation checks passed; no model, Herdr or Telegram calls; fixtures removed.")
