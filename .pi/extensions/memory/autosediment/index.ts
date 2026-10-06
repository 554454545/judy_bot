// mem0-autosediment — 把 agent_end 的用户消息持久入队，再筛选、写入并发送记忆通知。
// 流程：先保存任务，session_start 恢复未完成任务；session_shutdown 中止操作并释放 worker 锁。
// 关联：tasks.ts 管理状态和有限重试；mem0-cli.py 保存写入凭据；../paths.ts 提供项目路径。
// 观测：各阶段写回原 session JSONL；处理失败与不值得记分开，未知写入/通知结果不盲重试。
// 边界：保留原筛选提示词和前置规则，不改召回策略，不增加独立服务或模型配置。
import { beijingIsoTime } from "../../../../src/time/beijing.ts";
import { randomUUID } from "node:crypto";
import { memoryObservation, memoryObservationEnv, recordMemoryCall, type MemoryObservation } from "../../../../src/observability/memory.ts";
import { MemoryTasks, TaskFailure, type MemoryTask } from "./tasks.ts";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sendTelegramView } from "../../../npm/node_modules/@llblab/pi-telegram/api/delivery.ts";
import { MEM0_CLI, MEM0_PYTHON, PROJECT_ROOT, AUTOSED_LOG } from "../paths.ts";


// autosediment 自身日志（每次 agent_end 写入判定都留痕，便于查"该发没发"）
function autosedLog(msg: string) {
  try {
    mkdirSync(dirname(AUTOSED_LOG), { recursive: true, mode: 0o700 });
    appendFileSync(AUTOSED_LOG, `[${beijingIsoTime()}] ${msg}\n`, { mode: 0o600 });
  } catch {
    // 静默
  }
}

// 写入成功 → 独立 Telegram 消息确认（system-message 风格，不占下一轮回复）
// v2.2（2026-08-26）：不再硬截 60 字符——用户 quote 的引用内容常被截得看不懂。
// 改为完整内容（Telegram 单条上限 4096），仅当极端超长（>900）才截断并带明确提示。
//
// v2.3（2026-08-26）：LLM 过滤层 —— 用户拍板"交给 LLM 过滤一遍"（因 8-26 误沉淀了
// 一次性问答"agent_end hook是算作兜底处理吗？"，污染召回）。
// 每轮候选消息使用项目 mem0 配置的 LLM 筛选并提炼；筛选失败时不写入。
// 该调用独立于 Pi 对话模型，通过项目记忆观测保存请求、回复和原始用量。
// 筛选复用项目 .mem0 中已配置的模型与凭据。
function loadFilterConfig() {
  const config = JSON.parse(readFileSync(`${PROJECT_ROOT}/.mem0/config/config.json`, "utf8"));
  return config.llm.config;
}

const FILTER_SYSTEM = `你是长期记忆筛选器。用户在跟 AI agent 的对话中说了下面这句话，请判断它是否值得存入长期记忆。

**默认不记。** 绝大多数对话都不值得存——只有极少数情况才应记：

值得记（should_save=true）：
- 用户身份/背景/喜好等稳定事实（生日、爱好、追的队伍、居住地、工作经历）
- 用户偏好与沟通风格（排版、格式、语气要求）
- 技术决策与理由（"以后X都用Y""改为Z因为W"）
- 踩坑经验/技术结论（具体路径、命令、报错、教训）
- 用户明确要求记住的内容（"记住X""记一下"）

不值得记（should_save=false）——这些占了绝大多数：
- 任何一次性的问题/提问/澄清/请求（"X是什么？""帮我看看X""这个怎么改"）
- 汇报某次改动已提交/已修复（"修复了X，commit abc1234""提交了Y"）——可由代码确认，不记
- 投递/收藏/调研某个岗位或公司的一次性任务（"搜一下X公司""这个JD收藏一下""投了Y"）：求职状态不是长期稳定事实，别从任务请求里推断身份；只有明确的面试结果被用户告知时才可记
- 不要把"收藏/整理/存档/转发"理解成"记住"——这类请求是文件管理操作，不是长期记忆指令
- 代码提交/开发进展汇报一律不记：commit、commit hash、push、PR 编号、版本号这类信息 git log 和代码里都能查到，属于可从代码确认的过程性细节（用户 2026-09-05 明确要求）。提炼 memory 时也严禁夹带 commit hash；项目进展只记结构性事实（上线了什么能力、什么决策），commit 细节不进记忆
- 对当前任务/项目的讨论、过程性描述、待办、计划（"我想做X""下一步做Y""这个先不急"）
- 对刚才回复的反馈/评价（"感觉不对""你说得对""太那啥了"）
- 寒暄/确认/纯指令（"好的""继续""看看"）
- 消息本身不包含新的稳定事实、偏好或决策时，一律不记

只输出 JSON（不要输出其他文字）：{"should_save": true或false, "memory": "提炼后的陈述句（第三人称、含主语与日期；若 should_save=false 则为空串）", "reason": "一句话理由"}`;

