// 记忆模块统一路径：供 inject、autosediment、recap 使用；所有配置和运行数据位于项目内。
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const MEMORY_ROOT = resolve(PROJECT_ROOT, ".mem0");
export const MEMORY_FILES = ["memory.md", "user.md"].map((name) => resolve(MEMORY_ROOT, name));
export const MEM0_PYTHON = resolve(MEMORY_ROOT, "venv/bin/python");
export const MEM0_CLI = resolve(PROJECT_ROOT, ".pi/extensions/memory/mem0/mem0-cli.py");
export const RECAPS_DIR = resolve(PROJECT_ROOT, ".pi/agent/recaps");
export const AUTOSED_LOG = resolve(PROJECT_ROOT, ".pi/agent/logs/memory/autosediment.log");
