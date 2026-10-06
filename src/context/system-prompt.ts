// 上下文来源总入口：静态来源组装 System Prompt，动态来源组装本轮持久消息。
// 关联：memory/system-prompt.ts 明确记忆类内部顺序；extensions/context 是交给 Pi 的唯一项目组装监听。
// 边界：当前仅接入记忆类；后续 skills 等类别单独组织，不混入记忆来源表。
import type { ExtensionAPI, BeforeAgentStartEvent, BeforeAgentStartEventResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assembleMemoryPrompt, assertMemorySource, type MemorySource } from "./memory/system-prompt.ts";

const SOURCE_KEY = Symbol.for("bot.context.system-sources");
const TURN_SOURCE_KEY = Symbol.for("bot.context.turn-sources");

export function registerSystemSource(pi: ExtensionAPI, name: string, source: MemorySource) {
  assertMemorySource(name);
  const holder = globalThis as unknown as Record<symbol, Map<string, MemorySource>>;
  holder[SOURCE_KEY] ??= new Map();
  holder[SOURCE_KEY].set(name, source);
}

// 动态来源只返回资料；此入口决定消息类型和位置，Pi 负责追加并保存到 session。
export function registerTurnSource(pi: ExtensionAPI, name: string, source: MemorySource) {
  assertMemorySource(name);
  const holder = globalThis as unknown as Record<symbol, Map<string, MemorySource>>;
  holder[TURN_SOURCE_KEY] ??= new Map();
  holder[TURN_SOURCE_KEY].set(name, source);
  pi.on("session_shutdown", () => {
    if (holder[TURN_SOURCE_KEY]?.get(name) === source) {
      holder[TURN_SOURCE_KEY].delete(name);
    }
  });
}

export async function assembleTurnMessage(
  event: BeforeAgentStartEvent,
  ctx?: ExtensionContext,
): Promise<BeforeAgentStartEventResult["message"]> {
  const holder = globalThis as unknown as Record<symbol, Map<string, MemorySource>>;
  const content = await assembleMemoryPrompt(holder[TURN_SOURCE_KEY] ?? new Map(), event, ctx, "turn");
  if (!content) {
    return undefined;
  }
  return {
    customType: "memory-recall",
    content,
    display: false,
  };
}

export async function assembleSystemPrompt(systemPrompt: string, pi?: ExtensionAPI, event?: BeforeAgentStartEvent, ctx?: ExtensionContext): Promise<string> {
  if (!pi || !event) {
    return systemPrompt;
  }
  const holder = globalThis as unknown as Record<symbol, Map<string, MemorySource>>;
  const sections = [systemPrompt];
  // 记忆类：内部顺序只在 memory/system-prompt.ts 定义。
  const memory = await assembleMemoryPrompt(holder[SOURCE_KEY] ?? new Map(), event, ctx);
  if (memory) {
    sections.push(memory);
  }
  return sections.join("\n\n");
}
