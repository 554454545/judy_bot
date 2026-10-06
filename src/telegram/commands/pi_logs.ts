// Telegram /pi_logs：限量读取并脱敏项目启动日志尾部；由 index.ts 注册，不读取会话或凭据。
// 关联：scripts/startup/ 写入 runtime.log、stderr.log、restart-command.log。
import { open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TelegramExtensionCommandRegistration } from "../../../.pi/npm/node_modules/@llblab/pi-telegram/api/commands.ts";

const logDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.pi/agent/logs/startup");

export function redactLog(text: string): string {
  return text
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot[REDACTED]")
    .replace(/\b\d{5,}:[A-Za-z0-9_-]{20,}/g, "[REDACTED]")
    .replace(/(Bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|token|authorization|password)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, "$1[REDACTED]");
}

export async function readLogTail(file: string): Promise<string> {
  let handle;
  try {
    handle = await open(resolve(logDirectory, file), "r");
    const stat = await handle.stat();
    const length = Math.min(stat.size, 16384);
    const buffer = Buffer.alloc(length);
    const result = await handle.read(buffer, 0, length, stat.size - length);
    let text = buffer.subarray(0, result.bytesRead).toString("utf8");
    if (stat.size > length) {
      text = text.slice(text.indexOf("\n") + 1);
    }
    text = redactLog(text).trim().split("\n").slice(-12).join("\n");
    return text.length > 1000 ? `…${text.slice(-1000)}` : (text || "（空）");
  } catch {
    return "（日志不存在或无法读取）";
  } finally {
    await handle?.close();
  }
}

export function createPiLogsCommand(
  read = readLogTail,
): TelegramExtensionCommandRegistration {
  return {
    name: "pi_logs",
    description: "查看项目启动和错误日志尾部",
    emoji: "📋",
    showInMenu: true,
    handler: async ({ args, reply }) => {
      if (args.trim()) {
        await reply("用法：/pi_logs（无需参数）");
        return;
      }
      const files = ["runtime.log", "stderr.log", "restart-command.log"];
      const parts = await Promise.all(files.map(async file => `${file}\n${await read(file)}`));
      await reply(`📋 项目启动日志尾部\n${parts.join("\n\n")}`);
    },
  };
}
