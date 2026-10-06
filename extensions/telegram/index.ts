// Telegram 扩展入口：由 start.sh 的 -e 参数交给 Pi 加载，只负责组合模块。
// 关联：src/telegram/commands/index.ts 注册命令；src/telegram/final-reply-only.ts 控制回复显示。
// 关联：.pi/npm/node_modules/@llblab/pi-telegram/index.ts 提供连接、轮询和最终消息投递。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import telegram from "../../.pi/npm/node_modules/@llblab/pi-telegram/index.ts";
import { registerProjectCommands } from "../../src/telegram/commands/index.ts";
import { finalReplyOnlyApi } from "../../src/telegram/final-reply-only.ts";

export default function telegramEntry(pi: ExtensionAPI) {
  // 注册项目 TG 命令，并包装桥接后续使用的 pi.registerCommand。
  const commandApi = registerProjectCommands(pi);
  // 接入最终回复策略，再让 npm 桥接通过同一个 pi 注册命令、工具和生命周期事件。
  telegram(finalReplyOnlyApi(commandApi));
}
