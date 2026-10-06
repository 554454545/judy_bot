# 长期 worktree 验证：真实隔离仓库的创建/复用、并发、冲突、中断恢复；关联 background/worktrees/manage.py。
import concurrent.futures
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

sys.dont_write_bytecode = True
BOT = Path(__file__).resolve().parents[2]
PROTOCOL = BOT / ".pi/extensions/background/tasks/task_protocol.py"
spec = importlib.util.spec_from_file_location("background_protocol", PROTOCOL)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
import worktrees.manage as manager


def git(path, *args):
    return subprocess.check_output(["git", "-C", str(path), *args], text=True).strip()


def request(root, action, value):
    result = subprocess.run(
        ["python3", str(PROTOCOL), "--root", str(root), action, value["projectId"], "--base", value["baseRef"]],
        capture_output=True, text=True,
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
    )
    return result.returncode, json.loads(result.stdout or result.stderr)


def reject(function):
    try:
        function()
    except ValueError:
        return
    raise AssertionError("expected refusal")


with tempfile.TemporaryDirectory(prefix=".bot-worktrees-validation-", dir=BOT.parent / "test") as directory:
    temp = Path(directory)
    source = temp / "source"
    source.mkdir()
    git(source, "init", "-qb", "main")
    (source / "sample.txt").write_text("baseline\n")
    git(source, "add", "sample.txt")
    git(source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture")
    root = temp / "state"
    original_head = git(source, "rev-parse", "HEAD")

    def register(identity, target):
        module.register_project(root, {
            "projectId": identity,
            "sourcePath": str(source),
            "worktreePath": str(target),
            "branch": "background/test",
            "agentKind": "any-agent",
        })

    target = temp / "worktree with 中文"
    register("test", target)
    # 同时操作同一个登记表，恰好一个创建，其余核对复用。
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        results = list(pool.map(lambda _: request(root, "worktree-ensure", {"projectId": "test", "baseRef": "main"}), range(3)))
    assert all(code == 0 for code, _ in results), results
    actions = [item["action"] for _, item in results]
    assert actions.count("created") == 1 and actions.count("reused") == 2
    assert git(target, "branch", "--show-current") == "background/test"
    assert git(source, "branch", "--show-current") == "main"
    assert git(source, "rev-parse", "HEAD") == original_head
    assert len(manager.worktrees(source)) == 2
    print("PASS: one concurrent creation, Unicode/space path, source branch retained")

    (target / "sample.txt").write_text("keep user change\n")
    state_before = (root / "registry.json").read_bytes()
    result = module.ensure_worktree(root, "test", "main")
    assert result["action"] == "reused" and result["checks"]["warnings"]
    assert (root / "registry.json").read_bytes() == state_before
    assert (target / "sample.txt").read_text() == "keep user change\n"
    # 原 main 新提交不会把长期 worktree 重置到新 HEAD。
    (source / "sample.txt").write_text("new source commit\n")
    git(source, "add", "sample.txt")
    git(source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "advance")
    assert module.ensure_worktree(root, "test", "main")["action"] == "reused"
    assert git(target, "rev-parse", "HEAD") == original_head
    reject(lambda: module.ensure_worktree(root, "test", "HEAD"))
    git(source, "worktree", "lock", str(target))
    reject(lambda: module.ensure_worktree(root, "test", "main"))
    git(source, "worktree", "unlock", str(target))
    print("PASS: reuse preserves edits/HEAD, base conflict and locked tree refused")

    # 使用新隔离登记表测试冲突；不覆盖任何现有目录/分支。
    occupied = temp / "occupied"
    occupied.mkdir()
    (occupied / "keep.txt").write_text("keep")
    conflict_root = temp / "conflicts"
    project = {
        "projectId": "occupied", "sourcePath": str(source), "worktreePath": str(occupied),
        "branch": "background/new", "agentKind": "claude",
    }
    module.register_project(conflict_root, project)
    reject(lambda: module.ensure_worktree(conflict_root, "occupied", "main"))
    assert (occupied / "keep.txt").read_text() == "keep"
    module.register_project(temp / "used-branch", {**project, "worktreePath": str(temp / "used"), "branch": "background/test"})
    reject(lambda: module.ensure_worktree(temp / "used-branch", "occupied", "main"))
    git(source, "branch", "unowned", "main")
    module.register_project(temp / "unowned", {**project, "worktreePath": str(temp / "unowned-tree"), "branch": "unowned"})
    reject(lambda: module.ensure_worktree(temp / "unowned", "occupied", "main"))
    print("PASS: occupied directory, branch in use and unowned branch refused")

    # Git 已建好但写回中断：保留 creating，下一次依据真实 worktree 恢复。
    with module.transaction(root) as state:
        state["projects"]["test"]["worktree"]["status"] = "creating"
    assert module.ensure_worktree(root, "test", "main")["action"] == "reused"
    assert module.inspect(root)["projects"]["test"]["worktree"]["status"] == "ready"
    # 创建失败留下分支：只允许与已记录初始提交一致的分支续建。
    recovery_root = temp / "recover"
    recovery_target = temp / "recovery-tree"
    module.register_project(recovery_root, {**project, "worktreePath": str(recovery_target), "branch": "background/recover"})
    original_add = manager.add
    def fail_after_branch(source, target, branch, base_commit, reuse):
        git(source, "branch", branch, base_commit)
        raise ValueError("fixture failure")
    with patch.object(manager, "add", side_effect=fail_after_branch):
        reject(lambda: module.ensure_worktree(recovery_root, "occupied", "main"))
    assert module.inspect(recovery_root)["projects"]["occupied"]["worktree"]["status"] == "needs_reconciliation"
    assert module.ensure_worktree(recovery_root, "occupied", "main")["action"] == "created"
    # 目录丢失但 Git 登记仍在：不得凭已有绑定再造第二份。
    missing_root = temp / "missing"
    missing_target = temp / "missing-tree"
    module.register_project(missing_root, {**project, "worktreePath": str(missing_target), "branch": "background/missing"})
    module.ensure_worktree(missing_root, "occupied", "main")
    missing_target.rename(temp / "moved-outside-protocol")
    reject(lambda: module.ensure_worktree(missing_root, "occupied", "main"))
    print("PASS: creation interruption recovery and missing tree conservatively refused")
print("Worktree checks passed; no Agent/Herdr/TG calls; fixtures removed.")
