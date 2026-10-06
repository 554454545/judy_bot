# 真实失败/超时/取消/有限重试实验：原生 Herdr/Codex 执行并核对实际 Pi 接力/TG 回执；关联 live-lifecycle-observer.mjs，额外实验不计入十组。
import argparse
import copy
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

BOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(BOT / ".pi/extensions/background"))
from execution import codex, health, runner
from storage.registry import timestamp

PROTOCOL = BOT / ".pi/extensions/background/tasks/task_protocol.py"


def main(directory, project_id):
    assert os.environ.get("HERDR_ENV") == "1", "必须来自真实 Herdr"
    assert not directory.exists(), "保留每次证据，不覆盖旧实验"
    os.umask(0o077)
    directory.mkdir(parents=True, mode=0o700)
    root = directory / "background"
    (directory / "inputs").mkdir(mode=0o700)
    production = runner.read(BOT / ".pi/agent/background/registry.json")
    project = copy.deepcopy(production["projects"][project_id])
    assert not project.get("activeExecution")
    actual, native = health.inspect_agent(project)
    assert actual["agent_status"] in ("idle", "done")
    before = runner.worktree_snapshot(project["worktreePath"])
    runner.atomic_json(root / "registry.json", {"version": 1, "revision": 0, "projects": {project_id: project}, "tasks": {}})
    environment = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
    # 只继承正式项目启动器的代理，不打印凭据或进程环境。
    for folder in Path("/proc").iterdir():
        if not folder.name.isdigit():
            continue
        try:
            argv = (folder / "cmdline").read_bytes().split(b"\0")
            if len(argv) < 2 or argv[1] != str(BOT / "scripts/startup/telegram.mjs").encode():
                continue
            for value in (folder / "environ").read_bytes().split(b"\0"):
                name, _, data = value.partition(b"=")
                if name.decode() in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
                    environment[name.decode()] = data.decode()
            break
        except OSError:
            continue
    log = (directory / "observer.log").open("w")
    observer = subprocess.Popen(["node", str(BOT / "tests/background/live-lifecycle-observer.mjs"), "--live", "--root", str(root)], cwd=BOT, stdout=log, stderr=log, env=environment)
    result = {"startedAt": timestamp(), "projectId": project_id, "workerSessionId": native["id"], "mode": "real Pi user entries/Herdr/Codex/Telegram API; locally authored fault requests", "realUserTelegramIngress": False, "checks": [], "passed": False}
    started = time.monotonic()

    def cli(*args, expected=0):
        response = subprocess.run([sys.executable, str(PROTOCOL), "--root", str(root), *args], capture_output=True, text=True, timeout=30, env={**environment, "PI_SESSION_ID": "", "PI_SESSION_FILE": ""})
        assert response.returncode == expected, response.stderr
        return json.loads(response.stdout if expected == 0 else response.stderr)

    def check(name, condition, **evidence):
        result["checks"].append({"name": name, "passed": bool(condition), "at": timestamp(), **evidence})
        assert condition, name
        runner.atomic_json(directory / "progress.json", result)

    def wait(predicate, timeout=300):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if observer.poll() is not None:
                raise RuntimeError("真实 Pi 接力端意外退出；见 observer.log")
            value = predicate()
            if value:
                return value
            time.sleep(.5)
        raise TimeoutError("等待真实故障证据超时")

    def tasks():
        return runner.read(root / "registry.json")["tasks"]

    def delivered(tid, rid):
        receipt = runner.read(root / "runs" / tid / rid / "final-report-receipt.json", {})
        if receipt.get("state") in ("unknown", "sending"):
            raise RuntimeError("实际 TG 投递结果不明，保留证据且未重发；本次完整实验失败")
        handled = [event for event in runner.read(root / "inbox.json", {}).values() if event.get("task_id") == tid and event.get("run_id") == rid and event["state"] == "handled"]
        return receipt if receipt.get("state") == "success" and handled else None

    def ensure_idle():
        return health.inspect_agent(project)[0]["agent_status"] in ("idle", "done")

    try:
        owner = wait(lambda: runner.read(directory / "owner-ready.json"))
        missing = "health-experiments/lifecycle-required-source-never-created.json"
        check("失败输入确实缺失", not (Path(project["worktreePath"]) / missing).exists())
        runner.atomic_json(directory / "inputs/01-read-error.json", {
            "text": f"交给 {project_id} 后台一个只读健康测试：读取 {missing} 后生成说明。文件缺失必须 reason=read_error，如实保存错误，不创建输入、不改业务文件、不编造成功。任务 ID 固定 lifecycle-read-error，scope 和 artifacts 都写这个相对路径。登记、prepare、start-run、run --timeout 1800，快速返回。",
        })
        first = wait(lambda: tasks().get("lifecycle-read-error"))
        rid = wait(lambda: tasks()[first["taskId"]].get("run_id"))
        receipt = wait(lambda: delivered(first["taskId"], rid))
        cli("reconcile")
        task = tasks()[first["taskId"]]
        execution = runner.read(root / "runs" / first["taskId"] / rid / "result.json")
        check("实际 read_error 保持 blocked、无虚假验收", task["status"] == "blocked" and execution["reason"] == "read_error" and not task.get("verification"), messageId=receipt["message_id"])
        check("失败的原话来自真实 Pi 用户条目", task["originalRequest"]["sessionId"] == owner["sessionId"] and task["originalRequest"]["source"] == "pi-session")
        check("明确失败且原 Agent 空闲后释放占用", not runner.read(root / "registry.json")["projects"][project_id].get("activeExecution") and ensure_idle())
        for index in (1, 2):
            wait(ensure_idle)
            cli("retry", first["taskId"])
            cli("prepare", first["taskId"])
            retry_id = f"read-error-retry-{index}"
            cli("start-run", first["taskId"], "--run-id", retry_id)
            cli("run", first["taskId"], retry_id, "--timeout", "1800")
            receipt = wait(lambda: delivered(first["taskId"], retry_id))
            cli("reconcile")
            current = tasks()[first["taskId"]]
            check(f"真实重试 {index} 用新 run、仍如实失败", current["retry_count"] == index and current["status"] == "blocked" and current["run_id"] == retry_id, messageId=receipt["message_id"])
        stopped = cli("retry", first["taskId"], expected=1)
        check("两次重试后拒绝第三次", "两次返工已耗尽" in stopped["message"])
        native_offset = Path(native["path"]).stat().st_size
        runner.atomic_json(directory / "inputs/02-timeout.json", {
            "text": f"再交给 {project_id} 后台执行真实超时实验，任务 ID 固定 lifecycle-timeout。仅允许 health-experiments/lifecycle-timeout/。Coding Agent 必须先实际执行 Python time.sleep(180) 模拟等待外部程序，然后才在允许目录做确定性的铁路调度规则引擎和测试；不得伪造等待或省略。前台 run 的执行预算明确设为 --timeout 5，后续由测试控制端核查并取消，不自动重发。完成登记、prepare、start-run、run 后立即返回，不在前台 sleep。",
        })
        timed = wait(lambda: tasks().get("lifecycle-timeout"))
        timed_rid = wait(lambda: tasks()[timed["taskId"]].get("run_id"))
        wait(lambda: tasks()[timed["taskId"]]["status"] == "blocked")
        timed_result = runner.read(root / "runs" / timed["taskId"] / timed_rid / "result.json")
        check("超时原因来自真实 Herdr 返回而非猜测", timed_result["reason"] == "time_budget" and "5s" in timed_result["error"])
        actual, _ = health.inspect_agent(project)
        registered = runner.read(root / "registry.json")
        check("实际监督超时不等同 Coding Agent 已停止", actual["agent_status"] == "working" and registered["projects"][project_id].get("activeExecution") == {"task_id": timed["taskId"], "run_id": timed_rid})
        receipt = wait(lambda: delivered(timed["taskId"], timed_rid), 120)
        check("超时通知真实 API 投递，未冒充成功", receipt["state"] == "success" and tasks()[timed["taskId"]]["status"] == "blocked", messageId=receipt["message_id"])

        def actual_wait():
            with Path(native["path"]).open() as source:
                source.seek(native_offset)
                records = [json.loads(line) for line in source if line.strip()]
            invoked = [
                item for item in records
                if item.get("type") == "response_item"
                and item.get("payload", {}).get("type") in ("function_call", "custom_tool_call")
                and "sleep(180)" in item["payload"].get("arguments", item["payload"].get("input", ""))
            ]
            if not invoked:
                return None
            home = str(Path(project["executionSettings"]["agent"]["home"]).resolve()).encode()
            for process in Path("/proc").iterdir():
                if not process.name.isdigit():
                    continue
                try:
                    environment = (process / "environ").read_bytes().split(b"\0")
                    command = (process / "cmdline").read_bytes().split(b"\0")
                    channel = (process / "wchan").read_text().strip()
                    if b"CODEX_HOME=" + home in environment and command and b"python" in command[0] and "nanosleep" in channel:
                        return {"identity": runner.pid_identity(int(process.name)), "waitChannel": channel, "nativeCallId": invoked[-1]["payload"].get("call_id"), "nativeTimestamp": invoked[-1].get("timestamp")}
                except (OSError, ValueError):
                    continue
            return None

        sleeping = wait(actual_wait, 90)
        check("超时实验确有原生调用和真实计时等待进程", bool(sleeping), **sleeping)
        cli("cancel", timed["taskId"], "wrong-run", expected=1)
        check("错误 run 不能取消当前 worker", health.inspect_agent(project)[0]["agent_status"] == "working")
        proof = cli("cancel", timed["taskId"], timed_rid)
        repeat = cli("cancel", timed["taskId"], timed_rid)
        check("实际 esc 中断、PID 确认退出后取消幂等", proof == repeat and proof["after"]["agent_status"] in ("idle", "done") and ensure_idle())
        wait(lambda: not health.live(sleeping["identity"]), 15)
        check("取消没有遗留本 run 的实际等待子进程", not health.live(sleeping["identity"]), identity=sleeping["identity"])
        current = runner.read(root / "registry.json")
        check("取消后准确释放本 run 占用", current["tasks"][timed["taskId"]]["status"] == "cancelled" and not current["projects"][project_id].get("activeExecution"))
        check("原始会话与此前业务文件未改变", current["projects"][project_id]["sessionId"] == project["sessionId"] and runner.worktree_snapshot(project["worktreePath"]) == before)
        result["passed"] = True
    except Exception as error:
        result["error"] = f"{type(error).__name__}: {error}"
        raise
    finally:
        current = runner.read(root / "registry.json")
        active = current["projects"][project_id].get("activeExecution")
        if active and active["task_id"] in ("lifecycle-timeout", "lifecycle-read-error"):
            try:
                cleanup = health.cancel(root, active["task_id"], active["run_id"])
            except Exception as error:
                cleanup = {"state": "needs_reconciliation", "error": f"{type(error).__name__}: {error}"}
            runner.atomic_json(directory / "cleanup.json", cleanup)
        runner.atomic_json(directory / "stop.json", {"at": timestamp()})
        try:
            observer.wait(timeout=30)
        except subprocess.TimeoutExpired:
            observer.terminate()
            observer.wait(timeout=15)
        log.close()
        result.update(finishedAt=timestamp(), seconds=time.monotonic() - started, observerExitCode=observer.returncode)
        runner.atomic_json(directory / "result.json", result)
        with (BOT / "re.md").open("a") as report:
            report.write(f"\n### 额外真实生命周期实验：{result['finishedAt']}\n\n{result['seconds']:.1f}s；{'通过' if result['passed'] else '失败'}。证据：[{directory.name}]({directory.relative_to(BOT)}/result.json)。{result.get('error', '')}\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--live", action="store_true", required=True)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--project", default="test")
    args = parser.parse_args()
    main(args.directory.resolve(), args.project)
