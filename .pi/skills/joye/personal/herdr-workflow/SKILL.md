---
name: herdr-workflow
description: "The user's preferred herdr workflow for project coding tasks: register requirements, prepare a handoff, dispatch through the project Herdr, inspect results and independently verify. Ordinary questions do not need it."
---

## 项目路径约定

- `.pi/`、`data/`、`tools/`、`references/`、`outputs/`、`.cache/`、`docs/` 和 `node_modules/` 开头的路径，相对于项目根目录；示例命令从项目根目录执行，除非明确说明先切换目录。
- 技能内部的 `scripts/`、`rules/`、`templates/`、`examples/` 等引用，相对于本 `SKILL.md` 所在目录，不要和项目根目录混淆。
- 配套脚本根据自身位置定位项目根目录，配置、缓存和默认输出留在项目内；不回退到全局目录。显式传入的相对文件参数仍按调用时的工作目录解释。

## 本项目当前阶段与路径适配

本文件是已有 Joye Skill 的项目副本；以下适配用户指定的本地目录、长期会话和文件交接，后面的原工作流保留参考。

- 操作前读取 [项目边界](../../../../../plan.md)。用户已授权接通登记到真实 Coding Agent；明确要求“先准备／先不执行”的任务仍停在 prepare。普通问答和联网查询保持前台。已接入后台自动回传、独立验收、真实 TG 通知、watchdog 和项目常驻恢复；提交、合并、推送与关闭终端仍不自动执行。
- 不新建模型工具，通过已有 `bash` 调用 `.pi/extensions/background/tasks/task_protocol.py`。先执行 `inspect`，按 `registry.projects` 中的项目名称查目录；用户日常说“test 项目”即可，不要求用户输入完整路径。不替未知项目猜目录，不实现用户任务代码。
- 每次 bash 单独调用一个 task_protocol.py 操作，检查返回后再调用下一步；prepare/start-run/run 不是 register 的参数，不能直接拼到同一命令末尾。
- inspect 保持 Joye 的完整落盘/CLI 协议；输出给模型时用 Python/jq 提取当前项目绑定、任务 ID/status/run_id、task_hashes 与 handoff_checks，不把全表的 runs/worktree_baseline/outbox 反复输出。验收需求从当前 spec 读取，执行结果使用有界 result。
- 登记沿用 `register TASK --spec PRIVATE_JSON`。私有 JSON 需要 `projectId`、`instruction`、`scope`、`acceptance`、`artifacts`；ID 由 TASK 指定。允许修改范围与产物使用相对 worktree 路径，需求不足时先问清楚。
- 原话由扩展保存到当前 Pi session 的非上下文条目，脚本通过 Pi 自带的 `PI_SESSION_ID` / `PI_SESSION_FILE` 读取。模型不要填写、改写或从 instruction 补造 `originalRequest`。目前只支持单条纯文本；首次登记前跨多轮澄清未支持完整合并，应说明限制，不能声称原话完整。
- 登记后的需求补充沿用 `update TASK --delta PRIVATE_JSON --expected-hash HASH`；HASH 从最新 `inspect.task_hashes` 获取。delta 只包含需要修改的 instruction/scope/acceptance/artifacts，原始原话保持不变，补充原话自动留存。
- `prepare TASK` 生成 spec.json 和 prompt.md 后，再 inspect 核对 `handoff_checks`；`preflight.dispatchEnabled` 为 true 才可进入执行。文件放在 `.pi/agent/background/tasks/TASK/`，不要直接覆盖 registry。尚未绑定的项目先报告，不私自新建替代 Agent。
- 用户要求实际完成项目任务时，继续 `start-run TASK --run-id RUN`，再 `run TASK RUN`。前者沿用已登记任务并校验原话、修订和交接 hash，后者快速返回 Herdr 收据；模型不要直接写项目代码、直接控制 Herdr 或在当前回合等待 worker。监督程序在项目 Herdr 的真实 Shell 环境运行。
- 收据只表示启动命令被 Herdr 接受，不等于 Codex 已收到或做好。告知用户 task/run ID 和验收标准，后台事件会自动触发独立验收，用户也可以随后查询 `result TASK RUN`；不能在当前回合 sleep 或反复轮询。
- 查询 `result TASK RUN` 得到有界摘要、状态和证据路径；只按验收需要读取具体文件，不能将完整 worker 对话、终端日志或 diff 塞回主 Pi。ready_for_review 后按 acceptance 实查，写私有检查证据，再 `verify TASK RUN --evidence FILE`；失败加 `--reject`。未核查不能说已验收。
- 读取源码或测试前，先在当前任务允许的目录列出实际文件名，或核对本 run 业务结果中的实际产物；只读取已确认存在的路径。修改阶段不要求创建新测试文件，可能直接补在原测试文件内，不能根据“新机制”猜出 test_mechanisms.py 等名字。
- 项目绑定和长期 worktree 是用户指定的本版适配：`project-register PROJECT --spec PRIVATE_JSON`、`worktree-ensure PROJECT --base BASE`。先查询已有绑定；保持同项目目录、分支和未来固定 session，保留已有修改。
- 当前 spec/delta 临时文件放 `.cache/tmp/background/`；沿用文件交接，不把需求正文拼到命令参数。引用本文脚本的命令从项目根目录执行。需要隔离验证时，将 `--root PRIVATE_DIR` 放在子命令之前。

