// Telegram 命令接入：注册项目命令、维护会话控制上下文、在连接后同步菜单。
// 调用方：extensions/telegram/index.ts；返回包装后的 Pi API，供 npm 桥接注册本地命令。
// 关联：同目录 pi_new.ts、pi_restart.ts、pi_status.ts、pi_logs.ts、pi_model.ts 提供命令；menu.ts 同步菜单。
// 关联：notifications.ts 发送新会话通知；session_shutdown 注销本实例的全部命令。
// 注册区别：registerTelegramCommand 接入 TG 命令表；pi.registerCommand 接入 Pi 本地命令表。
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerTelegramCommand } from "../../../.pi/npm/node_modules/@llblab/pi-telegram/api/commands.ts";
import { notifyCurrentSession } from "../notifications.ts";
import { syncTelegramMenu } from "./menu.ts";
import { createPiNewCommand } from "./pi_new.ts";
import { createPiRestartCommand } from "./pi_restart.ts";
import { createPiStatusCommand } from "./pi_status.ts";
import { createPiLogsCommand } from "./pi_logs.ts";
import { createPiModelCommand } from "./pi_model.ts";

export function registerProjectCommands(pi: ExtensionAPI): ExtensionAPI {
  // Pi 会替换扩展实例；进程内共享槽只持有当前会话的正式 command context。
  const key = Symbol.for("bot.telegram.session-control");
  const shared = globalThis as typeof globalThis & {
    [key: symbol]: {
      context?: ExtensionCommandContext;
      profile?: string;
      connect?: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
    };
  };
  const control = shared[key] ??= {};
  // /pi_new 的 withSession 回调提供新上下文；使用当前桥接重新连接原 profile。
  const bindContext = async (fresh: ExtensionCommandContext) => {
    control.context = fresh;
    if (control.connect && control.profile !== undefined) {
      await control.connect(control.profile, fresh);
      await syncTelegramMenu(control.profile);
    }
  };
  // 项目命令直接注册到 TG 命令表，不通过模型执行。
  const commands = [
    createPiNewCommand(() => control.context, bindContext, notifyCurrentSession),
    createPiRestartCommand(),
    createPiStatusCommand(() => control.context, () => control.profile),
    createPiLogsCommand(),
    createPiModelCommand(pi, () => control.context, () => control.profile),
  ];
  const unregister = commands.map(command => registerTelegramCommand(command));
  // 注册 Pi 固定生命周期事件：会话关闭时清除旧上下文，并注销旧实例的 TG 命令。
  pi.on("session_shutdown", () => {
    control.context = undefined;
    for (const remove of unregister) {
      remove();
    }
  });
  return {
    ...pi,
    // npm 桥接调用这里注册本地命令；最终仍调用下方原始 pi.registerCommand。
    registerCommand(name, command) {
      if (name === "telegram-connect") {
        control.connect = command.handler;
      }
      // 保留桥接原有命令定义，只在执行时取得当前正式 command context。
      pi.registerCommand(name, {
        ...command,
        async handler(args, ctx) {
          // 桥接连接命令提供正式的 command context；普通 session_start 没有会话控制方法。
          control.context = ctx;
          if (name === "telegram-connect") {
            control.profile = args.trim();
          }
          const result = await command.handler(args, ctx);
          if (name === "telegram-connect") {
            try {
              await syncTelegramMenu(args.trim());
            } catch {
              ctx.ui.notify(
                "Telegram 命令菜单同步失败，请重新连接后重试。",
                "warning",
              );
            }
          }
          return result;
        },
      });
    },
  };
}
