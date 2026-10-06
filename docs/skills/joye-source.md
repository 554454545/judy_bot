# Joye Skills 本地参考副本

来源： https://github.com/joyehuang/skills

从已有参考目录 `/home/judy/workspace/joye/skills` 复制到项目 `.pi/skills/joye/`，保留目录层级、README、LICENSE、脚本和附属文件，不复制 Git 元数据，不执行安装或技能脚本。

源版本：`7ed5c1044af3cafcaab455b8f3c5c62292bb229c`。保存 108 个文件、27 个 SKILL.md；初次复制逐文件内容校验一致。此副本没有联网更新。

启动入口使用 `--no-skills` 加逐个 `--skill <SKILL.md>`：关闭自动发现，只显式加载项目内这份技能目录。此参数组合已由本地 0.84.1 的资源加载器核对。使用前按 plan.md 检查个人路径、依赖、项目外写入及所需授权，再按实际需要适配。

启用核对：27 个技能仅从项目目录加载；只枚举 SKILL.md，避免 README 和 MERGE-NOTES 被误当技能。web-search 的 description 原文含冒号导致 YAML 解析失败，已仅为本地副本该字段加引号，正文不变。原始参考仓库未修改。

此前启用清单缩减为 personal/skill-creator 与 personal/web-search；2026-10-05 后台整改后增加已有的 personal/herdr-workflow 副本。启动入口仍逐个显式指定 SKILL.md，不枚举整目录。其他技能仅保存在项目目录，不加载。

本地副本已完成项目路径适配，与原始来源不再逐文件一致；修改清单和缺失配套资源见 path-adaptation.md。当前启用清单为 skill-creator、web-search、herdr-workflow。

2026-10-05：后台准备阶段曾新增工作流适配 Skill，随后按用户要求删除并移除启动项，当时清单恢复为 skill-creator、web-search。后续按用户要求严格对照 Joye，改为已有 `joye/personal/herdr-workflow/SKILL.md` 的路径和派发前阶段适配，已加入启动白名单；没有恢复被删除的自写 Skill。后台扩展与脚本的逐项对照见 `.pi/extensions/background/README.md`。修改启动入口不会自动重载正在运行的实例。
