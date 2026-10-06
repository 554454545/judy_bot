// Pi 会话文件命名：将文件名时间设为北京时间并保留会话 ID，原始数据时间戳不变。
// 调用方：src/telegram/commands/pi_new.ts，在 newSession 的 setup 回调中调用。
// 关联：Pi 原生 SessionManager；通过 setSessionFile 更新原生会话管理器的文件位置。
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function useBeijingSessionFilename(manager: SessionManager) {
  const original = manager.getSessionFile();
  const header = manager.getHeader();
  if (!original || !header) {
    return;
  }
  const timestamp = new Date(Date.parse(header.timestamp) + 8 * 60 * 60 * 1000)
    .toISOString()
    .replace("Z", "+08-00")
    .replace(/[:.]/g, "-");
  const target = join(dirname(original), `${timestamp}_${header.id}.jsonl`);
  if (target === original) {
    return;
  }
  if (existsSync(target)) {
    throw new Error("北京时间会话文件已存在");
  }
  if (existsSync(original)) {
    renameSync(original, target);
  } else {
    writeFileSync(target, JSON.stringify(header) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
  }
  manager.setSessionFile(target);
}
