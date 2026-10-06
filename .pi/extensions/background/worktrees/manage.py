# 长期 worktree 创建/复用：按 projects 绑定操作 Git，状态由 storage 保存；tasks CLI 调用，不启动 Agent、不清理旧 worktree。
import os
import subprocess
from pathlib import Path
from projects.registry import get
from storage.registry import timestamp, transaction
from worktrees.check import check, git, worktrees


def source_check(project):
    source = Path(project["sourcePath"])
    if Path(git(source, "rev-parse", "--show-toplevel")).resolve() != source:
        raise ValueError("原项目必须是 Git 仓库根目录")
    git(source, "rev-parse", "--verify", "HEAD")
    git(source, "check-ref-format", "--branch", project["branch"])
    if Path(project["worktreePath"]).is_relative_to(source):
        raise ValueError("worktree 应放在原仓库之外，避免混入原项目文件")
    return source


def ready(project):
    result = check(project)
    if not result["worktreeChecksPassed"]:
        raise ValueError("；".join(result["blockers"]))
    return result


def branch_commit(source, branch):
    try:
        return git(source, "rev-parse", "--verify", f"refs/heads/{branch}")
    except ValueError:
        return None


def add(source, target, branch, base_commit, reuse_branch):
    arguments = ["git", "-c", "core.hooksPath=/dev/null", "-c", "submodule.recurse=false", "-C", str(source), "worktree", "add"]
    if reuse_branch:
        arguments.extend([str(target), branch])
    else:
        arguments.extend(["-b", branch, str(target), base_commit])
    # 参数数组执行，不调用 Shell；中断/超时先结束 checkout 子进程再释放登记锁。
    process = subprocess.Popen(
        arguments,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env={key: value for key, value in os.environ.items() if key not in (
            "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"
        )},
    )
    try:
        _, _ = process.communicate(timeout=120)
        if process.returncode != 0:
            raise ValueError("Git worktree 创建失败；保留现场，不重置分支或删除目录")
    except BaseException:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        raise


def ensure(root, project_id, base_ref):
    if not isinstance(base_ref, str) or not base_ref.strip() or base_ref.startswith("-"):
        raise ValueError("baseRef 必须是明确的本地分支、标签或提交，不得以 - 开头")
    base_ref = base_ref.strip()
    # 先持久化创建意图。Git 成功而进程未写回时，下次依据真实登记恢复。
    with transaction(root) as registry:
        project = get(registry, project_id)
        source = source_check(project)
        target = Path(project["worktreePath"])
        entries = worktrees(source)
        existing = next((item for item in entries if item["path"] == str(target)), None)
        previous = project.get("worktree")
        if previous and previous.get("baseRef") and previous["baseRef"] != base_ref:
            raise ValueError("项目已选择其他基准；不会自动重建、切换或重置 worktree")
        if existing:
            if not target.is_dir():
                raise ValueError("worktree 登记仍在但目录已丢失；先对账，不自动重建")
            inspection = ready(project)
            if not previous:
                previous = {"baseRef": None, "baseCommit": None, "adoptedAt": timestamp()}
            project["worktree"] = {
                **previous,
                "status": "ready",
                "readyAt": previous.get("readyAt") or timestamp(),
            }
            project["worktree"].pop("errorType", None)
            project["worktree"].pop("failedAt", None)
            return {"action": "reused", "project": project, "checks": inspection}
        if previous and previous.get("status") == "ready":
            raise ValueError("已创建 worktree 的 Git 登记丢失；停止，先对账")
        if target.exists() or target.is_symlink():
            raise ValueError("目标目录已存在但不是绑定 worktree；不覆盖或自动接管")
        if any(item.get("branch") == f"refs/heads/{project['branch']}" for item in entries):
            raise ValueError("工作分支已在其他 worktree 使用；不强制接管")
        # --end-of-options 防止基准值被解释成 Git 选项。
        base_commit = git(source, "rev-parse", "--verify", "--end-of-options", f"{base_ref}^{{commit}}")
        existing_commit = branch_commit(source, project["branch"])
        if existing_commit and not previous:
            raise ValueError("工作分支已存在但没有本协议创建记录；请先明确归属")
        if previous:
            if existing_commit and existing_commit != previous["baseCommit"]:
                raise ValueError("创建中断后的分支已经变化；不自动接管")
            base_commit = previous["baseCommit"]
        else:
            project["worktree"] = {
                "status": "creating",
                "baseRef": base_ref,
                "baseCommit": base_commit,
                "startedAt": timestamp(),
            }
    try:
        # 第二段持同一登记锁完成 Git 操作；其他进程在锁内重新检查，避免双创建。
        with transaction(root) as registry:
            project = get(registry, project_id)
            source = source_check(project)
            target = Path(project["worktreePath"])
            entry = next((item for item in worktrees(source) if item["path"] == str(target)), None)
            if entry:
                inspection = ready(project)
                action = "reused"
            else:
                if target.exists() or target.is_symlink():
                    raise ValueError("创建前目标被其他操作占用；停止，不覆盖")
                previous = project["worktree"]
                existing_commit = branch_commit(source, project["branch"])
                if existing_commit and existing_commit != previous["baseCommit"]:
                    raise ValueError("工作分支已发生变化；停止，不重置")
                target.parent.mkdir(parents=True, exist_ok=True)
                add(source, target, project["branch"], previous["baseCommit"], bool(existing_commit))
                inspection = ready(project)
                action = "created"
            metadata = project["worktree"]
            metadata.update({
                "status": "ready",
                "readyAt": metadata.get("readyAt") or timestamp(),
            })
            metadata.pop("errorType", None)
            metadata.pop("failedAt", None)
            return {"action": action, "project": project, "checks": inspection}
    except Exception as error:
        with transaction(root) as registry:
            project = get(registry, project_id)
            metadata = project.get("worktree", {})
            if metadata.get("status") != "ready":
                metadata.update({
                    "status": "needs_reconciliation",
                    "errorType": type(error).__name__,
                    "failedAt": timestamp(),
                })
        raise
