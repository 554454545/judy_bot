// 新项目真实健康验证：从空 test3/test4 交替接入、派发、验收、TG 投递，核查跨项目 UUID 隔离和同项目续用；关联 project-onboarding.py 与 GitHub Issue #24。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  createHash
} from "node:crypto";
import {
  execFileSync,
  spawnSync
} from "node:child_process";
import {
  createRequire
} from "node:module";
import {
  cases
} from "./complex-cases.mjs";

assert(process.argv.includes("--live"), "必须明确 --live；此驱动使用真实模型、Agent 和 TG 投递");
process.umask(0o077);
const bot = process.cwd();
const arg = name => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const caseId = 24;
const attempt = Number(arg("--attempt") || 1);
const selectedProject = arg("--project");
assert(!selectedProject || ["test3", "test4"].includes(selectedProject));
const games = [
  {
    ...cases[2],
    project: "test3"
  },
  {
    ...cases[3],
    project: "test4"
  },
].filter(item => !selectedProject || item.project === selectedProject);
let game;
let project;
const resumeFile = arg("--resume-bindings");
const savedRegistry = resumeFile ? JSON.parse(fs.readFileSync(resumeFile, "utf8")) : {};
const savedProjects = savedRegistry.projects ?? {};
const resumed = Object.fromEntries(games.filter(item => savedProjects[item.project]).map(item => [item.project, savedProjects[item.project]]));
const businessDirectory = arg("--business-directory") ?? (attempt === 1 ? "simulation" : `simulation_attempt_${attempt}`);
assert(/^[a-z][a-z0-9_]*$/.test(businessDirectory));
const directory = businessDirectory;
const repeatedOnly = process.argv.includes("--repeat-only");
const clarificationOnly = process.argv.includes("--clarification-only");
assert(!repeatedOnly || !clarificationOnly, "每次使用一个独立场景");
const scenarios = (clarificationOnly ? [] : repeatedOnly ? [2] : [0, 1, 2]).flatMap(phase => games.map(item => ({
  game: item,
  phase,
  text: item.prompts(directory)[phase].replace(` ${cases[item.number - 1].project} `, ` ${item.project} `)
  + (phase === 0 && !resumed[item.project] ? `\n${item.project} 是用户刚在 /home/judy/workspace 下创建的空文件夹。用户已明确授权初始化 Git、建长期 worktree 和新后台 Agent；使用项目集中默认配置。` : ""),
})));
const repeatBaseline = {};
if (repeatedOnly) {
  for (const scenario of scenarios) {
    const previous = Object.values(savedRegistry.tasks ?? {}).findLast(task =>
      task.projectId === scenario.game.project && task.status === "reported"
      && task.originalRequest?.text === scenario.text
    );
    assert(previous, "重复场景必须有已完成、逐字相同的原始请求；不能用改写需求冒充重复");
    repeatBaseline[scenario.game.project] = previous;
  }
}
const beijing = ms => new Date(ms + 8 * 3600000).toISOString().replace("Z", "+08:00");
const startedAt = beijing(Date.now());
const startedMono = process.hrtime.bigint();
const evidence = path.join(bot, ".pi/agent/background/verification/project-onboarding", startedAt.replaceAll(":", "-") + `-attempt-${attempt}`);
const root = path.join(evidence, "background");
const agentDir = path.join(evidence, "frontend");
const protocol = path.join(bot, ".pi/extensions/background/tasks/task_protocol.py");
const notifier = path.join(bot, ".pi/extensions/background/notifications/notify-telegram.py");
const host = path.join(bot, "node_modules/@earendil-works/pi-coding-agent");
const bridge = path.join(bot, ".pi/npm/node_modules/@llblab/pi-telegram");
const production = JSON.parse(fs.readFileSync(path.join(bot, ".pi/agent/background/registry.json"), "utf8"));
const nativeIds = {
};
const stableBindings = {
};
const oldBindings = Object.fromEntries(Object.entries(production.projects).map(([name, value]) => [name, {
    sessionId: value.sessionId,
    herdr: value.herdr,
    executionSettings: value.executionSettings,
}]));
const baselineTrees = {};
for (const item of games) {
  assert(!production.projects[item.project], "未交付的隔离实验不能覆盖正式绑定");
  const sourcePath = path.join(path.dirname(bot), item.project);
  if (resumed[item.project]) {
    const bound = resumed[item.project];
    assert(bound.sessionId && !bound.activeExecution);
    assert.equal(bound.sourcePath, sourcePath);
    nativeIds[item.project] = bound.sessionId;
    stableBindings[item.project] = structuredClone(bound);
  } else {
    assert(fs.existsSync(sourcePath) && fs.readdirSync(sourcePath).length === 0, "从真实空目录开始，不能覆盖内容");
    assert(!fs.existsSync(path.join(bot, ".worktrees", item.project)), "新项目不得预先创建 worktree");
    assert(!fs.existsSync(path.join(bot, ".pi/agent/background/codex", item.project)), "新项目不得预先创建 Codex session");
  }
}
const paired = JSON.parse(fs.readFileSync(path.join(bot, ".pi/agent/telegram.json"), "utf8")).profiles.personal.allowedUserId;
const target = {
  chatId: paired
};
const save = (file, value) => {
  fs.mkdirSync(path.dirname(file), {
    recursive: true,
    mode: 0o700
  });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600
  });
};
const digest = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const python = code => JSON.parse(execFileSync("python3", ["-c", code], {
  encoding: "utf8"
}));
const snapshot = dir => python(`import json,sys; sys.path.insert(0, ${JSON.stringify(path.join(bot, ".pi/extensions/background"))}); from execution.runner import worktree_snapshot; print(json.dumps(worktree_snapshot(${JSON.stringify(dir)})))`);
const cli = (...args) => JSON.parse(execFileSync("python3", [protocol, "--root", root, ...args], {
  encoding: "utf8",
  env: {
    ...process.env,
    PI_SESSION_ID: "",
    PI_SESSION_FILE: "",
    PYTHONDONTWRITEBYTECODE: "1"
  },
}));
const checks = [];
const steps = [];
const inputs = [];
const toolEvents = [];
const errors = [];
const check = (name, condition) => {
  checks.push({
    name,
    passed: Boolean(condition),
    at: beijing(Date.now())
  });
  assert(condition, name);

};
const status = (stage, fields = {
}) => console.log(JSON.stringify({
  at: beijing(Date.now()),
  group: caseId,
  attempt,
  stage,
  ...fields
}));
const result = {
  issue: 24,
  attempt,
  startedAt,
  evidence,
  mode: "constructed Telegram ingress; real frontend model, Herdr/Codex, independent review and Telegram API delivery",
  realUserTelegramIngress: false,
  realTelegramApiDelivery: true,
  scenario: clarificationOnly ? "clarification-only" : repeatedOnly ? "repeated-demand" : "alternating-projects",
  passed: false
};
let session;
let runtime;
let relay;
let timer;
let currentMessage = 500000 + caseId * 1000 + attempt * 10;
// 测试驱动沿用当前正式启动器的项目代理，不能把终端缺少代理误判为后台故障。
if (!process.env.HTTPS_PROXY && !process.env.HTTP_PROXY) {
  for (const pid of fs.readdirSync("/proc").filter(value => /^\d+$/.test(value))) {
    try {
      if (!fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").includes(path.join(bot, "scripts/startup/telegram.mjs"))) continue;
      for (const item of fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0")) {
        const index = item.indexOf("=");
        const key = item.slice(0, index);
        if (["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"].includes(key)) process.env[key] = item.slice(index + 1);

      }
      break;

    } catch {
    }
  }
}
const environmentProxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
if (environmentProxy) {
  const endpoint = new URL(environmentProxy);
  if (["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)) {
    const route = fs.readFileSync("/proc/net/route", "utf8").split("\n").map(line => line.trim().split(/\s+/)).find(fields => fields[1] === "00000000");
    endpoint.hostname = route[2].match(/../g).reverse().map(byte => parseInt(byte, 16)).join(".");

  }
  for (const variable of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) process.env[variable] = endpoint.href;
}
const wait = (predicate, timeout = 2100000) => new Promise((resolve, reject) => {
  const started = Date.now();
  const interval = setInterval(() => {
    try {
      const value = predicate();
      if (value) {
        clearInterval(interval);
        resolve(value);

      }
      else if (Date.now() - started >= timeout) {
        clearInterval(interval);
        reject(new Error("等待真实落盘证据超时"));

      }
    } catch (error) {
      clearInterval(interval);
      reject(error);

    }
  }, 1000);
});
const actualSend = async (text, eventId, parseMode) => {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const processResult = spawnSync("python3", [notifier, text, "--root", root, "--event-id", eventId, "--target", JSON.stringify(target), ...(parseMode ? ["--parse-mode", parseMode] : [])], {
      encoding: "utf8",
      timeout: 25000
    });
    const receipt = JSON.parse(processResult.stdout);
    save(path.join(evidence, "network", `${eventId}-attempt-${attempt}.json`), receipt);
    if (processResult.status === 0 && receipt.state === "success" && Number.isInteger(receipt.message_id)) {
      check(`真实 TG 回执 ${eventId}`, true);
      return receipt;

    }
    const delay = receipt.retry_at * 1000 - Date.now() + 500;
    if (receipt.state !== "failed" || !(delay > 0 && delay <= 60000) || attempt === 4) {
      throw new Error(`TG 投递未确认：${receipt.state}/${receipt.reason}`);

    }
    status("known-send-backoff", {
      eventId,
      delayMs: delay,
      reason: receipt.reason
    });
    await new Promise(resolve => setTimeout(resolve, delay));

  }
};
const record = text => fs.appendFileSync(path.join(evidence, "progress.log"), `\n${text}\n`);
const protectedHashes = Object.fromEntries(["start.sh", ".pi/agent/models.json", ".pi/agent/settings.json"].map(file => [file, digest(path.join(bot, file))]));
try {
  save(path.join(root, "registry.json"), {
    version: 1,
    revision: 0,
    projects: structuredClone(resumed),
    tasks: {},
  });
  for (const item of games) {
    baselineTrees[item.project] = resumed[item.project] ? snapshot(resumed[item.project].worktreePath) : {};
  }
  save(path.join(evidence, "baseline.json"), {
    oldBindings,
    protectedHashes
  });
  record(`开始 ${startedAt}：真实空目录首次接入。任务表隔离；本次完成后登记已验证项目绑定。`);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_CODING_AGENT_SESSION_DIR = path.join(agentDir, "sessions");
  process.env.TMPDIR = path.join(bot, ".cache/tmp/background");
  fs.mkdirSync(process.env.TMPDIR, {
    recursive: true,
    mode: 0o700
  });
  process.env.NODE_COMPILE_CACHE = path.join(bot, ".cache/node-compile");
  process.env.PI_OFFLINE = "1";
  process.env.PI_TELEMETRY = "0";
  process.env.PYTHONDONTWRITEBYTECODE = "1";
  const load = file => import(path.join(host, "dist", file));
  const {
    createAgentSession
  } = await load("core/sdk.js");
  const {
    DefaultResourceLoader
  } = await load("core/resource-loader.js");
  const {
    ModelRuntime
  } = await load("core/model-runtime.js");
  const {
    AuthStorage
  } = await load("core/auth-storage.js");
  const {
    SessionManager
  } = await load("core/session-manager.js");
  const {
    SettingsManager
  } = await load("core/settings-manager.js");
  const {
    createEventBus
  } = await load("core/event-bus.js");
  const {
    applyHttpProxySettings,
    configureHttpDispatcher
  } = await load("core/http-dispatcher.js");
  const selected = JSON.parse(fs.readFileSync(path.join(bot, ".pi/agent/settings.json"), "utf8"));
  applyHttpProxySettings(selected.httpProxy);
  configureHttpDispatcher(30000);
  const auth = JSON.parse(fs.readFileSync(path.join(bot, ".pi/agent/auth.json"), "utf8"));
  const modelRuntime = await ModelRuntime.create({
    credentials: AuthStorage.inMemory({
      [selected.defaultProvider]: auth[selected.defaultProvider]
    }),
    modelsPath: path.join(bot, ".pi/agent/models.json"),
    modelsStorePath: path.join(agentDir, "models-store.json"),
    refreshOnCreate: false
  });
  const model = modelRuntime.getModel(selected.defaultProvider, selected.defaultModel);
  assert(model);
  result.frontendModel = `${model.provider}/${model.id}`;
  const require = createRequire(path.join(host, "package.json"));
  const {
    createJiti
  } = await import(require.resolve("jiti"));
  const jiti = createJiti(import.meta.url, {
    fsCache: false
  });
  const {
    createRelay
  } = await jiti.import(path.join(bot, ".pi/extensions/background/notifications/relay-notify.ts"));
  const settings = SettingsManager.inMemory({
    compaction: {
      enabled: false
    },
    retry: {
      enabled: false
    }
  });
  const loader = new DefaultResourceLoader({
    cwd: bot,
    agentDir,
    settingsManager: settings,
    eventBus: createEventBus(),
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    noContextFiles: true,
    additionalExtensionPaths: [
      path.join(bot, ".pi/extensions/background/index.ts"),
      path.join(bot, ".pi/extensions/reply-health/index.ts"),
      path.join(bot, "extensions/observability/index.ts"),
    ],
    extensionFactories: [{
        name: "full-chain-owner",
        factory: pi => {
          relay = createRelay(pi, {
            root,
            isMain: () => true,
            intervalMs: 1500,
            target
          });

        }
    }],
    additionalSkillPaths: ["herdr-workflow", "web-search", "skill-creator"].map(name => path.join(bot, ".pi/skills/joye/personal", name, "SKILL.md")),
    appendSystemPrompt: [fs.readFileSync(path.join(bot, "AGENTS.md"), "utf8"), [
        "# 已授权真实后台健康实验的隔离边界",
        `本次项目为 test3、test4，来源目录分别是 /home/judy/workspace/test3 和 /home/judy/workspace/test4。用户明确授权创建 Git 基线、长期 worktree、新 Agent，以及完整业务链路。两者初始均为空，不能借用其他项目的 worktree/session。`,
        `本次登记根目录是 ${root}。每条 task_protocol.py 命令在子命令前传 --root ${path.relative(bot, root)}；不读写默认正式登记表。第一次分别完成 project-register、worktree-ensure --base main、project-bind，再 prepare/start-run/run。不要直接操作 Herdr pane 或调用 runner bind。`,
        `spec/review 等私有文件写 ${root}/handoffs 和 ${root}/reviews。前台不得代写业务程序；业务只在本项目 worktree 的 ${directory}/ 内。每轮创建新任务，保持该项目永久 session，不覆盖旧任务。`,
        "这是已有 Issue #24 的健康实验；调查、失败和验收记录沿用该 Issue，不为实验中的业务请求另建 Issue。",
      clarificationOnly
      ? "本场景只测试澄清与交接准备。用户确认之前不登记；确认后仅 register → prepare → 检查 hash/preflight，禁止 start-run/run、禁止给 Codex 派发。"
      : "必须完整执行 register → prepare → 检查 hash/preflight → start-run → run --timeout 1800；run 返回收据后立即简短回复，不 sleep、不轮询 worker、不等待或主动查询完成。",
        "查询需有界，使用 herdr-workflow Skill 中已核对的多行 Python 示例，将登记根目录换成本次 --root；禁止临时拼复杂 Python 单行字典。每次 bash 只调用一个 task_protocol.py 操作，检查返回后用下一次 bash 做后续步骤；不要合并 register/prepare/start-run/run。",
        "后台事件到来才进行独立验收。必须读取原 acceptance 并实际运行业务测试，必要时读有界业务文件；保存匹配 task_id/run_id/passed/checks 的 JSON，再 verify。不能读取完整 Codex 对话、terminal transcript 或巨大 diff。",
        "读取测试或源码前，先在本任务范围列出实际文件名，或核对本 run 的实际产物；只读确认存在的路径。新机制可以补在原测试文件内，不要猜测 test_mechanisms.py 等文件名。",
        "内部状态事件不是用户新任务，不 register 不派发。验收失败 verify --reject，不能偷偷修改业务程序或重跑；扩展负责 TG 投递和 receipt，模型不能自己发送 TG、调用 report/ack。",
      clarificationOnly
      ? "用户会先要求澄清，中间穿插普通问答，再确认准备。按 sourceEntryIds 绑定初始问题与确认，排除普通问答；两条原话身份要来自当前分支的真实取证。"
      : "三阶段需求明确，无需额外确认。初始消息授权新项目接入；后续按实际项目名查询既有绑定，不能因最近处理另一项目而串线。",
      ].join("\n")],

  });
  await loader.reload({
    resolveProjectTrust: async () => true
  });
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.deepEqual(loader.getSkills().diagnostics, []);
  check("后台未新增模型工具", loader.getExtensions().extensions.every(item => !item.path.endsWith("background/index.ts") || item.tools.size === 0));
  const manager = SessionManager.create(bot, path.join(agentDir, "sessions"));
  ({
    session,
    runtime
  } = await createAgentSession({
    cwd: bot,
    agentDir,
    resourceLoader: loader,
    modelRuntime,
    model,
    thinkingLevel: selected.defaultThinkingLevel ?? "high",
    settingsManager: settings,
    tools: ["read", "write", "edit", "bash"],
    sessionManager: manager
  }));
  await session.bindExtensions({
    onError: error => errors.push(error)
  });
  result.frontendSessionId = session.sessionId;
  session.subscribe(event => {
    if (["tool_execution_start", "tool_execution_end"].includes(event.type)) {
      toolEvents.push({
        at: beijing(Date.now()),
        messageId: currentMessage,
        ...event
      });
      status(event.type, {
        tool: event.toolName,
        isError: event.isError ?? false
      });
      save(path.join(evidence, "tool-events.json"), toolEvents);

    }
  });
  const {
    executeTelegramUpdate
  } = await jiti.import(path.join(bridge, "lib/updates.ts"));
  const queue = await jiti.import(path.join(bridge, "lib/queue.ts"));
  const {
    buildTelegramTurnPrompt
  } = await jiti.import(path.join(bridge, "lib/turns.ts"));
  const {
    renderTelegramMessage
  } = await jiti.import(path.join(bridge, "lib/rendering.ts"));
  let processing;
  const ports = {
    ctx: {
    },
    pairTelegramUserIfNeeded: async () => false,
    sendTextReply: async () => {
      throw new Error("意外未授权消息");

    },
    handleAuthorizedTelegramMessage: async message => {
      const text = buildTelegramTurnPrompt({
        telegramPrefix: "[telegram]",
        rawText: message.text,
        files: [],
        timeLine: beijing(message.date * 1000)
      });
      const turn = {
        kind: "prompt",
        chatId: message.chat.id,
        replyToMessageId: message.message_id,
        sourceMessageIds: [message.message_id],
        queueOrder: message.message_id,
        content: [{
            type: "text",
            text
        }]
      };
      inputs.push({
        message,
        inputText: text,
        at: beijing(Date.now())
      });
      globalThis[Symbol.for("bot.observability.telegram-turn")].enqueue(turn, [message]);
      queue.executeTelegramQueueDispatchPlan({
        kind: "prompt",
        item: turn
      }, {
        onPromptDispatchStart() {
        },
        sendUserMessage(content) {
          processing = session.sendUserMessage(content);

        },
        onPromptDispatchFailure(error) {
          throw new Error(error);

        }
      });
      timer = setTimeout(() => void session.abort(), 360000);
      try {
        await processing;

      } finally {
        clearTimeout(timer);

      }
      const assistant = session.messages.findLast(item => item.role === "assistant");
      assert(assistant && !["error", "aborted"].includes(assistant.stopReason), "前台模型没有正常结束");
      const answer = assistant.content.filter(block => block.type === "text").map(block => block.text).join("");
      const chunk = renderTelegramMessage(`🧪 实验 ${caseId}.${steps.length + 1}\n${answer}`, {
        mode: "markdown"
      })[0];
      const receipt = await actualSend(chunk.text, `front-${caseId}-${attempt}-${currentMessage}`, chunk.parseMode);
      inputs.at(-1).reply = {
        text: answer,
        receipt,
        at: beijing(Date.now())
      };

    },
    handleAuthorizedTelegramEditedMessage: async () => {
      throw new Error("unexpected edit");

    },
    handleAuthorizedTelegramCallbackQuery: async () => {
      throw new Error("unexpected callback");

    },
    handleAuthorizedTelegramReactionUpdate: async () => {
      throw new Error("unexpected reaction");

    },

  };
  if (clarificationOnly) {
    game = games[0];
    const messages = [
      `帮 test3 的 ${directory}/ 铁路模拟器增加批量命令报错定位，能指出第几条命令无效。先别登记任务，先问我序号从 0 还是 1 开始。`,
      "顺便问一句，9 + 9 =？只回答答案，不是后台任务。",
      "确认，刚才的铁路命令序号从 1 开始，继续保持整批失败不修改输入。只整理交接准备好，不执行。",
    ];
    for (const text of messages) {
      currentMessage += 1;
      await executeTelegramUpdate({
        update_id: currentMessage,
        message: {
          message_id: currentMessage,
          date: Math.floor(Date.now() / 1000),
          chat: {
            id: paired,
            type: "private",
          },
          from: {
            id: paired,
            is_bot: false,
            first_name: "Test driver",
          },
          text,
        },
      }, paired, ports);
      if (text !== messages.at(-1)) {
        check("首次澄清和普通问答不登记后台任务", Object.keys(cli("inspect").registry.tasks).length === 0);
      }
    }
    const tasks = Object.values(cli("inspect").registry.tasks);
    check("确认后只准备一个任务", tasks.length === 1);
    const task = tasks[0];
    check("初始问题逐字保留", task.originalRequest.text === messages[0]);
    check("确认原话单独保留且排除穿插问答", task.clarificationRequests?.length === 1 && task.clarificationRequests[0].text === messages[2]);
    check("原话绑定真实不同 entry 和 TG 身份", task.originalRequest.entryId !== task.clarificationRequests[0].entryId && task.originalRequest.telegram.messageId === inputs[0].message.message_id && task.clarificationRequests[0].telegram.messageId === inputs[2].message.message_id);
    check("只准备不执行且交接 hash 正确", task.status === "registered" && !task.run_id && digest(task.files.spec) === task.specHash && digest(task.files.prompt) === task.promptHash);
    const spec = JSON.parse(fs.readFileSync(task.files.spec, "utf8"));
    assert.deepEqual(spec.task.originalRequest, task.originalRequest);
    assert.deepEqual(spec.task.clarifications, task.clarificationRequests);
    check("整理需求含确认规则", task.instruction.includes("1") && task.instruction.length > 60);
    save(path.join(evidence, "clarification-audit.json"), {
      task,
      checks,
    });
  }
  for (const scenario of scenarios) {
    game = scenario.game;
    const {
      phase,
      text
    } = scenario;
    currentMessage += 1;
    const sentAt = beijing(Date.now());
    const stepMono = process.hrtime.bigint();
    status("input", {
      phase,
      text
    });
    await executeTelegramUpdate({
      update_id: currentMessage,
      message: {
        message_id: currentMessage,
        date: Math.floor(Date.now() / 1000),
        chat: {
          id: paired,
          type: "private"
        },
        from: {
          id: paired,
          is_bot: false,
          first_name: "Test driver"
        },
        text
      }
    }, paired, ports);
    const matches = Object.values(cli("inspect").registry.tasks).filter(task => task.originalRequest.telegram?.messageId === currentMessage);
    check(`阶段 ${phase} 唯一登记`, matches.length === 1);
    const task = matches[0];
    check(`阶段 ${phase} 项目路由 ${game.project}`, task.projectId === game.project);
    project = cli("inspect").registry.projects[game.project];
    check(`阶段 ${phase} 真正异步派发`, task.runs?.[task.run_id]?.dispatch_requested && fs.existsSync(path.join(root, "runs", task.taskId, task.run_id, "dispatch-receipt.json")));
    const step = {
      projectId: game.project,
      phase,
      taskId: task.taskId,
      runId: task.run_id,
      sentAt,
      inputMonotonicNs: stepMono.toString(),
      dispatchedAt: beijing(Date.now()),
      statuses: []
    };
    steps.push(step);
    save(path.join(evidence, "conversation.json"), {
      inputs,
      steps
    });
    let lastStatus;
    let failedSince;
    await wait(() => {
      const registry = JSON.parse(fs.readFileSync(path.join(root, "registry.json"), "utf8"));
      const taskNow = registry.tasks[task.taskId];
      if (taskNow.status !== lastStatus) {
        lastStatus = taskNow.status;
        step.statuses.push({
          at: beijing(Date.now()),
          status: lastStatus
        });
        status("task-status", {
          phase,
          taskId: task.taskId,
          status: lastStatus
        });

      }
      const networkReceiptFile = path.join(root, "runs", task.taskId, task.run_id, "final-report-receipt.json");
      if (fs.existsSync(networkReceiptFile) && JSON.parse(fs.readFileSync(networkReceiptFile, "utf8")).state === "unknown") {
        throw new Error(`阶段 ${phase} 实际 TG 投递结果不明，保留现场且未重发；整组失败`);

      }
      if (["blocked", "rework", "needs_reconciliation", "cancelled"].includes(taskNow.status)) {
        failedSince ??= Date.now();
        const failureReceipt = path.join(root, "runs", task.taskId, task.run_id, "final-report-receipt.json");
        const failureInbox = path.join(root, "inbox.json");
        if (fs.existsSync(failureReceipt) && fs.existsSync(failureInbox)) {
          const receipt = JSON.parse(fs.readFileSync(failureReceipt, "utf8"));
          const inbox = JSON.parse(fs.readFileSync(failureInbox, "utf8"));
          if (receipt.state === "success" && Object.values(inbox).some(event => event.task_id === task.taskId && event.run_id === task.run_id && event.state === "handled")) {
            throw new Error(`阶段 ${phase} 失败：${taskNow.status}；真实失败通知和事件签收已保存`);
          }

        }
        if (Date.now() - failedSince > 240000) {
          throw new Error(`阶段 ${phase} 失败：${taskNow.status}；失败通知等待超时`);
        }
        return false;

      }
      const attentionDirectory = path.join(root, "attention");
      if (fs.existsSync(attentionDirectory) && fs.readdirSync(attentionDirectory).length) {
        const inbox = JSON.parse(fs.readFileSync(path.join(root, "inbox.json"), "utf8"));
        if (Object.values(inbox).some(event => event.task_id === task.taskId && event.run_id === task.run_id && event.state === "needs_attention")) {
          throw new Error(`阶段 ${phase} 验收或投递未确认，必须检查 attention 证据`);

        }
      }
      if (taskNow.status !== "reported") {
        return false;
      }
      const inbox = JSON.parse(fs.readFileSync(path.join(root, "inbox.json"), "utf8"));
      return Object.values(inbox).some(event => event.task_id === task.taskId && event.run_id === task.run_id && event.state === "handled") && session.isIdle ? registry : false;

    });
    const registry = cli("inspect").registry;
    const complete = registry.tasks[task.taskId];
    const run = complete.runs[task.run_id];
    const runDirectory = path.join(root, "runs", task.taskId, task.run_id);
    const inboxEvents = Object.values(JSON.parse(fs.readFileSync(path.join(root, "inbox.json"), "utf8"))).filter(event => event.task_id === task.taskId && event.run_id === task.run_id);
    const source = inputs.find(item => item.message.message_id === complete.originalRequest.telegram.messageId);
    const nativeEntry = manager.getEntries().find(item => item.id === complete.originalRequest.entryId);
    check(`阶段 ${phase} 原话逐字和原生 entry`, complete.originalRequest.text === text && nativeEntry?.message.content[0].text === source.inputText && complete.originalRequest.sessionId === session.sessionId);
    if (repeatedOnly) {
      const previous = repeatBaseline[game.project];
      check(`${game.project} 重复原话仍使用新的来源身份`, complete.originalRequest.text === previous.originalRequest.text
        && complete.originalRequest.sessionId !== previous.originalRequest.sessionId
        && complete.originalRequest.entryId !== previous.originalRequest.entryId
        && complete.originalRequest.telegram.messageId !== previous.originalRequest.telegram.messageId);
      check(`${game.project} 重复任务不是旧结果`, run.marker !== previous.runs[previous.run_id].marker
        && run.result_path !== previous.runs[previous.run_id].result_path);
      step.repeatOf = {
        taskId: previous.taskId,
        runId: previous.run_id,
        sourceSessionId: previous.originalRequest.sessionId,
        sourceEntryId: previous.originalRequest.entryId,
      };
    }
    check(`阶段 ${phase} 时间对应真实 entry/update`, Date.parse(complete.originalRequest.receivedAt) === Date.parse(nativeEntry.timestamp) && Date.parse(complete.originalRequest.telegram.sentAt) === source.message.date * 1000);
    check(`阶段 ${phase} 整理需求保留且 hash 匹配`, complete.instruction.length > 80 && digest(complete.files.spec) === complete.specHash && digest(complete.files.prompt) === complete.promptHash && run.spec_hash === complete.specHash && run.prompt_hash === complete.promptHash);
    const spec = JSON.parse(fs.readFileSync(complete.files.spec, "utf8"));
    for (const field of ["taskId", "projectId", "originalRequest", "instruction", "scope", "acceptance", "artifacts"]) {
      assert.deepEqual(spec.task[field], complete[field]);
    }
    const proof = JSON.parse(fs.readFileSync(path.join(runDirectory, "herdr-evidence.json"), "utf8"));
    const bound = registry.projects[game.project];
    nativeIds[game.project] ??= bound.sessionId;
    check(`阶段 ${phase} 固定 UUID ${game.project}`, bound.sessionId && proof.session_id === nativeIds[game.project] && proof.session_id === bound.sessionId && proof.session_name === `herdr-${game.project}` && proof.native_input_count === 1 && proof.prompt_result.cli_exit_code === 0 && proof.native_final_message.text.split("\n").includes(run.marker));
    check(`阶段 ${phase} 原生调用使用登记模型`, proof.native_model_settings?.length > 0 && proof.native_model_settings.every(item => item.model === bound.executionSettings.agent.model && item.effort === bound.executionSettings.agent.reasoningEffort));
    check(`阶段 ${phase} 与旧项目 session 隔离`, !Object.values(oldBindings).some(old => old.sessionId === bound.sessionId));
    check(`阶段 ${phase} 项目独立运行目录`, bound.executionSettings.agent.home === path.join(bot, ".pi/agent/background/codex", game.project));
    if (nativeIds.test3 && nativeIds.test4) {
      check("test3/test4 session 完全不同", nativeIds.test3 !== nativeIds.test4);
    }
    stableBindings[game.project] ??= structuredClone(bound);
    check(`阶段 ${phase} 无越界变动`, proof.outside_scope.length === 0);
    const execution = JSON.parse(fs.readFileSync(path.join(runDirectory, "result.json"), "utf8"));
    check(`阶段 ${phase} 真实结果身份与完成`, execution.task_id === task.taskId && execution.run_id === task.run_id && execution.reason === "goal_complete" && !execution.error && execution.exit_code === 0 && execution.marker.seen);
    const review = JSON.parse(fs.readFileSync(complete.verification.evidence.path, "utf8"));
    check(`阶段 ${phase} 独立验收与投递`, review.task_id === task.taskId && review.run_id === task.run_id && review.passed === true && review.checks && complete.report.status === "success" && Number.isInteger(complete.report.message_id));
    const independent = spawnSync("python3", [path.join(bot, "tests/background/independent-game-check.py"), path.join(project.worktreePath, directory), String(phase)], {
      encoding: "utf8",
      timeout: 180000
    });
    const inspection = JSON.parse(independent.stdout);
    save(path.join(evidence, `independent-${game.project}-phase-${phase}.json`), inspection);
    check(`阶段 ${phase} 第二次独立属性/实际业务测试`, independent.status === 0 && inspection.passed);
    check(`阶段 ${phase} 释放项目占用`, !registry.projects[game.project].activeExecution);
    for (const field of ["sessionId", "worktreePath", "branch", "herdr", "executionSettings"]) {
      assert.deepEqual(registry.projects[game.project][field], stableBindings[game.project][field]);
    }
    step.finishedAt = beijing(Date.now());
    step.wallSeconds = (Date.parse(step.finishedAt) - Date.parse(sentAt)) / 1000;
    step.seconds = Number(process.hrtime.bigint() - stepMono) / 1e9;
    step.messageId = complete.report.message_id;
    step.stageEvidence = {
      receivedAt: complete.originalRequest.receivedAt,
      registeredAt: complete.createdAt,
      runStartedAt: run.started_at,
      runnerStartedAt: run.runner_started,
      workerFinalAt: beijing(Date.parse(proof.native_final_message.timestamp)),
      resultAt: execution.finished_at,
      verifiedAt: complete.verification.at,
      telegramApiConfirmedAt: beijing(complete.report.at * 1000),
      handledAt: beijing(inboxEvents.find(event => event.state === "handled").updated_at * 1000),
      monotonic: {
        runStarted: run.started_monotonic_ns,
        runnerStarted: run.runner_started_monotonic_ns,
        dispatchStarted: proof.dispatch_started_monotonic_ns,
        dispatchFinished: proof.dispatch_finished_monotonic_ns,
        resultWritten: execution.finished_monotonic_ns,
        verified: complete.verification.monotonic_ns,
        sent: complete.report.monotonic_ns,
        handled: inboxEvents.find(event => event.state === "handled")?.updated_monotonic_ns,

      },

    };
    step.checkCount = inspection.checkCount;
    step.passed = true;
    save(path.join(evidence, "conversation.json"), {
      inputs,
      steps
    });
    record(`- ${step.finishedAt}：实验 ${caseId} / 尝试 ${attempt} / 阶段 ${phase + 1} 通过；task ${task.taskId} / run ${task.run_id}；${step.seconds.toFixed(1)}s；TG message_id ${step.messageId}；属性检查 ${step.checkCount} 项，真实业务测试通过，项目占用已释放。`);
    status("phase-passed", step);

  }
  const finalRegistry = cli("inspect").registry;
  for (const item of games) {
    const bound = finalRegistry.projects[item.project];
    check(`${item.project} 源目录业务未越界`, Object.keys(snapshot(bound.sourcePath)).length === 0);
    const finalTree = snapshot(bound.worktreePath);
    for (const [file, hash] of Object.entries(baselineTrees[item.project])) {
      if (!file.startsWith(directory + "/")) {
        assert.deepEqual(finalTree[file], hash, "本轮范围外既有业务文件被修改：" + file);
      }
    }
    check(`${item.project} 产物范围`, Object.keys(finalTree).filter(file => !Object.hasOwn(baselineTrees[item.project], file)).every(file => file.startsWith(directory + "/")));
    const raw = python(`import json; from pathlib import Path; paths=list(Path(${JSON.stringify(bound.executionSettings.agent.home)}).joinpath("sessions").rglob("*.jsonl")); print(json.dumps([json.loads(p.open().readline())["payload"]["id"] for p in paths]))`);
    check(`${item.project} 唯一原生 session`, raw.length === 1 && raw[0] === nativeIds[item.project]);

  }
  result.workerSessions = nativeIds;
  for (const [file, hash] of Object.entries(protectedHashes)) {
    assert.equal(digest(path.join(bot, file)), hash, `受保护配置变化 ${file}`);
  }
  check("Pi 扩展无运行异常", errors.length === 0);
  check("新项目链路没有未解释的中途工具异常", !toolEvents.some(event => event.type === "tool_execution_end" && event.isError));
  save(path.join(evidence, "final-audit.json"), {
    checks,
    registry: finalRegistry
  });
  result.passed = true;
} catch (error) {
  result.error = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  relay?.dispose();
  await session?.abort();
  session?.dispose();
  runtime?.dispose();
  result.finishedAt = beijing(Date.now());
  result.wallSeconds = (Date.parse(result.finishedAt) - Date.parse(startedAt)) / 1000;
  result.seconds = Number(process.hrtime.bigint() - startedMono) / 1e9;
  save(path.join(evidence, "conversation.json"), {
    inputs,
    steps
  });
  save(path.join(evidence, "result.json"), {
    ...result,
    steps,
    checks,
    errors
  });
  record(`${result.finishedAt}：实验 ${caseId} / 尝试 ${attempt} / ${result.scenario} ${result.passed ? "完整通过" : "失败，不计通过"}，${result.seconds.toFixed(1)}s。${result.error ? "错误：" + result.error.split("\n")[0] : "本场景全部检查通过；具体输入、步骤和身份见私有审计。"}`);
  status("group-finished", result);
}
