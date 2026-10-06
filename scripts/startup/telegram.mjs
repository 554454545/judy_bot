// TG 与后台常驻入口：保持 Pi RPC 输入、连接 personal 并启动 background/execution/service.py；退出交给既有 Windows 登录任务恢复。
// 关联：../../start.sh 加载项目 Pi 和扩展；windows.ps1 提供 Windows/WSL 常驻入口。
// 边界：仅启动本项目；沿用最近 session 和默认模型；不记录 RPC 消息正文，不操作其他 Pi。
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, openSync, closeSync, readFileSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const logDir = resolve(root, '.pi/agent/logs/startup');
process.umask(0o077);
mkdirSync(logDir, { recursive: true, mode: 0o700 });
const errorLog = openSync(resolve(logDir, 'stderr.log'), 'a', 0o600);
// Windows 的 localhost 代理在 WSL NAT 中使用默认网关；只修改本项目子进程环境。
const childEnv = {
  ...process.env,
  PATH: [dirname(process.execPath), resolve(homedir(), '.local/bin'), process.env.PATH ?? ''].join(':'),
};
childEnv.PYTHONDONTWRITEBYTECODE = '1';
childEnv.TMPDIR = resolve(root, '.cache/tmp/background');
mkdirSync(childEnv.TMPDIR, { recursive: true, mode: 0o700 });
const proxy = childEnv.HTTPS_PROXY || childEnv.https_proxy || childEnv.HTTP_PROXY || childEnv.http_proxy;
if (proxy) {
  const endpoint = new URL(proxy);
  if (["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)) {
    const route = readFileSync('/proc/net/route', 'utf8').split('\n')
      .map(line => line.trim().split(/\s+/))
      .find(fields => fields[1] === '00000000' && /^[0-9A-Fa-f]{8}$/.test(fields[2] ?? ''));
    if (!route) {
      throw new Error('Windows proxy configured, but WSL default gateway is unavailable');
    }
    endpoint.hostname = route[2].match(/../g).reverse().map(byte => parseInt(byte, 16)).join('.');
  }
  childEnv.HTTP_PROXY = endpoint.href;
  childEnv.HTTPS_PROXY = endpoint.href;
  childEnv.http_proxy = endpoint.href;
  childEnv.https_proxy = endpoint.href;
  // Node 22.23 支持原生环境代理；TG 使用 fetch，避免失败后绕过代理直连。
  childEnv.NODE_USE_ENV_PROXY = '1';
  childEnv.PI_TELEGRAM_NETWORK_FAMILY = 'auto';
}
const child = spawn(resolve(root, 'start.sh'), ['--mode', 'rpc', '--continue'], {
  cwd: root,
  env: childEnv,
  stdio: ['pipe', 'pipe', errorLog],
});
// 后台服务与 TG 共用既有 Windows/WSL 入口；服务有项目内 flock，重复启动不重复创建 Agent。
let stopping = false;
let background;
let backgroundRestart;
let backgroundFailures = 0;
let backgroundHealth;
const stamp = () => new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium',
}).format(new Date()) + '+08:00';
const status = (message) => console.log(`${stamp()} ${message}`);
function startBackground() {
  backgroundRestart = undefined;
  if (stopping || child.exitCode !== null || child.signalCode !== null) return;
  const descriptor = openSync(resolve(logDir, 'stderr.log'), 'a', 0o600);
  const instance = spawn('python3', [resolve(root, '.pi/extensions/background/execution/service.py')], {
    cwd: root,
    env: childEnv,
    stdio: ['ignore', descriptor, descriptor],
  });
  closeSync(descriptor);
  background = instance;
  instance.on('error', () => status('项目后台服务启动失败，详情见后台 service 日志'));
  instance.on('close', code => {
    if (stopping || background !== instance) return;
    // 独立的 75 表示已有本项目服务；正常但非预期的退出同样需要恢复。
    if (code === 75) return;
    backgroundFailures += 1;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(backgroundFailures, 5));
    status(`项目后台服务异常退出，${delay / 1000}s 后重启；Herdr 和原会话保留`);
    backgroundRestart = setTimeout(startBackground, delay);
  });
}
closeSync(errorLog);
startBackground();
backgroundHealth = setInterval(() => {
  if (stopping || backgroundRestart || (background?.exitCode === null && background?.signalCode === null)) return;
  try {
    const identity = JSON.parse(readFileSync(resolve(root, '.pi/agent/background/service-pid.json'), 'utf8')).identity;
    const stat = readFileSync(`/proc/${identity.pid}/stat`, 'utf8').split(')').at(-1).trim().split(/\s+/);
    const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const command = readFileSync(`/proc/${identity.pid}/cmdline`, 'utf8').split('\0');
    if (stat[0] !== 'Z' && Number(stat[19]) === identity.start_ticks && boot === identity.boot_id && command.includes(resolve(root, '.pi/extensions/background/execution/service.py'))) return;
  } catch {}
  startBackground();
}, 5000);
const timeout = setTimeout(() => {
  status('Telegram 连接超时，退出以便服务重试');
  child.kill('SIGTERM');
}, 90000);
const lines = createInterface({ input: child.stdout });
lines.on('line', (line) => {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  if (event.id !== 'startup-connect' || event.type !== 'response') {
    return;
  }
  clearTimeout(timeout);
  if (event.success) {
    status('Telegram 连接命令完成');
  } else {
    status('Telegram 连接失败，退出以便服务重试；详情见 stderr.log');
    child.kill('SIGTERM');
  }
});
child.on('spawn', () => {
  child.stdin.write(JSON.stringify({
    id: 'startup-connect',
    type: 'prompt',
    message: '/telegram-connect personal',
  }) + '\n');
});
child.stdin.on('error', () => {
  status('Pi 输入管道关闭');
});
child.on('error', (error) => {
  clearTimeout(timeout);
  status(`Pi 启动失败：${error.code ?? 'unknown'}`);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  const requestedStop = stopping;
  stopping = true;
  clearInterval(backgroundHealth);
  clearTimeout(backgroundRestart);
  background?.kill('SIGTERM');
  clearTimeout(timeout);
  lines.close();
  status(`Pi 已退出，退出码 ${code ?? 'signal'}`);
  process.exitCode = requestedStop ? 0 : (code || 1);
});
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    stopping = true;
    clearInterval(backgroundHealth);
    clearTimeout(backgroundRestart);
    clearTimeout(timeout);
    child.kill(signal);
    background?.kill(signal);
  });
}
