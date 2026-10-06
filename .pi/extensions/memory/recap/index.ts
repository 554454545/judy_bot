// 会话摘要入口：记录回复中的状态行到项目 .pi/agent/recaps，供 inject 召回使用；路径见 ../paths.ts。
// session-recap — 每轮回复末尾追加一行状态总结（📌 状态 | 下一步），
// 并在 agent_end 时把 recap 行落盘到 .pi/agent/recaps/YYYY-MM-DD.md 形成可检索索引。
// 与 mem0 / memory.md 隔离：recap 只写增量状态行。
// 观测：保存失败通过 src/observability/memory.ts 写回原 session；stderr 兜底，不阻断回复。
// 上下文：仅注册 session-recap 内容来源，由 src/context/memory/system-prompt.ts 排序并统一组装。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSystemSource } from "../../../../src/context/system-prompt.ts";
import { memoryObservation, recordMemoryCall } from "../../../../src/observability/memory.ts";
import { beijingIsoTime } from "../../../../src/time/beijing.ts";
import { RECAPS_DIR } from "../paths.ts";
import { join } from "node:path";
import { appendFileSync, mkdirSync } from "node:fs";

const RECAP_INSTRUCTION = `
[Session Recap]
每轮回复的**最末尾**追加一行（用纯文本，不加 markdown 代码块）：
📌 状态: <本轮完成了什么，10-20 字> | 下一步: <下一步动作，10-20 字>
规则：
- 只写**本轮增量**，不重复之前的内容，不写"我们讨论了 X"这类复述
- 一句话，保持一行；实在放不下拆两行
- 回复本来就极短（如纯确认）时可省略
- 这行是给用户的方向感提示，不是报告，不要展开
- 注意：这一行会被扩展自动落盘到 .pi/agent/recaps/ 索引文件，所以保持单行、自包含（能脱离上下文看懂）
`;



// 去重：同一 session 文件 + 同一 recap 行只落盘一次（agent_end 可能因重试触发多次）
let lastWrittenKey = "";

function extractRecapLine(messages: unknown[]): string | undefined {
  // 从本次 run 的消息里找最后一条 assistant 文本，取末尾的 📌 行
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as { role?: string; content?: unknown };
    if (msg?.role !== "assistant") continue;
    const content = msg.content;
    if (typeof content === "string") {
      const line = findRecap(content);
      if (line) return line;
    } else if (Array.isArray(content)) {
      // 倒序拼文本块，找最后一个包含 recap 的块
      const texts: string[] = [];
      for (const block of content) {
        if (block && typeof block === "object" && "text" in (block as object)) {
          texts.push((block as { text: string }).text);
        }
      }
      const full = texts.join("\n");
      const line = findRecap(full);
      if (line) return line;
    }
  }
  return undefined;
}

// 方案 C 兜底：找不到 📌 行时，从最后一条 assistant 文本自动生成一行 recap。
// 策略：取最后一段非空文本，截取有意义的核心部分（去掉 markdown/链接/emoji），
// 尽量保留一句能概括本轮内容的话，控制在 40 字以内。
function generateFallbackRecap(messages: unknown[]): string | undefined {
  // 从后往前找最后一条有实质内容的 assistant 文本（排除 thinking）
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as { role?: string; content?: unknown };
    if (msg?.role !== "assistant") continue;
    let text = "";
    const content = msg.content;
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      const texts: string[] = [];
      for (const block of content) {
        if (block && typeof block === "object") {
          const b = block as { type?: string; text?: string };
          // 只取 text 块，排除 thinking / toolResult 等
          if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
        }
      }
      text = texts.join("\n");
    }
    if (!text.trim()) continue;
    return summarize(text);
  }
  return undefined;
}

function summarize(text: string): string | undefined {
  // 去掉 markdown 标记、链接、emoji、多余空白，找一句能概括的话
  let clean = text
    .replace(/[📌✅❌🔴🟡🟢🔵⚠️]/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[#*`>_~-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // 去掉末尾的“下一步”类尾巴，避免截断在无意义处
  clean = clean.replace(/\|\s*下一步[:：].*$/u, "").trim();
  if (!clean) return undefined;
  // 取前 60 字，优先在句子边界截断，但第一句太短时用整段
  const cut = clean.slice(0, 60);
  const lastSentence = cut.match(/^.*?[。！？!?]/);
  let head = "";
  if (lastSentence && lastSentence[0].length >= 8) {
    head = lastSentence[0];
  } else {
    head = cut; // 第一句太短（可能是“完成。”之类的短开头），用整段
  }
  const summary = head.slice(0, 55).replace(/[。！？!?\s]+$/, "");
  if (summary.length < 8) return undefined; // 太短没意义
  return `📌 状态: ${summary} | 下一步: 见上`;
}

function findRecap(text: string): string | undefined {
  // 取最后一个以 📌 状态: 开头的完整行（不跨行，保证单行可检索）
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith("📌 状态:")) return line;
  }
  return undefined;
}

function appendRecap(sessionFile: string | undefined, recap: string) {
  const now = beijingIsoTime();
  const dayFile = join(RECAPS_DIR, `${now.slice(0, 10)}.md`);
  try {
    mkdirSync(RECAPS_DIR, { recursive: true, mode: 0o700 });
    const time = now.slice(11, 16);
    const session = sessionFile ? sessionFile.split("/").pop() : "(unknown)";
    const key = `${session}|${recap}`;
    if (key === lastWrittenKey) return;
    appendFileSync(dayFile, `- ${time} \`${session}\` ${recap}\n`, { encoding: "utf8", mode: 0o600 });
    lastWrittenKey = key;
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    recordMemoryCall(memoryObservation(sessionFile ?? ""), "memory_recap_error", {
      source: "memory.recap",
      action: "append",
      targetFile: dayFile,
      errorType: failure.name ?? "Error",
      errorCode: failure.code ?? null,
    });
    // 无可用 session 或观测文件也无法写入时，仍可从 stderr 发现失败。
    console.error(`Session recap write failed: ${failure.code ?? failure.name ?? "Error"}`);
  }
}

export default function (pi: ExtensionAPI) {
  registerSystemSource(pi, "session-recap", async (event) => {
    const existing = event.systemPrompt ?? "";
    if (existing.includes("[Session Recap]")) return undefined; // 幂等
    return RECAP_INSTRUCTION;
  });

  pi.on("agent_end", (event: { messages?: unknown[] }, ctx: { sessionManager?: { getSessionFile?: () => string | undefined } }) => {
    const messages = event.messages;
    if (!Array.isArray(messages) || messages.length === 0) return;
    const sessionFile = ctx.sessionManager?.getSessionFile?.();
    // 优先模型回复中的 recap 状态行；缺失时用文本截取兜底。
    const recap = extractRecapLine(messages) ?? generateFallbackRecap(messages);
    if (!recap) return;
    appendRecap(sessionFile, recap);
  });
}
