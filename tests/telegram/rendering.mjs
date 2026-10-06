// Telegram 中文格式回归：验证历史回复、粗斜体边界、代码与链接；关联 patches/telegram-rendering/patch.mjs。
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(resolve(root, "node_modules/@earendil-works/pi-coding-agent/package.json"));
const { createJiti } = await import(require.resolve("jiti"));
const jiti = createJiti(import.meta.url, { fsCache: false });
const rendering = await jiti.import(resolve(root, ".pi/npm/node_modules/@llblab/pi-telegram/lib/rendering.ts"));
const cases = [
  ["是一所**公办、省属全日制普通本科院校**，以培养应用型人才为主。", "是一所<b>公办、省属全日制普通本科院校</b>，以培养应用型人才为主。"],
  ["我指**许昌学院（Xuchang University）**。", "我指<b>许昌学院（Xuchang University）</b>。"],
  ["一个**让 AI 更会讲解的技能包**", "一个<b>让 AI 更会讲解的技能包</b>"],
  ["**粗体**后跟汉字", "<b>粗体</b>后跟汉字"],
  ["中文*斜体*后面", "中文<i>斜体</i>后面"],
  ["**正常粗体** *正常斜体*", "<b>正常粗体</b> <i>正常斜体</i>"],
  ["***粗斜体***", "<b><i>粗斜体</i></b>"],
  ["**粗体含*斜体*内容**", "<b>粗体含<i>斜体</i>内容</b>"],
  ["**未闭合*", "**未闭合*"],
  ["*未闭合**", "*未闭合**"],
  ["**未闭合", "**未闭合"],
  ["a**word**b foo_bar_baz", "a**word**b foo_bar_baz"],
  ["2 * 3 = 6", "2 * 3 = 6"],
  ["`**代码中的星号**`", "<code>**代码中的星号**</code>"],
  ["[**学校**](https://example.com/a_b)", '<a href="https://example.com/a_b">学校</a>'],
  [String.raw`\*字面星号\*`, "*字面星号*"],
  ["<文字> & **加粗**", "&lt;文字&gt; &amp; <b>加粗</b>"],
];
for (const [input, expected] of cases) {
  assert.deepEqual(rendering.renderTelegramMessage(input, { mode: "markdown" }), [
    { text: expected, parseMode: "HTML" },
  ], input);
}
const patchFile = resolve(root, "patches/telegram-rendering/patch.mjs");
const target = resolve(root, ".pi/npm/node_modules/@llblab/pi-telegram/lib/rendering.ts");
const before = readFileSync(target, "utf8");
execFileSync(process.execPath, [patchFile], { cwd: root });
execFileSync(process.execPath, [patchFile, "--check"], { cwd: root });
assert.equal(readFileSync(target, "utf8"), before, "Reapplying the patch must not change source");
const result = {
  at: new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(" ", "T") + "+08:00",
  status: "passed",
  cases: cases.length,
  patchIdempotent: true,
  telegramDeliveryTested: false,
};
writeFileSync(resolve(root, ".pi/agent/logs/observability/telegram-rendering-verification.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
console.log(`Telegram rendering: ${cases.length} cases passed`);