查询使用下面已核对的多行 Python 例子；第二个参数换成当前明确授权的登记根目录，保留已有 inspect 协议。不要另拼复杂的一行字典，也不要安装 jq。它只显示项目身份、任务当前状态、交接 hash 与检查，不把完整 runs/worktree_baseline/outbox 注入主 Pi。

```bash
python3 - .pi/agent/background <<'PY'
import json
import subprocess
import sys

payload = json.loads(subprocess.check_output([
    sys.executable,
    ".pi/extensions/background/tasks/task_protocol.py",
    "--root",
    sys.argv[1],
    "inspect",
], text=True))
registry = payload["registry"]
projects = {}
for key, value in registry["projects"].items():
    projects[key] = {
        field: value.get(field)
        for field in ("projectId", "sourcePath", "worktreePath", "branch", "agentKind", "sessionId", "herdr", "activeExecution")
    }
tasks = {}
for key, value in registry["tasks"].items():
    tasks[key] = {
        field: value.get(field)
        for field in ("taskId", "projectId", "status", "run_id", "specHash", "promptHash")
    }
print(json.dumps({
    "registry": {
        "projects": projects,
        "tasks": tasks,
    },
    "task_hashes": payload.get("task_hashes"),
    "handoff_checks": payload.get("handoff_checks"),
}, ensure_ascii=False))
PY
```


# herdr Workflow（Joye 经验与本项目适配）

本项目执行以上文件 CLI 流程。下文的直接 Herdr 操作、其他 Agent 权限、模型和发布偏好是 Joye 历史参考，不是本项目用户授权；不据此启动其他 Agent、切换模型、关闭终端或上传资料。

- `run` 返回收据后立即回复，后台结果会经 outbox → inbox 唤醒主 Pi，自动验收后主动发送 TG；不需要前台长轮询。内部状态事件不是新的用户需求，不登记新任务，不自行发送 TG；结果接力扩展负责准备正文、真实 API 投递、report 和 ack。
- 用户取消时，调用 `cancel TASK RUN`，核对实际返回才说已取消。它只中断匹配项目与原生输入的当前任务，保留永久 session 和历史文件；状态不明保持占用。前台 `/abort` 不等于后台取消。
- ESC 后 idle 不等于命令子进程退出；取消凭据必须包含真实派发前基线与 child_cleanup，不能手工清空 activeExecution。缺少身份或旧 run 基线时保留现场。
- 用户明确要求重试失败任务时调用 `retry TASK`，重新 prepare、核对 hash、start-run 新 RUN、run。最多两次，不重用旧 RUN；未知发送先对账，不能盲目重发。
- 投递结果为 sending/unknown 或 inbox attention_required=delivery_unknown 时不能自动重发；新用户消息、分支变化和租约到期不代表首次未发送。
- 验收 JSON 必须匹配 task_id/run_id/passed/checks，记录实际检查；不能只复制 worker 的检查摘要。完整 worker 对话、终端日志和 diff 不回灌主 Pi。

## 0. 兜底规则（fallback rule）

本副本保留 Joye 工作流经验。`.pi/skills/joye/personal/herdr-official/SKILL.md` 是其保存的 0.8.2 参考；本项目实际安装 0.9.3，命令语法以项目 `scripts/startup/herdr.sh <cmd> --help` 为准。

