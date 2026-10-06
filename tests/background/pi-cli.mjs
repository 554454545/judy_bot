// Pi 命令行接入验证：真实 bash/session 环境调用 Joye 形式的协议；确认没有后台模型工具，原话不可由 spec 代填。
import assert from "node:assert/strict";
import { mkdtempSync, cpSync, mkdirSync, rmSync, writeFileSync, readFileSync, symlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const host = join(root, "node_modules/@earendil-works/pi-coding-agent");
const require = createRequire(join(host, "package.json"));
const { createJiti } = await import(require.resolve("jiti"));
const { SessionManager, DefaultResourceLoader, SettingsManager } = await import(join(host, "dist/index.js"));
const { createBashToolDefinition } = await import(join(host, "dist/core/tools/bash.js"));
const temp = mkdtempSync(resolve(root, "../test/.bot-background-cli-validation-"));
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

try {
  const extension = join(temp, ".pi/extensions/background");
  cpSync(join(root, ".pi/extensions/background"), extension, { recursive: true });
  // 接力复用既有 TG renderer；夹具只链接已安装依赖，不复制配置、凭据或运行状态。
  symlinkSync(join(root, ".pi/npm"), join(temp, ".pi/npm"), "dir");
  const jiti = createJiti(import.meta.url, {
    fsCache: false,
  });
  const feature = await jiti.import(join(extension, "tasks/source.ts"));
  const { default: register } = await jiti.import(join(extension, "index.ts"));
  const source = join(temp, "source");
  mkdirSync(source);
  const sessionManager = SessionManager.create(temp, join(temp, "sessions"));
  const ctx = {
    sessionManager,
  };
  const handlers = new Map();
  const pi = {
    events: new EventEmitter(),
    on(name, handler) {
      const listeners = handlers.get(name) ?? [];
      listeners.push(handler);
      handlers.set(name, listeners);
    },
    appendEntry(type, data) {
      sessionManager.appendCustomEntry(type, data);
    },
    registerTool() {
      throw new Error("后台扩展不应注册模型工具");
    },
  };
  register(pi);
  const emit = (name, event) => {
    for (const handler of handlers.get(name) ?? []) {
      handler(event, ctx);
    }
  };
  const addUser = (text, telegram = false) => {
    if (telegram) {
      pi.events.emit(feature.REQUEST_SOURCE_EVENT, {
        sessionId: sessionManager.getSessionId(),
        turnId: `turn-${sessionManager.getEntries().length}`,
        inputText: `[telegram] ${text}`,
        message: {
          text,
          message_id: 501,
          date: 1791198000,
          chat: {
            id: 123,
          },
        },
      });
    }
    const input = telegram ? `[telegram] ${text}` : text;
    emit("input", {
      text: input,
      source: telegram ? "extension" : "interactive",
    });
    const message = {
      role: "user",
      content: [{
        type: "text",
        text: input,
      }],
      timestamp: Date.now(),
    };
    emit("message_start", {
      message,
    });
    sessionManager.appendMessage(message);
    // 安装版 SessionManager 首个 assistant 到达后才将缓冲条目落盘。
    sessionManager.appendMessage({
      role: "assistant",
      content: [{
        type: "text",
        text: "fixture",
      }],
      timestamp: Date.now(),
    });
  };
  const protocol = join(extension, "tasks/task_protocol.py");
  const bash = createBashToolDefinition(temp);
  const invoke = async args => {
    const command = ["python3", protocol, ...args].map(quote).join(" ");
    emit("tool_call", {
      toolName: "bash",
      input: {
        command,
      },
      toolCallId: "fixture",
    });
    const result = await bash.execute("fixture", {
      command,
    }, undefined, undefined, ctx);
    const output = result.content[0].text;
    if (output.includes("Command exited with code")) {
      throw new Error(output);
    }
    return JSON.parse(output);
  };
  const projectFile = join(temp, "project.json");
  writeFileSync(projectFile, JSON.stringify({
    sourcePath: source,
    worktreePath: join(temp, "worktree"),
    branch: "background/fixture",
    agentKind: "other-agent",
  }));
  addUser("先登记 fixture 项目。");
  const project = await invoke(["project-register", "fixture", "--spec", projectFile]);
  assert.equal(project.sessionId, null);
  emit("agent_settled", {});

  const raw = "  帮 fixture 项目准备一个加法任务。\r\n保留空白  ";
  addUser(raw, true);
  const specFile = join(temp, "spec.json");
  writeFileSync(specFile, JSON.stringify({
    projectId: "fixture",
    instruction: "增加加法函数和测试",
    scope: ["add.py", "test_add.py"],
    acceptance: ["加法结果正确"],
    artifacts: ["add.py", "test_add.py"],
    originalRequest: {
      text: "模型伪造的原话",
    },
  }));
  assert.equal(await invoke(["register", "fixture.task", "--spec", specFile]), null);
  const task = (await invoke(["inspect"])).registry.tasks["fixture.task"];
  assert.equal(task.originalRequest.text, raw);
  assert.equal(task.originalRequest.source, "telegram");
  assert.equal(task.originalRequest.telegram.messageId, 501);
  const prepared = await invoke(["prepare", "fixture.task"]);
  assert.equal(prepared.preflight.dispatchEnabled, false);
  assert(prepared.preflight.blockers.length > 0);
  const current = await invoke(["inspect"]);
  assert(!Object.hasOwn(current, "ok") && !Object.hasOwn(current, "result"));
  assert(current.task_hashes["fixture.task"]);
  assert(current.handoff_checks["fixture.task"].prompt.matches);
  assert.equal(sessionManager.getBranch().filter(entry => entry.type === "custom"
    && entry.customType === feature.REQUEST_ENTRY_TYPE).length, 2);
  emit("agent_settled", {});

  const supplement = "再加上负数测试。";
  addUser(supplement, true);
  const deltaFile = join(temp, "delta.json");
  writeFileSync(deltaFile, JSON.stringify({
    acceptance: ["加法结果正确", "负数结果正确"],
    changeRequest: {
      text: "伪造补充",
    },
  }));
  assert.equal(await invoke(["update", "fixture.task", "--delta", deltaFile,
    "--expected-hash", current.task_hashes["fixture.task"]]), null);
  const updated = (await invoke(["inspect"])).registry.tasks["fixture.task"];
  assert.equal(updated.originalRequest.text, raw);
  assert.equal(updated.revisions[0].request.text, supplement);
  assert(!updated.files);
  await assert.rejects(() => invoke(["update", "fixture.task", "--delta", deltaFile,
    "--expected-hash", current.task_hashes["fixture.task"]]), /任务已变化/);
  assert((await invoke(["prepare", "fixture.task"])).task.promptHash);
  emit("agent_settled", {});

  // 未绑定的新 TG 消息不能复用前一轮取证记录。
  addUser("[telegram] 没有来源的消息");
  await assert.rejects(() => invoke(["register", "unsupported", "--spec", specFile]), /本轮原话未取证/);
  const inspection = await invoke(["inspect"]);
  assert.equal(Object.keys(inspection.registry.tasks).length, 1);
  const originalBranch = sessionManager.getBranch();
  const userEntry = originalBranch.findLast(entry => entry.type === "message" && entry.message.role === "user");
  assert.equal(originalBranch.findLast(entry => entry.type === "custom").data.entryId, userEntry.id);
  assert.equal(sessionManager.buildSessionContext().messages.filter(message => message.customType === feature.REQUEST_ENTRY_TYPE).length, 0);

  const old = spawnSync("python3", [protocol, "task-register"], { encoding: "utf8" });
  assert.notEqual(old.status, 0);
  for (const name of ["start-run", "run", "verify", "report"]) {
    const forbidden = spawnSync("python3", [protocol, name], { encoding: "utf8" });
    assert.notEqual(forbidden.status, 0);
  }
  const resources = new DefaultResourceLoader({
    cwd: temp,
    agentDir: join(temp, "resource-agent"),
    settingsManager: SettingsManager.inMemory(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [join(root, ".pi/extensions/background/index.ts")],
    additionalSkillPaths: ["skill-creator", "web-search", "herdr-workflow"].map(name =>
      join(root, ".pi/skills/joye/personal", name, "SKILL.md")),
  });
  await resources.reload();
  assert.deepEqual(resources.getExtensions().errors, []);
  assert.equal(resources.getExtensions().extensions[0].tools.size, 0);
  assert.deepEqual(resources.getSkills().diagnostics, []);
  assert.deepEqual(resources.getSkills().skills.map(skill => skill.name).sort(), ["herdr-workflow", "skill-creator", "web-search"]);
  assert(readFileSync(join(root, "start.sh"), "utf8").includes("joye/personal/herdr-workflow/SKILL.md"));
  console.log("PASS: native Pi bash/session → file CLI, raw evidence, revisions, zero background tools and no execution commands");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
