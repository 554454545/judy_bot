// Telegram /pi_restart：先确认回复，再调用项目 Windows＋WSL 启动入口重启；由 index.ts 注册。
// 关联：scripts/startup/windows.ps1 管理当前项目，startup/pi_restart-command.log 保存启动操作结果。
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFile, mkdir, open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { beijingIsoTime } from "../../time/beijing.ts";
import { recordTelegramRuntimeEvent } from "../../../.pi/npm/node_modules/@llblab/pi-telegram/api/outbound.ts";
import type { TelegramExtensionCommandRegistration } from "../../../.pi/npm/node_modules/@llblab/pi-telegram/api/commands.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const run = promisify(execFile);
const powershell = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";

export async function prepareProjectRestart(): Promise<() => Promise<void>> {
  // 只允许常驻入口启动的 Pi 重启，避免手动 TUI 意外操作后台任务。
  const parent = (await readFile(`/proc/${process.ppid}/cmdline`, "utf8")).split("\0");
  if (!parent.includes(resolve(root, "scripts/startup/telegram.mjs"))) {
    throw new Error("当前 Pi 不由项目常驻入口管理");
  }
  const converted = await run("wslpath", ["-w", resolve(root, "scripts/startup/windows.ps1")], {
    timeout: 5000,
  });
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", converted.stdout.trim()];
  await run(powershell, [...args, "-Action", "Status"], { timeout: 15000 });
  const directory = resolve(root, ".pi/agent/logs/startup");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return async () => {
    const log = await open(resolve(directory, "restart-command.log"), "a", 0o600);
    try {
      await log.write(`${beijingIsoTime()} /pi_restart 请求重启项目 TG\n`);
      // 独立进程继续执行 Restart，即使脚本已经停止当前 Pi 和父入口。
      const child = spawn(powershell, [...args, "-Action", "Restart"], {
        detached: true,
        cwd: root,
        stdio: ["ignore", log.fd, log.fd],
      });
      await new Promise<void>((resolveStarted, reject) => {
        child.once("spawn", resolveStarted);
        child.once("error", reject);
      });
      child.unref();
    } finally {
      await log.close();
    }
  };
}

export function createPiRestartCommand(
  prepare = prepareProjectRestart,
): TelegramExtensionCommandRegistration {
  let restarting = false;
  return {
    name: "pi_restart",
    description: "重启项目 Pi，继续当前会话",
    emoji: "🔄",
    showInMenu: true,
    handler: async ({ args, reply }) => {
      if (args.trim()) {
        await reply("用法：/pi_restart（无需参数）");
        return;
      }
      if (restarting) {
        await reply("正在重启，请稍候。");
        return;
      }
      restarting = true;
      let execute: () => Promise<void>;
      try {
        execute = await prepare();
        await reply("🔄 正在重启项目 Pi，继续当前会话。连接恢复前暂时无法回复。");
      } catch (error) {
        restarting = false;
        recordTelegramRuntimeEvent("telegram-restart", error, { phase: "prepare" });
        await reply("重启未执行：请检查项目常驻入口和启动日志。");
        return;
      }
      // 先让命令返回轮询，再停止进程；不能在回复成功前重启。
      setTimeout(() => {
        void execute().catch(async error => {
          restarting = false;
          recordTelegramRuntimeEvent("telegram-restart", error, { phase: "launch" });
          try {
            await reply("重启启动失败，请检查项目启动日志。");
          } catch (notificationError) {
            recordTelegramRuntimeEvent("telegram-restart", notificationError, { phase: "notification" });
          }
        });
      }, 1500);
    },
  };
}
