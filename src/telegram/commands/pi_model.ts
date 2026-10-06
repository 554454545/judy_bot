// Telegram /pi_model：按钮选择模型与思考强度；index.ts 接入，桥接 delivery/updates 处理菜单，Pi API 保存设置。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "../../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/compat.js";
import type { TelegramExtensionCommandRegistration } from "../../../.pi/npm/node_modules/@llblab/pi-telegram/api/commands.ts";
import { sendTelegramView, editTelegramView, type TelegramDeliveryHandle, type TelegramDeliveryView } from "../../../.pi/npm/node_modules/@llblab/pi-telegram/api/delivery.ts";
import { recordTelegramRuntimeEvent } from "../../../.pi/npm/node_modules/@llblab/pi-telegram/api/outbound.ts";
import { registerTelegramUpdateHandler } from "../../../.pi/npm/node_modules/@llblab/pi-telegram/api/updates.ts";

// 依赖槽仅供离线验证替代网络；运行时使用桥接公开接口和项目 profile。
const defaults = {
  send: sendTelegramView,
  edit: editTelegramView,
  subscribe: registerTelegramUpdateHandler,
  profile(name: string) {
    const dir = process.env.PI_CODING_AGENT_DIR;
    if (!dir) {
      throw new Error("项目配置目录未设置");
    }
    const config = JSON.parse(readFileSync(join(dir, "telegram.json"), "utf8"));
    return name ? config.profiles?.[name] : config;
  },
  async acknowledge(token: string, id: string, text: string) {
    const response = await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: id, text }),
      signal: AbortSignal.timeout(5000),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) {
      throw new Error("按钮确认失败");
    }
  },
};

type Context = ExtensionCommandContext;
type Model = ReturnType<Context["modelRegistry"]["getAvailable"]>[number];
type Menu = {
  nonce: string;
  ctx: Context;
  sessionId: string;
  models: Model[];
  provider?: string;
  page: number;
  handle?: TelegramDeliveryHandle;
};

