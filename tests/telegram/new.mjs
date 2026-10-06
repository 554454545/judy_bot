// 验证 /pi_new 使用真实 Pi 会话切换，连续执行、忙碌拦截及历史保留，不访问 Telegram 或模型。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const temp = fs.mkdtempSync(path.join(root, '.cache/tmp/telegram-new-'));
const agentDir = path.join(temp, 'agent');
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = '1';
process.env.PI_TELEMETRY = '0';
globalThis.fetch = () => { throw new Error('Network forbidden'); };
const load = file => import(path.join(root, 'node_modules/@earendil-works/pi-coding-agent/dist', file));
let host;
try {
  const { initTheme } = await load('modes/interactive/theme/theme.js');
  initTheme('dark');
  const { createAgentSession } = await load('core/sdk.js');
  const { DefaultResourceLoader } = await load('core/resource-loader.js');
  const { SettingsManager } = await load('core/settings-manager.js');
  const { SessionManager } = await load('core/session-manager.js');
  const { ModelRuntime } = await load('core/model-runtime.js');
  const { AuthStorage } = await load('core/auth-storage.js');
  const { AgentSessionRuntime } = await load('core/agent-session-runtime.js');
  const modelRuntime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null,
    modelsStorePath: path.join(temp, 'models.json'), refreshOnCreate: false });
  modelRuntime.streamSimple = () => { throw new Error('Model forbidden'); };
  const errors = [];
  const replies = [];
  const create = async ({ sessionManager, sessionStartEvent }) => {
    const settingsManager = SettingsManager.inMemory({compaction:{enabled:false}});
    const resourceLoader = new DefaultResourceLoader({cwd:root,agentDir,settingsManager,
      noExtensions:true,noSkills:true,noThemes:true,noPromptTemplates:true,noContextFiles:true,
      additionalExtensionPaths:[path.join(root,'extensions/telegram/index.ts'),path.join(root,'extensions/observability/index.ts')]});
    await resourceLoader.reload({resolveProjectTrust:async()=>true});
    assert.deepEqual(resourceLoader.getExtensions().errors,[]);
    const result = await createAgentSession({cwd:root,agentDir,modelRuntime,settingsManager,resourceLoader,sessionManager,sessionStartEvent});
    return {...result,services:{agentDir,cwd:root},diagnostics:[]};
  };
  const initial = await create({sessionManager:SessionManager.create(root,path.join(agentDir,'sessions'))});
  host = new AgentSessionRuntime(initial.session,initial.services,create);
  const bind = async session => {
    await session.bindExtensions({mode:"rpc",onError:e=>errors.push(e),commandContextActions:{
    newSession:options=>host.newSession(options),waitForIdle:async()=>{},
    fork:()=>{throw new Error('Unexpected fork');},switchSession:()=>{throw new Error('Unexpected switch');},
    navigateTree:()=>{throw new Error('Unexpected navigation');},reload:()=>{throw new Error('Unexpected reload');},
  }});
    globalThis.__piTelegramDeliveryRuntime__ = { runtime: {
      generation: session.sessionId,
      shutdown() {},
      async sendView(view, options) {
        assert.equal(options.scope.kind, "instance");
        assert(view.text.includes(session.sessionId));
        replies.push(view.text);
        return {ok:true,value:{target:{chatId:123},messageIds:[1],generation:session.sessionId}};
      },
    }};
  };
  host.setRebindSession(bind);
  await bind(host.session);
  await host.session.prompt('/telegram-status');
  const command = () => globalThis.__piTelegramCommandRegistry__.commands.get('pi_new');
  assert.equal(command().showInMenu,true);
  assert.equal(globalThis.__piTelegramCommandRegistry__.commands.has("new"), false);
  assert.equal(globalThis.__piTelegramCommandRegistry__.commands.has("restart"), false);
  for (const name of ['pi_restart', 'pi_status', 'pi_logs', 'pi_model']) {
    assert.equal(globalThis.__piTelegramCommandRegistry__.commands.get(name)?.showInMenu, true);
  }

  let pollingCallbackDone = Promise.resolve();
  const originalNewSession = host.newSession.bind(host);
  host.newSession = async options => {
    await pollingCallbackDone;
    return originalNewSession(options);
  };
  const invoke = args => pollingCallbackDone = command().handler({args,name:'pi_new',reply:async t=>replies.push(t),enqueuePrompt:()=>{throw new Error('Must not prompt');}});
  async function waitForSwitch() {
    for (let n = 0; n < 200; n++) {
      if (replies.at(-1)?.startsWith("🆕 已新建会话")) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail("Session replacement did not finish");
  }
  const oldId=host.session.sessionId;
  host.session.sessionManager.appendMessage({role:'user',content:'OLD_HISTORY',timestamp:Date.now()});
  host.session.sessionManager.appendMessage({role:'assistant',content:[{type:'text',text:'OLD_REPLY'}],api:'openai-completions',provider:'fixture',model:'fixture',stopReason:'stop',timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
  const oldFile=host.session.sessionFile;
  await invoke('unexpected');assert.equal(host.session.sessionId,oldId);
  Object.defineProperty(host.session, "isIdle", {get:()=>false, configurable:true});
  await invoke('');assert.equal(host.session.sessionId,oldId);
  assert(replies.at(-1).includes('/stop'), JSON.stringify({replies,errors}));
  delete host.session.isIdle;
  await invoke('');
  assert.equal(host.session.sessionId, oldId);
  assert(replies.some(text => text.startsWith('🆕 正在新建会话')));
  await waitForSwitch();
  assert.notEqual(host.session.sessionId,oldId);
  assert.equal(host.session.messages.length,0);
  assert(host.session.sessionFile.includes("+08-00_"));
  assert(fs.readFileSync(oldFile,'utf8').includes('OLD_HISTORY'));
  const second=host.session.sessionId;
  replies.length = 0;
  await invoke('');
  await waitForSwitch();
  assert.notEqual(host.session.sessionId,second);
  assert.equal(host.session.messages.length,0);
  assert(host.session.sessionFile.includes("+08-00_"));
  assert.equal(fs.readdirSync(path.join(agentDir,'observability')).length,3);
  assert.deepEqual(errors,[]);
  console.log('PASS: menu registration, arguments, busy guard, two native session replacements, empty context, retained history, per-session observations; no network/model calls.');
} finally {host?.session.dispose();fs.rmSync(temp,{recursive:true,force:true});}
