# 项目归档：保存成果和后台证据、退出活动管理并保留禁止重派的标记；由 tasks/task_protocol.py 调用，关联 registry、worktrees 和 execution/codex.py。
import contextlib
import copy
import fcntl
import hashlib
import json
import os
import shutil
import stat
import subprocess
import time
import uuid
from pathlib import Path

from execution import codex, dispatch, health, runner
from notifications import task_protocol as notices
from projects.registry import ident, operation
from storage.registry import atomic, timestamp
from worktrees.check import check, git, worktrees

BOT = Path(__file__).resolve().parents[4]


def inventory(directory):
    # 不跟随符号链接；包括隐藏、忽略、未跟踪、空目录和文件权限，不把 .git 管理指针当成果。
    directory = Path(directory)
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError("成果目录缺失或被替换为链接；停止归档，不跟随替代目录")
    result = {}
    for parent, folders, files in os.walk(directory, followlinks=False):
        if Path(parent) == directory:
            folders[:] = [name for name in folders if name != ".git"]
            files = [name for name in files if name != ".git"]
        for name in sorted(folders + files):
            path = Path(parent) / name
            metadata = path.lstat()
            value = {"mode": stat.S_IMODE(metadata.st_mode)}
            if stat.S_ISLNK(metadata.st_mode):
                value.update(kind="symlink", target=os.readlink(path))
            elif stat.S_ISDIR(metadata.st_mode):
                value.update(kind="directory")
            elif stat.S_ISREG(metadata.st_mode):
                with path.open("rb") as stream:
                    value.update(kind="file", size=metadata.st_size, sha256=hashlib.file_digest(stream, "sha256").hexdigest())
            else:
                raise ValueError("worktree 中有 socket、管道或特殊文件；保留现场，不能无损归档")
            result[path.relative_to(directory).as_posix()] = value
    return result


def save(directory, manifest):
    atomic(Path(directory) / "manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")


def read_project(registry, project_id):
    project = registry["projects"].get(ident(project_id))
    if not project:
        raise ValueError("项目尚未登记，不能按名称删除目录")
    return project


def members(registry, box, ledger, project_id):
    tasks = {key: value for key, value in registry["tasks"].items() if value["projectId"] == project_id}
    events = {key: value for key, value in registry.get("outbox", {}).items() if value.get("task_id") in tasks}
    inbox = {key: value for key, value in box.items() if value.get("task_id") in tasks or key in events}
    event_ids = set(events) | set(inbox)
    receipts = {
        key: value for key, value in ledger.items()
        if value.get("task_id") in tasks or value.get("event_id", "").split(":part-", 1)[0] in event_ids
        or (notices.notification_task(registry, value.get("event_id", "")) or {}).get("taskId") in tasks
    }
    return copy.deepcopy({
        "tasks": tasks,
        "outbox": events,
        "inbox": inbox,
        "receipts": receipts,
    })


def settled(project, owned):
    if project.get("activeExecution"):
        raise ValueError("项目仍有执行或待验收占用；先完成或明确取消任务，不强制归档")
    for task in owned["tasks"].values():
        if task.get("status") not in ("registered", "reported", "closed_legacy", "cancelled", "blocked"):
            raise ValueError(f"任务 {task['taskId']} 尚在执行、验收或交付阶段；暂不能归档")
        for run in task.get("runs", {}).values():
            if any(health.live(run.get(key)) for key in ("runner_pid_identity", "pid_identity")):
                raise ValueError("该项目的监督进程仍在运行；暂不能归档")
    for event in owned["outbox"].values():
        if any(target.get("state") in ("sending", "unknown") for target in event.get("targets", {}).values()):
            raise ValueError("通知正在发送或发送结果未知；先对账，暂不能归档")
    for event in owned["inbox"].values():
        if event.get("state") in ("claimed", "enqueued") or event.get("attention_required") == "delivery_unknown":
            raise ValueError("通知仍被前台处理或投递结果未知；暂不能归档")
    if any(value.get("state") in ("sending", "unknown") for value in owned["receipts"].values()):
        raise ValueError("Telegram 投递签收结果未知；暂不能归档")