- **本 skill 没覆盖的情况**（新命令、报错、行为异常、生命周期状态不明确等）→ 读官方 skill，或直接查 `scripts/startup/herdr.sh <cmd> --help`（CLI 是命令语法权威）。
- 官方 skill 的补充要点（本 skill 未写）：
  - agent 生命周期：`idle`=就绪、`done`=后台工作完成后的 idle、`blocked`=审批/提问 UI、`unknown`=无法分类（不代表完成）
  - `agent prompt` 从非工作状态发指令，5 秒内必须看到生命周期变化，否则返回 `agent_prompt_stalled`
  - `--until` 仅用于状态特定等待（如等 blocked）；普通等待用 `--wait` 即可
  - `agent send-keys <name> esc|ctrl+c` 逻辑键控
  - `pane run` / `pane wait-output --match` 用于普通命令 + 等输出
  - read source：`visible` / `recent` / `recent-unwrapped`（日志/转录优先）/ `detection`
  - 安全：`--no-focus` 后台工作；不关自己没建的 workspace/pane；不 kill herdr 主进程；`herdr server stop` 只在用户明确要求时用

## 1. Joye 历史参考：创建 workspace/worktree（前台不直接执行）

```bash
WS=$(herdr worktree create --cwd "$PWD" \
       --branch fix/some-bug --base main \
       --label "P1 some-bug" --no-focus \
     | jq -r '.result.workspace.workspace_id')

PANE=$(herdr pane list --workspace "$WS" | jq -r '.result.panes[0].pane_id')
```

- `--branch <name> --base <base>` for real code work (git worktree isolation).
- For read-only research/scratch use plain `herdr workspace create --cwd "$PWD" --label "..." --no-focus` (no worktree — research produces no git changes).

## 2. Joye 历史参考：启动 Agent（本项目由已登记配置控制）

```bash
until herdr agent start some-bug --kind claude --pane "$PANE" --timeout 90000 2>/dev/null; do sleep 1; done
```

- Model goes **after `--`**: `-- --model claude-opus-5`
- **Joye 的 Claude auto mode 经验**（其 2026-08-18 默认值；本项目尚未接入 Claude）: append `--permission-mode auto` after `--`, e.g. `-- --model claude-opus-5 --permission-mode auto`. Auto mode lets claude auto-run lower-risk commands without blocking (verified: runs commands, creates files, zero prompts). Without it, in-pane claude sits on manual mode and blocks on every permission prompt — you'd have to babysit approvals.
- **Joye 的 Codex full access mode 经验（其 2026-08-29 设置，不能当成本项目授权）**: append `--dangerously-bypass-approvals-and-sandbox` after `--`, e.g. `-- --model gpt-5.6-sol -c model_reasoning_effort='"xhigh"' --dangerously-bypass-approvals-and-sandbox`。不带它 codex 会每条命令弹批准，后台任务直接卡死（2026-08-28 教训：忘带这个参数导致被迫写轮询+白名单自动批脚本打补丁）。配套原则：等待用 herdr 内置阻塞 wait（`herdr agent wait <name> --until done` / `agent prompt --wait`），不要手写轮询循环。
  - 启动时仍会有项目信任确认（"Do you trust the contents"）→ 发 `1` + Enter 一次
  - First run asks "Make auto mode your default permission mode?" → answer Yes (option 1) once; it persists.
  - Also handles the project trust prompt at startup: send `1` + Enter once when it asks "Is this a project you created or one you trust?"
  - Alternative for tighter control: `--permission-mode acceptEdits` (auto-accepts edits, still asks for risky bash) or `--settings <file>` with a `permissions.allow` list.
- `--timeout 90000` (90s) for startup.
- **Agent name is global per terminal**: if `agent start claude` fails with `agent_name_taken`, another agent in that terminal already uses the name — use a unique `<NAME>` (e.g. `dash-react`) instead of the default.
- **READ THE SKILL FIRST**: before driving herdr, read this skill (and memory) — don't rely on recollection of the workflow.

## 3. Joye 历史参考：从文件派发（本项目由 runner 参数数组发送）

```bash
herdr agent prompt some-bug "$(cat prompts/some-bug.txt)" --wait --timeout 900000
```

- Inline prompts lose Chinese quotes, backticks, newlines to shell quoting.
- Wait a few seconds after `agent start` before prompting — claude may still be on its welcome screen and the prompt gets dropped (check terminal_title changes to the task title as confirmation it was received).
- Ask for a completion marker in the prompt ("print exactly DONE_XXX at the end").

## 4. Joye 历史参考：读取与关闭（本项目永久 session 不自动关闭）

```bash
herdr agent read <name> --source recent-unwrapped --lines 200
herdr pane close <pane_id>   # only panes/workspaces you created
herdr workspace close <ws>   # after user is done with it
```

## 5. Multi-stage relay tasks (自动接力，不靠盯梢)

