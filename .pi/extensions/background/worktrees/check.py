# worktree 只读检查：核对仓库、注册目录、分支和状态；tasks 和 worktrees/manage.py 调用，不创建/切换/合并 worktree。
import json
import os
import subprocess
from pathlib import Path


def git(directory, *args, timeout=10):
    result = subprocess.run(
        ["git", "--no-optional-locks", "-c", "core.quotePath=false", "-C", str(directory), *args],
        capture_output=True,
        text=True,
        timeout=timeout,
        env={key: value for key, value in os.environ.items() if key not in (
            "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"
        )},
    )
    if result.returncode != 0:
        raise ValueError("Git 检查失败")
    return result.stdout.strip()


def worktrees(source):
    # Git 2.34.1 不支持 list -z；控制字符路径已在项目登记时拒绝。
    records = []
    for block in git(source, "worktree", "list", "--porcelain").split("\n\n"):
        record = {}
        for line in block.splitlines():
            key, _, value = line.partition(" ")
            if key == "worktree":
                decoded = json.loads(value) if value.startswith('"') else value
                record["path"] = str(Path(decoded).resolve())
            elif key in ("branch", "HEAD"):
                record[key] = value
            elif key in ("locked", "prunable", "detached", "bare"):
                record[key] = True
        if "path" in record:
            records.append(record)
    return records


def check(project):
    blockers = []
    warnings = []
    source = Path(project["sourcePath"])
    target = Path(project["worktreePath"])
    try:
        if Path(git(source, "rev-parse", "--show-toplevel")).resolve() != source:
            blockers.append("sourcePath 不是仓库根目录")
        git(source, "rev-parse", "--verify", "HEAD")
        git(source, "check-ref-format", "--branch", project["branch"])
    except (ValueError, OSError, subprocess.TimeoutExpired):
        blockers.append("原项目不是可用 Git 仓库、尚无提交或分支名不合法")
    if not target.is_dir():
        blockers.append("计划 worktree 尚未创建")
    else:
        try:
            records = worktrees(source)
            entry = next((item for item in records if item["path"] == str(target)), None)
            if not entry or target == source:
                blockers.append("目标目录不是该仓库登记的独立 worktree")
            if entry and (entry.get("locked") or entry.get("prunable")):
                blockers.append("worktree 被锁定或登记已失效，需要人工检查")
            if Path(git(target, "rev-parse", "--show-toplevel")).resolve() != target:
                blockers.append("worktreePath 不是工作目录根目录")
            if git(target, "branch", "--show-current") != project["branch"]:
                blockers.append("worktree 当前分支与项目绑定不一致")
            if git(target, "status", "--porcelain"):
                warnings.append("worktree 有未提交改动，派发前需确认归属；本次保留全部改动")
        except (ValueError, OSError, subprocess.TimeoutExpired):
            blockers.append("目标 worktree 无法检查")
    return {"worktreeChecksPassed": not blockers, "blockers": blockers, "warnings": warnings}
