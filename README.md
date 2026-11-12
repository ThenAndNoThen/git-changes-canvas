# Git Changes canvas

GitHub Copilot 桌面应用的只读 Git 分支比较 Canvas，使用英文界面，支持全文并排、语法高亮、改动导航和与主对话联动的代码评审评论。

## 功能

- 比较任意本地 Git refs：端点比较 `A B`、共同祖先比较 `A...B`，自动读取所属会话 worktree 与当前分支。
- 文件筛选、增删统计、并排 / 统一 diff、全文并排 / 单栏、语法高亮、换行和跨文件改动导航。
- 行号左侧的 `+` 评论入口在悬停行号或选中代码时显示；支持行内片段和 Shift 点击多行。
- 评论发送给此 Canvas 所属主对话；主 Agent 处理后通过专用工具回复。用户可继续回复或 Resolve，已解决线程默认折叠。
- 独立的评论前后跳转；评论固定到原始 Git blob，代码变化时标记过期而不是误定位。
- 不切换分支、不修改被查看的工作区、不下载 Git 对象。缺少本地对象时明确提示跳过。

## 安装和分享

要求 Git、Node.js（建议 22 或更新版本），以及支持 `joinSession` Canvas 扩展和自定义 tools 的 GitHub Copilot 桌面应用。Canvas SDK 为实验性接口，不同应用版本可能有兼容性差异。

### 从 GitHub 安装（推荐分享方式）

将本仓库推送到 GitHub 后，把 **`extensions/git-changes` 文件夹链接**发给对方，例如：

```text
https://github.com/<owner>/<repo>/tree/main/extensions/git-changes
```

对方在 Copilot 中输入：

```text
请安装这个 Canvas 扩展到用户级：<上面的 GitHub 文件夹链接>
```

应用的 `install_extension` 支持这种 GitHub 文件夹 URL，安装后会重载扩展。用户级安装可供本机各会话加载；已运行的其他会话可能需要重载扩展。随后在右侧 Canvas 菜单选 Git Changes，或在目标仓库会话让 Agent 打开 Git Changes。

### 本地安装

源码文件夹位于 `extensions\git-changes`。将其中的文件（含 `vendor` 子目录）复制到 `$COPILOT_HOME\extensions\git-changes`；没有设置 `COPILOT_HOME` 时通常是 `~\.copilot\extensions\git-changes`。已有安装时，保留其 `artifacts` 数据目录，不要用旧数据覆盖；然后让所在会话重新加载扩展。

**运行时无需 `npm install`**，高亮资源已经本地打包；`@github/copilot-sdk` 由 Copilot 运行时提供。根目录的 npm 依赖只用于开发和测试。

### 不要分享个人运行数据

仓库只包含源码和测试，不包含个人仓库路径、偏好、评论、会话记录或对象缓存。`.gitignore` 排除了 `artifacts`、偏好和评论文件。评论实际保存在所属会话目录的 `files/git-changes-reviews.json`，不在扩展源码里。

应用也提供 “Share extension as gist…”，但不要直接把使用过的安装目录作为分享源：分享工具未必按 `.gitignore` 排除运行数据。优先分享本仓库中干净的源码文件夹。没有上传、创建远端仓库或推送操作会由此扩展自动发生。

## 代码评审流程

1. 悬停行号并点击左侧的 `+`，或先选择代码范围再点击选区末行左侧的 `+`，填写意见并「Send to conversation」。
2. 扩展使用 SDK `session.send` 排队到所属会话，保留现有权限、模式与审批流程。主 Agent 通过 `git_changes_review_read` 读取线程，通过 `git_changes_review_reply` 回帖；线程不自动解决。
3. 用户继续「Send reply」或 Resolve。已解决线程折叠，可展开查看历史或 Reopen。评论导航只遍历未解决线程。

评论在本地持久化；关闭面板、重载扩展和恢复会话后仍可读取。引用的代码与用户评论会提交给该会话正在使用的模型，因此仍适用该会话的数据策略与模型额度。扩展不把评论发布到 GitHub / Azure DevOps PR。

评论绑定的是历史提交，不一定对应磁盘当前内容。Agent 需要先检查实际工作区；没有权限、路径不匹配或存在不明确的请求时应在评论中说明。发送失败且接收结果不确定时保留评论并提示，不自动重发。

## 开发与验证

```powershell
npm ci --ignore-scripts
npm test
npm run test:browser
```

浏览器测试使用已安装的 Microsoft Edge headless，在 `sandbox="allow-scripts"` iframe 中验证。测试只创建并清理自己的临时 Git 仓库；评论测试模拟主对话发送函数，不会向真实会话发送测试消息。

高亮引擎重新打包：

```powershell
npm run build:highlight
```

打包后应保留 `extensions\git-changes\vendor\highlight.LICENSE`。更多比较语义、限制和安全说明见 [扩展文档](extensions/git-changes/README.md)。

## 发布准备

当前仓库默认分支为 `main`，未配置远端。检查源码、选择你希望授予使用者的许可证，然后自行创建 GitHub 仓库、提交和推送：

```powershell
git add .
git commit -m "Add Git Changes canvas"
git remote add origin https://github.com/<owner>/<repo>.git
git push -u origin main
```

本项目尚未代你选择开源许可证；发布前请自行决定。第三方 highlight.js 的 BSD-3-Clause 许可证已随资源保留。
