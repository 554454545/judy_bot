// 用途：自动接入项目会话搜索工具及 Pi/TG 命令；关联同目录 search.py，索引写入 .pi/agent/session-search。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerTelegramCommand } from "../../npm/node_modules/@llblab/pi-telegram/api/commands.ts";

const exec = promisify(execFile);
const script = fileURLToPath(new URL("./search.py", import.meta.url));

async function search(query: string, limit = 5, signal?: AbortSignal): Promise<string> {
  if (!query.trim() || !Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new Error("关键词不能为空，条数须为 1—20 的整数。");
  }
  const { stdout } = await exec("python3", [script, "search", query.trim(), "--limit", String(limit)], {
    timeout: 30000,
    maxBuffer: 1024 * 1024,
    signal,
  });
  return stdout.trim() || "无结果";
}

async function searchCommand(args: string): Promise<string> {
  const input = args.trim();
  if (!input) {
    return "用法：/pi-search <关键词或短语> [条数1—20]；TG 使用 /pi_search。";
  }
  const match = input.match(/^(.*?)\s+(\d+)$/);
  return search(match ? match[1] : input, match ? Number(match[2]) : 5);
}

export default function sessionSearch(pi: ExtensionAPI) {
  pi.registerTool({
    name: "session_search",
    label: "Session Search",
    description: "搜索本项目 Pi 历史会话。当需要查找之前聊过的内容时调用，提供明确关键词。返回会话 ID、北京时间和原文片段；这不是当前模型请求快照，也不是 mem0 记忆。",
    parameters: Type.Object({
      query: Type.String({ description: "历史内容的关键词或短语", minLength: 1 }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "返回会话数，默认5" })),
    }),
    async execute(_toolCallId, params, signal) {
      const output = await search(params.query, params.limit, signal);
      return {
        content: [{ type: "text", text: output }],
        details: { query: params.query },
      };
    },
  });
  pi.registerCommand("pi-search", {
    description: "检索本项目历史会话：/pi-search <关键词> [条数]",
    async handler(args, ctx) {
      try {
        ctx.ui.notify(await searchCommand(args), "info");
      } catch {
        ctx.ui.notify("会话搜索失败，请检查关键词、条数或索引目录权限。", "error");
      }
    },
  });
  const unregister = registerTelegramCommand({
    name: "pi_search",
    description: "搜索项目历史会话",
    emoji: "🔎",
    showInMenu: true,
    async handler({ args, reply }) {
      try {
        await reply(await searchCommand(args));
      } catch {
        await reply("会话搜索失败，请检查关键词、条数或索引目录权限。");
      }
    },
  });
  pi.on("session_shutdown", unregister);
}
