# 真实 Herdr/Codex 独立验收：在 test 的长期 worktree 发任务并实查结果；调用 execution，不模拟 worker/消息/状态。
import argparse
import copy
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT / ".pi/extensions/background"))
from execution import codex, herdr, runner
from storage.registry import atomic, timestamp, transaction


def run_cli(directory, *args):
    process = subprocess.run(
        [sys.executable, str(PROJECT / ".pi/extensions/background/execution/runner.py"), "--root", str(directory / "background"), *args],
        capture_output=True, text=True,
    )
    if process.returncode != 0:
        raise RuntimeError(process.stderr)
    return json.loads(process.stdout)


def handoff(directory, project, task_id, text, scope, acceptance):
    task = {
        "taskId": task_id,
        "projectId": project["projectId"],
        "instruction": text,
        "scope": scope,
        "acceptance": acceptance,
        "artifacts": scope,
    }
    folder = directory / "handoffs" / task_id
    spec = {
        "version": 2,
        "project": project,
        "task": task,
        "source": "direct-real-execution-test",
    }
    prompt = "\n".join([
        "# 独立后台真实测试任务",
        f"项目：{project['projectId']}",
        f"工作目录：{project['worktreePath']}",
        f"分支：{project['branch']}",
        "",
        text,
        "",
        "允许修改：" + "、".join(scope),
        "验收标准：",
        *["- " + item for item in acceptance],
        "",
        "只处理本任务，保留已有文件，不修改范围外内容，不提交、不推送、不安装依赖。",
    ])
    atomic(folder / "spec.json", json.dumps(spec, ensure_ascii=False, indent=2) + "\n")
    atomic(folder / "prompt.md", prompt)
    return folder


def independent_checks(worktree, task_id, directory, second=False):
    python = worktree / "herdr-execution-validation/text.py"
    module_spec = importlib.util.spec_from_file_location("real_text_validation", python)
    module = importlib.util.module_from_spec(module_spec)
    old = sys.dont_write_bytecode
    sys.dont_write_bytecode = True
    try:
        module_spec.loader.exec_module(module)
    finally:
        sys.dont_write_bytecode = old
    cases = [("  Hello\tworld\n", "Hello world"), ("\u3000甲\u00a0乙\t 丙\n", "甲 乙 丙"), ("  \n\t", ""), ("已经整理好", "已经整理好"), ("", "")]
    for source, expected in cases:
        assert module.normalize_whitespace(source) == expected
    if second:
        for source in (None, 1, [], b"text"):
            try:
                module.normalize_whitespace(source)
            except TypeError as error:
                assert str(error) == "text must be str"
            else:
                raise AssertionError("非字符串输入没有抛出 TypeError")
    process = subprocess.run(
        [sys.executable, "-m", "unittest", "discover", "-s", "herdr-execution-validation", "-p", "test_*.py", "-v"],
        cwd=worktree, capture_output=True, text=True,
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
    )
    atomic(directory / "independent-tests.stdout", process.stdout)
    atomic(directory / "independent-tests.stderr", process.stderr)
    assert process.returncode == 0, process.stderr
    assert (worktree / "herdr-execution-validation/README.md").is_file()
    return [
        {
            "name": "独立正常输入与 Unicode/空白边界检查",
            "passed": True,
        },
        {
            "name": "真实 unittest",
            "passed": True,
            "exit_code": process.returncode,
            "stdout_hash": runner.digest(process.stdout.encode()),
            "stderr_hash": runner.digest(process.stderr.encode()),
        },
    ]


