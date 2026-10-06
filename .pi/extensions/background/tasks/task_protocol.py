# 后台任务文件 CLI：沿用 Joye 的登记、start-run/run/result/verify；原话与交接在本文件，真实派发和结果交给 execution/。
import argparse
import copy
import hashlib
import json
import os
import signal
import sys
from pathlib import Path
from datetime import datetime

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from projects.registry import get, register as register_project
from storage.registry import DEFAULT_ROOT, atomic, ident, required, timestamp, transaction
from worktrees.check import check
from worktrees.manage import ensure as ensure_worktree


def text_list(value, field):
    if not isinstance(value, list) or not value:
        raise ValueError(f"{field} 必须是非空列表")
    return [required(item, field) for item in value]


def paths(value, field):
    items = text_list(value, field)
    for item in items:
        path = Path(item)
        if path.is_absolute() or ".." in path.parts or item == ".":
            raise ValueError(f"{field} 只允许 worktree 内的相对文件或目录路径")
    return items


def digest(value):
    # 与 Joye task_protocol.py 的 digest 相同；不再另定义一种序列化格式。
    content = value if isinstance(value, bytes) else json.dumps(value, sort_keys=True).encode()
    return hashlib.sha256(content).hexdigest()


def beijing_time(value, field):
    text = required(value, field)
    try:
        date = datetime.fromisoformat(text)
    except ValueError as error:
        raise ValueError(f"{field} 必须为北京时间 ISO 时间") from error
    if date.utcoffset() is None or date.utcoffset().total_seconds() != 8 * 3600:
        raise ValueError(f"{field} 必须明确标注北京时间 +08:00")
    return text


def original_request(value):
    if not isinstance(value, dict):
        raise ValueError("originalRequest 必须来自真实用户消息，不能从 instruction 补造")
    text = value.get("text")
    if not isinstance(text, str) or not text.strip():
        raise ValueError("originalRequest.text 不能为空")
    if value.get("source") not in ("pi-session", "telegram"):
        raise ValueError("原话来源必须为 pi-session 或 telegram")
    result = {
        "text": text,
        "source": value["source"],
        "sessionId": required(value.get("sessionId"), "originalRequest.sessionId"),
        "entryId": required(value.get("entryId"), "originalRequest.entryId"),
        "receivedAt": beijing_time(value.get("receivedAt"), "originalRequest.receivedAt"),
    }
    if value["source"] == "telegram":
        telegram = value.get("telegram")
        if not isinstance(telegram, dict):
            raise ValueError("TG 原话必须保留消息来源")
        for key in ("chatId", "messageId"):
            if type(telegram.get(key)) is not int:
                raise ValueError(f"originalRequest.telegram.{key} 必须为整数")
        result["telegram"] = {
            "chatId": telegram["chatId"],
            "messageId": telegram["messageId"],
            "sentAt": beijing_time(telegram.get("sentAt"), "originalRequest.telegram.sentAt"),
        }
        if "turnId" in telegram:
            result["telegram"]["turnId"] = required(telegram["turnId"], "originalRequest.telegram.turnId")
        if "threadId" in telegram:
            if type(telegram["threadId"]) is not int:
                raise ValueError("originalRequest.telegram.threadId 必须为整数")
            result["telegram"]["threadId"] = telegram["threadId"]
    return result


def register_task(root, request):
    task_id = ident(request.get("taskId"))
    project_id = ident(request.get("projectId"))
    candidate = {
        "taskId": task_id,
        "projectId": project_id,
        "originalRequest": original_request(request.get("originalRequest")),
        "instruction": required(request.get("instruction"), "instruction"),
        "scope": paths(request.get("scope"), "scope"),
        "acceptance": text_list(request.get("acceptance"), "acceptance"),
        "artifacts": paths(request.get("artifacts"), "artifacts"),
    }
    with transaction(root) as registry:
        get(registry, project_id)
        old = registry["tasks"].get(task_id)
        if old:
            if any(old.get(key) != value for key, value in candidate.items()):
                raise ValueError("taskId 已存在且内容不同；不覆盖原任务")
            return old
        candidate.update({"status": "registered", "createdAt": timestamp()})
        registry["tasks"][task_id] = candidate
        return candidate


