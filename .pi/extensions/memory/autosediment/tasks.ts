// memory-tasks — 持久保存自动沉淀任务，处理失败、超时和 session/进程重启后的恢复。
// 流程：先落盘 → 筛选 → 写入 → 保存结果 → 通知；不保存与失败分开，未知结果不盲重试。
// 关联：index.ts 提供模型/CLI/TG 操作；mem0-cli.py 保存写入凭据；观测仍进入原 session JSONL。
// 边界：无独立服务；flock 只保护本项目 worker，写入 CLI 另有数据库锁；通知只在原 session 发送。
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, linkSync, unlinkSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { beijingIsoTime } from "../../../../src/time/beijing.ts";
import type { MemoryObservation } from "../../../../src/observability/memory.ts";

export interface MemoryTask {
  id: string;
  sessionId: string;
  sessionFile: string;
  sourceMessage: string;
  text: string;
  observation?: MemoryObservation;
  state: string;
  filterAttempts: number;
  writeAttempts: number;
  verifyAttempts: number;
  notifyAttempts: number;
  nextAt: number;
  createdAt: string;
  updatedAt: string;
  memory?: string;
  reason?: string;
  result?: { ids: string[]; status: string; matches?: string[] };
  error?: string;
}

export interface TaskOperations {
  filter(task: MemoryTask, signal: AbortSignal): Promise<{ save: boolean; memory: string; reason: string }>;
  write(task: MemoryTask, signal: AbortSignal): Promise<{ ids: string[]; status: string; matches?: string[] }>;
  verify(task: MemoryTask, signal: AbortSignal): Promise<{ ids: string[]; status: string; matches?: string[] }>;
  notify(task: MemoryTask): Promise<{ status: "sent" | "retry" | "unknown" | "blocked"; ids?: readonly number[] }>;
  record(task: MemoryTask): void;
}

export class TaskFailure extends Error {
  constructor(public code: string, public retryable = false) {
    super(code);
  }
}

export class MemoryTasks {
  private active = false;
  private sessionId = "";
  private timer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  private running?: Promise<void>;
  private lock?: ChildProcess;
  private unreadable = new Set<string>();

  constructor(private directory: string, private operations: TaskOperations) {}

  private file(id: string) {
    return join(this.directory, `${id}.json`);
  }

