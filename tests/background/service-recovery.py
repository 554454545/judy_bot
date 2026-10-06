# Herdr 冷启动真实回归：在独立命名测试实例验证同一 service 启动/恢复 Shell 后清理；关联 execution/service.py，不停止 bot 或全局 server。
import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

BOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(BOT / ".pi/extensions/background"))
from execution import dispatch, service, runner
from storage.registry import timestamp


def main(attempt):
    assert os.environ.get("HERDR_ENV") == "1"
    os.umask(0o077)
    base = Path((BOT / ".pi/agent/background/verification/full-chain/current.txt").read_text().strip())
    directory = base / f"herdr-cold-start-attempt-{attempt}"
    assert not directory.exists()
    directory.mkdir(mode=0o700)
    namespace = "h" + str(os.getpid())
    # Unix socket 的 sun_path 有长度上限；运行路径用项目内短缓存，证据仍放完整验收目录。
    short = BOT / ".cache" / ("herdr-health-" + str(os.getpid()))
    assert not short.exists()
    short.mkdir(mode=0o700)
    protected = dispatch.control(service.SETTINGS, "agent", "list")
    original = {agent["name"]: {key: agent[key] for key in ("workspace_id", "pane_id", "cwd")} for agent in protected["result"]["agents"]}
    os.environ.update({
        "HERDR_SESSION": namespace,
        "HERDR_CONFIG_PATH": str(BOT / ".pi/agent/background/herdr/config.toml"),
        "XDG_CONFIG_HOME": str(short / "config"),
        "XDG_STATE_HOME": str(short / "state"),
        "XDG_CACHE_HOME": str(short / "cache"),
        "XDG_RUNTIME_DIR": str(short / "runtime"),
        "TMPDIR": str(BOT / ".cache/tmp/background"),
        "HISTFILE": str(short / "bash_history"),
        "PATH": str(BOT / "scripts/startup") + os.pathsep + os.environ["PATH"],
    })
    for key in ("HERDR_SOCKET_PATH", "HERDR_CLIENT_SOCKET_PATH", "HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_PANE_ID"):
        os.environ.pop(key, None)
    for name in ("config", "state", "cache", "runtime"):
        (short / name).mkdir(mode=0o700)
    # 仅更换真实测试实例配置；启动、查询和恢复逻辑仍是生产 service 的同一实现。
    service.SETTINGS.update(herdrPath=str(BOT / "tools/herdr/herdr"), herdrSession=namespace)
    result = {"startedAt": timestamp(), "namespace": namespace, "runtimeDirectory": str(short), "passed": False, "checks": []}
    started = time.monotonic()

    def pane():
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            try:
                return service.runtime_pane(directory)
            except ValueError:
                time.sleep(.2)
        raise TimeoutError("真实测试实例的 Shell 未就绪")

    def stop():
        response = subprocess.run(
            [service.SETTINGS["herdrPath"], "--session", namespace, "server", "stop"],
            capture_output=True,
            text=True,
            timeout=15,
        )
        # server stop 的成功输出不是 JSON；记录原生退出证据，不伪造服务响应。
        return {
            "source": "actual_cli_exit_status",
            "cli_exit_code": response.returncode,
            "stdout": response.stdout,
            "stderr": response.stderr,
        }

    try:
        before = time.monotonic()
        first = pane()
        result["checks"].append({"name": "冷启动真实 Herdr 与唯一空闲 Shell", "seconds": time.monotonic() - before, "paneId": first["pane_id"], "passed": True})
        second = pane()
        assert second["pane_id"] == first["pane_id"]
        result["checks"].append({"name": "重复检查不创建第二个 workspace/pane", "passed": True})
        stopped = stop()
        assert stopped["cli_exit_code"] == 0
        runner.atomic_json(directory / "first-stop.json", stopped)
        time.sleep(.5)
        third = pane()
        result["checks"].append({"name": "命名实例停止后真实重启并恢复 Shell", "paneId": third["pane_id"], "passed": True})
        current = dispatch.control({"herdrPath": str(BOT / "scripts/startup/herdr.sh"), "herdrSession": "bot"}, "agent", "list")
        after = {agent["name"]: {key: agent[key] for key in ("workspace_id", "pane_id", "cwd")} for agent in current["result"]["agents"]}
        assert original == after
        result["checks"].append({"name": "原 bot 工作实例身份完全保留", "passed": True})
        result["passed"] = True
    except Exception as error:
        result["error"] = f"{type(error).__name__}: {error}"
        raise
    finally:
        # 此 namespace 是本次创建的隔离测试对象，里面只有本测试 Shell。
        try:
            result["cleanup"] = stop()
        except ValueError as error:
            result["cleanup"] = {"already_stopped_or_unavailable": str(error)}
        result.update(finishedAt=timestamp(), seconds=time.monotonic() - started)
        runner.atomic_json(directory / "result.json", result)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--attempt", type=int, default=1)
    main(parser.parse_args().attempt)