def update_task(root, request):
    # 参考 Joye update_metadata：限定可修改字段，并在同一个登记锁内比较 expectedHash。
    task_id = ident(request.get("taskId"))
    changes = request.get("changes")
    allowed = {"instruction", "scope", "acceptance", "artifacts"}
    if not isinstance(changes, dict) or not changes or set(changes) - allowed:
        raise ValueError("只允许更新 instruction/scope/acceptance/artifacts；状态和项目绑定不能直接修改")
    normalized = {}
    for key, value in changes.items():
        if key == "instruction":
            normalized[key] = required(value, key)
        elif key == "acceptance":
            normalized[key] = text_list(value, key)
        else:
            normalized[key] = paths(value, key)
    change_request = original_request(request.get("changeRequest"))
    with transaction(root) as registry:
        task = registry["tasks"].get(task_id)
        if not task:
            raise ValueError("任务尚未登记")
        if digest(task) != request.get("expectedHash"):
            raise ValueError("任务已变化，请重新 inspect 后使用最新 taskHashes 更新")
        if task["status"] != "registered":
            raise ValueError("任务已进入执行阶段，本版不能改写正在执行的需求")
        original_request(task.get("originalRequest"))
        if all(task.get(key) == value for key, value in normalized.items()):
            return task
        changed_at = timestamp()
        previous_hash = digest(task)
        task.setdefault("revisions", []).append({
            "changedAt": changed_at,
            "request": change_request,
            "previousHash": previous_hash,
            "before": {key: copy.deepcopy(task[key]) for key in sorted(allowed)},
            "changes": normalized,
        })
        task.update(normalized)
        task["updatedAt"] = changed_at
        task["status"] = "registered"
        # 原稿留在现场，但已失去当前文件绑定；必须再次 prepare 才能成为本次交接稿。
        for key in ("files", "specHash", "promptHash"):
            task.pop(key, None)
        return task


def quote_request(original):
    lines = [
        *[f"> {line}" for line in original["text"].split("\n")],
        f"来源：{original['source']} / session {original['sessionId']} / entry {original['entryId']}",
        f"消息进入 Pi 的时间：{original['receivedAt']}",
    ]
    telegram = original.get("telegram")
    if telegram:
        lines.extend([
            f"TG 消息来源：chat {telegram['chatId']} / message {telegram['messageId']}",
            f"TG 原始发送时间：{telegram['sentAt']}",
        ])
        if "turnId" in telegram:
            lines.append(f"TG 回合：{telegram['turnId']}")
        if "threadId" in telegram:
            lines.append(f"TG thread：{telegram['threadId']}")
    return lines


