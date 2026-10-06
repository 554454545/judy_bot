// 每次模型调用的消息组装：统一管理历史筛选、记忆召回内容及注入顺序。
// 调用方：extensions/context/index.ts 的 context 处理器，包括工具循环中的后续调用。
// 关联：Pi 提供当前消息列表；后置 observability 扩展记录实际 Provider 请求。
// 当前原样返回，保留摘要、历史、用户问题和工具调用/结果的全部顺序。
// 动态召回由 before_agent_start 返回 memory-recall 消息，Pi 已按“问题→召回→回答”持久追加。
// 此处不再注入或重排记忆，保证工具循环和后续用户回合保留已有消息前缀。
import type { ContextEvent } from "@earendil-works/pi-coding-agent";

export function assembleMessages(messages: ContextEvent["messages"]): ContextEvent["messages"] {
  return messages;
}
