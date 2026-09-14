# 当前分支向 REPL / UI 提供的统一接口是否承接主线能力？

TL;DR：当前分支已经包含本次比较的主线，但接口迁移仍发现真实消费者缺口：classic 的过期待答请求及失效观察无法关闭 readline，已在本轮修复；跨 Client 取回队列会丢附件，已交给主任务补齐。现有 Session Stop、设置、历史、MCP、扩展、工作流及协作有正式产品入口，不能把旧接口数量减少直接认定为能力丢失。[基线：`0841fb51726bcce437f5952483a072a662dbbf84`；主线：`origin/KodaX`=`7b5b1b9e`；来源：`src/client-runtime-adapter.ts:27`、`packages/coding/src/client-contract.ts:87`]

## 范围与判据

- 2026-09-14 执行 `git merge-base --is-ancestor origin/KodaX HEAD` 返回成功；本轮不能解释为“分支尚未合入这些主线提交”。主线近期的 Session Stop / shell cleanup 提交包括 `c61914bf`、`3e4bea12`、`368982ae`、`5c6a18c0`；比较重点应是改成 Product Client 后是否遗漏其行为，而非再次机械移植相同提交。[来源：上述 commits；`git log origin/KodaX -18 --oneline`]
- v0.7.97 明确约束既有能力和体验不得下降；本笔记以真实消费者和当前源码为准，不把设计块历史评审中已经修复的项目重新计为问题。[来源：`docs/features/v0.7.97.md:130`、`docs/CLIENT_CONTRACT.md:5`]
- 只读仓库第一方源码、契约和测试；没有外部网页事实需要查证。经典终端问题通过真实 Node readline / PassThrough 测试验证，不靠内部 Map 状态断言。[来源：`packages/repl/src/interactive/classic-plane-display.test.ts:11`]

## 确认缺口与处理

### 1. classic 的远端已答请求仍占用 readline，阻塞后续问题（本轮已修复）

复现：classic 收到第一个 `question_input` 并显示提示；另一 Client 回答它，Host 新视图只包含第二个问题。修改前第一道 `askInput` 不会结束，`dialogChain` 永远不能显示第二个问题。用户必须再回答一次已经失效的问题才能继续。Host 的首次有效答案保护避免重复执行，但没有解决客户端被旧弹窗阻塞的问题。[基线源码：`0841fb51:packages/repl/src/interactive/classic-plane-display.ts:161`、同文件 `:177`；`0841fb51:packages/repl/src/interactive/classic-plane-interactions.ts:92`、`:112`；契约：`docs/CLIENT_CONTRACT.md:287`]

修改后按 requestId 持有 AbortController；新完整视图确认请求消失及主动停止观察时取消本地对话，等待中的旧请求不会开窗，也不向 Host 发送自动取消/拒绝。普通问题、多问题、输入问题均将信号传到共享 `askInput`，其 readline 读取可取消并保留原有多行输入路径。[来源：`packages/repl/src/interactive/classic-plane-display.ts:161`、`packages/repl/src/interactive/classic-plane-interactions.ts:92`、`packages/repl/src/interactive/readline-helpers.ts:55`]

验证：先运行新增公共接缝测试出现 RED，失败为 `expected 'first: ' to contain 'second:'`；修改后 `classic-plane-display`、`classic-plane-interactions`、`readline-helpers` 共 22 测试通过，执行命令为 `npx vitest run packages/repl/src/interactive/classic-plane-display.test.ts packages/repl/src/interactive/classic-plane-interactions.test.ts packages/repl/src/interactive/readline-helpers.test.ts --maxWorkers=1`。[来源：`packages/repl/src/interactive/classic-plane-display.test.ts:11`；本轮终端验证]

### 2. classic 未消费观察永久关闭，失效窗口仍接收答案（本轮已修复）

修改前 attach 只消费 view，不传 `onStatus`；连接建立后 `closed/reason=unavailable` 既不会拒绝已经完成的 attach Promise，也不会停止 readline 问题。此时用户输入仍向已经失效的观察提交答案。Ink 已消费该生命周期，classic 应遵守相同规则。[基线源码：`0841fb51:packages/repl/src/interactive/classic-plane-display.ts:164`；当前参考：`packages/repl/src/ui/InkREPL.tsx:1859`；契约：`docs/CLIENT_CONTRACT.md:287`]

修改后永久关闭清理待答窗口并明确显示 observation unavailable；短暂 interrupted 不被当作取消。新增 RED 记录显示旧实现对第二个问题提交了 `late answer`；修复后永久关闭和主动关闭两个场景均无答复副作用。[来源：`packages/repl/src/interactive/classic-plane-display.ts` 的 `onStatus` 回调；`packages/repl/src/interactive/classic-plane-display.test.ts:11`]

### 3. 重新挂接或另一 Client 取回队列输入会丢附件（本轮已移交）

