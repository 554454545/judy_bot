# 项目登记与归档围栏：固定 source/worktree/branch/agentKind 绑定，共用项目操作锁；供 tasks、dispatch、service、projects/archive.py 调用，不创建业务目录、分支或会话。
import contextlib
import fcntl
import os
from pathlib import Path
from execution.settings import default_agent
from storage.registry import ident, required, timestamp, transaction


def inactive(project):
    return bool(project.get("archive"))


def assert_active(project):
    archive = project.get("archive")
    if archive:
        state = "已归档" if archive.get("state") == "archived" else "正在归档或归档尚未完成"
        raise ValueError(f"项目 {project['projectId']} {state}；不能派发、重新绑定或创建新 session。归档位置：{archive['path']}")
    return project


@contextlib.contextmanager
def operation(root, project_id):
    # 绑定、恢复与归档共用一把项目锁；锁文件保留在原位置，不能随归档移动。
    directory = Path(root) / "bindings" / ident(project_id)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (directory / "operation.lock").open("a+") as lock:
        os.chmod(lock.name, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ValueError("该项目正在绑定、恢复或归档；请稍后查询，不重复执行") from error
        yield


def absolute(value, field):
    path = Path(required(value, field))
    if not path.is_absolute():
        raise ValueError(f"{field} 必须是绝对路径")
    resolved = str(path.resolve())
    if any(ord(character) < 32 for character in resolved):
        raise ValueError(f"{field} 不能包含控制字符")
    return resolved


def register(root, request):
    project_id = ident(request.get("projectId"))
    source = absolute(request.get("sourcePath"), "sourcePath")
    worktree = absolute(request.get("worktreePath"), "worktreePath")
    if source == worktree:
        raise ValueError("本版约定使用独立 worktree，不能与原目录相同")
    candidate = {
        "projectId": project_id,
        "sourcePath": source,
        "worktreePath": worktree,
        "branch": required(request.get("branch"), "branch"),
        "sessionId": None,
    }
    with transaction(root) as registry:
        previous = registry["projects"].get(project_id)
        if previous:
            assert_active(previous)
        for other in registry["projects"].values():
            if other["sourcePath"] == source or other["worktreePath"] == worktree:
                assert_active(other)
        if not Path(source).is_dir():
            raise ValueError("项目原目录不存在")
        # 已有绑定优先；只有新项目省略 Agent 时，才读取集中默认选择。
        agent_kind = request.get("agentKind")
        if agent_kind is None:
            agent_kind = previous["agentKind"] if previous else default_agent()
        candidate["agentKind"] = ident(agent_kind)
        if previous:
            binding = {key: previous[key] for key in candidate if key != "sessionId"}
            if binding != {key: value for key, value in candidate.items() if key != "sessionId"}:
                raise ValueError("项目已绑定其他目录、分支或 Agent；不自动改绑")
            return previous
        for other in registry["projects"].values():
            if other["sourcePath"] == source or other["worktreePath"] == worktree:
                raise ValueError("原项目或 worktree 已被其他项目 ID 绑定")
        candidate["createdAt"] = timestamp()
        registry["projects"][project_id] = candidate
        return candidate


def get(registry, project_id):
    project = registry["projects"].get(ident(project_id))
    if not project:
        raise ValueError("项目尚未登记")
    return assert_active(project)
