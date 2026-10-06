// Telegram /pi_new 实现：调用 Pi 原生 newSession 创建空白会话并保留旧会话。
// 调用方：commands/index.ts 创建本命令，再通过桥接的 registerTelegramCommand 注册。
// 关联：src/pi/session-file.ts 设置北京时间文件名；commands/index.ts 绑定新上下文并重新连接。
// 关联：notifications.ts 提供 notifyReady，通过当前桥接发送完成通知，避免使用旧会话的 reply。
import { useBeijingSessionFilename } from "../../pi/session-file.ts";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { recordTelegramRuntimeEvent } from "../../../.pi/npm/node_modules/@llblab/pi-telegram/api/outbound.ts";
import type { TelegramExtensionCommandRegistration } from "../../../.pi/npm/node_modules/@llblab/pi-telegram/api/commands.ts";

export function createPiNewCommand(
  getContext: () => ExtensionCommandContext | undefined,
  bindContext: (ctx: ExtensionCommandContext) => Promise<void> | void,
  notifyReady: (text: string) => Promise<void>,
): TelegramExtensionCommandRegistration {
  let switching = false;
  return {
    name: "pi_new",
    description: "新建会话",
    emoji: "🆕",
    showInMenu: true,
    handler: async ({ args, reply }) => {
      if (args.trim()) {
        await reply("用法：/pi_new（无需参数）");
        return;
      }
      const ctx = getContext();
      if (!ctx) {
        await reply("会话控制尚未就绪，请在本地重新连接 Telegram。");
        return;
      }
      if (switching) {
        await reply("正在新建会话，请稍候。");
        return;
      }
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        await reply("当前还有任务或排队消息，请先 /stop，再发送 /pi_new。");
        return;
      }
      switching = true;
      // 参考 Joye：切换前先给明确反馈；回复失败时不继续创建会话。
      try {
        await reply("🆕 正在新建会话，旧会话会保留。");
      } catch (error) {
        switching = false;
        throw error;
      }
      // 命令回调先返回轮询循环；否则 newSession 的关闭逻辑会等待当前轮询自身。
      setTimeout(() => {
        void switchSession().catch(error => {
          recordTelegramRuntimeEvent("telegram-new", error, {
            phase: "completion-notification",
          });
        });
      }, 0);

      async function switchSession() {
        let created = false;
        let newSessionId: string | undefined;
        try {
          const result = await ctx!.newSession({
            setup: async manager => {
              useBeijingSessionFilename(manager);
            },
            withSession: async fresh => {
              created = true;
              newSessionId = fresh.sessionManager.getSessionId();
              await bindContext(fresh);
            },
          });
          if (result.cancelled) {
            await reply("新建会话已取消。");
            return;
          }
        } catch {
          const notify = created ? notifyReady : reply;
          await notify(
            created
              ? "新会话已建立，但后续初始化失败，请检查本地状态。"
              : "新建会话失败，请检查本地 Pi 状态后重试。",
          );
          return;
        } finally {
          switching = false;
        }
        await notifyReady(
          `🆕 已新建会话，可以开始提问。\n会话 ID：${newSessionId}\n旧会话已保留。`,
        );
      }
    },
  };
}
