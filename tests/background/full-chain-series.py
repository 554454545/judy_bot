# 同项目复杂实验串行驱动：上一整组实际通过才启动下一组，任一失败即停；关联 full-chain.mjs 和 re.md，不改变后台会话。
import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

BOT = Path(__file__).resolve().parents[2]
DRIVERS = BOT / ".pi/agent/background/verification/full-chain"


def main(args):
    os.umask(0o077)
    assert args.live
    assert args.attempt > 0 and args.after_attempt > 0
    assert len(set(args.cases)) == len(args.cases)
    assert all(1 <= case <= 10 for case in args.cases)
    assert all(case <= 5 for case in args.cases) or all(case > 5 for case in args.cases)
    base = Path((DRIVERS / "current.txt").read_text().strip())
    previous = base / f"group-{args.after_case}-attempt-{args.after_attempt}/result.json"
    started = time.monotonic()
    print(json.dumps({"stage": "waiting-for-passed-group", "case": args.after_case, "attempt": args.after_attempt}), flush=True)
    while not previous.exists():
        if time.monotonic() - started > 3600:
            raise TimeoutError("等待上一组完整证据超时，不启动下一组")
        time.sleep(1)
    assert json.loads(previous.read_text())["passed"], "上一组失败，不进入下一组"
    for case in args.cases:
        output = DRIVERS / f"group-{case}-attempt-{args.attempt}-driver.log"
        assert not output.exists(), "保留旧驱动日志，不覆盖已有尝试"
        print(json.dumps({"stage": "next-real-group", "group": case, "attempt": args.attempt}), flush=True)
        with output.open("w") as log:
            response = subprocess.run(["node", str(BOT / "tests/background/full-chain.mjs"), "--live", "--case", str(case), "--attempt", str(args.attempt)], cwd=BOT, stdout=log, stderr=log)
        current = base / f"group-{case}-attempt-{args.attempt}/result.json"
        assert response.returncode == 0 and current.exists() and json.loads(current.read_text())["passed"], f"实验 {case} 失败，串行实验停止"
    print(json.dumps({"stage": "series-passed", "groups": args.cases, "seconds": time.monotonic() - started}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--live", action="store_true", required=True)
    parser.add_argument("--after-case", type=int, required=True)
    parser.add_argument("--after-attempt", type=int, default=1)
    parser.add_argument("--cases", type=int, nargs="+", required=True)
    parser.add_argument("--attempt", type=int, default=1)
    main(parser.parse_args())
