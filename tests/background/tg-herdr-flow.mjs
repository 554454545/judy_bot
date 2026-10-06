// TG 入站替身与真实 Pi/Herdr/Codex 联测：沿用正式项目绑定和原 UUID，私有任务登记隔离；不冒充 Telegram 网络投递。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

assert(process.argv.includes("--live"), "真实模型与 Coding Agent 测试需要 --live 和用户授权");
process.umask(0o077);
const bot = process.cwd();
const host = path.join(bot, "node_modules/@earendil-works/pi-coding-agent");
const bridge = path.join(bot, ".pi/npm/node_modules/@llblab/pi-telegram");
const beijing = ms => new Date(ms + 8 * 3600000).toISOString().replace("Z", "+08:00");
const stamp = beijing(Date.now());
const evidence = path.join(bot, ".pi/agent/background/verification/tg-herdr-flow", stamp.replaceAll(":", "-"));
const root = path.join(evidence, "background");
const agentDir = path.join(evidence, "frontend");
const protocol = path.join(bot, ".pi/extensions/background/tasks/task_protocol.py");
const production = JSON.parse(fs.readFileSync(path.join(bot, ".pi/agent/background/registry.json"), "utf8"));
const project = structuredClone(production.projects.test);
assert(project?.herdr?.agent_name === "herdr-test");
assert(!project.activeExecution, "正式项目必须没有执行中的任务");
const businessDirectory = "tg-chain-validation";
assert(!fs.existsSync(path.join(project.worktreePath, businessDirectory)), "测试目录已存在，不能覆盖历史产物");
const save = (file, value) => {
  fs.mkdirSync(path.dirname(file), {
    recursive: true,
    mode: 0o700,
  });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
  });
};
const digest = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const python = code => JSON.parse(execFileSync("python3", ["-c", code], {
  encoding: "utf8",
  env: {
    ...process.env,
    PYTHONDONTWRITEBYTECODE: "1",
  },
}));
const snapshot = directory => python(`import json,sys; sys.path.insert(0, ${JSON.stringify(path.join(bot, ".pi/extensions/background"))}); from execution.runner import worktree_snapshot; print(json.dumps(worktree_snapshot(${JSON.stringify(directory)})))`);
const sourceBefore = snapshot(project.sourcePath);
const worktreeBefore = snapshot(project.worktreePath);
const protectedFiles = ["start.sh", "AGENTS.md", "plan.md", ".pi/agent/auth.json", ".pi/agent/models.json", ".pi/agent/settings.json", ".pi/agent/background/registry.json", ".pi/agent/background/codex/test/config.toml"];
const protectedHashes = Object.fromEntries(protectedFiles.map(file => [file, digest(path.join(bot, file))]));
const cli = (...args) => JSON.parse(execFileSync("python3", [protocol, "--root", root, ...args], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    PI_SESSION_ID: "",
    PI_SESSION_FILE: "",
    PYTHONDONTWRITEBYTECODE: "1",
  },
}));
const inputs = [];
const replies = [];
const tools = [];
const checks = [];
const checkpoints = [];
const errors = [];
const result = {
  startedAt: stamp,
  evidence,
  mode: "synthetic Telegram update and send port; real project Pi model, native bash, Herdr 0.9.3, existing Codex UUID",
  realTelegramNetworkDelivery: false,
  workerSessionId: project.sessionId,
  workerName: project.herdr.agent_name,
  passed: false,
};
const check = (name, condition) => {
  checks.push({
    name,
    passed: Boolean(condition),
  });
  assert(condition, name);
};

// 只由测试驱动等待持久证据；前台回合不 sleep，不轮询 worker，不依据时间流逝认定成功。
function waitJSON(file, predicate, timeout = 600000) {
  return new Promise((resolve, reject) => {
    let watcher;
    let timer;
    const inspect = () => {
      try {
        const value = JSON.parse(fs.readFileSync(file, "utf8"));
        if (predicate(value)) {
          clearTimeout(timer);
          watcher?.close();
          resolve(value);
        }
      } catch (error) {
        if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) {
          clearTimeout(timer);
          watcher?.close();
          reject(error);
        }
      }
    };
    watcher = fs.watch(path.dirname(file), inspect);
    timer = setTimeout(() => {
      watcher.close();
      reject(new Error(`等待持久证据超时：${file}`));
    }, timeout);
    inspect();
  });
}

