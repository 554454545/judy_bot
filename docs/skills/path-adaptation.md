# Joye Skills 路径适配

扫描全部 27 个 Skills 及附属文件，只修改 bot 内副本，不修改 joye 参考仓库；当前启用清单为 skill-creator、web-search、herdr-workflow。后者是已有 Joye 副本的派发前阶段适配。

- 技能引用统一到 `.pi/skills/joye/`；新建技能放 `.pi/skills/<name>/`，移除全局安装和双份同步默认。
- API 凭据、轮换器和使用日志统一到 `.pi/agent/config/`，不迁移全局凭据。
- 收藏夹和面经数据路径为 `data/`；交付文件为 `outputs/`；临时文件为 `.cache/tmp/<功能>/`。
- 原作者配套项目路径映射到 `references/`，辅助程序到 `tools/`；这些缺失资源没有创建假文件或安装。
- 系统命令、URL、界面装饰字符串不机械改写；MERGE-NOTES.md 保留原始来源事实并标明非运行指令。

初次整理的配套缺失项：favorites 数据和 CLI、friend-link-worker 和包装脚本、interview-dashboard 源码、task_protocol.py、remotion-best-practices skill。后续 task_protocol.py 已按当前授权阶段接入 `.pi/extensions/background/tasks/`；web-search key 已另行授权配置，rotate.sh 仍未配置。不能将当前派发前协议当成完整的 Joye runner。

验证记录：27 个 Skills 经实际 Pi 0.84.1 资源加载器解析，无诊断；所有 Shell 脚本 bash -n 和 Python AST 解析通过。没有网络调用、发布、安装依赖或读取全局凭据。PowerShell/macOS 截图流程未在当前 Linux 环境实际执行。

修改文件：
- `MERGE-NOTES.md`
- `README.md`
- `archive-card-writer/SKILL.md`
- `article-to-script/SKILL.md`
- `blog/SKILL.md`
- `brainstorm/SKILL.md`
- `compare/SKILL.md`
- `curated-content-writer/SKILL.md`
- `deep-dive/SKILL.md`
- `diff-story/SKILL.md`
- `explore-site/SKILL.md`
- `gemini-tts-fast/README.md`
- `gemini-tts-fast/SKILL.md`
- `gemini-tts-fast/examples/basic.md`
- `gemini-tts-fast/tts_cli.py`
- `learn/SKILL.md`
- `personal/README.md`
- `personal/favorites/SKILL.md`
- `personal/friend-link/SKILL.md`
- `personal/handdrawn-ui/README.md`
- `personal/handdrawn-ui/SKILL.md`
- `personal/herdr-workflow/SKILL.md`
- `personal/interview-kb/SKILL.md`
- `personal/publish-artifact/SKILL.md`
- `personal/publish-artifact/scripts/publish.sh`
- `personal/publish-artifact/scripts/report.sh`
- `personal/skill-creator/SKILL.md`
- `personal/web-search/SKILL.md`
- `personal/web-search/scripts/search.sh`
- `personal/web-search/scripts/tinyfish.sh`
- `quiz/SKILL.md`
- `resume/SKILL.md`
- `screenshot/scripts/take_screenshot.ps1`
- `screenshot/scripts/take_screenshot.py`
- `script-to-remotion/SKILL.md`
- `script-to-remotion/rules/component-generation.md`
- `script-to-remotion/rules/project-assembly.md`
- `script-to-remotion/rules/tts-integration.md`
- `user-insight-research/SKILL.md`
- `x-auto-engagement/SKILL.md`
- `x-auto-engagement/reference/runbook.md`
- `x-auto-engagement/reference/troubleshooting.md`

## 项目相对路径整理

全部 27 个 SKILL.md 已补充项目路径约定；Skills 内 README 和附属说明的项目绝对路径改为相对路径。项目资源相对于项目根目录，技能内部资源相对于对应 SKILL.md；示例命令默认从项目根目录执行，明确 cd 的步骤按切换后的目录解释。

发布、TTS、截图及 macOS 截图权限辅助脚本按自身位置推导根目录。默认配置、缓存和输出随项目移动；用户显式传入的相对文件参数保持按调用时工作目录解释。MERGE-NOTES.md 的原始来源路径保留，不作为运行指令。

验证：实际 Pi 加载器解析 27 个 Skills，无诊断；所有 Shell 脚本语法检查和 Python AST 解析通过。复制到临时项目后验证截图与 TTS 默认路径及发布脚本读取项目配置，发布使用模拟 rclone，无真实上传、截图或语音调用。PowerShell 和 macOS 专用流程未实际运行。此为初次路径整理的历史验证；当前额外加载已有 herdr-workflow 副本，派发前整改见后台目录 README 和 test.md。
