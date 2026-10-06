// Telegram 回复策略：屏蔽桥接的流式消息事件，在回合结束后提供完整最终文字。
// 调用方：extensions/telegram/index.ts，将 commands/index.ts 返回的 Pi API 包装后交给 npm 桥接。
// 关联：npm 桥接的 message_update 处理器负责文字归一化和预览；agent_end 处理器负责最终投递。
// 只包装传给桥接的 API，不修改 Pi 原始事件、会话历史或 observability 扩展收到的事件。
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type BridgeHandler = (event: unknown, ctx: ExtensionContext) => unknown;

export function finalReplyOnlyApi(pi: ExtensionAPI): ExtensionAPI {
  let updateHandler: BridgeHandler | undefined;

  return {
    ...pi,
    on: new Proxy(pi.on, {
      apply(target, _receiver, args) {
        const [name, handler] = args as [string, BridgeHandler];
        // 捕获桥接的流式处理器，不把它注册到 Pi，避免中间文字和预览被实时发送。
        if (name === "message_update") {
          updateHandler = handler;
          return;
        }
        // 回合结束事件仍注册到原 Pi；先补最终文字，再执行桥接原来的投递处理器。
        if (name === "agent_end") {
          return Reflect.apply(target, pi, [name, async (event: {
            messages: Array<{
              role: string;
              stopReason?: string;
              content: Array<{ type: string; text?: string }>;
            }>;
          }, ctx: ExtensionContext) => {
            const control = (globalThis as any)[Symbol.for("bot.background.control-turn")];
            if (control?.sessionId === ctx.sessionManager.getSessionId()) {
              // 内部验收由 background/notifications 在核对真实结果后单独交付，不投递模型中间正文。
              return;
            }
            // 原始事件及历史不变；只给桥接补一个完整的最终文字块。
            const message = event.messages.findLast(item => item.role === "assistant");
            const text = message?.content
              .filter(block => block.type === "text")
              .map(block => block.text ?? "")
              .join("") ?? "";
            if (message && text.trim() && updateHandler) {
              await updateHandler({
                type: "message_update",
                message,
                assistantMessageEvent: {
                  type: "text_end",
                  contentIndex: 0,
                  content: text,
                  partial: message,
                },
              }, ctx);
              await updateHandler({
                type: "message_update",
                message,
                assistantMessageEvent: {
                  type: message.stopReason === "error" || message.stopReason === "aborted"
                    ? "error"
                    : "done",
                  reason: message.stopReason ?? "stop",
                  message,
                },
              }, ctx);
            }
            return handler(event, ctx);
          }]);
        }
        // 其余生命周期事件按原样注册到 Pi，连接、工具活动和会话管理保持原有流程。
        return Reflect.apply(target, pi, args);
      },
    }),
  };
}