def main(directory):
    project = runner.read(directory / "project.json")
    settings = runner.read(directory / "settings.json")
    worktree = Path(project["worktreePath"])
    result = {
        "started_at": timestamp(),
        "mocked": False,
        "project": project,
        "cases": [],
    }
    protected = runner.read(directory / "baseline.json")
    baseline = runner.worktree_snapshot(str(worktree))
    try:
        bound = run_cli(directory, "bind", "--project", str(directory / "project.json"), "--settings", str(directory / "settings.json"))
        known = codex.sessions(settings["agent"]["home"], project["worktreePath"])
        native = herdr.native_session(directory / "background", project["projectId"]) if known else None
        result["session_id"] = native["id"] if native else None
        result["session_name"] = "herdr-" + project["projectId"]
        if native:
            assert codex.title(settings["agent"]["home"], native["id"]) == result["session_name"]
        result["herdr"] = bound["project"]["herdr"]
        tasks = [
            (
                "real-normalize-whitespace",
                "在 herdr-execution-validation/ 新建纯 Python 小模块 text.py，提供 normalize_whitespace(text)：把所有连续 Unicode 空白合并成一个普通空格，并去除首尾空白。补 unittest 和简短 README，实际运行测试。只使用标准库。",
                ["正常文本、空字符串、全空白、换行、制表符与 Unicode 空白正确处理", "真实运行 unittest，通过", "README 说明使用和测试命令"],
            ),
            (
                "real-normalize-type-check",
                "继续刚才的小模块，为 normalize_whitespace 增加非字符串输入校验：None、整数、列表、bytes 都必须抛出 TypeError，错误文本固定为 text must be str。保留上一次的所有行为和文件，补充真实测试与 README，并运行完整测试。",
                ["非字符串输入抛出指定 TypeError", "第一轮的正常行为全部保持", "完整 unittest 通过"],
            ),
            (
                "real-missing-input",
                "只读任务：读取 herdr-execution-validation/required-input-does-not-exist.json，然后按其中内容生成说明。如果文件不存在，明确以 read_error 报告失败；不要创建该输入文件、不要修改项目文件、不要编造内容。",
                ["缺少真实输入时报告 read_error，不能报告 goal_complete", "worktree 内容保持原值"],
            ),
        ]
        for index, (task_id, text, acceptance) in enumerate(tasks, 1):
            folder = handoff(directory, project, task_id, text, ["herdr-execution-validation"], acceptance)
            record = run_cli(directory, "run", "--spec", str(folder / "spec.json"), "--prompt", str(folder / "prompt.md"), "--run-id", "run-001", "--timeout", "600")
            execution = runner.read(record["result_path"])
            evidence = runner.read(Path(record["result_path"]).parent / "herdr-evidence.json")
            if result["session_id"] is None:
                result["session_id"] = evidence["session_id"]
            assert evidence["session_id"] == result["session_id"]
            assert evidence["session_name"] == result["session_name"]
            assert evidence["native_input_count"] == 1
            assert not evidence["outside_scope"]
            assert execution["pid_identity"] and execution["exit_code"] == 0
            assert execution["marker"]["seen"]
            case = {
                "task_id": task_id,
                "run_id": "run-001",
                "result_path": record["result_path"],
                "execution_status": runner.result_status(execution),
                "passed": False,
            }
            result["cases"].append(case)
            if index < 3:
                assert case["execution_status"] == "ready_for_review"
                checks = independent_checks(worktree, task_id, Path(record["result_path"]).parent, second=index == 2)
                review = {
                    "task_id": task_id,
                    "run_id": "run-001",
                    "passed": True,
                    "checks": checks,
                    "reviewed_at": timestamp(),
                }
                review_path = Path(record["result_path"]).parent / "review.json"
                runner.atomic_json(review_path, review, immutable=True)
                run_cli(directory, "verify", task_id, "run-001", "--evidence", str(review_path))
                case["verified"] = True
                case["checks"] = checks
                checkpoint = runner.worktree_snapshot(str(worktree))
            else:
                assert case["execution_status"] == "blocked"
                assert execution["reason"] == "read_error"
                assert runner.worktree_snapshot(str(worktree)) == checkpoint
                case["verified"] = False
            case["passed"] = True
            result["finished_at"] = timestamp()
            runner.atomic_json(directory / "result.json", result)
            print(json.dumps({
                "task": task_id,
                "status": case["execution_status"],
                "passed": True,
            }, ensure_ascii=False), flush=True)
        current = runner.worktree_snapshot(str(worktree))
        assert all(current.get(path) == value for path, value in baseline.items())
        assert all(path.startswith("herdr-execution-validation/") for path in set(current) - set(baseline))
        for name, expected in protected["protected"].items():
            assert runner.digest((PROJECT / name).read_bytes()) == expected, name
        for name, expected in protected["projects"][project["sourcePath"]].items():
            assert runner.digest((Path(project["sourcePath"]) / name).read_bytes()) == expected, name
        result["protected_files_unchanged"] = True
        result["passed"] = True
    except Exception as error:
        result["passed"] = False
        result["error"] = f"{type(error).__name__}: {error}"
        raise
    finally:
        result["finished_at"] = timestamp()
        runner.atomic_json(directory / "result.json", result)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--verification", type=Path, required=True)
    args = parser.parse_args()
    main(args.verification.resolve())