> 2026-08-20 教训：trajectory-panel v2 完成后 workspace 闲置 3 小时，v3 直到用户问起才开始。根因：`--wait` 被 abort 后误判“还在跑”，没轮询状态也没检测完成标记。**多阶段接力必须脚本化自动触发，不能靠 agent 人工盯梢。**

### 方式 A：有证据的阶段接力

终端可能回显 prompt 中的 DONE，不能 grep 命中就宣告成功。使用下节统一 runner：核对当前 task/run 的退出码、实际 stdout 独立 marker 行、新产物及业务 reason/error；需要验收时，主 agent 验收后才继续已授权阶段。

- herdr wait、agent_status=done 或 pane 命中仅为观察，不等于目标完成。
- 未接入 runner 的历史任务保留 needs_reconciliation，禁止猜测退出码。
- 等待只在后台 relay 中进行，不能在当前回合 sleep 长轮询。

### 方式 B：多阶段合并成一个连续任务

把 v1+v2+v3 的完整需求写进**一个 prompt**，让一个 agent 一口气做完，只打一个最终 `DONE_XXX`。适合阶段间耦合紧、中途不需人工确认的任务。缺点是单次运行时间长、中途不能插入新需求。

### 方式 C：herdr 内置 wait（无人值守时，2026-08-23 修正）

**不需要手写轮询脚本** —— herdr 内置了完整的等待机制：

```bash
# 后台跑一个接力脚本，每阶段用 herdr 内置 wait 等完成，跑完才退出
cat > .cache/tmp/herdr/relay.sh << 'EOF'
herdr agent wait <name> --until done --timeout 1800000   # 仅等待状态，不证明业务成功
# 按下节核对当前 run 的 result 和 acceptance；通过后才继续下一阶段。
EOF
nohup bash .cache/tmp/herdr/relay.sh > .cache/tmp/herdr/relay.log 2>&1 &
```

关键点：
- `agent prompt --wait` / `agent wait` 本身就等到 settled 状态（idle/done/blocked）才返回，**无需轮询**
- 等特定输出用 `herdr pane wait-output <pane> --match "DONE_XXX" --timeout <ms>`
- `--wait` 被 bash 工具 timeout 截断 ≠ 任务没在跑 —— 把带 `--wait` 的命令放后台（nohup）跑，完成读日志即可
- 多阶段都写进一个脚本，最后一步完成后可加通知（如 notify-telegram.py）

### 铁律

- 承诺“我收尾/我盯着”必须伴随实际保障机制（herdr 内置 wait/接力脚本），否则不说
- `--wait` 被 abort ≠ 任务没在跑，先查 `herdr agent get <name>` 的 `agent_status` 再判断
- 阶段完成标准 = 当前 run 的退出码 + 实际 stdout 标记 + 新产物 + 业务结果；prompt 回显和时间经过均不算证据

## 6. 后台任务协议（task/run + 验收 + 真实签收，2026-09-08 已激活）

后台任务 = subagent 模式：我是 orchestrator，herdr workspace 是 worker subagent，我是质量验收闸门。用户默认只听到「做完了」和需要拍板的事。

### 任务分类（接到任务先判断，前台 or 后台）

- **前台**：普通问答、即时联网查询、需求澄清和有界验收；项目代码交给已绑定后台，不因改动小就代写。
- **后台**：能独立完成、有明确验收标准的活（改代码/跑调研/做报告/长任务烧 token）。
- 判断不了就默认前台，或一句话向用户确认；用户说「放后台」/「前台做」优先。

### 登记与统一 runner（所有后台活，不另立账）

- 派活确认消息仍必须带 acceptance 给用户过目；后台默认 herdr subagent，用户只需一个主 agent 入口。本协议不授权新 workspace、模型测试、拓扑或模型默认值变更。
- 本项目私有目录 `.pi/agent/background/` 保存登记、交接稿、runs 和内部 outbox；inbox、主动通知和真实签收由 `.pi/extensions/background/notifications/` 接入。**这些是持久证据，不得说损坏可丢弃**。status 是观察结果，不能直接改成完成。
- `python3 .pi/extensions/background/tasks/task_protocol.py register TASK --spec PRIVATE_JSON`：当前 spec 字段见本文的项目适配；Joye 原版的 done_marker/type/route 和 agent_name/workspace_id/pane_id 属于后续执行阶段，当前不填。
- 本项目每次执行先 `start-run TASK --run-id RUN`，再 `run TASK RUN`；不向 run 追加任意命令，实际 runner 与 Herdr 目标从项目绑定读取。worker 从 TASK_ID/TASK_RUN_ID/TASK_RESULT_PATH 取身份，写匹配的 business JSON（reason/error），实际 stdout 打印独立 marker 行。
- `result TASK RUN` 核对退出码、PID 出生身份、产物 size/mtime/hash/freshness、marker、reason/error。goal_complete 与 batch_finished 分开；空/旧产物、缺标记、预算边界、read_error/http_error 都不证明成功。
- 禁止直接覆盖 registry；所有 writer 走协议锁和原子操作。元数据修改使用带 expected-hash 的 update；flock 不会保护不守锁的旧 writer。