export function filterWithLLM(text: string, observation?: MemoryObservation, signal?: AbortSignal): Promise<{ save: boolean; memory: string; reason: string }> {
  const config = loadFilterConfig();
  const key = config.api_key;
  if (!key) {
    throw new TaskFailure("missing_filter_credentials");
  }
  const body = {
    model: config.model,
    messages: [
      { role: "system", content: FILTER_SYSTEM },
      { role: "user", content: text },
    ],
    temperature: 0,
    max_tokens: 3000,
  };
  const requestId = randomUUID();
  recordMemoryCall(observation, "memory_request", { requestId, model: config.model, providerPayload: body });
  return fetch(`${config.openai_base_url.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000),
  })
    .then(async (r) => {
      const payload = await r.json();
      recordMemoryCall(observation, "memory_response", {
        requestId,
        status: r.status,
        providerResponse: payload,
        rawUsage: payload.usage ?? null,
        cost: null,
        costStatus: "unknown_missing_price",
      });
      if (r.ok === false) {
        throw new TaskFailure(`filter_http_${r.status}`, r.status === 429 || r.status >= 500);
      }
      return payload;
    })
    .then((j) => {
      const raw = j?.choices?.[0]?.message?.content ?? "";
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) {
        throw new TaskFailure("filter_invalid_json", true);
      }
      const parsed = JSON.parse(m[0]);
      if (typeof parsed.should_save !== "boolean" || (parsed.should_save && !parsed.memory?.trim())) {
        throw new TaskFailure("filter_invalid_result", true);
      }
      const save = parsed.should_save;
      const memory = typeof parsed.memory === "string" && parsed.memory.trim() ? parsed.memory.trim() : text;
      const reason = typeof parsed.reason === "string" ? parsed.reason : "";
      return { save, memory, reason };
    })
    .catch((e) => {
      recordMemoryCall(observation, "memory_error", { requestId, errorType: e?.name ?? "Error" });
      autosedLog(`LLM 过滤失败，交由任务处理: ${e instanceof TaskFailure ? e.code : e?.name ?? "Error"}`);
      if (e instanceof TaskFailure) {
        throw e;
      }
      throw new TaskFailure(e?.name ?? "filter_failed", ["TypeError", "TimeoutError", "AbortError", "SyntaxError"].includes(e?.name));
    });
}
// Telegram 引用回复标记：[reply|from:名字] 被引用的完整文本
// 提取被引用内容并拼进写入文本（被引用的是用户真正想记的）
function extractQuote(text: string): string | null {
  const m = text.match(/\[reply\|from:[^\]]*\]\s*([\s\S]+)/);
  if (!m) return null;
  const quoted = m[1].trim();
  return quoted.length > 0 ? quoted : null;
}

// 不值得沉淀的消息特征（纯指令/寒暄/极短/过程性反馈）
function isWorthSaving(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return false;
  // 纯指令、确认、寒暄（即使带 quote 也被上面的提取逻辑拆开了）
  if (/^(好的|好|ok|OK|嗯|可以|继续|看看|知道了|收到|谢谢|感谢|辛苦了|可以了|就这样|先这样|没问题|对|是的|行|来吧|搞|做吧|开始|等一下|稍等)/.test(t)) return false;
  // 过程性反馈/评价/讨论（不含新稳定事实的短句）——这类交给 LLM 判定，但先拦掉明显形式
  if (/^(感觉|觉得|这个|这样|现在|目前|就是|其实|突然|我记得|我想|我要|我需要|为什么|怎么|是不是|有没有|能不能|可否)/.test(t) && t.length < 60) return false;
  return true;
}

function extractUserMessages(messages: unknown[]): { text: string; timestamp?: number }[] {
  const out: { text: string; timestamp?: number }[] = [];
  for (const msg of messages || []) {
    const m = msg as { role?: string; content?: unknown; timestamp?: number };
    if (m?.role !== "user") continue;
    const content = m.content;
    let text = "";
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      text = content
        .filter((b) => b && typeof b === "object" && "text" in (b as object))
        .map((b) => (b as { text: string }).text)
        .join("\n");
    }
    // 去掉 telegram 元信息行（[telegram]、[time]）
    text = text.replace(/^\[telegram\]\s*/gm, "").replace(/^\[time\].*$/gm, "").trim();
    if (!text) continue;

    // quote 提取：被引用的回复内容优先，放在用户原话之前
    const quoted = extractQuote(text);
    const own = text.replace(/\[reply\|from:[^\]]*\]\s*[\s\S]*/, "").trim();
    let finalText: string;
    if (quoted) {
      finalText = own ? `[用户引用] ${quoted}\n[用户原话] ${own}` : `[用户引用] ${quoted}`;
    } else {
      finalText = text;
    }
    if (isWorthSaving(finalText)) {
      out.push({ text: finalText, timestamp: m.timestamp });
    }
  }
  return out;
}

// CLI 超时/中止后等子进程真正退出，再允许 worker 核对持久凭据。
function runTaskCli(task: MemoryTask, check: boolean, signal: AbortSignal) {
  return new Promise<{ ids: string[]; status: string; matches?: string[] }>((resolve, reject) => {
    const args = check
      ? [MEM0_CLI, "task-check", task.id]
      : [MEM0_CLI, "task-add", task.id, task.memory!, task.sessionId, task.sourceMessage];
    const child = spawn(MEM0_PYTHON, args, {
      cwd: PROJECT_ROOT,
      env: memoryObservationEnv(task.observation),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let interrupted = false;
    const interrupt = () => {
      interrupted = true;
      child.kill("SIGTERM");
    };
    const timer = setTimeout(interrupt, 120000);
    signal.addEventListener("abort", interrupt, { once: true });
    if (signal.aborted) {
      interrupt();
    }
    child.stdout.on("data", data => {
      output += data;
    });
    child.stderr.on("data", () => {});
    child.once("error", error => {
      clearTimeout(timer);
      signal.removeEventListener("abort", interrupt);
      reject(new TaskFailure(error.name));
    });
    child.once("close", code => {
      clearTimeout(timer);
      signal.removeEventListener("abort", interrupt);
      if (interrupted || code !== 0) {
        reject(new TaskFailure(interrupted ? "cli_interrupted" : "cli_failed"));
        return;
      }
      try {
        const result = JSON.parse(output);
        if (!["completed", "safe_retry", "unknown", "blocked"].includes(result.status) || !Array.isArray(result.ids)) {
          throw new Error("Invalid CLI receipt");
        }
        resolve(result);
      } catch {
        reject(new TaskFailure("cli_invalid_receipt"));
      }
    });
  });
}

export default function (pi) {
  const worker = new MemoryTasks(join(PROJECT_ROOT, ".pi/agent/memory/tasks"), {
    filter: (task, signal) => filterWithLLM(task.text, task.observation, signal),
    write: (task, signal) => runTaskCli(task, false, signal),
    verify: (task, signal) => runTaskCli(task, true, signal),
    async notify(task) {
      const oneLine = task.memory!.replace(/\n+/g, " ").trim();
      const text = oneLine.length > 900 ? oneLine.slice(0, 900) + "…（内容过长已截断）" : oneLine;
      const prefix = task.result?.ids.length ? "🧠 已记忆：" : "🧠 记忆处理完成（未新增条目）：";
      const result = await sendTelegramView({ text: prefix + text, parseMode: "plain" }, {
        scope: { kind: "instance" },
      });
      if (result.ok) {
        recordMemoryCall(task.observation, "memory_notification", { taskId: task.id, status: "sent", messageIds: result.value.messageIds });
        return { status: "sent", ids: result.value.messageIds };
      }
      recordMemoryCall(task.observation, "memory_notification", { taskId: task.id, status: result.reason });
      return {
        status: result.reason === "commit-unknown" ? "unknown"
          : ["runtime-unavailable", "target-unavailable"].includes(result.reason) ? "retry" : "blocked",
      };
    },
    record(task) {
      recordMemoryCall(task.observation, "memory_task", {
        taskId: task.id,
        sourceMessageId: task.sourceMessage,
        taskState: task.state,
        attempts: { filter: task.filterAttempts, write: task.writeAttempts, verify: task.verifyAttempts, notify: task.notifyAttempts },
        shouldSave: task.state === "rejected" ? false : task.memory ? true : null,
        memory: task.memory ?? null,
        reason: task.reason ?? null,
        error: task.error ?? null,
        result: task.result ?? null,
      });
      autosedLog(`task=${task.id} session=${task.sessionId} state=${task.state}`);
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    await worker.start(ctx.sessionManager.getSessionId());
  });
  pi.on("session_shutdown", async () => {
    await worker.stop();
  });
  pi.on("agent_end", (event, ctx) => {
    const sessionFile = ctx.sessionManager.getSessionFile() ?? "";
    const sessionId = ctx.sessionManager.getSessionId();
    const branch = ctx.sessionManager.getBranch();
    for (const candidate of extractUserMessages(event.messages ?? [])) {
      const original = branch.find(entry => entry.type === "message" && entry.message.role === "user" && entry.message.timestamp === candidate.timestamp);
      const sourceMessage = original?.id ?? `${candidate.timestamp ?? "unknown"}:${createHash("sha256").update(candidate.text).digest("hex")}`;
      worker.enqueue({
        sessionId,
        sessionFile,
        sourceMessage,
        text: candidate.text,
        observation: memoryObservation(sessionFile),
      });
    }
  });
}