  private save(task: MemoryTask) {
    task.updatedAt = beijingIsoTime();
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temp = `${this.file(task.id)}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(task, null, 2) + "\n", { mode: 0o600 });
    renameSync(temp, this.file(task.id));
    this.operations.record(task);
  }

  private all(): MemoryTask[] {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const tasks: MemoryTask[] = [];
    for (const name of readdirSync(this.directory).filter(name => name.endsWith(".json"))) {
      try {
        const task = JSON.parse(readFileSync(join(this.directory, name), "utf8"));
        if (!/^[a-f0-9]{64}$/.test(task.id) || name !== `${task.id}.json` || typeof task.createdAt !== "string") {
          throw new Error("Invalid task file");
        }
        tasks.push(task);
        this.unreadable.delete(name);
      } catch {
        if (!this.unreadable.has(name)) {
          console.error(`Memory task unreadable; preserved for review: ${name}`);
          this.unreadable.add(name);
        }
      }
    }
    return tasks.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  enqueue(input: { sessionId: string; sessionFile: string; sourceMessage: string; text: string; observation?: MemoryObservation }) {
    const id = createHash("sha256").update(`${input.sessionId}\n${input.sourceMessage}\n${input.text}`).digest("hex");
    const file = this.file(id);
    try {
      readFileSync(file);
      return;
    } catch (error: any) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
    const now = beijingIsoTime();
    const task: MemoryTask = {
      ...input,
      id,
      state: "pending_filter",
      filterAttempts: 0,
      writeAttempts: 0,
      verifyAttempts: 0,
      notifyAttempts: 0,
      nextAt: 0,
      createdAt: now,
      updatedAt: now,
    };
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(task, null, 2) + "\n", { mode: 0o600 });
    try {
      linkSync(temp, file);
      this.operations.record(task);
    } catch (error: any) {
      if (error.code !== "EEXIST") {
        throw error;
      }
    } finally {
      unlinkSync(temp);
    }
    this.wake();
  }

  async start(sessionId: string) {
    await this.stop();
    this.sessionId = sessionId;
    this.active = true;
    this.wake();
  }

  async stop() {
    this.active = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.controller?.abort();
    await this.running;
    const lock = this.lock;
    this.lock = undefined;
    if (lock && lock.exitCode === null) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => lock.kill("SIGTERM"), 1000);
        lock.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        lock.stdin?.end();
      });
    }
  }

  private async acquire() {
    if (this.lock) {
      return true;
    }
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const child = spawn("/usr/bin/flock", ["-n", join(this.directory, "worker.lock"),
      process.execPath, "-e", "process.stdout.write('locked\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));"],
      { stdio: ["pipe", "pipe", "ignore"] });
    const locked = await new Promise<boolean>(resolve => {
      child.stdout.once("data", () => resolve(true));
      child.once("error", () => resolve(false));
      child.once("exit", () => resolve(false));
    });
    if (!locked) {
      return false;
    }
    chmodSync(join(this.directory, "worker.lock"), 0o600);
    this.lock = child;
    child.once("exit", () => {
      if (this.lock === child) {
        this.lock = undefined;
        this.controller?.abort();
      }
    });
    // Only the lock owner can recover a task previously interrupted mid-operation.
    for (const task of this.all()) {
      if (task.state === "filtering") {
        task.state = "pending_filter";
      } else if (task.state === "writing" || task.state === "verifying") {
        task.state = "write_unknown";
      } else if (task.state === "notifying") {
        task.state = "notification_unknown";
      } else {
        continue;
      }
      this.save(task);
    }
    return true;
  }

  private wake() {
    if (!this.active || this.running) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.running = this.drain().catch(error => {
      console.error("Memory task worker failed:", error?.code ?? error?.name ?? "Error");
    }).finally(() => {
      this.running = undefined;
      if (this.active) {
        this.timer = setTimeout(() => this.wake(), 1000);
        this.timer.unref();
      }
    });
  }

  private async drain() {
    if (!await this.acquire() || !this.active) {
      return;
    }
    for (const task of this.all()) {
      if (!this.active || !this.lock) {
        break;
      }
      if (task.nextAt > Date.now()) {
        continue;
      }
      if (["pending_filter", "filter_failed", "pending_write", "write_failed", "write_unknown", "saved", "notification_failed"].includes(task.state)) {
        await this.process(task);
      }
    }
  }

  private async process(task: MemoryTask) {
    this.controller = new AbortController();
    const signal = this.controller.signal;
    let phase = "filter";
    try {
      if (["pending_filter", "filter_failed"].includes(task.state)) {
        if (task.filterAttempts >= 3) {
          task.state = "filter_blocked";
          this.save(task);
          return;
        }
        task.state = "filtering";
        task.filterAttempts++;
        this.save(task);
        const verdict = await this.operations.filter(task, signal);
        task.memory = verdict.memory;
        task.reason = verdict.reason;
        task.error = undefined;
        task.state = verdict.save ? "pending_write" : "rejected";
        this.save(task);
      }
      if (signal.aborted) {
        return;
      }
      phase = "verify";
      if (task.state === "write_unknown") {
        if (task.verifyAttempts >= 3) {
          task.state = "write_needs_review";
          this.save(task);
          return;
        }
        task.state = "verifying";
        task.verifyAttempts++;
        this.save(task);
        const result = await this.operations.verify(task, signal);
        task.result = result;
        task.state = result.status === "completed" ? "saved"
          : result.status === "safe_retry" ? "pending_write"
          : result.status === "blocked" ? "write_blocked" : "write_needs_review";
        this.save(task);
      }
      if (signal.aborted) {
        return;
      }
      phase = "write";
      if (["pending_write", "write_failed"].includes(task.state)) {
        if (task.writeAttempts >= 3) {
          task.state = "write_blocked";
          this.save(task);
          return;
        }
        task.state = "writing";
        task.writeAttempts++;
        this.save(task);
        const result = await this.operations.write(task, signal);
        task.result = result;
        task.state = result.status === "completed" ? "saved"
          : result.status === "safe_retry" ? "write_failed"
          : result.status === "blocked" ? "write_blocked" : "write_unknown";
        task.nextAt = result.status === "safe_retry" ? Date.now() + 5000 : 0;
        this.save(task);
      }
      phase = "notify";
      if (!signal.aborted && ["saved", "notification_failed"].includes(task.state) && task.sessionId === this.sessionId) {
        if (task.notifyAttempts >= 3) {
          task.state = "notification_blocked";
          this.save(task);
          return;
        }
        task.state = "notifying";
        task.notifyAttempts++;
        this.save(task);
        const result = await this.operations.notify(task);
        task.state = result.status === "sent" ? "notified"
          : result.status === "retry" ? "notification_failed"
          : result.status === "unknown" ? "notification_unknown" : "notification_blocked";
        task.nextAt = Date.now() + 5000;
        this.save(task);
      }
    } catch (error: any) {
      task.error = error instanceof TaskFailure ? error.code : error?.name ?? "Error";
      if (phase === "write") {
        task.state = "write_unknown";
      } else if (phase === "verify") {
        task.state = "write_unknown";
      } else if (phase === "notify") {
        task.state = "notification_unknown";
      } else {
        task.state = signal.aborted ? "pending_filter"
          : error instanceof TaskFailure && error.retryable ? "filter_failed" : "filter_blocked";
      }
      task.nextAt = Date.now() + 5000;
      this.save(task);
    } finally {
      this.controller = undefined;
    }
  }
}