def paths(root, project, registry):
    target = Path(project["worktreePath"])
    source = Path(project["sourcePath"])
    if target.is_symlink() or not target.resolve().is_relative_to(BOT / ".worktrees") or target.resolve() == (BOT / ".worktrees"):
        raise ValueError("归档只处理 Bot .worktrees 下的独立工作副本；不删除原目录或其他位置")
    if target.resolve() == source.resolve() or source.resolve().is_relative_to(target.resolve()):
        raise ValueError("worktree 和原项目边界冲突；停止归档")
    settings = project.get("executionSettings", {})
    home = settings.get("agent", {}).get("home")
    if home:
        home = Path(home)
        if home.is_symlink() or not home.resolve().is_relative_to(Path(root).resolve() / "codex") or home.resolve() == Path(root).resolve() / "codex":
            raise ValueError("Coding Agent home 必须是本登记根目录内的独立项目目录")
        for other in registry["projects"].values():
            if other["projectId"] == project["projectId"]:
                continue
            other_home = (other.get("executionSettings") or {}).get("agent", {}).get("home")
            if other_home and (Path(other_home).resolve().is_relative_to(home.resolve()) or home.resolve().is_relative_to(Path(other_home).resolve())):
                raise ValueError("Coding Agent home 与另一项目共享或嵌套；停止归档")
    for other in registry["projects"].values():
        other_target = Path(other["worktreePath"]).resolve()
        if other["projectId"] != project["projectId"] and (other_target.is_relative_to(target.resolve()) or target.resolve().is_relative_to(other_target)):
            raise ValueError("worktree 与另一项目嵌套；停止归档")


def pending_bind(root, project_id):
    pending = runner.read(Path(root) / "bindings" / project_id / "pending.json", {})
    if pending and not runner.read(pending.get("receipt"), {}):
        raise ValueError("项目首次绑定的启动结果仍未知；先对账，暂不能归档")


def runtime(project):
    binding = project.get("herdr")
    if not binding:
        if project.get("sessionId"):
            codex.check_writer_lock(project["executionSettings"]["agent"]["home"], project["sessionId"])
        return None
    settings = project["executionSettings"]
    agents = dispatch.control(settings, "agent", "list")["result"]["agents"]
    matches = [value for value in agents if value.get("name") == binding.get("agent_name") or value.get("pane_id") == binding["pane_id"]]
    if not matches:
        info = dispatch.control(settings, "pane", "process-info", "--pane", binding["pane_id"])["result"]["process_info"]
        foreground = info.get("foreground_processes", [])
        if len(foreground) != 1 or foreground[0]["pid"] != info.get("shell_pid") or info.get("foreground_process_group_id") != info.get("shell_pid"):
            raise ValueError("原 Herdr pane 不是空闲 Shell；不接管其他客户端")
        return None
    if len(matches) != 1:
        raise ValueError("项目 Herdr 客户端不唯一；不关闭")
    agent = dispatch.control(settings, "agent", "get", matches[0]["name"])["result"]["agent"]
    if any(agent.get(key) != binding.get(key) for key in ("workspace_id", "pane_id")) or agent.get("name") != binding.get("agent_name"):
        raise ValueError("Herdr 客户端身份与绑定不同；不关闭")
    if agent.get("agent") != "codex" or project.get("agentKind") != "codex" or Path(agent.get("cwd", "")).resolve() != Path(project["worktreePath"]).resolve():
        raise ValueError("该 Coding Agent 归档适配尚未接入或目录不匹配")
    native = agent.get("agent_session") or {}
    if project.get("sessionId") and (native.get("kind") != "id" or native.get("value") != project["sessionId"]):
        raise ValueError("Herdr 原生 session 与登记不符；不关闭")
    if agent.get("agent_status") not in ("idle", "done"):
        raise ValueError("Coding Agent 尚非空闲：" + str(agent.get("agent_status")))
    observed = health.worker_processes(project)
    internal = {runner.digest(value["identity"]) for value in observed["internal_processes"]}
    if any(runner.digest(value["identity"]) not in internal for value in observed["children"]):
        raise ValueError("Coding Agent 仍有业务子进程；保留现场，暂不能归档")
    return observed


def no_users(project):
    # 只比较进程 cwd 与 CODEX_HOME，不读取或记录其他环境变量/命令正文，不强杀独立客户端。
    target = Path(project["worktreePath"])
    home = (project.get("executionSettings") or {}).get("agent", {}).get("home")
    for process in Path("/proc").iterdir():
        if not process.name.isdigit() or int(process.name) == os.getpid():
            continue
        try:
            if process.stat().st_uid != os.getuid():
                continue
            cwd = (process / "cwd").resolve(strict=True)
            if cwd.is_relative_to(target):
                raise ValueError("仍有进程使用项目 worktree；请先正常退出，暂不能归档")
            if home and b"CODEX_HOME=" + str(home).encode() in (process / "environ").read_bytes().split(b"\0"):
                raise ValueError("仍有进程使用该 Coding Agent home；请先正常退出")
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue


