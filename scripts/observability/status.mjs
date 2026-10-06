import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const base = path.join(root, ".pi/agent/observability");
const files = fs.existsSync(base) ? fs.readdirSync(base)
  .filter(name => name.endsWith(".jsonl"))
  .map(name => path.join(base, name))
  .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs) : [];

if (!files.length) {
  console.log("暂无观测记录。通过 ./start.sh 启动新版入口后生成；既有进程不会自动加载新增扩展。");
} else {
  let state = {};
  const lines = readline.createInterface({ input: fs.createReadStream(files[0]), crlfDelay: Infinity });
  for await (const line of lines) {
    try { const entry = JSON.parse(line); if (entry.state) state = entry.state; } catch {}
  }
  let running = false;
  try { process.kill(state.pid, 0); running = true; } catch {}
  console.log(JSON.stringify({ ...state, processExists: running, recordFile: files[0] }, null, 2));
}