export function createPiModelCommand(
  pi: Pick<ExtensionAPI, "setModel" | "getThinkingLevel" | "setThinkingLevel" | "on">,
  getContext: () => Context | undefined,
  getProfile: () => string | undefined = () => undefined,
  io = defaults,
): TelegramExtensionCommandRegistration {
  let menu: Menu | undefined;
  let busy = false;
  const pageSize = 8;
  function view(state: Menu, notice = ""): TelegramDeliveryView {
    const model = state.ctx.model;
    const button = (text: string, action: string) => ({
      text,
      callback_data: `pim:${state.nonce}:${action}`,
    });
    const rows = [];
    if (state.provider === undefined) {
      const providers = [...new Set(state.models.map(item => item.provider))].sort();
      for (let index = 0; index < providers.length; index += 2) {
        rows.push(providers.slice(index, index + 2).map(provider =>
          button(provider, `p${providers.indexOf(provider)}`),
        ));
      }
    } else {
      // 模型目录没有统一发布日期，按型号版本号降序排列：6.1 在 6 前，5.3 在 5 前。
      const choices = state.models
        .filter(item => item.provider === state.provider)
        .sort((left, right) => right.id.localeCompare(left.id, "en", { numeric: true }));
      const pages = Math.max(1, Math.ceil(choices.length / pageSize));
      state.page = Math.max(0, Math.min(state.page, pages - 1));
      for (const item of choices.slice(state.page * pageSize, (state.page + 1) * pageSize)) {
        const selected = model?.provider === item.provider && model?.id === item.id;
        rows.push([button(`${selected ? "✓ " : ""}${item.id}`, `m${state.models.indexOf(item)}`)]);
      }
      const navigation = [button("返回供应商", "back")];
      if (state.page > 0) {
        navigation.push(button("上一页", `n${state.page - 1}`));
      }
      if (state.page + 1 < pages) {
        navigation.push(button("下一页", `n${state.page + 1}`));
      }
      rows.push(navigation);
    }
    if (model) {
      const levels = getSupportedThinkingLevels(model);
      for (let index = 0; index < levels.length; index += 3) {
        rows.push(levels.slice(index, index + 3).map(level =>
          button(`${pi.getThinkingLevel() === level ? "✓ " : ""}${level}`, `t${level}`),
        ));
      }
    }
    return {
      text: [
        `当前模型：${model ? `${model.provider}/${model.id}` : "未知"}`,
        `思考强度：${pi.getThinkingLevel()}`,
        state.provider === undefined ? "选择供应商，再选择模型；下方可直接调整思考强度。" : `选择模型：${state.provider}（第 ${state.page + 1} 页）`,
        "切换保留当前会话，并保存为项目默认设置。",
        notice,
      ].filter(Boolean).join("\n"),
      parseMode: "plain",
      replyMarkup: { inline_keyboard: rows },
    };
  }
  const unsubscribe = io.subscribe(async (update: unknown) => {
    const query = (update as {
      callback_query?: {
        id: string;
        data?: string;
        from: { id: number };
        message?: { message_id: number; chat: { id: number }; message_thread_id?: number };
      };
    })?.callback_query;
    if (!query?.data?.startsWith("pim:")) {
      return "pass";
    }
    try {
      // raw update 在桥接鉴权之前触发，必须独立校验用户和菜单目标。
      const profile = io.profile(getProfile() ?? "");
      if (!profile?.botToken || query.from.id !== profile.allowedUserId) {
        return "consume";
      }
      const state = menu;
      const [, nonce, action] = query.data.split(":");
      const message = query.message;
      if (!state?.handle || nonce !== state.nonce || getContext() !== state.ctx ||
          state.sessionId !== state.ctx.sessionManager.getSessionId() ||
          message?.chat.id !== state.handle.target.chatId ||
          message.message_thread_id !== state.handle.target.threadId ||
          !state.handle.messageIds.includes(message.message_id)) {
        await io.acknowledge(profile.botToken, query.id, "菜单已过期，请重新发送 /pi_model。");
        return "consume";
      }
      if (busy) {
        await io.acknowledge(profile.botToken, query.id, "正在处理，请稍后。");
        return "consume";
      }
      busy = true;
      try {
        let notice = "";
        if (action.startsWith("m") || action.startsWith("t")) {
          if (!state.ctx.isIdle() || state.ctx.hasPendingMessages()) {
            notice = "正在回答或有待处理消息，请等结束后再切换。";
          } else if (/^m\d+$/.test(action)) {
            const chosen = state.models[Number(action.slice(1))];
            notice = chosen && await pi.setModel(chosen) ? "模型已切换。" : "切换失败，请检查模型凭据。";
          } else {
            const level = action.slice(1);
            const supported = state.ctx.model ? getSupportedThinkingLevels(state.ctx.model) : [];
            if (supported.includes(level as typeof supported[number])) {
              pi.setThinkingLevel(level as ReturnType<ExtensionAPI["getThinkingLevel"]>);
              notice = "思考强度已更新。";
            } else {
              notice = "当前模型不支持此思考强度。";
            }
          }
        } else if (/^p\d+$/.test(action)) {
          state.provider = [...new Set(state.models.map(item => item.provider))].sort()[Number(action.slice(1))];
          state.page = 0;
        } else if (/^n\d+$/.test(action)) {
          state.page = Number(action.slice(1));
        } else if (action === "back") {
          state.provider = undefined;
        }
        try {
          await io.acknowledge(profile.botToken, query.id, notice || "菜单已更新");
        } catch {
          recordTelegramRuntimeEvent("pi-model-callback-ack", new Error("模型菜单按钮确认失败"));
        }
        if (getContext() === state.ctx && menu === state) {
          const result = await io.edit(state.handle, view(state, notice));
          if (!result.ok) {
            recordTelegramRuntimeEvent("pi-model-menu-edit", new Error("模型菜单更新失败"), { reason: result.reason });
            menu = undefined;
          }
        }
      } finally {
        busy = false;
      }
    } catch {
      // 不输出带 token 的 fetch 异常；重新打开菜单即可恢复。
      recordTelegramRuntimeEvent("pi-model-callback", new Error("模型菜单按钮处理失败"));
      menu = undefined;
    }
    return "consume";
  });
  pi.on("session_shutdown", () => {
    menu = undefined;
    unsubscribe();
  });
  return {
    name: "pi_model",
    description: "按钮选择模型和思考强度",
    emoji: "🤖",
    showInMenu: true,
    async handler({ reply }) {
      const ctx = getContext();
      if (!ctx) {
        await reply("模型控制尚未就绪，请重新连接项目 TG。");
        return;
      }
      if (busy) {
        await reply("正在处理模型操作，请稍后。");
        return;
      }
      busy = true;
      try {
        await ctx.modelRegistry.refresh();
        if (getContext() !== ctx) {
          throw new Error("会话已变更");
        }
        const state: Menu = {
          nonce: randomBytes(6).toString("hex"),
          ctx,
          sessionId: ctx.sessionManager.getSessionId(),
          models: ctx.modelRegistry.getAvailable(),
          page: 0,
        };
        if (state.models.length === 0) {
          await reply("没有已配置凭据的可用模型，请检查项目模型配置。" );
          return;
        }
        const result = await io.send(view(state), { scope: { kind: "instance" } });
        if (!result.ok) {
          throw new Error("菜单发送失败");
        }
        state.handle = result.value;
        menu = state;
      } catch {
        await reply("模型菜单打开失败，请稍后重新发送 /pi_model。");
      } finally {
        busy = false;
      }
    },
  };
}