### 状态与独立验收

- **ready_for_review ≠ 做好**。收到 task/run/event 先 inspect 对账，读当前 run 结构化结果，再按 acceptance 实查，不能只复述 worker 或回复收到。
- Herdr 状态从实际 `result.agent.agent_status` 读取；working 保持运行态，未知/查询错误只保留观察。终端 done 或 prompt 回显不能补造 runner 退出码。
- 通过：`verify TASK RUN --evidence FILE`；失败加 `--reject`。最多返工两次，第二次仍失败就升级用户，不无限开跑。
- 验收通过仅执行已经授权的后续步骤。接力扩展负责 prepare-report 绑定正文/目标/验收以及发送后的 report；模型不自行发送或签收。没有真实匹配 message_id、结果 unknown 或无签收，不得标 reported。
- claim/ack 由接力扩展处理，模型不调用；enqueued 只代表注入尝试，不等于 handled/verified。身份变化按持久证据对账。

### 通知三层保障与边界

1. **推送**：结构化 runner 结果与稳定 task/run/phase outbox 同事务提交；notify-agent 使用 --task-id/--run-id/--event-id/--result-path/--route。同事件双生产幂等，不同 run 不吞。
2. **拉取**：主 agent 接续时现场 inspect，检查结果、claim/lease、验收和真实签收。
3. **兜底**：Joye 原版通过 launchd 每 180 秒对账；本项目由 execution/service.py 每 5 秒巡检并在空闲时由 relay 补扫，独立重试 agent/Telegram 两个目标；超时生成稳定提醒，不假装目标完成。无 owner/持续错误时不能保证一个周期内送达。

- 用户直达 Telegram 兜底默认保留，不擅自关；待验收与已验收明确区分。失败 backoff，未知 ACK 人工对账，绝不盲重发。
- Joye 原 relay 识别 run-pi.sh；本项目 relay 仅向由 scripts/startup/telegram.mjs 启动且实际拥有对应 profile/session 的主 Pi 注入，宿主及队列均须 idle；无 owner 留 pending。当前 getBranch 持久输入支持去重，旧分支不能抑制新分支。原 handling deadline 后一次稳定恢复提示，仍无证明则 needs_attention，不无限续租。
- 跨进程崩溃恢复采用至少一次注入 + 幂等对账，不承诺 exactly-once。未发送的过时 run/阶段通知可 superseded，已在发送或 unknown 的不确定性必须保留。
- notify-agent 旧 `TEXT [SOURCE]` 与 `queued DIGITS-DIGITS.json` 兼容，该字符串只是私有 inbox 签收映射，不再是旧 spool 文件。旧调用方忽略退出码/源业务提前标 seen 的问题不能靠 CLI 兼容自动修复。
- 旧任务缺少有效 runs metadata 时不批量宣告成功/失败、不重放历史通知，保留证据再核查。本项目没有 adopt-legacy/close-legacy/import-legacy 命令，不能照搬 Joye 未接入的历史迁移接口。

本项目实际 CLI、签收和恢复边界见 [后台实现说明](../../../../extensions/background/README.md)。Joye 原 docs/delivery-watchdog-fix.md 仅作历史参考，不能直接套用其 core patch 或未接入接口。主 Pi 负责独立验收和本次已经授权的交付；未经用户请求不提交、上线或发布。

## Joye 历史参考：Artifact convention（不自动发布）

- Joye 原偏好为 HTML/HTTPS 交付。本项目按用户指定保留 Markdown/私有证据；只有用户明确要求分享或发布时才检查并调用发布流程。
- One-shot pipeline: `bash .pi/skills/joye/personal/publish-artifact/scripts/report.sh <file> [--title T]` (md → styled HTML → R2 upload → prints link). Reply with `[label](link)` Markdown links in Telegram.
- 用户明确要求分享会话时可导出 HTML；使用项目 `start.sh --export`，先检查隐私范围，不调用全局 pi。
- Local copies always kept in `outputs/YYYY-MM-DD/` (or alongside the report) before/after upload.
