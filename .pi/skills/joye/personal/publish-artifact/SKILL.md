---
name: publish-artifact
description: "The user's standard artifact pipeline — every report or output file becomes a styled HTML page, uploaded to Cloudflare R2, and delivered as a directly clickable https link (never raw file paths, never md attachments). Use for reports, research writeups, session exports, screenshots, and any shareable output. HTML is the default format; Markdown is converted automatically."
---

## 项目路径约定

- `.pi/`、`data/`、`tools/`、`references/`、`outputs/`、`.cache/`、`docs/` 和 `node_modules/` 开头的路径，相对于项目根目录；示例命令从项目根目录执行，除非明确说明先切换目录。
- 技能内部的 `scripts/`、`rules/`、`templates/`、`examples/` 等引用，相对于本 `SKILL.md` 所在目录，不要和项目根目录混淆。
- 配套脚本根据自身位置定位项目根目录，配置、缓存和默认输出留在项目内；不回退到全局目录。显式传入的相对文件参数仍按调用时的工作目录解释。

# Publish Artifact (report → HTML → R2 → link)

The user's fixed convention: **reports/artifacts default to HTML and are delivered as clickable links**. Use this pipeline for every output worth sharing.

## Pipeline (one command)

```bash
bash .pi/skills/joye/personal/publish-artifact/scripts/report.sh <file> [remote-key] [--title "T"]
```

- `.md` / `.txt` → auto-converted to a styled standalone HTML (marked, bundled in the skill)
- `.html` → uploaded as-is
- other files (png/pdf/zip…) → uploaded as artifacts
- Prints the public https link; reply to the user with a **clickable link**, e.g. `[报告标题](https://pub-xxx.r2.dev/...)` — in Telegram use Markdown link syntax so it's tappable.

## HTML-first rules (user preference)

- Generate reports as **HTML by default**, not Markdown — easier to share.
- **Mobile-first is mandatory** (2026-08-13): templates are responsive — wide tables get wrapped in a scrollable `.table-wrap` (never squish the page), body is 16px with safe-area padding on phones. Verify at 375px viewport before delivering: `document.body.scrollWidth <= innerWidth` must hold and every `table` must sit inside a `.table-wrap`.
- Chat/session export to HTML: `PI_CODING_AGENT_DIR="$PWD/.pi/agent" node_modules/.bin/pi --export <session-file> <out.html>` (sessions are JSONL under `.pi/agent/sessions/`), then upload via report.sh.
- Always keep a local copy (`outputs/YYYY-MM-DD/` or next to the source) before/after uploading.

## Setup (done)

- Credentials: `.pi/agent/config/r2-upload/env` (0600): R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET / R2_PUBLIC_BASE
- rclone --config .pi/agent/config/rclone/rclone.conf installed; auth via env vars (no conf file needed)
- Converters: `scripts/convert-md.js` (marked bundled), `scripts/publish.sh` (upload+link), `scripts/report.sh` (one-shot pipeline)

## Troubleshooting

- Browse the bucket anytime (standard rclone --config .pi/agent/config/rclone/rclone.conf conf at `.pi/agent/config/rclone/rclone.conf`, works in any shell):
  - `rclone --config .pi/agent/config/rclone/rclone.conf lsf r2:joye-agent` — list files (recursive: `lsf --recursive` or `lsl`)
  - `rclone --config .pi/agent/config/rclone/rclone.conf size r2:joye-agent` — total size
  - `rclone --config .pi/agent/config/rclone/rclone.conf delete r2:joye-agent/<path>` — delete
  - `rclone --config .pi/agent/config/rclone/rclone.conf copy <local> r2:joye-agent/<path>` — upload
  - `rclone --config .pi/agent/config/rclone/rclone.conf copy r2:joye-agent/<path> <local>` — download
- "Credential access key has length 53" → the value is a Cloudflare API token, not an R2 S3 access key; get the 32-char key from R2 → Manage R2 API Tokens.
- Link 403s → bucket has no Public access enabled (Settings → Public access → Public bucket, or bind a custom domain).
- Never print secrets; read only from the env file.
