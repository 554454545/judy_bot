// Telegram /pi_status：读取当前进程、会话及桥接心跳；由 index.ts 注册，不调用模型。
// 关联：项目 .pi/agent/tmp/telegram/owners.json 保存桥接所有权，Beijing 时间共用 src/time/beijing.ts。
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { beijingIsoTime } from "../../time/beijing.ts";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { TelegramExtensionCommandRegistration } from "../../../.pi/npm/node_modules/@llblab/pi-telegram/api/commands.ts";

export function createPiStatusCommand(
  getContext: () => ExtensionCommandContext | undefined,
  getProfile: () => string | undefined,
): TelegramExtensionCommandRegistration {
  return {
    name: "pi_status",
    description: "查看项目进程、会话和 TG 心跳",
    emoji: "📡",
    showInMenu: true,
    handler: async ({ args, reply }) => {
      if (args.trim()) {
        await reply("用法：/pi_status（无需参数）");
        return;
      }
      const ctx = getContext();
      const lines = [
        "📡 Pi 状态",
        `进程：${process.pid}；父进程：${process.ppid}`,
        `启动时间：${beijingIsoTime(Date.now() - process.uptime() * 1000)}`,
        `会话：${ctx?.sessionManager.getSessionId() ?? "未就绪"}`,
        `模型任务：${ctx ? (ctx.isIdle() ? "空闲" : "执行中") : "未知"}`,
      ];
      const profile = getProfile() || "default";
      try {
        const agentDir = process.env.PI_CODING_AGENT_DIR;
        if (!agentDir) {
          throw new Error("项目配置目录未设置");
        }
        const owners = JSON.parse(await readFile(join(agentDir, "tmp/telegram/owners.json"), "utf8"));
        const owner = owners[profile];
        if (!Number.isFinite(owner?.heartbeatMs) || !Number.isInteger(owner?.pid)) {
          throw new Error("心跳记录缺失");
        }
        const age = Date.now() - owner.heartbeatMs;
        lines.push(`TG profile：${profile}；owner PID：${owner.pid}`);
        lines.push(age >= 0
          ? `心跳：${Math.round(age / 1000)} 秒前更新（仅代表桥接心跳）`
          : "心跳：记录时间晚于本机时间，请检查时钟");
      } catch {
        lines.push(`TG profile：${profile}；心跳记录不可用`);
      }
      await reply(lines.join("\n"));
    },
  };
}
