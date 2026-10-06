// 后台扩展入口：接入 tasks/source.ts 原话取证与 notifications/relay-notify.ts 结果接力；任务操作沿用 Joye 的 bash → task_protocol.py，不注册模型工具。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerOriginalRequestEvidence } from "./tasks/source.ts";
import { createRelay } from "./notifications/relay-notify.ts";

export default function (pi: ExtensionAPI) {
  registerOriginalRequestEvidence(pi);
  createRelay(pi);
}