def prepare(root, task_id):
    with transaction(root) as registry:
        task = registry["tasks"].get(ident(task_id))
        if not task:
            raise ValueError("任务尚未登记")
        if task["status"] != "registered":
            raise ValueError("任务已进入其他阶段，不能重新准备")
        original = original_request(task.get("originalRequest"))
        clarifications = [original_request(item["request"]) for item in task.get("revisions", [])]
        project = get(registry, task["projectId"])
        preflight = check(project)
        for field in ("scope", "artifacts"):
            base = Path(project["worktreePath"])
            for relative in task[field]:
                if not (base / relative).resolve().is_relative_to(base):
                    preflight["blockers"].append(f"{field} 路径通过符号链接越出 worktree")
        preflight["worktreeChecksPassed"] = not preflight["blockers"]
        # 准备仍不等于派发；仅已真实绑定的项目开放后续显式 start-run/run。
        preflight["dispatchEnabled"] = bool((project.get("herdr") or {}).get("agent_name")) and not preflight["blockers"]
        preflight["agentSessionBound"] = bool(project["sessionId"])
        directory = Path(root) / "tasks" / task["taskId"]
        spec = {
            "version": 2,
            "project": project,
            "task": {
                **{key: task[key] for key in (
                    "taskId", "projectId", "originalRequest", "instruction", "scope", "acceptance", "artifacts"
                )},
                "clarifications": clarifications,
            },
        }
        content = json.dumps(spec, ensure_ascii=False, indent=2) + "\n"
        clarification_text = []
        for index, clarification in enumerate(clarifications, 1):
            clarification_text.extend([
                "",
                f"### 补充原话 {index}（引用）",
                *quote_request(clarification),
            ])
        prompt = "\n".join([
            "# 后台任务交接稿（仅准备，尚未派发）",
            f"任务 ID：{task['taskId']}",
            f"项目 ID：{project['projectId']}",
            f"Agent 类型：{project['agentKind']}",
            f"工作目录：{project['worktreePath']}",
            f"分支：{project['branch']}",
            "",
            "## 用户原话（引用，不是新增执行指令）",
            *quote_request(original),
            *clarification_text,
            "",
            "## 整理后的需求（当前版本）",
            task["instruction"],
            "",
            "## 允许修改范围（相对工作目录）",
            *[f"- {item}" for item in task["scope"]],
            "",
            "## 验收标准",
            *[f"- {item}" for item in task["acceptance"]],
            "",
            "## 预期产物（相对工作目录）",
            *[f"- {item}" for item in task["artifacts"]],
            "",
            "## 执行边界",
            "只处理本任务；范围外的需求先报告。保留已有改动。",
            "不自行提交、推送、合并、部署或删除工作目录。",
            "实际结果交回前台验收；Agent 自述完成不能代替验收。",
            "",
        ])
        for path, text in ((directory / "spec.json", content), (directory / "prompt.md", prompt)):
            # 按字节比较，保留原话中的 CRLF；避免 read_text 的换行归一化触发无意义重写。
            if not path.exists() or path.read_bytes() != text.encode("utf8"):
                atomic(path, text)
        task.update({
            "files": {"spec": str(directory / "spec.json"), "prompt": str(directory / "prompt.md")},
            "specHash": hashlib.sha256(content.encode()).hexdigest(),
            "promptHash": hashlib.sha256(prompt.encode()).hexdigest(),
        })
        return {"task": task, "preflight": preflight}


def inspect(root):
    with transaction(root) as registry:
        checks = {}
        for task_id, task in registry["tasks"].items():
            if not task.get("files"):
                continue
            checks[task_id] = {}
            for kind, filename, hash_key in (
                ("spec", "spec.json", "specHash"),
                ("prompt", "prompt.md", "promptHash"),
            ):
                path = Path(root) / "tasks" / ident(task_id) / filename
                try:
                    actual = hashlib.sha256(path.read_bytes()).hexdigest()
                except OSError:
                    actual = None
                expected = task.get(hash_key)
                checks[task_id][kind] = {
                    "path": str(path),
                    "expectedHash": expected,
                    "actualHash": actual,
                    "matches": expected is not None and actual == expected,
                }
        return {
            **registry,
            "taskHashes": {key: digest(value) for key, value in registry["tasks"].items()},
            "handoffChecks": checks,
        }


def read_spec(filename):
    # Joye 用 --spec/--delta 读取私有文件，正文不经 Shell 参数或 stdin 接口传递。
    value = json.loads(Path(filename).read_bytes())
    if not isinstance(value, dict):
        raise ValueError("spec/delta 必须是 JSON 对象")
    return value


