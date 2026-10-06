---
name: favorites
description: "收藏夹（统一收藏夹，原名 reading 素材库）：维护 data/favorites/favorites.json 的精选资源（课程/文章/开源项目/公司动态/我的产出）。当用户说「收藏」「加进收藏夹」「这个不错收一下」、或 agent 在对话中发现高质量可长期复用的资源（读过的优质文章、值得学的课程、好用的开源项目）时使用。不要用于：临时链接、工具文档、仅本次任务用的一次性资源。产物默认 HTML+链接交付。"
---

## 项目路径约定

- `.pi/`、`data/`、`tools/`、`references/`、`outputs/`、`.cache/`、`docs/` 和 `node_modules/` 开头的路径，相对于项目根目录；示例命令从项目根目录执行，除非明确说明先切换目录。
- 技能内部的 `scripts/`、`rules/`、`templates/`、`examples/` 等引用，相对于本 `SKILL.md` 所在目录，不要和项目根目录混淆。
- 配套脚本根据自身位置定位项目根目录，配置、缓存和默认输出留在项目内；不回退到全局目录。显式传入的相对文件参数仍按调用时的工作目录解释。

## 本项目路径状态

以下配套资源当前未安装，不要假定存在，也不要自动到全局或作者目录寻找：
- `data/favorites/favorites.json`
- `tools/bin/favorites-add`


# 收藏夹（Favorites）

## 是什么 / 何时用

用户维护一个「收藏夹」：把对话中发现的优质资源长期留存，分类管理。
- 位置：`data/favorites/`（本地源 + 生成器），线上 R2 `favorites/index.html`
- 数据源：`favorites.json`（唯一的真源，手工编辑或 CLI 均可）
- 分类：`course`（课程）/ `article`（文章）/ `project`（开源项目）/ `company`（公司动态）/ `mine`（用户自己的产出）

**触发场景**：
1. 用户明确说「收藏这个」「加进收藏夹」
2. 用户在对话中发来一个优质资源链接并表达认可（如「这个不错」「很好的资源」）
3. agent 读完一篇文章/调研完一个项目后，判断质量高、对用户有长期复用价值（如经典文章、系统性课程、可学源码的开源项目）——**主动建议并默认添加**，但要在回复里告知

**不触发**：临时排查链接、API 文档、一次性任务资源（不长期有价值的不收）。

## 步骤

### 1. 添加资源（二选一）

**A. CLI 方式（推荐，自动去重）**：
```bash
tools/bin/favorites-add add --title "标题" --url "https://..." \
  --cat course|article|project|company|mine \
  --desc "一句话描述" --meta "作者/机构/日期" --tags "a b c"
```

**B. 直接编辑** `data/favorites/favorites.json`（适合批量/复杂条目），结构：
```json
{ "favorites": { "course": [ { "title": "", "url": "", "meta": "", "desc": "", "date": "YYYY-MM-DD", "tags": "" } ] } }
```

### 2. 重建并发布（每次改动后必做）

```bash
tools/bin/favorites-add rebuild
# 等价于: (cd data/favorites && python3 gen_index_html.py) && bash .pi/skills/joye/personal/publish-artifact/scripts/report.sh data/favorites/index.html favorites/index.html
```

### 3. 交付

回复用户可点击链接（Telegram 用 `[标题](链接)` 格式）：
`https://pub-5d453927f5eb462dad58b9ac1b2fbacd.r2.dev/favorites/index.html`

## 验证清单
- [ ] 新条目已出现在 `data/favorites/favorites.json`（`tools/bin/favorites-add list` 可查）
- [ ] `rebuild` 成功（index.html 重新生成 + 上传 R2 无报错）
- [ ] 回复给了可点击链接
- [ ] 本地留档：`outputs/YYYY-MM-DD/favorites/`（改完复制一份）
