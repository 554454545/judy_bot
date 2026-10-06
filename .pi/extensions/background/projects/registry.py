# 项目登记：固定 source/worktree/branch/agentKind 绑定；调用 storage，供 tasks 使用，不创建目录、分支或会话。
from pathlib import Path
from execution.settings import default_agent
from storage.registry import ident, required, timestamp, transaction


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
    if not Path(source).is_dir():
        raise ValueError("项目原目录不存在")
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
    return project
