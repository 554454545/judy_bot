// memory-context — 明确记忆类上下文的排列顺序，不依赖扩展注册先后。
// 流程：系统来源 personal-memory（静态记忆）→ session-recap；回合来源 personal-memory（动态召回）。
// 关联：../system-prompt.ts 保存来源并调用本模块；.pi/extensions/memory 的 inject、recap 提供内容。
// 边界：仅管理记忆类来源，不查询数据库、不保存摘要；后续 skills 应单独分类。
import type { BeforeAgentStartEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type MemorySource = (event: BeforeAgentStartEvent, ctx?: ExtensionContext) => Promise<string | undefined>;

export const MEMORY_SOURCE_ORDER = [
  "personal-memory",
  "session-recap",
] as const;

export function assertMemorySource(name: string) {
  if (!MEMORY_SOURCE_ORDER.some(source => source === name)) {
    throw new Error(`Context source has no category/order: ${name}`);
  }
}

export async function assembleMemoryPrompt(
  sources: ReadonlyMap<string, MemorySource>,
  event: BeforeAgentStartEvent,
  ctx?: ExtensionContext,
  placement: "system" | "turn" = "system",
): Promise<string> {
  for (const name of sources.keys()) {
    assertMemorySource(name);
  }
  const sections: string[] = [];
  for (const name of MEMORY_SOURCE_ORDER) {
    const source = sources.get(name);
    if (!source) {
      continue;
    }
    // 观测只包住来源调用；来源顺序、内容与异常传播保持原样。
    const observer = (globalThis as any)[Symbol.for("bot.observability.telegram-turn")];
    const read = () => source(event, ctx);
    const spanName = placement === "turn" ? `context.memory.recall.${name}` : `context.memory.${name}`;
    const content = await (observer ? observer.span(spanName, read) : read());
    if (content) {
      sections.push(content);
    }
  }
  return sections.join("\n\n");
}
