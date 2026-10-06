// Pi 上下文扩展入口：注册组装事件，并调用 src/context 中的具体实现。
// 关联：start.sh 将本扩展加载在 Telegram 之后、observability 之前。
// 关联：system-prompt.ts 处理每个用户回合；assemble-messages.ts 处理每次模型调用。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { assembleSystemPrompt, assembleTurnMessage } from "../../src/context/system-prompt.ts";
import { assembleMessages } from "../../src/context/assemble-messages.ts";

export default function contextEntry(pi: ExtensionAPI) {
  // 静态规则保留在 System Prompt；动态记忆作为本轮消息交给 Pi 持久追加。
  pi.on("before_agent_start", async (event, ctx) => {
    const observer = (globalThis as any)[Symbol.for("bot.observability.telegram-turn")];
    const assemble = async () => {
      const systemPrompt = await assembleSystemPrompt(event.systemPrompt, pi, event, ctx);
      const message = await assembleTurnMessage(event, ctx);
      return {
        systemPrompt,
        ...(message ? { message } : {}),
      };
    };
    return observer ? observer.span("context.assemble", assemble) : assemble();
  });

  // 工具执行后再次请求模型时也会触发；返回完整消息列表，不直接改写历史。
  pi.on("context", event => {
    return {
      messages: assembleMessages(event.messages),
    };
  });
}
