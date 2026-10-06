# Coding Agent 默认配置读取：连接 agent/background/coding-agents-default-setting/ 与 projects/registry.py、execution/herdr.py 和 codex.py。
import json
from pathlib import Path

from storage.registry import ident


DIRECTORY = Path(__file__).resolve().parents[4] / ".pi/agent/background/coding-agents-default-setting"


def read(filename):
    path = DIRECTORY / filename
    if not path.resolve().is_relative_to(DIRECTORY.resolve()):
        raise ValueError("Coding Agent 默认配置不能越出指定目录")
    try:
        value = json.loads(path.read_text(encoding="utf8"))
    except (OSError, ValueError) as error:
        raise ValueError(f"无法读取 Coding Agent 默认配置：{path}") from error
    if not isinstance(value, dict):
        raise ValueError(f"Coding Agent 默认配置必须是 JSON 对象：{path}")
    return {
        key: item
        for key, item in value.items()
        if key != "_comment"
    }


def default_agent():
    return ident(read("defaults.json").get("defaultAgent"))


def agent_options(agent_kind, overrides):
    if not isinstance(overrides, dict):
        raise ValueError("Coding Agent 参数必须是 JSON 对象")
    return {
        **read(ident(agent_kind) + ".json"),
        **overrides,
    }
