// Telegram 会话通知：通过当前桥接的公开 delivery API 向本实例目标发送文字。
// 调用方：commands/index.ts 将本函数传给 commands/pi_new.ts，作为新建会话后的 notifyReady。
// 关联：npm 桥接 api/delivery.ts；新会话通知不能使用已关闭旧会话捕获的 reply 回调。
import { sendTelegramView } from "../../.pi/npm/node_modules/@llblab/pi-telegram/api/delivery.ts";

export async function notifyCurrentSession(text: string) {
  const result = await sendTelegramView(
    {
      text,
      parseMode: "plain",
    },
    {
      scope: { kind: "instance" },
    },
  );
  if (!result.ok) {
    throw new Error(`新会话通知发送失败：${result.reason}`);
  }
}