def close_client(project, directory, manifest):
    observed = runtime(project)
    if observed:
        # 原生退出按键只用于已核对且空闲的客户端；不用 kill，也不关闭 server、pane 或 workspace。
        evidence = dispatch.control(project["executionSettings"], "agent", "send-keys", project["herdr"]["agent_name"], "ctrl+c", "ctrl+c")
        manifest["closeIntent"] = {
            "processes": observed,
            "receipt": evidence,
            "at": timestamp(),
        }
        save(directory, manifest)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if not health.live(observed["agent"]) and all(not health.live(child["identity"]) for child in observed["children"]):
                agents = dispatch.control(project["executionSettings"], "agent", "list")["result"]["agents"]
                binding = project["herdr"]
                if not any(value.get("name") == binding["agent_name"] or value.get("pane_id") == binding["pane_id"] for value in agents):
                    break
            time.sleep(.2)
        else:
            raise ValueError("正常退出尚未完成；保留归档意图，不强杀客户端")
    runtime(project)
    no_users(project)
    manifest["clientClosedAt"] = timestamp()
    save(directory, manifest)


@contextlib.contextmanager
def browser_lock(root):
    directory = Path(root) / "codex-session-browser"
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (directory / "browser.lock").open("a+") as lock:
        os.chmod(lock.name, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ValueError("Bot Codex 会话浏览器仍打开；请先退出再归档") from error
        yield


def git_state(target):
    index = Path(git(target, "rev-parse", "--git-path", "index"))
    if not index.is_absolute():
        index = target / index
    return {
        "head": git(target, "rev-parse", "HEAD"),
        "branch": git(target, "branch", "--show-current"),
        "gitStatus": git(target, "status", "--porcelain"),
        "indexHash": runner.digest(index.read_bytes()) if index.exists() else None,
    }, index


def snapshot_worktree(project, directory, manifest):
    target = Path(project["worktreePath"])
    destination = directory / "worktree"
    proof = manifest.get("worktreeSnapshot")
    if proof:
        if inventory(destination) != proof["inventory"]:
            raise ValueError("已保存的 worktree 成果发生变化；停止归档")
        if target.exists() and inventory(target) != proof["inventory"]:
            raise ValueError("保存后原 worktree 又有改动；停止归档，保留两份成果")
        if target.exists():
            current, _ = git_state(target)
            if any(current[key] != proof[key] for key in current):
                raise ValueError("保存后 Git HEAD、分支或暂存区发生变化；停止解除 worktree")
        return
    if not target.exists():
        source = Path(project["sourcePath"])
        records = worktrees(source) if (source / ".git").exists() else []
        if project.get("worktree") or any(value["path"] == str(target) for value in records):
            raise ValueError("worktree 已丢失，无法保全成果；先对账")
        manifest["worktreeAbsent"] = True
        save(directory, manifest)
        return
    preflight = check(project)
    if preflight["blockers"]:
        raise ValueError("；".join(preflight["blockers"]))
    before = inventory(target)
    git_before, index = git_state(target)
    intent = {"inventory": before, **git_before}
    if manifest.get("worktreeCopyIntent") and manifest["worktreeCopyIntent"] != intent:
        raise ValueError("复制中断后成果或暂存区发生变化；保留原 worktree，先核查")
    manifest["worktreeCopyIntent"] = intent
    save(directory, manifest)
    if destination.exists():
        if inventory(destination) != before:
            raise ValueError("保存的成果发生变化；不覆盖归档副本")
    else:
        staging = directory / ".worktree-copy"
        if staging.is_symlink():
            raise ValueError("归档临时副本被替换成链接；停止操作")
        if staging.exists():
            # 只重建本操作尚未确认的临时复制；上面已证明原成果与复制意图一致。
            shutil.rmtree(staging)
        shutil.copytree(target, staging, symlinks=True, ignore=lambda path, names: [".git"] if Path(path) == target else [])
        if inventory(staging) != before:
            raise ValueError("成果复制不完整；未删除原 worktree")
        for parent, _, files in os.walk(staging, topdown=False, followlinks=False):
            for name in files:
                path = Path(parent) / name
                if not path.is_symlink():
                    with path.open("rb") as stream:
                        os.fsync(stream.fileno())
            fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
        os.rename(staging, destination)
    if inventory(target) != before or inventory(destination) != before:
        raise ValueError("复制期间成果发生变化；未删除原 worktree")
    git_after, _ = git_state(target)
    if git_after != git_before:
        raise ValueError("复制期间 Git HEAD 或暂存区发生变化；未解除 worktree")
    proof = {
        **intent,
        "savedAt": timestamp(),
    }
    # 暂存区也保留原字节，便于区分 staged/unstaged；Git 管理目录由原仓库继续保存。
    if index.is_file():
        shutil.copyfile(index, directory / "worktree-index")
        with (directory / "worktree-index").open("rb") as stream:
            os.fsync(stream.fileno())
    # binary patch 同时保全暂存内容；split-index 的外部 sharedindex 不会随 worktree 管理目录丢失。
    result = subprocess.run(
        ["git", "--no-optional-locks", "-C", str(target), "diff", "--cached", "--binary", "--full-index", "--no-ext-diff"],
        capture_output=True,
        check=True,
        timeout=15,
        env={key: value for key, value in os.environ.items() if key not in (
            "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"
        )},
    )
    with (directory / "worktree-staged.patch").open("wb") as stream:
        os.fchmod(stream.fileno(), 0o600)
        stream.write(result.stdout)
        stream.flush()
        os.fsync(stream.fileno())
    if git_state(target)[0] != git_before:
        raise ValueError("导出暂存内容期间 Git 状态变化；未删除原 worktree")
    manifest["worktreeSnapshot"] = proof
    save(directory, manifest)


def detach_worktree(project, directory, manifest):
    if manifest.get("worktreeAbsent"):
        return
    snapshot_worktree(project, directory, manifest)
    target = Path(project["worktreePath"])
    records = worktrees(project["sourcePath"])
    entry = next((value for value in records if value["path"] == str(target)), None)
    if entry:
        proof = manifest["worktreeSnapshot"]
        if entry.get("HEAD") != proof["head"] or entry.get("branch") != "refs/heads/" + proof["branch"] or entry.get("locked"):
            raise ValueError("解除前 Git worktree 登记或分支变化；停止操作")
        no_users(project)
        git(project["sourcePath"], "-c", "core.hooksPath=/dev/null", "worktree", "remove", "--force", str(target), timeout=120)
    if target.exists() or any(value["path"] == str(target) for value in worktrees(project["sourcePath"])):
        raise ValueError("Git 尚未完整解除 worktree；不补造归档成功")
    manifest["worktreeDetachedAt"] = timestamp()
    save(directory, manifest)


def move_evidence(root, directory, owned, manifest):
    moves = [(Path(root) / kind / ident(tid), directory / kind / tid) for kind in ("tasks", "runs") for tid in owned["tasks"]]
    binding = Path(root) / "bindings" / manifest["project"]["projectId"]
    moves.extend((path, directory / "bindings" / path.name) for path in binding.iterdir() if path.name != "operation.lock")
    recovery = Path(root) / "recovery" / (manifest["project"]["projectId"] + ".json")
    moves.append((recovery, directory / "recovery.json"))
    for eid in set(owned["inbox"]) | set(owned["outbox"]):
        for kind in ("handled", "attention"):
            moves.append((Path(root) / kind / (ident(eid) + ".json"), directory / kind / (eid + ".json")))
    for source, destination in moves:
        if source.is_symlink():
            raise ValueError("任务证据目录包含替代链接；不移动外部对象")
        if not source.exists():
            continue
        if destination.exists():
            raise ValueError("归档证据目标已存在且原文件仍在；不覆盖")
        destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.rename(source, destination)
    manifest["evidenceMovedAt"] = timestamp()
    save(directory, manifest)


def preview(root, project_id):
    with notices.registry_inbox(root) as (registry, box):
        with notices.transaction(root, "telegram-receipts.json") as ledger:
            project = read_project(registry, project_id)
            owned = members(registry, box, ledger, project_id)
            return {
                "projectId": project_id,
                "sourcePath": project["sourcePath"],
                "worktreePath": project["worktreePath"],
                "sessionId": project.get("sessionId"),
                "archive": project.get("archive"),
                "taskCount": len(owned["tasks"]),
                "notificationCount": len(set(owned["outbox"]) | set(owned["inbox"])),
                "activeExecution": project.get("activeExecution"),
                "sourceDirectoryPreserved": True,
            }


def archive(root, project_id):
    root = Path(root).resolve()
    if not root.is_relative_to(BOT) or root == BOT:
        raise ValueError("项目归档数据必须留在 Bot 内的独立私有登记目录")
    if not (root / "archives").resolve().is_relative_to(root):
        raise ValueError("归档目录不能通过链接越出本登记根目录")
    project_id = ident(project_id)
    with operation(root, project_id), browser_lock(root):
        with notices.registry_inbox(root) as (registry, box):
            with notices.transaction(root, "telegram-receipts.json") as ledger:
                bound = read_project(registry, project_id)
                previous = bound.get("archive")
                if previous and previous["state"] == "archived":
                    proof_path = Path(previous["path"]) / "manifest.json"
                    if runner.digest(proof_path.read_bytes()) != previous.get("manifestHash"):
                        raise ValueError("已归档项目的清单证据缺失或变化；请先核查")
                    return {
                        "projectId": project_id,
                        "state": "archived",
                        "path": previous["path"],
                        "alreadyArchived": True,
                    }
                if previous:
                    directory = Path(previous["path"])
                    if not directory.is_relative_to(root / "archives") or directory.is_symlink():
                        raise ValueError("归档路径不属于本登记根目录")
                    manifest = runner.read(directory / "manifest.json")
                    project = manifest["project"]
                    current_binding = {key: value for key, value in bound.items() if key != "archive"}
                    if project["projectId"] != project_id or runner.digest(project) != previous.get("projectHash") or current_binding != project:
                        raise ValueError("归档身份不同；停止操作")
                else:
                    project = copy.deepcopy(bound)
                    manifest = None
                owned = members(registry, box, ledger, project_id)
                settled(project, owned)
                paths(root, project, registry)
                pending_bind(root, project_id)
                runtime(project)
                if manifest is None:
                    directory = root / "archives" / (timestamp().replace(":", "-") + "_" + project_id + "_" + uuid.uuid4().hex[:8])
                    directory.mkdir(parents=True, mode=0o700)
                    manifest = {
                        "version": 1,
                        "state": "archiving",
                        "startedAt": timestamp(),
                        "project": project,
                        "records": owned,
                    }
                    save(directory, manifest)
                    bound["archive"] = {
                        "state": "archiving",
                        "path": str(directory),
                        "startedAt": manifest["startedAt"],
                        "projectHash": runner.digest(project),
                    }
        try:
            step = "close_client"
            close_client(project, directory, manifest)
            step = "save_worktree"
            snapshot_worktree(project, directory, manifest)
            step = "archive_coding_agent_home"
            codex.archive_home(root, project, directory, manifest, lambda: save(directory, manifest))
            step = "detach_worktree"
            detach_worktree(project, directory, manifest)
            step = "move_task_evidence"
            move_evidence(root, directory, manifest["records"], manifest)
            step = "prune_browser"
            codex.prune_browser(root, project)
            step = "finalize_registry_and_notifications"
            with notices.registry_inbox(root) as (registry, box):
                with notices.transaction(root, "telegram-receipts.json") as ledger:
                    bound = read_project(registry, project_id)
                    current_binding = {key: value for key, value in bound.items() if key != "archive"}
                    if bound.get("archive", {}).get("path") != str(directory) or current_binding != project:
                        raise ValueError("归档期间项目绑定变化；停止操作")
                    owned = members(registry, box, ledger, project_id)
                    settled(project, owned)
                    for event in owned["outbox"].values():
                        for target in registry["outbox"][event["event_id"]]["targets"].values():
                            if target["state"] not in ("success", "unknown"):
                                target.update(state="superseded", reason="project_archived", at=time.time())
                    for eid in owned["inbox"]:
                        if box[eid].get("state") != "handled":
                            box[eid].update(state="superseded", disposition={
                                "reason": "project_archived",
                                "at": time.time(),
                            })
                    manifest.update(state="archived", finishedAt=timestamp())
                    manifest.pop("lastError", None)
                    save(directory, manifest)
                    marker = {
                        "state": "archived",
                        "path": str(directory),
                        "startedAt": manifest["startedAt"],
                        "archivedAt": manifest["finishedAt"],
                        "manifestHash": runner.digest((directory / "manifest.json").read_bytes()),
                    }
                    # 最小标记按 ID、原目录和 worktree 阻止换名绕过；完整绑定/任务历史保存在私有档案。
                    registry["projects"][project_id] = {key: project[key] for key in ("projectId", "sourcePath", "worktreePath")}
                    registry["projects"][project_id]["archive"] = marker
            return {
                "projectId": project_id,
                "state": "archived",
                "path": str(directory),
                "taskCount": len(manifest["records"]["tasks"]),
                "sessionId": project.get("sessionId"),
                "sourcePath": project["sourcePath"],
                "sourceDirectoryPreserved": True,
            }
        except BaseException as error:
            manifest["lastError"] = {
                "type": type(error).__name__,
                "step": step,
                "reason": str(error) if isinstance(error, ValueError) else None,
                "errno": getattr(error, "errno", None),
                "exitCode": getattr(error, "returncode", None),
                "at": timestamp(),
            }
            save(directory, manifest)
            raise
