// 记忆注入来源：静态文件进入 System Prompt，动态召回作为本轮持久消息；../index.ts 注册，extensions/context 接入 Pi。
// 关联：src/context/system-prompt.ts 的 registerSystemSource / registerTurnSource 分别接收两类内容。
// 顺序：固定系统规则 → 原历史 → 当前问题 → 本轮召回 → 回答；后续回合不改写旧召回。
// 召回仍使用当前问题和 recap 主题两路查询，合并去重取 top 8，保留分数作为本轮证据。
// 静态文件最多 12000 字符，动态召回块最多 8000 字符；空召回不生成消息，失败沿用空结果降级。
import { memoryObservation, memoryObservationEnv, type MemoryObservation } from "../../../../src/observability/memory.ts";
import { readFileSync, statSync, readdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSystemSource, registerTurnSource } from "../../../../src/context/system-prompt.ts";
const execFileAsync = promisify(execFile);
import { join } from "node:path";

import { MEMORY_FILES as FILES, MEM0_CLI, MEM0_PYTHON, PROJECT_ROOT, RECAPS_DIR } from "../paths.ts";
let cache: { key: string; content: string; rules: string } | null = null;

// 单路召回：mem0 search（失败静默返回空数组）
async function recallMem0(query: string, limit = 5, observation?: MemoryObservation): Promise<{ id: string; score: number; text: string }[]> {
  try {
    const r = await execFileAsync(MEM0_PYTHON, [MEM0_CLI, "search", query, String(limit)], {
      encoding: "utf8",
      cwd: PROJECT_ROOT,
      env: memoryObservationEnv(observation),
      timeout: 20000,
    });
    const out: { id: string; score: number; text: string }[] = [];
    for (const line of (r.stdout || "").split("\n")) {
      const m = line.match(/^\[([0-9a-f]+)\] \(score=([0-9.]+)(?:, date=[0-9-]*)?\)\s*(.+)$/);
      if (m) out.push({ id: m[1], score: Number(m[2]), text: m[3] });
    }
    return out;
  } catch {
    return [];
  }
}

// 从最近 recap 文件拿检索主题（末行的下一步/主题词）—— Lane B 补充 query
function recallQuery(): string {
  try {
    const recapsDir = RECAPS_DIR;
    const files = readdirSync(recapsDir).filter((f) => f.endsWith(".md")).sort().reverse();
    if (files.length === 0) return "";
    const latest = readFileSync(join(recapsDir, files[0]), "utf8").split("\n").reverse().find((l) => l.trim());
    const m = latest ? latest.match(/下一步[:：]\s*(.+)$/) : null;
    return m ? m[1].slice(0, 60) : "";
  } catch {
    return "";
  }
}

// 多路召回：Lane A 当前用户消息 + Lane B recap 主题，合并按 score 去重取 top N
async function multiLaneRecall(prompt: string, maxResults = 8, observation?: MemoryObservation): Promise<string> {
  const queries: string[] = [];
  const laneA = (prompt || "").trim().replace(/^\[telegram\]\s*/gm, "").slice(0, 120);
  const laneB = recallQuery();
  if (laneA) queries.push(laneA);
  if (laneB && laneB !== laneA) queries.push(laneB);
  if (queries.length === 0) queries.push("用户的偏好和最近的工作内容");

  const seen = new Set<string>();
  const results: { id: string; score: number; text: string }[] = [];
  for (const q of queries) {
    for (const r of await recallMem0(q, 6, observation)) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      results.push(r);
    }
  }
  results.sort((a, b) => b.score - a.score);
  const top = results.slice(0, maxResults);
  if (top.length === 0) return "";
  return top
    .map((r) => {
      const confidence = r.score >= 0.55 ? "确定" : r.score >= 0.45 ? "有印象" : "不确定";
      return `[${confidence} ${r.score.toFixed(2)}] ${r.text}`;
    })
    .join("\n");
}

function loadAll(): { key: string; content: string; rules: string } | null {
  const parts: string[] = [];
  let key = "";
  for (const f of FILES) {
    try {
      const st = statSync(f);
      key += `${f}:${st.mtimeMs};`;
      parts.push(readFileSync(f, "utf8"));
    } catch {
      // missing file → skip
    }
  }
  if (parts.length === 0) return null;
  return { key, content: parts.join("\n\n"), rules: extractRules(parts.join("\n\n")) };
}

// 提取「## 好习惯」小节（标题行可能是「## 好习惯（已确立，必须遵守）」等变体）。
// 行级解析：找到标题行后收集内容，直到下一个 `## ` 标题或文件尾。
function extractRules(md: string): string {
  const lines = md.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^## 好习惯/.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return "";
  const out: string[] = [];
  for (let i = start; i < lines.length; i++) {
    if (/^## /.test(lines[i])) break;
    if (lines[i].trim() !== "") out.push(lines[i]);
  }
  return out.join("\n").trim();
}

export default function (pi: ExtensionAPI) {
  registerSystemSource(pi, "personal-memory", async () => {
    const loaded = loadAll();
    if (!loaded) {
      return undefined;
    }
    if (!cache || cache.key !== loaded.key) {
      cache = loaded;
    }
    const rulesBlock = cache.rules
      ? `<rules>\n${cache.rules}\n</rules>\n\n每次回复前必须先核对上方 <rules>，违反其中任何一条都是事故，不得违反。`
      : "";
    return (rulesBlock ? `${rulesBlock}\n\n` : "") +
      `<memory>\n${cache.content.slice(0, 12000)}\n</memory>`;
  });

  registerTurnSource(pi, "personal-memory", async (event, ctx) => {
    const recalled = await multiLaneRecall(
      event.prompt ?? "",
      8,
      memoryObservation(ctx?.sessionManager.getSessionFile() ?? ""),
    );
    if (!recalled) {
      return undefined;
    }
    const content = `<recalled-memory>\n${recalled}\n</recalled-memory>\n\n相关记忆仅作背景参考，如需更准确的细节请回源会话（session）核对，不要编造。`;
    return content.slice(0, 8000);
  });
}
