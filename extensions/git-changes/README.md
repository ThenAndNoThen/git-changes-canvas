# Git Changes

用户级、工作区只读、完全不下载的 Git diff canvas，界面文案、提示和错误信息均使用英文；顶部不显示 Git 命令和自动选择提示行。「本地」指 Git 对象库已拥有比较所需的内容，而不是文件必须存在于工作区；新增、删除和尚未检出的文件均可显示。在仓库会话中打开时，自动从 SDK 的 `ctx.session.workingDirectory` 解析当前 worktree（不是主仓库目录，也不是 SDK 的会话产物目录），选择当前检出分支作为目标 B，并立即加载改动。基准 A 优先使用 `origin/HEAD` 指向的远程默认分支；否则使用唯一的远程 HEAD、当前分支上游，最后使用 HEAD，不猜测 main/master。Detached HEAD 使用 `HEAD`。未关联 Git 工作区的普通对话才回退到最近仓库。分支选择框仍允许手动输入 tag、提交 SHA、`HEAD~3` 等 Git revision；点击「Compare / Refresh」或在输入框按 Enter 执行。远程分支使用本地已有的 remote-tracking refs，不自动更新分支引用。

尚无首个提交的新仓库也会自动填入路径和当前分支，不会因 `HEAD` 尚未指向提交而中断初始化。默认比较显示「No commits on this branch」；创建首个提交后点击「Compare / Refresh」即可继续，无需重开面板。

- **分叉后 · A...B**：按 `git diff A...B` 的方向比较共同祖先与 B，使用本地 Git 对象显示 B 自分叉后的改动。交换 A/B 会改变结果。没有共同祖先或存在多个 merge base 时明确报错，改用端点比较。
- **两个端点 · A B**：按 `git diff A B`（或 `git diff A..B`）比较两个提交，无需检出对应文件。
- 左侧可搜索改动文件，增删行数只显示大于 0 的值（省略 `+0` / `−0`，二进制提示保留）；右侧支持并排 / 统一 diff、行号、单词级差异强调、换行和水平滚动。新增和删除使用更明显的绿色 / 红色背景与行号侧边色条，分别适配亮色、暗色主题。拖动分隔线调整文件列表宽度。
- diff 与全文均支持语法高亮，覆盖 C#、Java、Kotlin、JavaScript / TypeScript、Python、C / C++、Go、Rust、JSON、XML、YAML、Markdown 等常见格式。着色基于比较两侧的完整本地版本，跨行注释和字符串不会因 diff 上下文被省略而重置；未知格式显示纯文本。
- 右侧工具栏的「Full file」支持「Split」和「Single column」：并排展示实际比较基准（`A...B` 时为共同祖先）与目标 B 的完整文件，并按改动块对齐两侧；插入 / 删除造成的行数差用空位补齐，未修改的前后文不省略。单栏展示目标 B，已删除文件则展示基准全文。两种布局均保留行号、语法高亮、换行、上下箭头、`F7` / `Shift+F7` 和跨文件跳转；跨文件时保持全文与布局选项。单栏下纯删除的位置显示可跳转的提示标记，包括文件开头、结尾和清空文件的情况，提示标记不是文件正文。切换全文 / Diff 或布局会保留当前改动块位置。选项按仓库保存。二进制和子模块明确提示无法显示普通文本全文。
- 工具栏上下箭头、`F7` / `Shift+F7`、`Alt+↓` / `Alt+↑` 跳转改动块，到达当前文件边界时切换到筛选列表中的下一个 / 上一个文件。二进制和权限变更也会显示。为避免读取非本地的重命名候选内容，关闭跨文件重命名检测，重命名按范围内的新增 / 删除展示。`Ctrl+P` 聚焦文件筛选。

## Review comments

在 diff 或全文中悬停行号，点击行号左侧出现的 `+` 即可评论该行；拖选同一侧的代码片段后，选区末行左侧也会显示 `+`。也可点击行号，按住 Shift 点击另一行号选择多行，再点击 `+` 评论选区。入口支持键盘聚焦和 Enter / Space，无独立工具栏评论按钮。引用支持行内起止列和跨行范围（最多 200 行 / 16000 字符）。服务端会从固定 Git blob 重新提取引用，不采用浏览器提交的任意代码文本。

点击「Send to conversation」后，扩展通过 SDK `session.send` 将评论排入此 Canvas 所属会话，不是其他打开的聊天，也不是远端 PR 评论。主 Agent 会收到文件、版本、范围、原文和处理要求；处理完成或遇到阻碍时，使用 `git_changes_review_read` / `git_changes_review_reply` 在同一线程回帖。保留会话现有模式、权限和审批流程，不提升权限，不自动切换工作区。发送动作会使用当前会话的模型额度。没有可用的会话持久化目录时会明确报错，不降级为丢失数据的临时评论。

