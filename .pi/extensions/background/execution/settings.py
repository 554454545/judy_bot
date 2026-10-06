# Coding Agent 默认配置读取：连接 agent/background/coding-agents-default-setting/ 与 projects/registry.py、execution/herdr.py 和 codex.py。
import json
import os
import shutil
from pathlib import Path

from storage.registry import ident, required


DIRECTORY = Path(__file__).resolve().parents[4] / ".pi/agent/background/coding-agents-default-setting"
BOT = Path(__file__).resolve().parents[4]


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


def runtime_options(project, overrides):
    options = agent_options(project["agentKind"], overrides)
    for field in ("home", "authFile", "binary", "baseUrl"):
        options[field] = required(options.get(field), "agent." + field)
    for field in ("home", "authFile"):
        try:
            value = options[field].format(projectId=ident(project["projectId"]))
        except (IndexError, KeyError, ValueError) as error:
            raise ValueError("agent." + field + " 仅支持 {projectId} 路径模板") from error
        path = Path(value)
        if not path.is_absolute():
            path = BOT / path
        path = path.resolve()
        if not path.is_relative_to(BOT):
            raise ValueError("agent." + field + " 必须留在 Bot 项目内")
        options[field] = str(path)
    binary = shutil.which(options["binary"])
    if not binary or not os.access(binary, os.X_OK):
        raise ValueError("agent.binary 不存在或不可执行：" + options["binary"])
    options["binary"] = str(Path(binary).absolute())
    return options