let session;
let runtime;
let modelRuntime;
let deadline;
let currentMessage = 100;
try {
  save(path.join(root, "registry.json"), {
    version: 1,
    revision: 0,
    projects: {
      test: project,
    },
    tasks: {},
  });
  save(path.join(evidence, "baseline.json"), {
    project,
    sourceBefore,
    worktreeBefore,
    protectedHashes,
  });
  fs.mkdirSync(agentDir, {
    recursive: true,
    mode: 0o700,
  });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_CODING_AGENT_SESSION_DIR = path.join(agentDir, "sessions");
  process.env.TMPDIR = path.join(bot, ".cache/tmp/background");
  fs.mkdirSync(process.env.TMPDIR, {
    recursive: true,
    mode: 0o700,
  });
  process.env.NODE_COMPILE_CACHE = path.join(bot, ".cache/node-compile");
  process.env.PI_OFFLINE = "1";
  process.env.PI_TELEMETRY = "0";
  process.env.PYTHONDONTWRITEBYTECODE = "1";
  const load = file => import(path.join(host, "dist", file));
  const { createAgentSession } = await load("core/sdk.js");
  const { DefaultResourceLoader } = await load("core/resource-loader.js");
  const { ModelRuntime } = await load("core/model-runtime.js");
  const { AuthStorage } = await load("core/auth-storage.js");
  const { SessionManager } = await load("core/session-manager.js");
  const { SettingsManager } = await load("core/settings-manager.js");
  const { createEventBus } = await load("core/event-bus.js");
  const { applyHttpProxySettings, configureHttpDispatcher } = await load("core/http-dispatcher.js");
  const selected = JSON.parse(fs.readFileSync(path.join(bot, ".pi/agent/settings.json"), "utf8"));
  applyHttpProxySettings(selected.httpProxy);
  configureHttpDispatcher(30000);
  const auth = JSON.parse(fs.readFileSync(path.join(bot, ".pi/agent/auth.json"), "utf8"));
  modelRuntime = await ModelRuntime.create({
    credentials: AuthStorage.inMemory({
      [selected.defaultProvider]: auth[selected.defaultProvider],
    }),
    modelsPath: path.join(bot, ".pi/agent/models.json"),
    modelsStorePath: path.join(agentDir, "models-store.json"),
    refreshOnCreate: false,
  });
  const model = modelRuntime.getModel(selected.defaultProvider, selected.defaultModel);
  assert(model);
  result.frontendModel = `${model.provider}/${model.id}`;
  const settings = SettingsManager.inMemory({
    compaction: {
      enabled: false,
    },
    retry: {
      enabled: false,
    },
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
    additionalExtensionPaths: [path.join(bot, ".pi/extensions/background/index.ts"), path.join(bot, "extensions/observability/index.ts")],
    additionalSkillPaths: ["herdr-workflow", "web-search", "skill-creator"].map(name => path.join(bot, ".pi/skills/joye/personal", name, "SKILL.md")),
    appendSystemPrompt: [fs.readFileSync(path.join(bot, "AGENTS.md"), "utf8"), [
      "# 本次已授权真实后台验收的隔离范围",
      `当前是 Bot 测试前台，所有 task_protocol.py 命令必须在子命令之前加 --root ${root}。这是本次唯一登记表，里面是正式 test 项目的真实执行绑定。不要操作默认正式登记表。`,
      `spec/delta/review 等测试私有文件只写 ${evidence} 内；允许新建它的 handoffs/ 和 reviews/。不写其他 Bot 源码和配置。`,
      "按已启用 Joye herdr-workflow Skill 完成 register → prepare → 核查 → start-run → run，run 返回收据后立即回复。不要在前台回合等待、重复派发、轮询，或直接控制 Herdr。",
      `真实 Coding Agent 只允许修改 test 的 worktree 内 ${businessDirectory}/，前台不能代写项目业务文件。原有业务文件全部保留。每项目串行复用原 UUID，不能启动替代会话。`,
      "用户查询完成时先 result，只按 acceptance 读取业务产物、跑只读检查与测试，实际通过后写 review.json 并 verify；不能复制完整 worker 对话、日志或 diff 进上下文。",
      "用户要求新增修改时登记新任务，完成的原任务保留。明确失败任务保持 blocked，不能 verify，也不能自动重试。",
      "普通问答与末轮联网查询不登记任务。联网可以读取 Bot 的原 web-search Skill 和项目凭据，只读使用，不复制或输出凭据。",
    ].join("\n")],
  });
  await loader.reload({
    resolveProjectTrust: async () => true,
  });
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.deepEqual(loader.getSkills().diagnostics, []);
  assert.deepEqual(loader.getSkills().skills.map(skill => skill.name).sort(), ["herdr-workflow", "skill-creator", "web-search"]);
  check("不注册后台模型工具", loader.getExtensions().extensions.find(extension => extension.path.endsWith("background/index.ts")).tools.size === 0);
  const manager = SessionManager.create(bot, path.join(agentDir, "sessions"));
  ({ session, runtime } = await createAgentSession({
    cwd: bot,
    agentDir,
    resourceLoader: loader,
    modelRuntime,
    model,
    thinkingLevel: selected.defaultThinkingLevel ?? "high",
    settingsManager: settings,
    tools: ["read", "write", "edit", "bash"],
    sessionManager: manager,
  }));
  await session.bindExtensions({
    onError: error => errors.push(error),
  });
  result.frontendSessionId = session.sessionId;
  session.subscribe(event => {
    if (["tool_execution_start", "tool_execution_end"].includes(event.type)) {
      tools.push({
        messageId: currentMessage,
        ...event,
      });
      console.log(JSON.stringify({
        stage: event.type,
        tool: event.toolName,
        isError: event.isError ?? false,
      }));
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
        timeLine: beijing(message.date * 1000),
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
      inputs.push({
        message,
        inputText,
      });
      globalThis[Symbol.for("bot.observability.telegram-turn")].enqueue(turn, [message]);
      let processing;
      queue.executeTelegramQueueDispatchPlan({
        kind: "prompt",
        item: turn,
      }, {
        onPromptDispatchStart() {},
        sendUserMessage(content) {
          processing = session.sendUserMessage(content);
        },
        onPromptDispatchFailure(error) {
          throw new Error(error);
        },
      });
      deadline = setTimeout(() => void session.abort(), 300000);
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
  const update = (id, text) => ({
    update_id: currentMessage,
    message: {
      message_id: currentMessage,
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
  await executeTelegramUpdate(update(456, "不要接受这条未授权消息"), 123, ports);
  check("未授权 TG 用户不会进入 Pi", session.messages.length === 0 && rejected.length === 1);
  const say = async text => {
    currentMessage++;
    console.log(JSON.stringify({
      stage: "input",
      message: currentMessage,
      text,
    }));
    await executeTelegramUpdate(update(123, text), 123, ports);
    checkpoints.push({
      messageId: currentMessage,
      registry: cli("inspect"),
    });
    save(path.join(evidence, "conversation.json"), {
      inputs,
      replies,
      tools,
      checkpoints,
    });
    console.log(JSON.stringify({
      stage: "reply",
      message: currentMessage,
      text: replies.at(-1)?.text,
    }));
  };
  const taskFromCurrentMessage = () => {
    const tasks = Object.values(cli("inspect").registry.tasks).filter(task => task.originalRequest.telegram.messageId === currentMessage);
    assert.equal(tasks.length, 1, "当前消息恰好登记一个任务");
    return tasks[0];
  };
  const auditTask = task => {
    const input = inputs.find(item => item.message.message_id === task.originalRequest.telegram.messageId);
    check(`${task.taskId}: 原话逐字保存`, task.originalRequest.text === input.message.text);
    const entry = manager.getEntries().find(item => item.id === task.originalRequest.entryId);
    check(`${task.taskId}: TG/Pi 身份和原生文本一致`, task.originalRequest.sessionId === session.sessionId && entry?.type === "message" && entry.message.content[0].text === input.inputText && task.originalRequest.telegram.chatId === input.message.chat.id);
    check(`${task.taskId}: 发送和入 Pi 时间准确`, Date.parse(task.originalRequest.telegram.sentAt) === input.message.date * 1000 && Date.parse(task.originalRequest.receivedAt) === Date.parse(entry.timestamp));
    check(`${task.taskId}: 原稿 hash 未变`, digest(task.files.spec) === task.specHash && digest(task.files.prompt) === task.promptHash);
    const run = task.runs[task.run_id];
    check(`${task.taskId}: 交接稿与 run hash 一致`, run.spec_hash === task.specHash && run.prompt_hash === task.promptHash);
    const spec = JSON.parse(fs.readFileSync(task.files.spec, "utf8"));
    for (const field of ["taskId", "projectId", "originalRequest", "instruction", "scope", "acceptance", "artifacts"]) {
      assert.deepEqual(spec.task[field], task[field]);
    }
    const currentProject = cli("inspect").registry.projects.test;
    for (const field of ["sessionId", "worktreePath", "branch", "herdr", "executionSettings"]) {
      assert.deepEqual(currentProject[field], project[field]);
    }
  };
  const finish = async (task, expected) => {
    const runDirectory = path.join(root, "runs", task.taskId, task.run_id);
    const execution = await waitJSON(path.join(runDirectory, "result.json"), value => value.task_id === task.taskId);
    const registered = await waitJSON(path.join(root, "registry.json"), value => value.tasks[task.taskId].status === expected);
    const complete = registered.tasks[task.taskId];
    auditTask(complete);
    const proof = JSON.parse(fs.readFileSync(path.join(runDirectory, "herdr-evidence.json"), "utf8"));
    check(`${task.taskId}: Codex 原 UUID 与真实原生输入`, proof.session_id === project.sessionId && proof.native_input_count === 1);
    check(`${task.taskId}: 实际 final_answer 独立 marker`, proof.native_final_message.text.split("\n").includes(complete.runs[task.run_id].marker));
    check(`${task.taskId}: 无范围外变动`, proof.outside_scope.length === 0);
    check(`${task.taskId}: 真实 Herdr 等待退出`, proof.prompt_result.cli_exit_code === 0 && ["done", "idle"].includes(proof.after.result.agent.agent_status));
    check(`${task.taskId}: 监督进程证据`, execution.exit_code_source === "herdr_supervisor_process_wait" && execution.pid_identity?.pid && execution.marker.seen);
    const brief = cli("result", task.taskId, task.run_id);
    check(`${task.taskId}: result 有界且不含完整 transcript`, brief.summary.length <= 1200 && !Object.hasOwn(brief, "native_final_message") && !Object.hasOwn(brief, "stdout"));
    return {
      complete,
      proof,
      execution,
      brief,
    };
  };
  const independentlyTest = (task, strict) => {
    const directory = path.join(project.worktreePath, businessDirectory);
    const source = [
      "import importlib.util, pathlib, subprocess, sys, json",
      `d=pathlib.Path(${JSON.stringify(directory)})`,
      "spec=importlib.util.spec_from_file_location('addition',d/'addition.py'); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
      "assert m.add(2,3)==5 and m.add(-5,2)==-3 and m.add(0,0)==0 and m.add(10**60,-10**60)==0",
      ...(strict ? ["for a,b in [(True,1),(1,False),(1.0,2),('1',2),(None,2),([],2)]:\n try: m.add(a,b)\n except TypeError: pass\n else: raise AssertionError('expected TypeError')"] : []),
      "p=subprocess.run([sys.executable,'-m','unittest','discover','-s',str(d),'-p','test_*.py'],capture_output=True,text=True)",
      "assert p.returncode==0, p.stderr",
      "print(json.dumps({'returncode':p.returncode,'stdout':p.stdout,'stderr':p.stderr,'independentEdges':True}))",
    ].join("\n");
    const proof = python(source);
    save(path.join(evidence, "independent-reviews", task.taskId + ".json"), {
      task_id: task.taskId,
      run_id: task.run_id,
      passed: true,
      checks: proof,
    });
  };

  await say("帮 test 项目在 tg-chain-validation 里加个 Python 加法函数 add(a, b)，文件叫 addition.py，支持正数、负数和零，补 test_addition.py 的 unittest 和简短 README。其他文件不要动，直接交后台做。");
  const first = taskFromCurrentMessage();
  check("首条任务实际派发", first.runs[first.run_id].dispatch_requested && fs.existsSync(path.join(root, "runs", first.taskId, first.run_id, "dispatch-receipt.json")));
  const firstDone = await finish(first, "ready_for_review");
  check("首条业务真实成功", firstDone.execution.reason === "goal_complete" && !firstDone.execution.error);
  independentlyTest(first, false);
  // 重复启动的拒绝必须由真实 CLI 证明，不能通过改表或模拟 Herdr 响应制造。
  for (const args of [["run", first.taskId, first.run_id], ["start-run", first.taskId, "--run-id", "duplicate-run"]]) {
    const before = digest(path.join(root, "registry.json"));
    assert.throws(() => cli(...args), error => JSON.parse(error.stderr).error === "ValueError");
    check(`重复 ${args[0]} 不改变登记表`, before === digest(path.join(root, "registry.json")));
  }
  await say("刚才 test 那条做完了吗？帮我按要求验收下，简短说结果。");
  check("前台实际独立验收首条", cli("inspect").registry.tasks[first.taskId].status === "verified");
  check("验收后释放项目串行占用", !cli("inspect").registry.projects.test.activeExecution);

  await say("给刚才 test 的加法函数补类型检查：只接受整数，布尔值也不接受，其他类型抛 TypeError。更新测试和 README，继续交后台做，别改 tg-chain-validation 以外的文件。");
  const second = taskFromCurrentMessage();
  check("连续工作登记新任务且保留首条", second.taskId !== first.taskId && cli("inspect").registry.tasks[first.taskId].status === "verified");
  const secondDone = await finish(second, "ready_for_review");
  check("第二条业务真实成功", secondDone.execution.reason === "goal_complete" && !secondDone.execution.error);
  independentlyTest(second, true);
  await say("test 刚才的类型检查做好了吗？你实际跑一下测试验收，简短告诉我。");
  check("前台实际独立验收第二条", cli("inspect").registry.tasks[second.taskId].status === "verified");

  const failedBefore = snapshot(project.worktreePath);
  await say("给 test 后台一个只读核查任务：读取 tg-chain-validation/required-input-does-not-exist.json，告诉我里面的内容。如果不存在就如实报告读取失败，不要创建文件、不要改任何项目文件，也不要重试。");
  const failed = taskFromCurrentMessage();
  const failedDone = await finish(failed, "blocked");
  check("真实失败不当成完成", failedDone.execution.reason === "read_error" && failedDone.execution.error && !cli("inspect").registry.tasks[failed.taskId].verification);
  assert.deepEqual(snapshot(project.worktreePath), failedBefore);
  await say("刚才那个只读核查怎么样了？失败就直接说失败，先不要重试。");
  check("失败查询不自动重发或验收", cli("inspect").registry.tasks[failed.taskId].status === "blocked" && Object.keys(cli("inspect").registry.tasks[failed.taskId].runs).length === 1);
  const tasksBeforeChat = cli("inspect").registry.tasks;
  await say("1 + 1 =？只回答答案。");
  assert.deepEqual(cli("inspect").registry.tasks, tasksBeforeChat);
  check("普通问题没有进入后台", /2/.test(replies.at(-1).text));
  await say("请联网查一下南京大学的官方英文名称，给官网链接，简短回答。");
  assert.deepEqual(cli("inspect").registry.tasks, tasksBeforeChat);
  check("联网实际执行只读检索或官网抓取", tools.some(event =>
    event.messageId === currentMessage
    && event.type === "tool_execution_start"
    && event.toolName === "bash"
    && /tinyfish\.sh|search\.(?:sh|py)|fetch\.py|\bcurl\b.*https?:\/\//.test(event.args.command)));
  check("联网答复有来源", /https?:\/\//.test(replies.at(-1).text));

  assert.deepEqual(snapshot(project.sourcePath), sourceBefore);
  const finalTree = snapshot(project.worktreePath);
  for (const [relative, value] of Object.entries(worktreeBefore)) {
    assert.deepEqual(finalTree[relative], value, `原工作文件必须保留：${relative}`);
  }
  check("新增业务文件都在允许目录", Object.keys(finalTree).filter(file => !Object.hasOwn(worktreeBefore, file)).every(file => file.startsWith(businessDirectory + "/")));
  for (const [file, hash] of Object.entries(protectedHashes)) {
    assert.equal(digest(path.join(bot, file)), hash, `受保护文件被改动：${file}`);
  }
  check("扩展无运行错误", errors.length === 0);
  save(path.join(evidence, "final-audit.json"), {
    checks,
    projects: cli("inspect").registry.projects,
    tasks: cli("inspect").registry.tasks,
    finalTree,
  });
  result.passed = true;
} catch (error) {
  result.error = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  result.finishedAt = beijing(Date.now());
  save(path.join(evidence, "conversation.json"), {
    inputs,
    replies,
    tools,
    checkpoints,
  });
  save(path.join(evidence, "result.json"), {
    ...result,
    checks,
    errors,
  });
  session?.dispose();
  runtime?.dispose();
  console.log(JSON.stringify(result));
}
