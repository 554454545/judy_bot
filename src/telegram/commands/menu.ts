// Telegram 菜单同步：读取当前项目配置，将内置命令和项目命令更新到 TG 菜单。
// 调用方：同目录 index.ts，在 /telegram-connect 成功和 /pi_new 重新连接后调用。
// 关联：.pi/agent/telegram.json 保存 profile/token；npm 桥接 lib/commands.ts 构建菜单清单。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { registerTelegramBotCommands } from "../../../.pi/npm/node_modules/@llblab/pi-telegram/lib/commands.ts";

export async function syncTelegramMenu(profile: string) {
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  if (!agentDir) {
    throw new Error("未设置项目配置目录");
  }
  const config = JSON.parse(readFileSync(join(agentDir, "telegram.json"), "utf8"));
  const token = profile ? config.profiles?.[profile]?.botToken : config.botToken;
  if (!token) {
    throw new Error("未找到当前 Telegram 配置");
  }
  // 桥接 0.27.12 公开命令 API 没有菜单同步方法，使用已锁定版本的清单构建器。
  await registerTelegramBotCommands({
    setMyCommands: async commands => {
      let response;
      try {
        response = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ commands }),
          signal: AbortSignal.timeout(10000),
        });
      } catch {
        throw new Error("Telegram 菜单同步网络请求失败");
      }
      const result = await response.json();
      if (!response.ok || !result.ok) {
        throw new Error("Telegram 菜单同步失败");
      }
    },
  });
}
