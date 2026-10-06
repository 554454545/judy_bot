// Telegram 中文格式补丁：修正粗体边界和星号误解析；关联 start.sh、tests/telegram/rendering.mjs。
// 仅适配项目 pi-telegram 0.27.12；全文件校验、幂等应用，未知源码拒绝覆盖。
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const patch = {
  "path": ".pi/npm/node_modules/@llblab/pi-telegram/lib/rendering.ts",
  "beforeHash": "0e1f637dfd1595d86aad4cb71a134c4aceee201aa2942e7096953dfee88b5b97",
  "afterHash": "9c6b4660da4b8f775451035a8ead95b4a1b53e06204b5496fb758165c717a312",
  "beforeText": "  const escapedDelimiter = delimiter.replace(/[.*+?^${}()|[\\]\\\\]/g, \"\\\\$&\");\n  const pattern = new RegExp(\n    `(^|[^\\\\p{L}\\\\p{N}\\\\\\\\])(${escapedDelimiter})(?=\\\\S)([\\\\s\\\\S]+?)(?<=\\\\S)\\\\2(?=[^\\\\p{L}\\\\p{N}]|$)`,\n    \"gu\",\n  );\n",
  "afterText": "  const escapedDelimiter = delimiter.replace(/[.*+?^${}()|[\\]\\\\]/g, \"\\\\$&\");\n  const marker = delimiter[0];\n  const escapedMarker = marker.replace(/[.*+?^${}()|[\\]\\\\]/g, \"\\\\$&\");\n  // 汉字可紧邻星号；保留英文单词与下划线原有的边界约束。\n  const cjkBoundary = marker === \"*\" ? \"\\\\p{Script=Han}|\" : \"\";\n  const leftBoundary = `(^|${cjkBoundary}[^\\\\p{L}\\\\p{N}\\\\\\\\${escapedMarker}])`;\n  const rightBoundary = `(?=${cjkBoundary}[^\\\\p{L}\\\\p{N}${escapedMarker}]|$)`;\n  // 分隔符必须是完整的一组，单星号不能吃掉双星号或未闭合的粗体。\n  const pattern = new RegExp(\n    `${leftBoundary}(${escapedDelimiter})(?!${escapedMarker})(?=\\\\S)([\\\\s\\\\S]+?)(?<=\\\\S)(?<!${escapedMarker})\\\\2(?!${escapedMarker})${rightBoundary}`,\n    \"gu\",\n  );\n"
};
const digest = text => createHash("sha256").update(text).digest("hex");
const versionPath = resolve(root, ".pi/npm/node_modules/@llblab/pi-telegram/package.json");
if (JSON.parse(readFileSync(versionPath, "utf8")).version !== "0.27.12") {
  throw new Error("Telegram rendering patch version mismatch");
}
const target = resolve(root, patch.path);
const source = readFileSync(target, "utf8");
const hash = digest(source);
const check = process.argv.includes("--check");
if (hash !== patch.beforeHash && hash !== patch.afterHash) {
  throw new Error(`Telegram rendering patch source mismatch: ${patch.path}`);
}
if (check && hash !== patch.afterHash) {
  throw new Error("Telegram rendering patch missing; run node patches/telegram-rendering/patch.mjs");
}
if (!check && hash === patch.beforeHash) {
  const changed = source.replace(patch.beforeText, () => patch.afterText);
  if (digest(changed) !== patch.afterHash) {
    throw new Error("Telegram rendering patch output verification failed");
  }
  const temporary = `${target}.rendering-patch.tmp`;
  writeFileSync(temporary, changed, { mode: 0o600 });
  renameSync(temporary, target);
}
console.log(`Telegram rendering patch: ${check ? "verified" : "applied"}`);
