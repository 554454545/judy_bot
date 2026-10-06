// 真实前台模型/TG 模拟验证：新 session 经原版 Joye Skill、native bash 和文件 CLI 准备任务；只写隔离 test 样本，不联系 TG/Herdr。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

assert(process.argv.includes("--live"), "真实模型测试需明确 --live，并取得用户对测试的授权");
const bindingAudit = process.argv.includes("--binding-audit");
process.umask(0o077);
const bot = process.cwd();
const host = path.join(bot, "node_modules/@earendil-works/pi-coding-agent");
const bridge = path.join(bot, ".pi/npm/node_modules/@llblab/pi-telegram");
const stamp = new Date(Date.now() + 8 * 3600000).toISOString().replace("Z", "+08:00");
const evidence = path.join(bot, ".pi/agent/background/verification/joye-cli-flow", stamp.replaceAll(":", "-"));
const fixture = fs.mkdtempSync(path.join(bot, "../test/.bot-background-joye-flow-"));
const frontend = path.join(fixture, "frontend");
const source = path.join(fixture, "source");
const target = path.join(fixture, "worktree");
const docsSource = path.join(fixture, "source-docs");
const docsTarget = path.join(fixture, "worktree-docs");
const agentDir = path.join(frontend, ".pi/agent");
const save = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
  });
};
const digest = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
// 同时比较文件内容和 Git 状态，避免未跟踪文件被覆盖后仍显示相同的 ?? 状态。
const treeContents = directory => {
  const entries = {};
  const visit = (folder, prefix = "") => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.name === ".git") {
        continue;
      }
      const relative = path.join(prefix, entry.name);
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        visit(file, relative);
      } else if (entry.isSymbolicLink()) {
        entries[relative] = {
          link: fs.readlinkSync(file),
        };
      } else {
        entries[relative] = {
          sha256: digest(file),
        };
      }
    }
  };
  visit(directory);
  return entries;
};
const git = (cwd, ...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-C", cwd, ...args], { encoding: "utf8" }).trim();
const protectedPaths = ["AGENTS.md", "plan.md", "start.sh", ".pi/agent/auth.json", ".pi/agent/models.json",
  ".pi/agent/settings.json", ".pi/agent/background/registry.json", ".pi/extensions/background/index.ts",
  ".pi/extensions/background/tasks/task_protocol.py", ".pi/extensions/background/tasks/source.ts"];
const protectedHashes = Object.fromEntries(protectedPaths.map(file => [file, digest(path.join(bot, file))]));
const outerGit = git(path.join(bot, "../test"), "worktree", "list", "--porcelain");
const result = {
  startedAt: stamp,
  mode: "synthetic authorized TG updates, real frontend model, existing Joye Skill and native bash",
  scenario: bindingAudit ? "document-bugfix-project-binding" : "math-preparation",
  realTelegramMessagesSent: false,
  herdrOrCodingAgentStarted: false,
  fixture,
  evidence,
  passed: false,
};
const events = [];
const replies = [];
const errors = [];
const inputs = [];
const checkpoints = [];
const auditChecks = [];
const prompts = bindingAudit ? [
  "给 test 项目的 README 补一段本地运行说明，写清安装和测试怎么跑，只改 README。",
  "给刚才的说明补一句：Windows 用户在 WSL 里运行。\n标题用「本地运行」，示例命令保留 `npm test`，不要改代码。",
  "test 项目的 slug 函数有个问题：全是空格时现在返回短横线，应该返回空字符串。准备修复任务并补测试，只动 src/slug.js 和 tests/slug.test.js。",
  "给刚才的修复任务加上长度限制：slug 最多 80 个字符，超出就截断，并补上对应测试。README 那条任务别动。",
  "现在 test 项目登记了哪些任务？先不执行。",
  "给 test-docs 项目的首页加一句“这是测试站点”，只改 index.html，先准备任务。",
  "刚才首页那条文案改成“只用于链路验证”。不要动 test 项目的任务。",
  "test 和 test-docs 现在各有些什么任务？给我项目、工作分支和状态，先别执行。",
  "test 那两个任务里，我打算改一个，但还没选好是哪一个。先别改，告诉我有哪些可选。",
  "给 test 项目准备一个任务：修改 ../outside.txt，把文件里的标题改成“越界检查”。",
  "给 missing-project 项目补一段安装说明。",
  "3 + 4 =？只回答答案。",
  "请联网查一下南京大学的官方英文名称，给官网链接，简短回答。",
] : [
  "帮 test 项目加个加法函数，顺便写个测试。",
  "给刚才那个任务加上负数测试。",
  "再准备一个减法函数的任务，也补上测试。",
  "刚才准备了哪些任务？",
  "1 + 1 =？只回答答案。",
  "帮 unknown-project 项目补个测试。",
  "请联网查询武汉大学的官方英文名称，给出官网来源链接。简短回答。",
];
let session;
let deadline;
let modelRuntime;
let runtime;

try {
  fs.mkdirSync(frontend, { recursive: true });
  fs.mkdirSync(source);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(path.join(fixture, "tmp"));
  fs.cpSync(path.join(bot, ".pi/extensions/background"), path.join(frontend, ".pi/extensions/background"), { recursive: true });
  for (const name of ["herdr-workflow", "web-search", "skill-creator"]) {
    fs.cpSync(path.join(bot, ".pi/skills/joye/personal", name), path.join(frontend, ".pi/skills/joye/personal", name), { recursive: true });
  }
  fs.copyFileSync(path.join(bot, ".pi/agent/models.json"), path.join(agentDir, "models.json"));
  // 搜索验证沿用项目已授权凭据，仅在本次私有样本内使用，结束随样本删除。
  for (const name of ["tavily", "tinyfish"]) {
    const config = path.join(bot, ".pi/agent/config", name);
    if (fs.existsSync(config)) {
      fs.cpSync(config, path.join(agentDir, "config", name), { recursive: true });
    }
  }
  fs.writeFileSync(path.join(frontend, "AGENTS.md"), "# 隔离前台验证\n操作前完整读取 plan.md，按已有 Joye herdr-workflow Skill 只完成派发前准备。\n");
  fs.writeFileSync(path.join(frontend, "plan.md"), [
    "# 本次测试边界", "所有写入限于当前测试 frontend 和它的登记项目 worktree；不修改原 Bot，不修改全局目录。",
    "当前阶段只登记项目任务、更新需求、准备交接稿；不启动 Herdr/Coding Agent，不实际写用户任务代码，不提交、合并或部署。",
    "使用原版 Joye Skill 的项目适配和已有 bash；所有管理操作以最新登记表为依据。普通问答和查询不能登记新任务。",
    "末轮联网查询可读取已有 web-search Skill；只读搜索，不保存用户记忆。",
  ].join("\n") + "\n");
  git(source, "init", "-qb", "main");
  fs.writeFileSync(path.join(source, "README.md"), bindingAudit
    ? "# Isolated slug project\nAn ES module package; install with npm install and run tests with npm test.\nSlug implementation: src/slug.js. Tests: tests/slug.test.js.\n"
    : "# Isolated JavaScript project\nFunctions live in math.js; tests use node --test in math.test.js.\n");
  save(path.join(source, "package.json"), {
    name: bindingAudit ? "isolated-slug-fixture" : "isolated-math-fixture",
    type: "module",
    scripts: {
      test: "node --test",
    },
  });
  if (bindingAudit) {
    fs.mkdirSync(path.join(source, "src"));
    fs.mkdirSync(path.join(source, "tests"));
    fs.writeFileSync(path.join(source, "src/slug.js"), "export function slug(text) {\n  return text.toLowerCase().replace(/\\s+/g, \"-\");\n}\n");
    fs.writeFileSync(path.join(source, "tests/slug.test.js"), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { slug } from '../src/slug.js';\ntest('lowercase words', () => assert.equal(slug('Hello World'), 'hello-world'));\n");
    git(source, "add", "README.md", "package.json", "src/slug.js", "tests/slug.test.js");
  } else {
    fs.writeFileSync(path.join(source, "math.js"), "export {};\n");
    git(source, "add", "README.md", "package.json", "math.js");
  }
  git(source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
  const protocol = path.join(frontend, ".pi/extensions/background/tasks/task_protocol.py");
  const projectFile = path.join(fixture, "project.json");
  save(projectFile, {
    sourcePath: source,
    worktreePath: target,
    branch: "background/test",
    agentKind: "codex",
  });
  const cli = (...args) => JSON.parse(execFileSync("python3", [protocol, ...args], {
    encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  }));
  cli("project-register", "test", "--spec", projectFile);
  cli("worktree-ensure", "test", "--base", "main");
  fs.writeFileSync(path.join(target, "keep-existing-change.txt"), "Keep this user modification.\n");
  const projectTrees = [{
    source,
    target,
  }];
  if (bindingAudit) {
    fs.mkdirSync(docsSource);
    git(docsSource, "init", "-qb", "main");
    fs.writeFileSync(path.join(docsSource, "README.md"), "# Isolated documentation site\nThe homepage is index.html; no build tools or dependencies are needed.\n");
    fs.writeFileSync(path.join(docsSource, "index.html"), "<!doctype html>\n<html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><title>测试站点</title></head><body><h1>测试首页</h1></body></html>\n");
    git(docsSource, "add", "README.md", "index.html");
    git(docsSource, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
    const docsProjectFile = path.join(fixture, "project-docs.json");
    save(docsProjectFile, {
      sourcePath: docsSource,
      worktreePath: docsTarget,
      branch: "background/test-docs",
      agentKind: "other-agent",
    });
    cli("project-register", "test-docs", "--spec", docsProjectFile);
    cli("worktree-ensure", "test-docs", "--base", "main");
    fs.writeFileSync(path.join(docsTarget, "keep-existing-change.txt"), "Keep the documentation user's change.\n");
    projectTrees.push({
      source: docsSource,
      target: docsTarget,
    });
    fs.writeFileSync(path.join(fixture, "outside.txt"), "Keep this boundary sentinel.\n");
  }
  const projectBefore = cli("inspect").registry.projects;
  const targetBefore = git(target, "status", "--porcelain");
  const sourceHead = git(source, "rev-parse", "HEAD");
  const treesBefore = projectTrees.map(tree => ({
    sourceHead: git(tree.source, "rev-parse", "HEAD"),
    source: treeContents(tree.source),
    target: treeContents(tree.target),
    targetStatus: git(tree.target, "status", "--porcelain"),
  }));

  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_CODING_AGENT_SESSION_DIR = path.join(agentDir, "sessions");
  process.env.TMPDIR = path.join(fixture, "tmp");
  process.env.NODE_COMPILE_CACHE = path.join(fixture, "tmp/node-compile");
  process.env.PI_OFFLINE = "1";
  process.env.PI_TELEMETRY = "0";
  process.env.PYTHONDONTWRITEBYTECODE = "1";
  process.chdir(frontend);
  const load = file => import(path.join(host, "dist", file));
  const { createAgentSession } = await load("core/sdk.js");
  const { DefaultResourceLoader } = await load("core/resource-loader.js");
  const { ModelRuntime } = await load("core/model-runtime.js");
  const { AuthStorage } = await load("core/auth-storage.js");
  const { SessionManager } = await load("core/session-manager.js");
  const { SettingsManager } = await load("core/settings-manager.js");
  const { createEventBus } = await load("core/event-bus.js");
  const selected = JSON.parse(fs.readFileSync(path.join(bot, ".pi/agent/settings.json"), "utf8"));
  const { applyHttpProxySettings, configureHttpDispatcher } = await load("core/http-dispatcher.js");
  applyHttpProxySettings(selected.httpProxy);
  configureHttpDispatcher(30000);
  const auth = JSON.parse(fs.readFileSync(path.join(bot, ".pi/agent/auth.json"), "utf8"));
  modelRuntime = await ModelRuntime.create({
    credentials: AuthStorage.inMemory({
      [selected.defaultProvider]: auth[selected.defaultProvider],
    }),
    modelsPath: path.join(agentDir, "models.json"),
    modelsStorePath: path.join(agentDir, "models-store.json"),
    refreshOnCreate: false,
  });
  const model = modelRuntime.getModel(selected.defaultProvider, selected.defaultModel);
  assert(model);
  result.model = `${model.provider}/${model.id}`;
  const eventBus = createEventBus();
  const settings = SettingsManager.inMemory({
    compaction: {
      enabled: false,
    },
    retry: {
      enabled: false,
    },
  });
  const loader = new DefaultResourceLoader({
    cwd: frontend,
    agentDir,
    settingsManager: settings,
    eventBus,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    noContextFiles: true,
    additionalExtensionPaths: [path.join(frontend, ".pi/extensions/background/index.ts"), path.join(bot, "extensions/observability/index.ts")],
    additionalSkillPaths: ["herdr-workflow", "web-search", "skill-creator"].map(name => path.join(frontend, ".pi/skills/joye/personal", name, "SKILL.md")),
    appendSystemPrompt: [fs.readFileSync(path.join(frontend, "AGENTS.md"), "utf8")],
    extensionFactories: [pi => {
      pi.on("tool_call", event => {
        if (["write", "edit"].includes(event.toolName)) {
          const destination = path.resolve(frontend, event.input.path);
          if (!destination.startsWith(frontend + path.sep)) {
            return {
              block: true,
              reason: "本次测试只准备交接文件，不写项目代码或样本外文件。",
            };
          }
        }
        if (event.toolName === "bash" && /(?:^|[\s;|&])(?:\S*\/)?herdr(?:\s|$)|\b(?:start-run|prepare-report|task_event_finish)\b/.test(event.input.command)) {
          return {
            block: true,
            reason: "当前停止在 Herdr 分发之前。",
          };
        }
      });
    }],
  });
  await loader.reload({ resolveProjectTrust: async () => true });
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.deepEqual(loader.getSkills().diagnostics, []);
  assert.deepEqual(loader.getSkills().skills.map(skill => skill.name).sort(), ["herdr-workflow", "skill-creator", "web-search"]);
  assert.equal(loader.getExtensions().extensions.find(extension => extension.path.endsWith("background/index.ts")).tools.size, 0);
  const sessionManager = SessionManager.create(frontend, path.join(agentDir, "sessions"));
  ({ session, runtime } = await createAgentSession({
    cwd: frontend,
    agentDir,
    resourceLoader: loader,
    modelRuntime,
    model,
    thinkingLevel: selected.defaultThinkingLevel ?? "high",
    settingsManager: settings,
    tools: ["read", "write", "edit", "bash"],
    sessionManager,
  }));
  await session.bindExtensions({ onError: error => errors.push(error) });
  result.sessionId = session.sessionId;
  session.subscribe(event => {
    if (["tool_execution_start", "tool_execution_end"].includes(event.type)) {
      events.push(event);
      console.log(JSON.stringify({ stage: event.type, tool: event.toolName, isError: event.isError ?? false }));
    }
  });
  const require = createRequire(path.join(host, "package.json"));
  const { createJiti } = await import(require.resolve("jiti"));
  const jiti = createJiti(import.meta.url, {
    fsCache: false,
  });
  const { executeTelegramUpdate } = await jiti.import(path.join(bridge, "lib/updates.ts"));
  const queue = await jiti.import(path.join(bridge, "lib/queue.ts"));
  const { buildTelegramTurnPrompt } = await jiti.import(path.join(bridge, "lib/turns.ts"));
  const rejected = [];
  const ports = {
    ctx: {},
    pairTelegramUserIfNeeded: async () => false,
    sendTextReply: async (...args) => rejected.push(args),
    handleAuthorizedTelegramMessage: async message => {
      const inputText = buildTelegramTurnPrompt({
        telegramPrefix: "[telegram]",
        rawText: message.text,
        files: [],
        timeLine: new Date(message.date * 1000 + 8 * 3600000).toISOString().replace("Z", "+08:00"),
      });
      const turn = {
        kind: "prompt",
        chatId: message.chat.id,
        replyToMessageId: message.message_id,
        sourceMessageIds: [message.message_id],
        queueOrder: message.message_id,
        content: [{
          type: "text",
          text: inputText,
        }],
      };
      const observer = globalThis[Symbol.for("bot.observability.telegram-turn")];
      // 首轮失败也保留实际输入，便于核对取证时机，不仅保存已通过的题目。
      inputs.push({ message, inputText });
      observer.enqueue(turn, [message]);
      let processing;
      queue.executeTelegramQueueDispatchPlan({ kind: "prompt", item: turn }, {
        onPromptDispatchStart() {},
        sendUserMessage(content) {
          processing = session.sendUserMessage(content);
        },
        onPromptDispatchFailure(error) {
          throw new Error(error);
        },
      });
      deadline = setTimeout(() => void session.abort(), 180000);
      try {
        await processing;
      } finally {
        clearTimeout(deadline);
      }
      const assistant = session.messages.findLast(item => item.role === "assistant");
      assert(assistant && !["error", "aborted"].includes(assistant.stopReason), "前台模型未正常结束");
      await queue.handleTelegramAgentEndRuntime({
        turn: {
          chatId: message.chat.id,
          replyToMessageId: message.message_id,
          target: {
            chatId: message.chat.id,
          },
          queuedAttachments: [],
        },
        assistant: {
          text: assistant.content.map(block => block.text ?? "").join(""),
          stopReason: assistant.stopReason,
        },
        foldQueuedPromptsIntoHistory: false,
        resetRuntimeState() {},
        updateStatus() {},
        dispatchNextQueuedTelegramTurn() {},
        clearPreview: async () => {},
        setPreviewPendingText() {},
        finalizeMarkdownPreview: async () => false,
        sendQueuedAttachments: async () => {},
        sendTextReply: async () => {
          throw new Error("意外投递分支");
        },
        sendMarkdownReply: async (chatId, replyId, text) => replies.push({
          chatId,
          replyId,
          text,
        }),
      });
    },
    handleAuthorizedTelegramEditedMessage: async () => {
      throw new Error("意外编辑");
    },
    handleAuthorizedTelegramCallbackQuery: async () => {
      throw new Error("意外回调");
    },
    handleAuthorizedTelegramReactionUpdate: async () => {
      throw new Error("意外反应");
    },
  };
  const update = (id, messageId, text) => ({
    update_id: messageId,
    message: {
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      chat: {
        id,
        type: "private",
      },
      from: {
        id,
        is_bot: false,
        first_name: "Synthetic",
      },
      text,
    },
  });
  await executeTelegramUpdate(update(456, 100, prompts[0]), 123, ports);
  assert.equal(session.messages.length, 0);
  assert.equal(rejected.length, 1);
  let firstId;
  let secondId;
  let docsId;
  let afterPrepared;
  const check = (name, condition) => {
    auditChecks.push({ name, passed: Boolean(condition) });
    assert(condition, name);
  };
  const findTaskByMessage = (tasks, messageId) => {
    const matches = Object.values(tasks).filter(task => task.originalRequest.telegram.messageId === messageId);
    assert.equal(matches.length, 1, `TG message ${messageId} 必须且仅对应一个任务`);
    return matches[0].taskId;
  };
  const auditSource = (original, taskId) => {
    const input = inputs.find(item => item.message.message_id === original.telegram.messageId);
    assert(input, `${taskId} 的来源必须是实际已入场消息`);
    const entry = sessionManager.getEntries().find(item => item.id === original.entryId);
    const captured = sessionManager.getEntries().filter(item => item.type === "custom"
      && item.customType === "background-original-request" && item.data.entryId === original.entryId);
    check(`${taskId}: 原话逐字保留`, original.text === input.message.text);
    check(`${taskId}: TG 与 Pi 身份对应`, original.sessionId === session.sessionId
      && original.telegram.chatId === input.message.chat.id && original.source === "telegram"
      && entry?.type === "message" && entry.message.role === "user"
      && entry.message.content[0].text === input.inputText);
    check(`${taskId}: 发送与进入 Pi 时间对应`, Date.parse(original.telegram.sentAt) === input.message.date * 1000
      && Date.parse(original.receivedAt) === Date.parse(entry.timestamp)
      && original.telegram.sentAt.endsWith("+08:00") && original.receivedAt.endsWith("+08:00"));
    assert.equal(captured.length, 1, `${taskId}: 一条入站消息只取证一次`);
    assert.deepEqual(captured[0].data.originalRequest, original);
  };
  const auditTask = task => {
    auditSource(task.originalRequest, task.taskId);
    for (const revision of task.revisions ?? []) {
      auditSource(revision.request, task.taskId);
    }
    const spec = JSON.parse(fs.readFileSync(task.files.spec, "utf8"));
    assert.deepEqual(spec.project, projectBefore[task.projectId]);
    for (const field of ["taskId", "projectId", "originalRequest", "instruction", "scope", "acceptance", "artifacts"]) {
      assert.deepEqual(spec.task[field], task[field], `${task.taskId}: spec.${field} 与登记一致`);
    }
    assert.deepEqual(spec.task.clarifications, (task.revisions ?? []).map(revision => revision.request));
    check(`${task.taskId}: 交接文件字节 hash`, digest(task.files.spec) === task.specHash
      && digest(task.files.prompt) === task.promptHash);
    assert.equal(task.files.spec, path.join(agentDir, "background/tasks", task.taskId, "spec.json"));
    assert.equal(task.files.prompt, path.join(agentDir, "background/tasks", task.taskId, "prompt.md"));
    const prompt = fs.readFileSync(task.files.prompt, "utf8");
    // prompt.md 按行引用原话；JSON 保持原始文本，Markdown 的 > 标记不属于原话。
    const quotedRequest = text => text.split("\n").map(line => `> ${line}`).join("\n");
    check(`${task.taskId}: 交接稿包含原话与最新需求`, [quotedRequest(task.originalRequest.text), task.instruction,
      ...(task.revisions ?? []).map(revision => quotedRequest(revision.request.text)),
      ...task.scope, ...task.acceptance, ...task.artifacts].every(text => prompt.includes(text)));
    check(`${task.taskId}: Agent 类型/目录/分支取项目绑定`, prompt.includes(spec.project.agentKind)
      && prompt.includes(spec.project.worktreePath) && prompt.includes(spec.project.branch)
      && spec.project.sessionId === null);
  };
  const auditRevision = (task, previous, previousHash, inputIndex) => {
    const revision = task.revisions.at(-1);
    assert.equal(task.revisions.length, (previous.revisions?.length ?? 0) + 1);
    assert.deepEqual(task.originalRequest, previous.originalRequest);
    assert.equal(revision.request.text, prompts[inputIndex]);
    assert.equal(revision.request.telegram.messageId, 101 + inputIndex);
    assert.equal(revision.previousHash, previousHash);
    assert.deepEqual(revision.before, Object.fromEntries(["instruction", "scope", "acceptance", "artifacts"].map(field => [field, previous[field]])));
    for (const [field, value] of Object.entries(revision.changes)) {
      assert.deepEqual(task[field], value);
    }
    check(`${task.taskId}: 修订时间晚于补充入场`, Date.parse(revision.changedAt) >= Date.parse(revision.request.receivedAt));
  };
  for (let index = 0; index < prompts.length; index++) {
    console.log(JSON.stringify({ stage: "message", index, sessionId: session.sessionId, model: result.model }));
    await executeTelegramUpdate(update(123, 101 + index, prompts[index]), 123, ports);
    const current = cli("inspect");
    const previous = checkpoints.at(-1)?.inspection;
    checkpoints.push({
      index,
      messageId: 101 + index,
      originalText: prompts[index],
      inspection: current,
    });
    assert.deepEqual(current.registry.projects, projectBefore);
    const tasks = current.registry.tasks;
    if (bindingAudit) {
      if (index === 0) {
        assert.equal(Object.keys(tasks).length, 1);
        firstId = findTaskByMessage(tasks, 101);
        assert.equal(tasks[firstId].projectId, "test");
        assert.deepEqual(tasks[firstId].scope, ["README.md"]);
        assert.deepEqual(tasks[firstId].artifacts, ["README.md"]);
      } else if (index === 1) {
        assert.equal(Object.keys(tasks).length, 1);
        auditRevision(tasks[firstId], previous.registry.tasks[firstId], previous.task_hashes[firstId], index);
        assert.deepEqual(tasks[firstId].scope, ["README.md"]);
        assert(/WSL/.test(JSON.stringify(tasks[firstId])));
      } else if (index === 2) {
        assert.equal(Object.keys(tasks).length, 2);
        secondId = findTaskByMessage(tasks, 103);
        assert.equal(tasks[secondId].projectId, "test");
        assert.deepEqual([...tasks[secondId].scope].sort(), ["src/slug.js", "tests/slug.test.js"]);
        assert.deepEqual(tasks[firstId], previous.registry.tasks[firstId]);
      } else if (index === 3) {
        assert.equal(Object.keys(tasks).length, 2);
        auditRevision(tasks[secondId], previous.registry.tasks[secondId], previous.task_hashes[secondId], index);
        assert.deepEqual(tasks[firstId], previous.registry.tasks[firstId]);
        assert(/80/.test(tasks[secondId].instruction + JSON.stringify(tasks[secondId].acceptance)));
      } else if (index === 5) {
        assert.equal(Object.keys(tasks).length, 3);
        docsId = findTaskByMessage(tasks, 106);
        assert.equal(tasks[docsId].projectId, "test-docs");
        assert.deepEqual(tasks[docsId].scope, ["index.html"]);
        assert.deepEqual(tasks[firstId], previous.registry.tasks[firstId]);
        assert.deepEqual(tasks[secondId], previous.registry.tasks[secondId]);
      } else if (index === 6) {
        assert.equal(Object.keys(tasks).length, 3);
        auditRevision(tasks[docsId], previous.registry.tasks[docsId], previous.task_hashes[docsId], index);
        assert.deepEqual(tasks[docsId].scope, ["index.html"]);
        assert(tasks[docsId].instruction.includes("只用于链路验证"));
        assert.deepEqual(tasks[firstId], previous.registry.tasks[firstId]);
        assert.deepEqual(tasks[secondId], previous.registry.tasks[secondId]);
      } else {
        assert.deepEqual(tasks, previous.registry.tasks, "查询/未指定目标/越界/未知项目/问答/联网不能改任务登记");
      }
    } else if (index === 0) {
      assert.equal(Object.keys(tasks).length, 1);
      firstId = Object.keys(tasks)[0];
      assert.equal(tasks[firstId].originalRequest.text, prompts[0]);
      assert.equal(tasks[firstId].originalRequest.telegram.messageId, 101);
      assert(tasks[firstId].files);
    } else if (index === 1) {
      assert.equal(Object.keys(tasks).length, 1);
      assert.equal(tasks[firstId].originalRequest.text, prompts[0]);
      assert.equal(tasks[firstId].revisions[0].request.text, prompts[1]);
      assert.equal(tasks[firstId].revisions[0].request.telegram.messageId, 102);
      assert(tasks[firstId].acceptance.some(item => /负数|negative/.test(item)));
    } else if (index === 2) {
      assert.equal(Object.keys(tasks).length, 2);
      secondId = Object.keys(tasks).find(id => id !== firstId);
      assert.equal(tasks[secondId].originalRequest.text, prompts[2]);
      assert.equal(tasks[secondId].originalRequest.telegram.messageId, 103);
      afterPrepared = current.registry.tasks;
    } else {
      assert.deepEqual(tasks, afterPrepared, "查询/问答/未知项目/联网不应改任务登记");
    }
    for (const task of Object.values(tasks)) {
      assert(Object.hasOwn(projectBefore, task.projectId));
      assert.equal(task.status, "registered", "执行前状态沿用 Joye registered，不新增 prepared 状态");
      assert(current.handoff_checks[task.taskId].spec.matches && current.handoff_checks[task.taskId].prompt.matches);
      auditTask(task);
    }
    assert.equal(git(target, "status", "--porcelain"), targetBefore, "不应实际编写用户任务或覆盖已有修改");
    assert.equal(git(source, "rev-parse", "HEAD"), sourceHead);
    for (let treeIndex = 0; treeIndex < projectTrees.length; treeIndex++) {
      const tree = projectTrees[treeIndex];
      const before = treesBefore[treeIndex];
      assert.deepEqual(treeContents(tree.source), before.source, "项目源文件内容必须保留");
      assert.deepEqual(treeContents(tree.target), before.target, "worktree 包括未跟踪文件的内容必须保留");
      assert.equal(git(tree.source, "rev-parse", "HEAD"), before.sourceHead);
      assert.equal(git(tree.target, "status", "--porcelain"), before.targetStatus);
    }
    if (bindingAudit) {
      assert.equal(fs.readFileSync(path.join(fixture, "outside.txt"), "utf8"), "Keep this boundary sentinel.\n");
    }
    save(path.join(evidence, "prompts-and-replies.json"), { prompts, inputs, replies, events, checkpoints, auditChecks });
    console.log(JSON.stringify({ stage: "checked", index, taskCount: Object.keys(tasks).length }));
  }
  assert.equal(replies.length, prompts.length);
  assert.deepEqual(replies.map(reply => reply.replyId), prompts.map((_, index) => 101 + index));
  assert.equal(replies[bindingAudit ? 11 : 4].text.trim(), bindingAudit ? "7" : "2");
  assert(replies.at(-1).text.includes(bindingAudit ? "Nanjing University" : "Wuhan University") && /https?:\/\//.test(replies.at(-1).text));
  assert(events.some(event => event.type === "tool_execution_start" && event.toolName === "read"
    && event.args.path.includes("herdr-workflow/SKILL.md")));
  assert(events.some(event => event.type === "tool_execution_start" && event.toolName === "bash"
    && /task_protocol\.py.*\bregister\b/.test(event.args.command)));
  assert(events.every(event => !event.toolName.startsWith("background_")));
  assert.deepEqual(errors, []);
  const observationDir = path.join(agentDir, "observability");
  const observationFiles = fs.readdirSync(observationDir);
  assert.equal(observationFiles.length, 1);
  const observations = fs.readFileSync(path.join(observationDir, observationFiles[0]), "utf8").trim().split("\n").map(JSON.parse);
  const requests = observations.filter(entry => entry.stage === "request");
  const responses = observations.filter(entry => entry.stage === "response");
  assert(requests.length > 1 && requests.length === responses.length);
  const toolDefinitions = payload => payload.tools ?? [];
  result.toolDefinitionVariants = new Set(requests.map(entry => JSON.stringify(toolDefinitions(entry.providerPayload)))).size;
  result.systemPromptVariants = new Set(requests.map(entry => entry.systemPrompt)).size;
  assert.equal(result.toolDefinitionVariants, 1);
  assert.equal(result.systemPromptVariants, 1);
  assert(requests.every(entry => !JSON.stringify(toolDefinitions(entry.providerPayload)).includes("background_")));
  assert(requests.every(entry => !JSON.stringify(entry.providerPayload).includes("background-original-request")));
  result.passed = true;
  result.checks = {
    originalAndStructuredRequirements: true,
    supplementRecorded: true,
    twoTasksSameProjectWorktree: true,
    unchangedUserEdits: true,
    ordinaryAndUnknownProjectDidNotRegister: true,
    existingSkillRead: true,
    zeroBackgroundToolsInProviderPayload: true,
    privateSourceEntriesExcludedFromContext: true,
    finalNetworkQuery: true,
    unauthorizedUserRejected: true,
    rawMessageIdentityAndTimes: true,
    registrySpecPromptByteConsistency: true,
    sourceAndWorktreeFileContentsUnchanged: true,
    threeSkillsActuallyLoaded: true,
  };
  if (bindingAudit) {
    result.checks.twoProjectsDistinctWorktreesAndAgentKinds = true;
    result.checks.revisionsOnlyChangedTheNamedTask = true;
    result.checks.invalidPathAndUnspecifiedTargetDidNotRegister = true;
    result.thirdTaskId = docsId;
  }
  result.checkedRounds = checkpoints.length;
  result.sourceAndBindingCheckCount = auditChecks.length;
  result.modelRequests = requests.length;
  result.firstTaskId = firstId;
  result.secondTaskId = secondId;
  save(path.join(evidence, "prompts-and-replies.json"), { prompts, inputs, replies, events, checkpoints, auditChecks });
} catch (error) {
  result.error = {
    name: error.name,
    message: error.message,
  };
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  session?.dispose();
  runtime?.dispose();
  // 保存当前失败现场和请求证据；不会用重试覆盖失败结果。
  for (const name of ["sessions", "observability", "background"]) {
    const folder = path.join(agentDir, name);
    if (fs.existsSync(folder)) {
      fs.cpSync(folder, path.join(evidence, name), { recursive: true });
    }
  }
  // 同一轮失败时也刷新实际输入与失败 checkpoint；其他历史运行目录不改动。
  save(path.join(evidence, "prompts-and-replies.json"), { prompts, inputs, replies, events, checkpoints, auditChecks });
  result.finishedAt = new Date(Date.now() + 8 * 3600000).toISOString().replace("Z", "+08:00");
  result.protectedFilesUnchanged = protectedPaths.every(file => digest(path.join(bot, file)) === protectedHashes[file]);
  result.outerWorktreeRegistryUnchanged = git(path.join(bot, "../test"), "worktree", "list", "--porcelain") === outerGit;
  if (!result.protectedFilesUnchanged || !result.outerWorktreeRegistryUnchanged) {
    result.passed = false;
    process.exitCode = 1;
  }
  result.extensionErrors = errors;
  result.evidenceIsHistoricalSnapshot = true;
  save(path.join(evidence, "result.json"), result);
  process.chdir(bot);
  fs.rmSync(fixture, { recursive: true, force: true });
  console.log(JSON.stringify({ passed: result.passed, resultFile: path.join(evidence, "result.json"), error: result.error ?? null }));
}