def session_request(provided=None):
    session_id = os.environ.get("PI_SESSION_ID")
    if not session_id:
        # 独立 CLI 调用者负责提供真实资料；Pi 内调用必须使用运行时来源。
        return original_request(provided)
    filename = os.environ.get("PI_SESSION_FILE")
    if not filename:
        raise ValueError("当前 Pi 没有持久会话文件，不能准确登记原话")
    entries = [json.loads(line) for line in Path(filename).read_bytes().splitlines() if line.strip()]
    if not entries or entries[0].get("type") != "session" or entries[0].get("id") != session_id:
        raise ValueError("原话来源的 Pi session 身份不一致")
    nodes = {entry["id"]: entry for entry in entries[1:] if "id" in entry}
    current = entries[-1].get("id")
    branch = []
    visited = set()
    while current is not None:
        if current in visited or current not in nodes:
            raise ValueError("Pi 会话分支损坏，停止登记")
        visited.add(current)
        entry = nodes[current]
        branch.append(entry)
        current = entry.get("parentId")
    user = next((entry for entry in branch if entry.get("type") == "message"
                 and entry.get("message", {}).get("role") == "user"), None)
    source = next((entry for entry in branch if entry.get("type") == "custom"
                   and entry.get("customType") == "background-original-request"), None)
    data = source.get("data", {}) if source else {}
    if not user or data.get("entryId") != user["id"] or data.get("error"):
        raise ValueError("本轮原话未取证或输入类型不支持，不能复用旧原话或从需求补造")
    original = original_request(data.get("originalRequest"))
    if original["sessionId"] != session_id or original["entryId"] != user["id"]:
        raise ValueError("原话和当前用户消息身份不一致")
    if original["source"] == "pi-session":
        content = user["message"].get("content")
        if isinstance(content, list) and len(content) == 1 and content[0].get("type") == "text":
            content = content[0].get("text")
        if content != original["text"]:
            raise ValueError("原话和实际 Pi 用户消息不一致")
    return original


