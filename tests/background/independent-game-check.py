# 复杂游戏独立验收：直接调用真实 worker 产物，检查确定性、输入原子性、局部 RNG、存档和回放；关联 complex-cases.mjs 与 full-chain.mjs。
import argparse
import copy
import importlib.util
import json
import random
import re
import subprocess
import sys
from pathlib import Path


def inspect(directory, phase):
    directory = directory.resolve()
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location("actual_game_engine", directory / "engine.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    checks = []

    def check(name, condition):
        if not condition:
            raise AssertionError(name)
        checks.append(name)

    def rejects(name, callback):
        try:
            callback()
        except (ValueError, TypeError):
            checks.append(name)
            return
        raise AssertionError(name + " did not reject")

    initial_global_rng = random.getstate()
    for seed in (True, None, "1", 1.5):
        rejects(f"invalid seed {seed!r}", lambda seed=seed: module.initial_state(seed))
    for seed in (0, 1, 17, 941):
        state = module.initial_state(seed)
        check(f"initial clock seed={seed}", state["tick"] == 0)
        check(f"initial stable seed={seed}", state == module.initial_state(seed))
        history = [copy.deepcopy(state)]
        for index in range(120):
            before = copy.deepcopy(state)
            next_state = module.step(state, [])
            check(f"input immutable seed={seed} tick={index}", state == before)
            check(f"clock seed={seed} tick={index}", next_state["tick"] == index + 1)
            module.validate(next_state)
            json.dumps(next_state, allow_nan=False)
            check(f"status seed={seed} tick={index}", next_state["status"] in ("running", "win", "loss"))
            entities = next_state["entities"]
            check(f"entity IDs seed={seed} tick={index}", isinstance(entities, list) and len({entity["id"] for entity in entities}) == len(entities))
            state = next_state
            if index < 3 or index == 59:
                history.append(copy.deepcopy(state))
        repeated = module.initial_state(seed)
        for _ in range(120):
            repeated = module.step(repeated, [])
        check(f"trajectory deterministic seed={seed}", state == repeated)
        if phase >= 1:
            for saved in history:
                text = module.dumps(saved)
                restored = module.loads(text)
                check(f"round trip seed={seed} tick={saved['tick']}", restored == saved)
                for _ in range(25):
                    saved = module.step(saved, [])
                    restored = module.step(restored, [])
                check(f"continue exactly seed={seed}", restored == saved)
        if phase >= 2:
            check(f"replay trajectory seed={seed}", module.replay(seed, [[] for _ in range(120)], 120) == state)
            check(f"empty replay seed={seed}", module.replay(seed, [], 0) == module.initial_state(seed))
    check("local RNG does not affect caller", random.getstate() == initial_global_rng)
    state = module.initial_state(42)
    original = copy.deepcopy(state)
    rejects("unknown command", lambda: module.step(state, [{"action": "__unknown_action__"}]))
    check("failed commands immutable", state == original)
    for field, value in (("tick", -1), ("tick", True), ("version", 999)):
        bad = copy.deepcopy(state)
        bad[field] = value
        rejects(f"invalid state {field}={value}", lambda: module.validate(bad))
    if state["entities"]:
        bad = copy.deepcopy(state)
        bad["entities"].append(copy.deepcopy(bad["entities"][0]))
        rejects("duplicate entity ID", lambda: module.validate(bad))
    if phase >= 1:
        for text in ("{invalid", '{"version":999}', "null", '{"version":1,"tick":NaN}'):
            rejects("invalid saved data", lambda text=text: module.loads(text))
    # 测试既可 import engine，也可按 README 从 worktree 根目录 import simulation.engine。
    repository = subprocess.run(["git", "-C", str(directory), "rev-parse", "--show-toplevel"], capture_output=True, text=True)
    working_directory = Path(repository.stdout.strip()) if repository.returncode == 0 else directory.parent
    process = subprocess.run([sys.executable, "-B", "-m", "unittest", "discover", "-s", str(directory), "-p", "test_*.py", "-v"], cwd=working_directory, capture_output=True, text=True, timeout=120)
    check("actual worker unittest suite", process.returncode == 0)
    count = re.search(r"Ran (\d+) tests?", process.stderr)
    check("required number of real tests", count is not None and int(count.group(1)) >= 20 + phase * 10)
    check("README describes usage", (directory / "README.md").stat().st_size > 300)
    check("engine has substantive code", (directory / "engine.py").stat().st_size > 5000)
    return {
        "passed": True,
        "phase": phase,
        "checks": {
            "seeds": [0, 1, 17, 941],
            "ticksPerSeed": 120,
            "immutableInputChecks": 480,
            "determinism": True,
            "strictJsonAndUniqueIds": True,
            "localRng": True,
            "invalidInputRejected": True,
            "saveRestore": phase >= 1,
            "replay": phase >= 2,
            "actualUnitTests": int(count.group(1)),
        },
        "checkCount": len(checks),
        "stdout": process.stdout,
        "stderr": process.stderr,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    parser.add_argument("phase", type=int)
    args = parser.parse_args()
    try:
        print(json.dumps(inspect(args.directory, args.phase), ensure_ascii=False))
    except Exception as error:
        print(json.dumps({"passed": False, "error": type(error).__name__, "message": str(error)}, ensure_ascii=False))
        sys.exit(1)
