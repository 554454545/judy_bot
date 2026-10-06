// 任务原话取证：绑定真实 TG/Pi 用户消息，bash 前和回合结束保存非上下文条目；task_protocol.py 通过 Pi 原生会话环境读取。
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// 项目自定义事件，由 telegram-turn/index.ts 的既有出队观察点发送，不是 Pi 内置事件。
export const REQUEST_SOURCE_EVENT = "bot.background.original-request";
export const REQUEST_ENTRY_TYPE = "background-original-request";

type TelegramSource = {
  sessionId: string;
  turnId: string;
  inputText: string;
  message: {
    text: string;
    message_id: number;
    date: number;
    message_thread_id?: number;
    chat: { id: number };
  };
};

function beijing(ms: number) {
  return new Date(ms + 8 * 3600000).toISOString().replace("Z", "+08:00");
}

function validSource(value: unknown): value is TelegramSource {
  if (!value || typeof value !== "object") {
    return false;
  }
  const data = value as Partial<TelegramSource>;
  const message = data.message;
  return typeof data.sessionId === "string" && !!data.sessionId.trim()
    && typeof data.turnId === "string" && !!data.turnId.trim()
    && typeof data.inputText === "string"
    && !!message
    && typeof message.text === "string"
    && Number.isSafeInteger(message.message_id)
    && Number.isSafeInteger(message.date)
    && Number.isFinite(new Date(message.date * 1000).getTime())
    && Number.isSafeInteger(message.chat?.id)
    && (message.message_thread_id === undefined || Number.isSafeInteger(message.message_thread_id));
}

function messageText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content) && content.length === 1 && content[0]?.type === "text") {
    return content[0].text;
  }
  return undefined;
}

export function createOriginalRequestCapture(pi: ExtensionAPI) {
  const waiting = new Map<string, TelegramSource>();
  const admitted = new Map<string, TelegramSource>();
  const active = new Set<string>();
  const bound = new WeakMap<object, TelegramSource>();

  pi.events.on(REQUEST_SOURCE_EVENT, value => {
    if (!validSource(value)) {
      return;
    }
    // 不允许迟到事件覆盖已经入场的本轮来源；同文消息的身份由实际消息对象固定。
    if (waiting.has(value.sessionId) || admitted.has(value.sessionId) || active.has(value.sessionId)) {
      return;
    }
    waiting.set(value.sessionId, structuredClone(value));
  });
  pi.on("input", (event, ctx) => {
    const session = ctx.sessionManager.getSessionId();
    const source = waiting.get(session);
    waiting.delete(session);
    if (source && event.source === "extension" && event.text === source.inputText
        && !event.images?.length && event.streamingBehavior === undefined) {
      admitted.set(session, source);
    } else {
      admitted.delete(session);
    }
    // 只观察，不改变输入、历史、System Prompt 或模型请求。
  });
  pi.on("message_start", (event, ctx) => {
    if (event.message.role !== "user") {
      return;
    }
    const session = ctx.sessionManager.getSessionId();
    const source = admitted.get(session);
    admitted.delete(session);
    active.add(session);
    if (source && messageText(event.message.content) === source.inputText) {
      bound.set(event.message, source);
    }
  });
  const clear = (_event: unknown, ctx: ExtensionContext) => {
    const session = ctx.sessionManager.getSessionId();
    waiting.delete(session);
    admitted.delete(session);
    active.delete(session);
  };
  // agent_end 后 Pi 可能自动重试；到 agent_settled 才清理这一轮入场状态。
  pi.on("agent_settled", clear);
  pi.on("session_tree", clear);
  pi.on("session_shutdown", clear);

  return (ctx: ExtensionContext) => {
    const entry = ctx.sessionManager.getBranch().findLast(item =>
      item.type === "message" && item.message.role === "user");
    if (!entry || entry.type !== "message") {
      throw new Error("当前分支没有真实用户消息，不能从整理后的需求补造原话。");
    }
    const text = messageText(entry.message.content);
    const receivedMs = Date.parse(entry.timestamp);
    if (typeof text !== "string" || !text.trim() || !Number.isFinite(receivedMs)) {
      throw new Error("当前输入不是可准确取证的单条文本消息，停止任务登记。");
    }
    const evidence = {
      sessionId: ctx.sessionManager.getSessionId(),
      entryId: entry.id,
      receivedAt: beijing(receivedMs),
    };
    const source = bound.get(entry.message);
    if (source) {
      if (source.sessionId !== evidence.sessionId) {
        throw new Error("TG 来源属于其他 session，停止登记。");
      }
      return {
        text: source.message.text,
        source: "telegram",
        ...evidence,
        telegram: {
          turnId: source.turnId,
          chatId: source.message.chat.id,
          messageId: source.message.message_id,
          sentAt: beijing(source.message.date * 1000),
          ...(source.message.message_thread_id === undefined
            ? {}
            : { threadId: source.message.message_thread_id }),
        },
      };
    }
    if (/^\s*\[telegram(?:\]|\|)/.test(text)) {
      throw new Error("未关联到本轮 TG 入站原话；合并消息、附件或重载前的消息暂不支持，不能从装饰文本猜原话。");
    }
    return {
      text,
      source: "pi-session",
      ...evidence,
    };
  };
}

// 用户要求的原话记录适配：沿用 Joye appendEntry/getBranch 原则，不改变 bash 参数，也不增加模型工具或消息。
export function registerOriginalRequestEvidence(pi: ExtensionAPI) {
  const capture = createOriginalRequestCapture(pi);
  const save = (ctx: ExtensionContext) => {
    const branch = ctx.sessionManager.getBranch();
    const user = branch.findLast(entry => entry.type === "message" && entry.message.role === "user");
    if (!user) {
      return;
    }
    const saved = branch.findLast(entry => entry.type === "custom" && entry.customType === REQUEST_ENTRY_TYPE);
    if (saved?.type === "custom" && saved.data?.entryId === user.id) {
      return;
    }
    let data;
    try {
      data = {
        entryId: user.id,
        originalRequest: capture(ctx),
      };
    } catch (error) {
      // 缺失来源也留下本轮身份；CLI 拒绝登记，不能错误复用上一轮原话。
      data = {
        entryId: user.id,
        error: error instanceof Error ? error.message : "原话来源不可核实",
      };
    }
    pi.appendEntry(REQUEST_ENTRY_TYPE, data);
  };
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName === "bash") {
      save(ctx);
    }
  });
  // 只问澄清、不调用 bash 的回合也要保留来源；重试同一 user entry 不重复保存。
  pi.on("agent_end", (_event, ctx) => save(ctx));
}