Product `inputs.withdraw` 返回完整 `ClientSubmitInput`，包括 `inputArtifacts`。但基线 `createCliClientPlane` 把返回值压成 `result.text`，队列 `pull` 只有当前窗口还持有 `draft.originalText` 时才能恢复 `@image` 原文。另一个窗口 / 新建立的队列无这份草稿，取回的是已经处理过的正文，附件数组被丢弃；再次提交无法恢复图片。[来源：`0841fb51:src/cli-client-plane.ts:63`、`0841fb51:packages/repl/src/ui/client-input-queue.ts:63`、同文件 `:67`；`packages/coding/src/client-contract.ts` 的 `inputs.withdraw`；图片改写：`packages/repl/src/common/input-artifacts.ts:103`]

公开接缝验证：用 `createCliClientPlane` 连接返回 `{text:'review [Image 1]',inputArtifacts:[image]}` 的 Client，再建立没有本地 draft 的 `createClientInputQueue` 并 `pull('s',['peer-input'])`，实际仅得到字符串 `review [Image 1]`，原附件数为 1。既有队列图片测试只在同一个 queue 里 submit 后 pull，因此未覆盖这个丢失路径。[来源：`packages/repl/src/ui/client-input-queue.test.ts:53`；本轮 `node --import tsx --input-type=module` 接缝验证]

该问题已发送主任务处理，避免两个 Agent 同时修改 Client plane 和队列文件。最终修复状态以主任务验证为准。[来源：本轮协作任务分工]

## 非问题 / 已有承接

- **Session Stop 与 Run Stop 仍有区分。** 产品面公开 `sessions.cancel`；REPL `bindClientPlaneSessionStop` 固定 Session、expectedRunId 和 requestId；终态仍等待 `awaitRun`，不是看到 stop 被接收就宣布成功。现有 stop-control 测试明确把 `unknown` / `shell_cleanup_unconfirmed` 当失败。[来源：`packages/repl/src/ui/client-plane.ts:271`、`:287`、`:344`；`packages/repl/src/ui/client-plane.stop-control.test.ts:23`；`docs/CLIENT_CONTRACT.md:382`]
- **基本域未因 facade 收敛消失。** Session 的创建/归档/删除、设置、目标、lineage、fork/recover/rewind/compact、分页全文/搜索；MCP 配置与工具发现；扩展诊断与注册命令；Agent 协作；workflow 完整快照/订阅/控制；Memory/Learning 均有产品契约和向同一 Runtime 的投影。此项结论是入口存在及接线一致，不能代替每个业务分支端到端验证。[来源：`packages/coding/src/client-contract.ts:87`；`src/client-runtime-adapter.ts:15`、`:27`、`:89`、`:104`、`:233`]
- **本窗口队列附件并非全都失效。** submitPrompt 保留 `originalText`，相同 Client 的普通取回可恢复原 `@image` 路径，已有测试验证。因此缺口 3 精确限于本地草稿不在的取回流程。[来源：`packages/repl/src/ui/client-input-queue.ts:17`、`:36`、`:67`；`packages/repl/src/ui/client-input-queue.test.ts:53`]
- **浏览器 transport 不是本次已交付能力。** 契约明确仅有 Node 连接实现，浏览器可使用纯类型；没有理由把“尚无浏览器 HTTP/WebSocket 实现”误记为此次删除了主线已有 Web 功能。[来源：`docs/CLIENT_CONTRACT.md:27`]

## 未证实

- classic differ 只按同一 assistant item 的长度增长追加；理论上同 ID 更短替换会被忽略。但已查到的 Host retry/replace 路径会更换 `providerRequestId`、移除旧项并生成新 itemId，因此未证明当前真实 Provider 路径触发“同 ID 更短 assistant 替换”。不据这个人工 DTO 场景增加输出修复。[来源：`packages/repl/src/interactive/classic-plane-display.ts:94`；`src/session-view.ts:75`、`:95`]
- 本轮没有执行真实 Windows 交互终端、完整已安装 CLI、macOS 或 Linux 手工验收；22 项测试不能解释为跨平台全量发布验收完成。[来源：本轮验证命令；发布标准：`docs/features/v0.7.97.md:159`]

## 未解问题

- 已被用户显式打开的外部编辑器仍按既有进程生命周期结束；本轮取消的是 readline 问题与后续 Host 答复，未添加强制关闭外部编辑器的行为。是否应在 Host 问题失效时同时关闭用户编辑器，需要单独明确体验边界。[来源：`packages/repl/src/interactive/readline-helpers.ts:62`、`openExternalEditor`]
- 交付前仍需真实 classic 终端多 Client 问题/断线和重挂接队列附件的手工验收；这是对本轮已修行为的终端体验确认，并非新增 SDK 抽象需求。[来源：`docs/features/v0.7.97.md:159`、本笔记缺口 1–3]
