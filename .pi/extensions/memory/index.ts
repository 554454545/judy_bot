// Pi 项目级自动发现入口：注册记忆注入、自动沉淀和每轮摘要落盘。
// 关联：inject/index.ts 提供记忆来源；autosediment/index.ts 管理沉淀；recap/index.ts 保存状态行。
// 上下文：inject 提供静态系统内容和动态回合消息；recap 提供固定规则；extensions/context 统一交给 Pi。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerMemorySource from "./inject/index.ts";
import registerAutosediment from "./autosediment/index.ts";
import registerSessionRecap from "./recap/index.ts";

export default function memoryEntry(pi: ExtensionAPI) {
  registerMemorySource(pi);
  registerAutosediment(pi);
  registerSessionRecap(pi);
}
