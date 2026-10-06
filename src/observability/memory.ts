// 记忆调用观测：筛选与 Python mem0 共用当前 session 的 JSONL，凭据脱敏；费用缺价格时明确未知。
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { beijingFilenameTime, beijingIsoTime } from "../time/beijing.ts";

export interface MemoryObservation {
  file: string;
  sessionId: string;
  operationId: string;
}

export function memoryObservation(sessionFile: string): MemoryObservation | undefined {
  try {
    const header = JSON.parse(readFileSync(sessionFile, "utf8").split("\n", 1)[0]);
    if (!/^[0-9a-f-]{36}$/i.test(header.id)) {
      return undefined;
    }
    return {
      file: resolve(dirname(sessionFile), "../observability", `${beijingFilenameTime(header.timestamp)}_${header.id}.jsonl`),
      sessionId: header.id,
      operationId: randomUUID(),
    };
  } catch {
    return undefined;
  }
}

function redact(key: string, value: unknown) {
  if (/^(authorization|api[-_]?key|token|secret|password)$/i.test(key)) {
    return "[REDACTED]";
  }
  if (typeof value === "string") {
    return value.replace(/\bsk[-_][a-zA-Z0-9_-]{12,}\b/g, "[REDACTED]")
      .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
  }
  return value;
}

export function recordMemoryCall(context: MemoryObservation | undefined, stage: string, details: Record<string, unknown>) {
  if (!context) {
    return;
  }
  try {
    mkdirSync(dirname(context.file), { recursive: true, mode: 0o700 });
    appendFileSync(context.file, JSON.stringify({
      schemaVersion: 3,
      at: beijingIsoTime(),
      stage,
      source: "memory.filter",
      sessionId: context.sessionId,
      operationId: context.operationId,
      ...details,
    }, redact) + "\n", { mode: 0o600 });
  } catch {
    console.error("Memory observability write failed");
  }
}

export function memoryObservationEnv(context: MemoryObservation | undefined) {
  return {
    ...process.env,
    BOT_MEMORY_OBSERVATION: context ? JSON.stringify(context) : "",
  };
}