def main():
    # 命令形式沿用 Joye；run 固定使用已核对的 Herdr 适配，不提供任意命令执行接口。
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    sub = parser.add_subparsers(dest="cmd", required=True)
    command = sub.add_parser("register")
    command.add_argument("task_id")
    command.add_argument("--spec", required=True)
    command = sub.add_parser("update")
    command.add_argument("task_id")
    command.add_argument("--delta", required=True)
    command.add_argument("--expected-hash", required=True)
    sub.add_parser("inspect")
    command = sub.add_parser("project-register")
    command.add_argument("project_id")
    command.add_argument("--spec", required=True)
    command = sub.add_parser("worktree-ensure")
    command.add_argument("project_id")
    command.add_argument("--base", required=True)
    command = sub.add_parser("prepare")
    command.add_argument("task_id")
    command = sub.add_parser("start-run")
    command.add_argument("task_id")
    command.add_argument("--run-id", required=True)
    command = sub.add_parser("run")
    command.add_argument("task_id")
    command.add_argument("run_id")
    command.add_argument("--timeout", type=int, default=600)
    command = sub.add_parser("result")
    command.add_argument("task_id")
    command.add_argument("run_id")
    command = sub.add_parser("verify")
    command.add_argument("task_id")
    command.add_argument("run_id")
    command.add_argument("--evidence", required=True)
    command.add_argument("--reject", action="store_true")
    sub.add_parser("reconcile")
    command = sub.add_parser("cancel")
    command.add_argument("task_id")
    command.add_argument("run_id")
    command = sub.add_parser("retry")
    command.add_argument("task_id")
    command = sub.add_parser("claim")
    command.add_argument("--owner", required=True)
    command = sub.add_parser("validate-notice")
    command.add_argument("event_id")
    command.add_argument("claim_id")
    command.add_argument("--owner", required=True)
    command = sub.add_parser("ack")
    command.add_argument("event_id")
    command.add_argument("claim_id")
    command.add_argument("state", choices=["pending", "enqueued", "handled"])
    command.add_argument("--evidence")
    command = sub.add_parser("attention")
    command.add_argument("event_id")
    command.add_argument("claim_id")
    command.add_argument("--evidence", required=True)
    command = sub.add_parser("observe-input")
    command.add_argument("event_id")
    command.add_argument("claim_id")
    command.add_argument("--entry-id", required=True)
    command.add_argument("--session-id", required=True)
    command.add_argument("--recovery-entry-id")
    command.add_argument("--entry-at", type=float)
    command = sub.add_parser("prepare-report")
    command.add_argument("task_id")
    command.add_argument("run_id")
    command.add_argument("--text-file", required=True)
    command.add_argument("--target", required=True)
    command = sub.add_parser("report")
    command.add_argument("task_id")
    command.add_argument("run_id")
    command.add_argument("--receipt", required=True)
    args = parser.parse_args()
    # CLI 的相对根目录按调用者 cwd 解析一次；后续 Herdr/Codex 切换工作目录不改变交接路径。
    args.root = args.root.resolve()
    if args.cmd == "project-register":
        result = register_project(args.root, {**read_spec(args.spec), "projectId": args.project_id})
    elif args.cmd == "register":
        request = read_spec(args.spec)
        register_task(args.root, {
            **request,
            "taskId": args.task_id,
            "originalRequest": session_request(request.get("originalRequest")),
        })
        result = None
    elif args.cmd == "update":
        delta = read_spec(args.delta)
        change_request = session_request(delta.pop("changeRequest", None))
        update_task(args.root, {
            "taskId": args.task_id,
            "expectedHash": args.expected_hash,
            "changes": delta,
            "changeRequest": change_request,
        })
        result = None
    elif args.cmd == "worktree-ensure":
        result = ensure_worktree(args.root, args.project_id, args.base)
    elif args.cmd == "prepare":
        result = prepare(args.root, args.task_id)
    elif args.cmd == "start-run":
        from execution import runner
        with transaction(args.root) as registry:
            task = copy.deepcopy(registry["tasks"][ident(args.task_id)])
        if not task.get("files"):
            raise ValueError("交接稿尚未 prepare；先准备并核对 hash")
        tid, rid = runner.start_run(args.root, task["files"]["spec"], task["files"]["prompt"], args.run_id)
        result = rid
    elif args.cmd == "run":
        from execution.dispatch import launch
        result = launch(args.root, args.task_id, args.run_id, args.timeout)
    elif args.cmd == "result":
        from execution.dispatch import result as execution_result
        result = execution_result(args.root, args.task_id, args.run_id)
    elif args.cmd == "verify":
        from execution.runner import verify
        result = verify(args.root, ident(args.task_id), ident(args.run_id), args.evidence, args.reject)
    elif args.cmd in ("reconcile", "cancel", "retry"):
        from execution import health
        if args.cmd == "reconcile":
            result = health.reconcile(args.root)
        elif args.cmd == "cancel":
            result = health.cancel(args.root, args.task_id, args.run_id)
        else:
            result = health.retry(args.root, args.task_id)
    elif args.cmd in ("claim", "validate-notice", "ack", "attention", "observe-input", "prepare-report", "report"):
        from notifications import task_protocol as notices
        if args.cmd == "claim":
            result = notices.claim(args.root, json.loads(args.owner))
        elif args.cmd == "validate-notice":
            result = notices.validate_notice(args.root, args.event_id, args.claim_id, json.loads(args.owner))
        elif args.cmd == "ack":
            result = notices.receipt(args.root, args.event_id, args.claim_id, args.state, args.evidence)
        elif args.cmd == "attention":
            result = notices.attention(args.root, args.event_id, args.claim_id, args.evidence)
        elif args.cmd == "observe-input":
            result = notices.observe_input(args.root, args.event_id, args.claim_id, args.entry_id, args.session_id, args.recovery_entry_id, args.entry_at)
        elif args.cmd == "prepare-report":
            result = notices.prepare_report(args.root, args.task_id, args.run_id, notices.delivery_hash(Path(args.text_file).read_text()), json.loads(args.target))
        else:
            result = notices.report(args.root, args.task_id, args.run_id, read_spec(args.receipt))
    else:
        registry = inspect(args.root)
        result = {
            "registry": {key: value for key, value in registry.items() if key not in ("taskHashes", "handoffChecks")},
            "task_hashes": registry["taskHashes"],
            "handoff_checks": registry["handoffChecks"],
        }
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    os.umask(0o077)
    def interrupted(_signal, _frame):
        raise InterruptedError("操作已中断；保留现场供下次对账")
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        main()
    except Exception as error:
        message = str(error) if isinstance(error, ValueError) else "后台登记操作失败，请检查目录权限与程序状态"
        print(json.dumps({"error": type(error).__name__, "message": message}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