新发送的评论通过 SDK `displayPrompt` 在主对话中简洁显示为 `Review inline code: path:L10`，后续回复显示为 `Reply to thread: path:L10`；多行范围显示为 `L10-L15`。Agent 仍收到完整评论、固定版本的代码引用和处理要求；Canvas 内的评论原文也保持不变。这是简短消息展示，不是原生评审卡片的折叠协议，也不会改写已发送的历史消息。

用户可继续「Send reply」或点击 Resolve；Agent 回帖不会自动 resolve。已解决线程默认折叠，可展开查看历史或 Reopen。「↑ Comment / ↓ Comment」独立于 diff 跳转，按文件与引用位置导航未解决线程，支持跨文件，定位时展开并排全文。代码版本变化后保留原始引用并标记过期，不把旧行号误用到新版本。

评论存于所属会话工作区的 `files/git-changes-reviews.json`，按仓库、比较 refs 和线程 UUID 管理，不依赖面板 instanceId，也不写入被查看的代码仓库。刷新、关闭重开和扩展 reload 后可恢复。同一会话多个面板同步回复。发送失败或结果不确定时保留评论并明确提示，不自动重发以免重复处理；需先检查主对话的实际接收情况。尚未发送的输入框草稿不是持久化评论，页面重载可能丢失。

通过 `open_canvas` 打开 `canvasId: "git-changes"`，`instanceId` 自选，无需提供路径或分支。可选输入 `{ "repo": "C:\\work\\repo", "base": "origin/main", "target": "HEAD", "mode": "merge-base" }` 会显式覆盖自动默认值，历史记录不会覆盖这些参数。支持 `compare`、`get_state`、`get_file` agent actions；`compare` 的文件清单最多返回 30 条，完整清单在 canvas 内显示。`get_state` 同时返回工作区来源和 HTTP 诊断计数。`get_file` 可选 `includeSources: true`，返回比较基准与目标的完整本地 Git 文本；默认仍只返回 diff。

比较使用固定提交 SHA，避免查看过程中分支移动导致文件列表和详情不一致。刷新重新解析 refs 并检查历史对象是否在本地。仓库不会被修改，不切换分支，不执行外部 diff / textconv，不运行仓库脚本。单次 Git 输出限制 24 MiB，超时 60 秒，超限明确报错而非截断。文件列表和详情按需加载；大型比较请缩小范围。

全文同样读取固定 Git blob，而不是磁盘上的未提交内容。超过约 1M 字符时暂停语法着色并明确提示，但仍显示完整文本；单个版本超过 24 MiB 时明确提示无法加载全文，不会静默截断。高亮引擎为本地打包的 highlight.js 11.11.1（`vendor\highlight.mjs`），许可证保留于 `vendor\highlight.LICENSE`；不依赖 CDN，不向外部服务发送源码。

部分克隆也不联网：先读取已有目录树中的改动元数据，再批量检查每个文件需要的历史 blob 是否已在本地，不使用工作区路径存在性作为过滤条件。缺少历史对象的文件会明确计入「跳过」并标出文件名，不阻断其他可比较文件，也不将跳过解释成「没有改动」。历史对象齐全的文件才计算统计与文本 diff。所有 Git 命令都设置 `GIT_NO_LAZY_FETCH=1`，没有下载缓存或自动 fetch 路径；若连目录树都缺失、无法列举改动，会明确报错，不下载或编造结果。

最近使用的仓库、选中文件、视图及换行设置保存在本扩展 `artifacts\preferences.json`，按 worktree 路径持久化，不依赖面板 `instanceId`。新面板或扩展 reload 后重新读取当前分支，不沿用旧比较参数；普通页面刷新保留当前面板的比较。仅比较已提交的分支内容，不包含未提交或未跟踪文件。

界面资源全在本地，无 CDN、无外部上传。服务仅监听 `127.0.0.1`，使用随机 capability URL、Host 校验与 JSON POST header。支持无 `allow-same-origin`、无 `allow-forms` 的沙箱 iframe：只在有效随机路径下允许 `Origin: null` 的无凭据 CORS（包括模块脚本、fetch 预检和 SSE），其他外部 Origin 仍拒绝。按钮直接调用 API，不依赖被沙箱禁止的 HTML 表单提交。

运行 `node --test git.test.mjs` 可验证 diff 语义、沙箱 HTTP 接口、worktree 自动识别和配置优先级；测试仓库仅创建在临时目录，不访问真实仓库。浏览器回归保存在 `renderer.test.mjs`：从已安装 Playwright 的独立测试目录运行 `node <扩展路径>\renderer.test.mjs`，使用本机 Edge headless，在 `sandbox="allow-scripts"` 的真实 iframe 中验证自动加载、diff、跳转、比较按钮、Enter 和刷新。扩展运行本身不需要 Playwright。

评论测试：`node --test reviews.test.mjs` 验证引用、幂等发送、回复、resolve 和持久化；从安装 Playwright 的测试目录运行 `node <扩展路径>\review-renderer.test.mjs` 验证真实沙箱里的选区、评论、回复、折叠、跳转和过期引用。浏览器测试注入模拟的发送函数，不会向真实主对话提交测试请求。
