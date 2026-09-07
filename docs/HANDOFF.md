# v0.7.97 实施交接

交接时间：2026-09-05，Asia/Shanghai。用户最新指令是**停止实现并执行 handoff**。本文件仅交接；没有继续修复、提交、推送或发布。只有用户重新要求继续时才恢复实施。

## 1. 原始意图与有效约束

用户最初希望深入梳理 KodaX 给 UI 和 SDK 的统一接口、其他统一接口及控制面，对照 `C:/Works/PubProj/deepseek-harness` 和 `C:/Works/PubProj/codex`，并要求子 Agent 研究与交叉讨论。设计、规格及票据已经形成，恢复时以现有产物为准，不重新从研究阶段开始。

本次实施请求原话：

> 请你连续谨慎 [$implement](C:\Users\ADMIN\\.agents\skills\implement\SKILL.md) ，直到完成0.1.47的完整设计。

随后用户明确更正：

> 是同一套 0.7.97，我打错了

评审期间的核心要求原话：

> 接口不应该简洁可维护吗？我们搞这么多恢复语义不是因为之前补丁套补丁吗？
>
> 我要重构后的能力和体验只能提升，不该退步。这个你可以仔细做下分析对照

持续有效的边界：最小必要实现，保持包层次独立；保留 REPL 的实际能力和体验；不把有用的一次精确授权、Auto、后台运行、多 Client 一并删除；不再新增 `docs/analysis`。本交接放在已有 `docs/` 下，不创建新的文档目录。

本地实施、测试、评审和提交此前已授权；远程 push、合并、发布未授权。本轮停下以后，不因为旧的“连续实施”指令自动续跑。没有创建持续 goal 或自动化。

## 2. 当前进度与恢复入口

### 仓库与正式产物

- 工作目录：`C:/Users/ADMIN/.codex/worktrees/a72f/KodaX`。
- 主仓库分支：`codex/product-client-refactor`；当前 HEAD：`d6f92553`。
- `docs/features` 是独立 Git submodule，分支同名，HEAD：`775cabb`，停止时干净。
- 初始实施基线：`a8f0eedce151d9980acbfa7c938e9bf5cf5931e8`。
- 主仓库包版本仍为 `0.7.96-beta.1`，没有声称已完成或发布 0.7.97。
- 原 checkout `C:/Works/GitProj/KodaX-AI/KodaX` 留作旧版本补丁/发布，不要误改。主仓库与 submodule 的开发分支已创建，不必再建。
- 规格及正式票据唯一入口：[v0.7.97.md](features/v0.7.97.md)，重点读 `ticket-review`、`implementation-roadmap`、`repl-no-regression-audit` 三个锚点。
- 总状态：[FEATURE_LIST.md](FEATURE_LIST.md)，FEATURE_298 仍 In Progress。
- 仓库规范：[AGENTS.md](../AGENTS.md)。技能入口：`C:/Users/ADMIN/.agents/skills/{implement,tdd,code-review,to-spec,to-tickets,handoff}/SKILL.md`。

### 已提交

只需按需查看提交，不重新实现这些票：

| 提交 | 内容 |
|---|---|
| `1255a87a` | T01，共享纯产品契约及 Client SDK 入口 |
| `0b1c093e` | 启用已批准实施状态及开发分支 |
| `6e476d16` | T13 / T24，一次 prepared shell action，删除惰性控制 |
| `8722b025` | T02，被动连接与正常 launcher refresh |
| `143071f3` | Shell 测试响应字面量类型修正 |
| `d6f92553` | 更新已验证票据及 submodule 指针 |

T01、T02、T13、T24 的证据及状态已写入正式规格。其他票没有整体完成。可选 T28/T29 未选择，按正式 DAG 推进其余核心票。

### 未提交工作：必须保留，不能整批视为已验收

| 范围 / 原负责者 | 已验证部分 | 停止时缺口 |
|---|---|---|
| T03 / root | 真实 Host + IPC 的即时输入并发去重、先保存再调用 Provider、保存失败不执行、Host 变化不透明重交、临时 Session 清理及失败报告；6 项 S1 通过。另迟到清理 S2 1 项通过并有严格 RED 证据。双审发现已修复。 | 未提交；最新 T06 改动使 acceptance.runId 可选，部分旧测试调用需类型收窄。不能由 T03 推断附件、队列、统一生命周期已完成。 |
| T04 / inert_controls | 当前视图 observe/readItem、有界正文、部分稳定 ID、提示/工具/子活动/Todo/用量显示、串行 uiHistory 保存；真实慢 socket 背压修复。 | canonical conversation 尚未接线；压缩前历史、流式结算后的去重及 ID 对齐、workflow/诊断显示、初始读取一致性、长会话/渲染基线、非正文大小边界、最终类型/完整回归/双审未完成。 |
| T06 / root | 第一条真实双 Client S1 已通过：同队列、去重、精确撤回、撤回不复活、两条普通文本合并一次 Provider 请求。 | **目前有已知 RED，见下节。** Skill 原文识别/独立批边界/延迟准备未实现；保存与投递竞争、后续 stop 语义仍待完整验证。正式文档 T06 仍 Todo，代码比文档领先。 |
| T12 / client_boundary | Session 设置与用户默认、实际 MCP reload、两 Session 私有 MCP 隔离和删除、裸 Host 冷启动 MCP、显式能力 probe/cache/forget、Provider 来源及模型目录部分真实效果。 | typed Skill/command/extension/config-effective/diagnostics 及原命令实际效果仍待核对；Session 私有 MCP 仅在本进程持有，重启重建、失败及并发清理未验收；最新 Provider 返回类型改动后未重跑 typecheck。 |
| T12 live / shell_execution | 真 SA / AMA 后续请求热更新 provider/model/effort/reasoning/thinking、清除 override；AMA 自动压缩使用当前选择；已发请求不被改写。3 项真实 S1 通过，相关回归通过。 | 本片 Standards：client_boundary 0 findings；Spec：root 0 Critical/High。范围只含此片，不能代表整个 T12。未提交。 |
| T15 / shell_execution | `client.host.shutdown()` 窄边界，区分 idle 接受与实际清理结束；busy/客户端 detach/真实 helper 退出验证，3 项 S1 及相关 19 项通过，双审 0。 | Ink/classic 资源所有权迁移在 T17/T18，旧 exit 协议删除在 T25；没有宣告这些已完成。未提交。 |
| 共享 MCP reverse / shell_execution | 仅源码调研：tool ctx 已有 Session/workspace/askUser，共享连接的 reverse handler 当前静态绑定。 | **没有新增源码或测试。** 普通 reverse 请求缺少可直接复用的父请求关联；不能猜最后一个 Session 或使用进程级 active UI。需评估明确执行上下文与共享连接内串行绑定。 |

三个子 Agent 已停止并确认没有仍运行的命令 session。最后各自交接信息已汇入本文件，不需要靠旧 Agent 的内存恢复。

### T06 当前明确失败及未完成点

测试文件：[src/sdk-client.queue.test.ts](../src/sdk-client.queue.test.ts)。最后完整运行 4 项：2 通过、2 失败；调整 stop 用例以尊重真实执行结果后，定向 stop 用例仍 RED：

1. `bounds queue previews and capacity while withdrawal returns the complete original once`：视图队列直接携带 1,040,000 字符，断言 `< 100` 失败。正文应留在真实 MessageQueue，观察只给有界预览，withdraw 必须取回完整原文。尚未修复。
2. `retains undelivered text and starts no remaining work after stop`：停止请求已接受，但测试 Provider 忽略取消后正常返回，最终 phase 合理地可能为 completed；**当前 finishRun 只看 completed 就自动消费队列**，withdraw 因已经投递而报 `Input has already been submitted or withdrawn.`。尚未修复。不要把测试改成“stop 必须取消成功”，也不要仅看 cancelled 猜用户是否想继续；需要尊重明确 stop 意图，T07 再区分 redirect。
3. 失败终态用例通过，普通文本合批用例通过。完整队列数量上限为原有 5 条，但预览用例在第一处失败后，后面的双端竞争断言还没有本轮 GREEN 证据。
4. `SessionInputQueue.batch` 尚无 Skill 边界；暂存正文只在既有 MessageQueue，facts Map 仅存当前 Host 内身份/摘要/处置/Run 引用。不要把它扩张为永久回执账本。
5. `batch` 目前每条 queue message 扫描所有 facts，待做必要的最小收敛；`MAX_PENDING_INPUTS` 目前重复为 5，避免为此把 agent 层反向依赖 UI。
6. 需检查 executor terminal callback 早于真实 Promise 结束的情形：临时 Session 有保护，普通产品 Run 的自动续队列还需验证。不要在尚未证实旧执行结束时启动下一批。
7. 新字段/方法已接通 SDK、daemon 和 Runtime，`queuedInputs is not a function` 的中间态已经修复，不需重复修它。当前整体 build/typecheck 未完成。

### 最新验证证据的边界

- root 较早：inputs + queue（当时仅首条）+ schema，3 文件 30/30；不能代替当前 4 项 queue 回归。
- T03：inputs + schema + storage SDK consumer，3 文件 49/49。曾额外传入的 auto-resume 测试路径没有匹配文件，**不能声称它运行通过**。
- T03 迟到清理：`src/sdk-client.inputs-late-cleanup.test.ts` 1/1；临时 Vitest transform 恢复旧逻辑时 RED：缺失诊断并出现 unhandled rejection。
- T04 最新：`src/sdk-client.observe.test.ts -t 'keeps earlier'`，1 passed / 2 skipped。最新代码没有完整重跑这三项。
- T04 传输：`src/runtime-daemon/transport.view.test.ts src/runtime-daemon/transport.test.ts`，16/16。
- T12 最新：`src/sdk-client.capabilities.test.ts --reporter=dot`，1/1；包含实际本地 HTTP probe、真 SA/AMA、wire 缓存效果/forget、Provider 来源/模型目录。
- T12 较早：mcp + server，56/56；capabilities + capability-probe，4/4；Provider reasoning/cache 81 项。最新目录返回类型修改不在较早检查覆盖内。
- live：`src/sdk-client.live-settings.test.ts` 3/3；最近相关回归 52 项，此前相关组合 59 项，均不是全仓测试。
- 中断前 `git diff --check` 没有发现 whitespace error。它不检查未跟踪文件内容，也不代表构建成功。

## 3. 已确定接口与实现接缝

正式接口以 [client-contract.ts](../packages/coding/src/client-contract.ts)、[sdk-client.ts](../src/sdk-client.ts) 及规格的 `client-contract` 锚点为准，本文不复制完整契约。

恢复时须记住的骨架事实：

- `@kodax-ai/coding/client-contract` 提供纯数据契约，`@kodax-ai/kodax/client` 提供连接；普通 connect 被动附着，不自动启动或替换 Host。
- `inputs.submit` 使用 Session 内 inputId；当前 `delivery` 是 immediate / after_turn。`ClientInputAcceptance` 已扩为 submitted / queued / withdrawn，`runId` 变为可选；一批输入可共享同一 Run。
- `inputs.withdraw(sessionId, inputId)` 是精确、原子取回完整原文；编辑后使用新 ID。提交/撤回/实际批提交复用既有 Session operation gate。
- `sessions.observe` 给当前有界视图及替换；`readItem` 取全文分块。当前队列预览尚未限界，不能把正文限界成果套到整个视图上。
- T03 即时输入使用当前 Host owner + Session + inputId 算出内部 Run 地址，可直接从既有 Run status 找同 Host 接受事实，没有新建持久输入索引。摘要已包含文本与 delivery。
- canonical user entry 携带 inputId；批量 entry 新增 inputIds。保存后才启动 Provider，沿既有 lineage 创建函数合入新消息。
- 临时 Session 的 lifetime 由 Host 持有；内部 deleteTemporary 共用已有删除路径、真实运行检查和资源清理。UI detach 不转移责任，未知执行结果不能被当作安全删除依据。
- 产品输入现按合并后的 Session agentMode 派发：SA→coding，AMA/default→managed_task；旧 Runtime start 的默认没有一并改变。
- 配置/MCP 必须影响真正执行的实例。CLI 原 bootstrap 已提取到 host-integrations，裸 Host 持有自己的实例/watcher；私有 Session MCP 不能替换共享全局实例。

## 4. 避坑墓碑与环境

### 已踩过、不要重复的错误

- 把用户的 0.1.47 当成新版本重做设计。目标已明确是 0.7.97。
- “把新 messages 放进旧 lineage 对象”会让新 canonical 输入不进入有效历史；必须使用既有 `createSessionLineage(messages, previous)`。
- 临时 Session 的 runtimeInfo 会被执行快照覆盖。当前 storage 修改只保留 Host-owned temporary:true；不要为此无条件合并全部 runtimeInfo，破坏其他字段清除语义。
- 较早取消已清空 record.start 后，迟到清理 Promise 不能只挂在旧 record.result 上；当前直接观察 completion 的修正已用 S2 验证。失败时保留 Session 并诊断，不能吞错或伪称删除成功。
- Client updateSettings 返回值变化、临时 MCP manager reload、把 AMA 用例实际上跑成 SA，都会制造假绿。现有 S1 特意检查实际 Provider 请求、真实 MCP child 和 runtime mode。
- AMA 主循环热更新后，压缩仍可能使用构建时的旧 Provider；该真实遗漏已经在 live slice 修复，不必另建控制框架。
- 完整 View 重发曾超过既有 8 MiB 帧限制。限界前后实验为 10.56M 字符：累计约 60 MB → 193,821 B / 22 views，最大 9,226 B，全文分块读回相等。但 RSS 增长仍约 142 MB，**没有明显内存改善**，且这不是发布版 Ink 渲染对照。
- 慢 socket 原来积压 500 个视图；现在仅对 session.view 每订阅保留最新待发视图，RPC 不应丢弃。不要把这种合并应用到普通 RPC 响应。
- 不要把所有共享文件一次 `git add`；T03/T04/T06/T12/T15 的 hunks 交错。部分提交应先审查暂存 diff；此前用基线内容加选定 hunk 重建 index，避免修改工作副本。

### 工具与检查

显式使用本 worktree 作为 cwd。PowerShell 的 `{protocol,schema}` 不是 bash 的文件展开。Python 读写源码一律 `encoding='utf-8'`，默认 GBK 曾失败。不得打印、探测 GitHub token；若以后授权 HTTPS 远程操作，直接非交互使用既有 `GITHUB_TOKEN`。

Node 路径：`C:/Users/ADMIN/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe`，版本 v24.19.0。

```powershell
$env:PATH = 'C:/Users/ADMIN/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin;' + $env:PATH
node node_modules/vitest/vitest.mjs run src/sdk-client.queue.test.ts --maxWorkers=1
```

npm 通过现有 bundled fallback 调用，项目仍是 npm workspaces，不能添加 pnpm 配置：

```powershell
$taskRuntimeRoot = 'C:/Users/ADMIN/.cache/codex-runtimes/codex-primary-runtime/dependencies'
& "$taskRuntimeRoot/bin/fallback/pnpm.cmd" dlx npm@10.9.8 <npm 参数>
```

依赖已安装。Windows native text/sandbox 已构建，位置 `dist/native/win32-x64`。Cargo 是 `C:/Users/ADMIN/.cargo/bin/cargo.exe`。

**root 原始 tsc 已有基线失败**：独立初始 checkout 与 T01/T02/T13/T24 后的比较均为 478 条，其中 288 条 TS6059、190 条其他既有诊断，彼时无实质新增。后续未提交修改不在该比较覆盖内，不能用“基线已坏”掩盖新错。支持的 `tsc -b tsconfig.build.json` / packages / bundle / dts gates 曾通过，当前必须重做相关检查；没有 root lint script。

留存的临时证据（不复制内容；不存在时不要据此判代码损坏）：

- `%TEMP%/kodax-type-baseline-536166af8ff74fdab7a3dcf1c3153c14/`：独立 baseline checkout、current-tsc.log、comparison.json、audit-summary.txt。若清理该 checkout，先检查注册 worktree 与目标范围，不盲删。
- `%TEMP%/kodax-late-cleanup-red.vitest.mts`、`kodax-late-cleanup-red.log`：严格恢复旧逻辑的 RED 证据。
- `%TEMP%/kodax-session-view-volume-before.json`、`kodax-session-view-volume-after.json`：上述实际 IPC 体积证据。
- `%TEMP%/kodax-live-settings-types.log`：live slice 检查时的捕获，不是当前全量结果。
- 根目录 `.tmp-t12-typecheck.txt`：agent 的中间类型诊断，包含后来已修复的问题；未提交、未在停止后清理。

若恢复 benchmark/eval 工作，先完整阅读 [benchmark/EVAL_GUIDELINES.md](../benchmark/EVAL_GUIDELINES.md)。前任 root 只读了前 165 行，inert_controls 读过全文；不要继承“root 已读完整”的错误假设。

## 5. 用户授权继续后的下一步

1. 读取本交接、正式规格及实现技能，检查主仓库和 submodule 状态，保留所有未提交代码。不要从头重建 T01/T02/T13/T24。
2. 从上述两个 T06 RED 恢复：先修明确 stop 后自动续跑，再给队列视图限界且保证取回全文。保持单一 Session gate，补投递与撤回竞争、保存失败和晚结算验证，不新增恢复状态机。
3. 收敛 T04 canonical conversation 来源、流式结算身份/去重及完整显示清单；目前 storage.load 最近上下文不能承接压缩前历史。与 T09 共享现有 conversationPage 接缝。
4. 收敛 T12 剩余实际效果与共享 MCP reverse Session 归属；先看实际上下文传播，不猜全局当前客户端。最新 catalog 类型先做新增诊断过滤与支持的 build 检查。
5. 对稳定基础按 `$code-review` 做独立 Standards / Spec，完成必要回归后提交。live slice 已双审，但共用产品测试依赖未提交 T03/T04，切分提交必须保持可构建。先提交 submodule 文档，再提交主仓库指针。
6. 更新正式票据的真实状态/证据，按现有 DAG 继续全部已选择核心票。SDK 基础可用不等于 Ink/classic、CLI、ACP/A2A、旧协议删除和性能门禁完成。全部选中票、最终测试及支持的类型/构建门禁完成前，不 bump 版本或声称重构结束。

## 6. 文件操作日志（只追加）

### 2026-09-05：实施与停止交接

**关键读取索引**：根 AGENTS；implement/tdd/code-review/handoff 技能；规格 v0.7.97 和 FEATURE_LIST；package.json/.gitmodules/构建入口；sdk-runtime 与 daemon；agent MessageQueue/types；REPL queued-prompt-sequence、pending-inputs、user-skill-invocation、invocation-runtime、repl/InkREPL 接缝；coding SA/AMA/provider/compaction 接缝。已提交变更的完整文件记录直接查上节提交与 `git diff --name-only a8f0eedc..HEAD`，不复制其设计或 diff。

**已修改、未提交文件**（停止时快照；多人的 hunks 共享这些文件）：

- `packages/agent/src/runtime/capability-cache.ts`；`packages/agent/src/types.ts`。
- `packages/coding/src/agent-runtime/run-substrate.ts`；`packages/coding/src/agent-runtime/stream-handler-wiring.ts`；`packages/coding/src/client-contract.ts`；`packages/coding/src/running-session.ts`；`packages/coding/src/types.ts`。
- `packages/coding/src/task-engine/runner-driven.ts`；`packages/coding/src/task-engine/_internal/managed-task/compaction.ts`；`packages/coding/src/task-engine/_internal/managed-task/llm-adapter.ts`。
- `packages/llm/src/providers/base.ts`；`packages/llm/src/types.ts`。
- `packages/repl/src/common/capability-probe.test.ts`；`packages/repl/src/common/capability-probe.ts`；`packages/repl/src/common/mcp-servers.ts`；`packages/repl/src/common/utils.ts`；`packages/repl/src/index.ts`；`packages/repl/src/interactive/storage.ts`。
- `src/kodax_cli.ts`；`src/sdk-client.ts`；`src/sdk-runtime.ts`；`src/sdk-runtime.config.test.ts`。
- `src/runtime-daemon/client.ts`；`src/runtime-daemon/protocol.ts`；`src/runtime-daemon/schema.ts`；`src/runtime-daemon/server.test.ts`；`src/runtime-daemon/server.ts`；`src/runtime-daemon/transport.ts`。

**新建、未跟踪文件**：

- `src/client-settings.ts`；`src/host-integrations.ts`；`src/session-input-queue.ts`；`src/session-view.ts`；`src/session-view-notices.ts`。
- `src/sdk-client.inputs.test.ts`；`src/sdk-client.inputs-late-cleanup.test.ts`；`src/sdk-client.queue.test.ts`；`src/sdk-client.observe.test.ts`；`src/sdk-client.lifecycle.test.ts`。
- `src/sdk-client.settings.test.ts`；`src/sdk-client.live-settings.test.ts`；`src/sdk-client.mcp.test.ts`；`src/sdk-client.capabilities.test.ts`；`src/runtime-daemon/transport.view.test.ts`。
- `.tmp-t12-typecheck.txt`（临时输出，不属于待交付源码）。
- `docs/HANDOFF.md`（本次停止后唯一新增交付文件）。

后续交接在这里追加文件操作和时间，不删除本条历史。正式实现状态仍由规格/FEATURE_LIST/提交事实维护。

### 2026-09-05（续）：T06、T07 完成并提交

用户授权继续 implement。本段会话从上一交接的两个 T06 RED 恢复，完成两张核心票；工作树停止时干净，全部改动已提交（本地，未 push）。

**提交记录**：

- `9c5f9ffd` — T06（Host 持有排队/合批/撤回）+ 交错的 T03/T04/T12/T15 未提交基础 + 类型对平修复。
- `ba6abc3`（submodule）/ `d55d6f48`（主仓指针）— 票据状态：T06 Done，T03/T04/T12/T15 状态行刷新（仍 In Progress，注明已验证部分与剩余项）。
- `4d24a5f7` — T07（steer/redirect/stop 区分）。
- `7247508f`（主仓指针，submodule 同批）— T07 Done。

**T06 要点**（详见规格票状态）：队列预览限界（72 字符 + `...`，正文只在 MessageQueue，withdraw 取回全文）；明确 stop 后 finishRun 不自动续跑；executor 终态回调 fallback 早于 Promise 事实时不续跑、晚到事实重新评估；任意完成 Run 释放 Session 后续队列；Skill 原文独立批边界（leading `/` 或行内 `/skill:`，语法级，展开归 T37）；MAX_QUEUED_INPUTS 命名；batch 单遍反查。评审：Spec 2 Low（已修），Standards 1 High 为误读（session.settings.updated 仍刷新视图，仅跳过历史重载，已加注释）；Standards 采纳修复含 SDK Host extension runtime activate()、enableElicitation 注释、daemon stub 补齐、provider.list Client 类型转换、inputs 测试 runId 收窄。

**T07 要点**：inputs.submit 新增 delivery `steer`/`redirect` + targetRunId；steer 走既有 interrupt 通道（AMA/managed Run 有窗口；SA 无 actorSession 显式 unsupported conflict，与现状一致）；redirect 先入队再以 `RUNTIME_REDIRECT_STOP_REASON`（"runtime run redirected by user"）abort 旧 Run，maybeDrainProductQueue 放行该 reason 的任意终态；digest 仅在含 targetRunId 时追加（保持旧摘要公式兼容）；abortRun/submitInterruptInput 逐字提取。评审双轴 0 Critical/High，Medium（steer 事实撤回文案）与 digest 兼容、cast、消息拆分、提取等已修。残留（票内已记录）：活跃中途窗口关闭分支与可取消工具中途 redirect 未单独 S1；产品 Client 无 Run 结果读取面（T08）。

**验证基线（本轮结束时）**：root tsc 与记录基线对平 478=478（%TEMP%/kodax-type-baseline-536166af8ff74fdab7a3dcf1c3153c14/ 的 compare-tsc.mjs，fresh log 为 current-fresh7）；`tsc -b tsconfig.build.json` 通过；steer 2、queue 5、inputs 7、inputs-late-cleanup 1、observe 3、lifecycle 3、daemon server/host/manager/transport 94+58 分批全绿；capabilities/live-settings/mcp/settings 6 项绿。`.tmp-t12-typecheck.txt` 已删除。

**下一步（DAG 前沿）**：T08（T07 已解锁；故障注入/进程终止 S1、工具身份先提交才派发）与 T04 canonical conversation（storage.load 最近上下文不能承接压缩前历史，与 T09 共享 conversationPage 接缝；完成后解锁 T05/T09/T10/T11/T32 大片）。T12 剩余：typed skill/command/extension/config-effective/diagnostics 实际效果、Session 私有 MCP 重启重建、共享 MCP reverse Session 归属。

### 2026-09-05（续二）：复审修复、T03/T08 完成并提交

用户要求：review 已完成部分并修复、确认剩余工作、连续 implement。全部本地提交，工作树停止时干净。

**提交记录**：`d79955e0`（T06/T07 提交后复核修复）、submodule/指针 ×2（票据记录）、`346dca61`（T08）、`b3b38549`（指针）。票据现况：**Done 8 张**（T01/T02/T03/T06/T07/T08/T13/T24），In Progress 3 张（T04/T12/T15），Todo 24 张。

**提交后复核（d79955e0）修复**：2 Medium——redirect 命中 executor 终态早退分支时先持久化 redirect Stop 理由（终态不再搁置保留输入）；steer 输入在目标 Run 未到安全点即结束时 acceptance 显式转 `dropped`（`ClientInputAcceptance` 新增该状态，schema 同步）。3 Low——`runs.abort` 纳入 Session gate；新增"取消真实生效"的 redirect S1（Provider 尊重中止、非 completed 终态仍续跑）；inputs 测试替换 Host 前先 close 旧 runtime。

**T08（346dca61）**：产品 Client 新增 `runs.read/stop`（复用 run.get/run.abort，stop 接受与终态分离、重复 stop 不建工作）；3 项故障注入 S1（`src/sdk-client.crash.test.ts`）：真实子进程 Host（ensureKodaXRuntime 拉起、锁 owner PID SIGKILL）+ OpenAI 协议 SSE mock Provider（首请求可脚本 bash tool_call、后续挂起）+ tee 写 marker 文件，分别在接受后/工具派发后（marker 出现）/工具结果进入后续上下文后（请求 2 到达）杀掉并 stale-lock 接管重启：内容保留、Run interrupted/unknown、工具与 Provider 不重做（双采样）。测试基建注意：mock server 需跟踪并销毁 socket 否则 `close()` 挂起 hook；场景 paths 注册到模块级列表供 afterEach 兜底杀 detached daemon；`RuntimeDaemonPaths` 无 `homeDir` 字段（重启要显式传原 homeDir/profile）。评审 0 Critical/High（清理加固、计数收窄已修）。结项说明见票面（list/await 留待 T19/T20/T26；完整回答≠成功由点位 3 结构性覆盖）。

**T04 恢复入口（调研已完成）**：剩余=canonical conversation 接线（SessionViewOwner 的 read 回调 `sdk-runtime.ts:4309` 现用 `storage.load` 的 messages.slice(-30)，压缩后早期历史丢失；接缝=既有 `conversationPage`（`sdk-runtime.ts:7601`，repl 层 `readConversationPageCache` 提供 revision/缓存页/容量错误/快照游标）+条目→ClientViewItem 投影）、流式结算去重及 ID 对齐、workflow/诊断显示清单、长会话/渲染基线。T12 剩余同上节。

**验证基线（本轮结束）**：tsc 基线对平 478=478（fresh10 log）；`tsc -b tsconfig.build.json` 通过；crash 3 + runs 1 + steer 3 + queue/inputs/daemon 回归全绿。

### 2026-09-05（续三）：T04 canonical 接线完成、T05 typed Interaction 完成并提交

用户要求继续连续 implement。全部本地提交，工作树停止时干净。

**提交记录**：`445da2f3`+`f5ad32d3`（T04 canonical conversation + 评审修复）、`718a3d7e`（T04 指针）、`73c9ef9`（submodule，T05 票据）、`b2f0ea90`（T05 实现 + 指针）。票据现况：**Done 10 张**（T01–T04、T06–T08、T13、T24、T05），In Progress 2 张（T12、T15——后者等 T17/T18/T25），Todo 23 张。

**T05（b2f0ea90）要点**：契约 `ClientInteraction` 判别联合（question/question_multi/question_input/permission；question 系 expiresAt 必填——RuntimeUserInputRequest.expiresAt 是必需字段）+ `ClientInteractionResponse`（含 cancel）+ `ClientInteractionResult` + `client.interactions.list/respond` + `ClientSessionView.interactions`。Host：`RuntimeInteractionService` 挂 `KodaXRuntime`（`sdk-runtime.ts` 工厂由 userInputs/permissions 注册表构成），视图 read 回调并入 pending interactions（bus 对 user_input.*/permission.* 事件本就无条件 `sessionViews.changed(sessionId, false)`，无需新增订阅）。Wire：`interaction.list`/`interaction.respond` 新 RPC（schema 验证 list 结果 base+kind、respond 的 kind 判别 + `permissionDecisionSchema` + result 形状；决策另有 `toRuntimePermissionDecision` Runtime 级 guard 双保险）；六个别名 RPC 进 retired 列表且错误消息按家族区分；scope 归 `interaction:respond`，`permission:respond` 旧 token 经 kind 检查保留"仅可答权限类交互"的向后兼容（`requireRuntimeMethodScope` 第三参 request）。daemon client 的 registry 形 facade（permissions.listPending/respond、userInputs.*）改为 interaction RPC 兼容层：runId/expectedRevision(恒 0) 绑定在 facade 强制、跨 registry id 显式无效（permissions.respond 对 question id 返 false、userInputs.dismiss 不碰 permission）、listPending 的 runId/toolName 过滤在客户端做（interaction.list params 只收 sessionId）。注意：`KodaXDaemonRuntime` 保持完整 KodaXRuntime 形状（曾试 Omit 造成 5 处 facade/测试破裂，回退为兼容层方案）。S1 测试技巧：ask_user_question 多题模式仍需顶层 `question` 字段（tool schema required，questions 才是执行优先）；accept-edits 下 bash 走沙箱自动放行，权限 S1 要用 write 工具打 `.kodax/` always-confirm 路径；`[Cancelled]` 前缀大写 C；服务端 runtime `invalid_input` 需在 interaction.respond handler 映射为 daemon `invalid_params`。

**评审（双轴 0 Critical/High）修复**：dismiss 跨 registry 泄漏、userInputs options 绑定丢失（a2a resume 传 expectedRevision/runId）、permission:respond scope 孤儿、retired 消息误导、interaction.list 结果/decision 无验证、cancel-on-permission 状态统一 dismissed、适配器去重（listInteractions/questionResponseFor/matchesUserInputBindings）、sdk-client 缩进、死 schema helper 删除、测试格式；新增并发双 Client 同时应答 S1（恰好一个 accepted）。

**残留（票内已记录）**：MCP form/url elicitation 未单独端到端 S1（复用 mcp-reverse 既有映射，随 T12/T19 验证）；exit_plan_mode UI-callback 审批在消费者路径（T17）；`src/sdk-runtime.test.ts` 10 项失败为分支预存（stash 对照确认，extension active 标记/诊断形状类，与本票无关，勿误判为回归）。

**验证基线（本轮结束）**：tsc 基线对平 478=478（fresh log 于 %TEMP%/kodax-type-baseline-536166af8ff74fdab7a3dcf1c3153c14/，注意 compare-tsc.mjs 只读预生成 log，需先跑 tsc 重写 current-tsc.log）；`tsc -b tsconfig.build.json` 通过（契约改动后必须先 build 再 root tsc，否则 dist 声明过期造成假错误）；interactions 5 + 产品 Client 各套件 + daemon 136 + transport 81 + crash 3 + a2a/upgrade 全绿。

**下一步（DAG 前沿，按阻塞关系现成可做）**：T09（公共分页读取，T04 已解）、T14（权限请求退役客户端任意创建，T03+T05 已解）、T32（goal/notice Host 写入，T04 已解）；T12 剩余（typed 核对、Session 私有 MCP 重启重建、共享 MCP reverse 归属）。T05 完成同时解锁 T14→T16 链。

### 2026-09-05（续四）：T09 公共分页读取完成并提交

**提交记录**：`2a9bd114`（T09 实现）、`2d75ad1`（submodule 票据）+ 主仓指针。票据现况：**Done 11 张**（T01–T05、T06–T09、T13、T24），In Progress 2（T12、T15），Todo 22。T09 完成解锁 T10/T11/T33。

**T09 要点**：`sessions.readHistory/readHistoryEntry/searchHistory` 骑既有 conversationPage/entryChunk/transcriptSearch 接缝（零新持久化、只读）；共享投影 `src/client-history.ts` —— 条目 id `<sid>:history:<rev>:<idx>[#ord]`（revision 含 `sha256:` 冒号，解析从右起）；**assistant tool_use 必须与其 user tool_result 后继配对投影**（repl 的 toolResults 从 messages[index+1] 取；后继仅在当前条目为 assistant 且后继为 user 时参与，否则 assistant 后继会被重复投影成 INCOMPLETE 假工具项）；正文/工具参数读原始块（回放投影有 2000 字符截断）；`readHistoryPageWithBoundaryRetry` 共享一次性瞬态边界重试（fresh-only；游标读直接 stale）；两 facade null 页抛错、解码失败/512 块上限发诊断并抛 internal_error。契约改动后先 `tsc -b` 再 root tsc。测试载体：oversized 用 >128KiB 助手正文（MAX_RUNTIME_TRANSCRIPT_INLINE_ENTRY_BYTES=128KiB、页 512KB、默认 50 条）；工具轮 full-access 下 bash 可直跑。

**评审教训**：Spec 轴抓到真 Critical——单消息投影丢工具配对（tool_use 无 tool_result 时 repl 降级 60 字符 ⚡摘要、oversized 工具结果读回空）；Standards 轴抓到 ordinal*100 id 碰撞。投影类功能必须用真实工具轮 S1 验证。

**验证基线（本轮结束）**：tsc 478=478（fresh log）；build gate 通过；history 2 + daemon client/server/host/schema 135 + observe×2 + interactions 5 全绿。

**下一步（DAG 前沿）**：T10/T11（T09 已解：按历史派生新 Session、旧会话打开续用 canonical 写权）、T33（会话写权收归 Host）；T14（T03+T05 已解：权限请求退役客户端任意创建）、T32（goal/notice Host 写入）；T12 剩余（typed 核对、Session 私有 MCP 重启重建、共享 MCP reverse 归属）。

### 2026-09-06：T32 Session goal/notice Host 写入完成并提交

**提交记录**：`ebaf01ce`（T32 实现）、`4e8ad11`（submodule 票据）+ 主仓指针。票据现况：**Done 12 张**（T01–T05、T06–T09、T13、T24、T32），In Progress 2（T12、T15），Todo 21。T34 仍需 T10/T11/T23/T31/T33/T36/T37。

**T32 要点**：`sessions.readGoal/createGoal/pauseGoal/resumeGoal/clearGoal/appendNotice`；Host 命令在 `mutateActiveSession`（per-session gate）内改 lineage + `manager.storage.save`；领域策略抽到 `packages/coding/src/goal/policy.ts`（planGoalCreate/planGoalTransition，同时从 goal barrel 和包根 index 导出——**包根 index.ts 是显式再导出清单，新导出必须同时加两处**）；Wire 五个 `session.goal.*` RPC（get 结果 nullOrObjectSchema——readGoal 可返 null，objectAnySchema 会拒；读 scope=session:observe）。**关键领域事实**：goal 条目 parentId 锚到 activeEntryId，`readLatestGoalFromBranch` 跳过 parentId===null → 空会话（无任何对话条目）上的 goal 永远不可见（REPL 全新会话 /goal 是静默丢失的存量缺陷）；Host 端以显式 conflict 拒绝空会话建 goal。verifier 门（complete）不暴露。测试坑：Windows named pipe 路径在测试里必须用 `'\\.\pipe\name' + uuid` 单引号拼接（模板字符串里 `\.\pipe\` 的 `\p` 会被吃掉）；coding 包 dist 过期时 root tsc 假绿——契约/导出改动后先 `tsc -b tsconfig.build.json` 再跑测试。

**评审（双轴 0 C/H）修复**：补并发 create 竞争 S1（Promise.allSettled 恰一成功）与同存储根 Host 重启 S1（goal 可读、零 Run 复活、requests 计数不增）；共享 planner 抽取（第三真实调用方）；notice 后断言零 Provider 调用；ReturnType 形态/重复字段提取等 polish。

**验证基线（本轮结束）**：tsc 478=478；build gate 通过；goal 4 + daemon client/server/host/schema 165 + observe/queue/history/interactions 回归全绿。

**下一步（DAG 前沿）**：T10/T11（T09 已解）、T33（T08+T09 已解）、T14（T05+T13 已解）；T12 剩余；T34 前置还差 T10/T11/T23/T31/T33/T36/T37。


---

## 2026-09-06 会话补记：T11 完成（Host 管理分支选择、标签与 rewind）

**提交**：代码 `09552b5d`（10 文件 +365/-11）、子模块 `419918e`（T11→Done，13/35）、指针 `9ec18e91`。

**实现面**：契约 `ClientLineageSummary/Entry/LabelInput`（entry.type 收紧为域判别联合 `KodaXSessionEntry['type']`；rewind marker 透出 `truncatedCount`）；sessions 增 `readLineage/labelEntry/selectBranch/rewindSession`；RPC `session.lineage.get/label`（nullOrObjectSchema/objectAnySchema、读 scope=session:observe、写 scope=session:write）。**关键决定**：`session.lineage.label` 同时进 `RuntimeDaemonMutationMethod` 联合与 `RUNTIME_DAEMON_MUTATION_METHODS` 数组——facade 自动带 operation envelope、Host journal 去重（与 rewind/active_entry.set 对齐，重连重试不会双写 label 事实）；goal.* 只在联合不在数组（T32 的既有豁免）保持不动。Host 复用 `appendSessionLineageLabel` + `mutateActiveSession` 门；selectBranch/rewind 未命中显式 conflict；空/空白 label `invalid_params`（域函数把 '' 规范成 unlabel 是静默坑，必须在 runtime 面挡住——去 label 只能省略字段）。

**评审（双轴 0 C/H）修复**：protocol 重复联合成员删除；`lineageCommandError` 并入 `goalCommandError`；goal S1 通知断言从 `conversationalRequests()===0`（空转）改 `nonJudgeRequests()===0`（judge 帧=单条 user 消息且 content 以 '{' 开头——`invokeLlmJudge` 的 systemPrompt 走独立参数不进 messages）；lineage S1 补 label-by-label 名、空 label invalid_params、rewind 后归档 head 的 stale 选择冲突、rewind marker truncatedCount 与保留条目断言。

**测试坑（新增）**：背景 learning-review 帧污染 provider requests 计数——过滤方式按帧形状（judge 帧）或按会话暖场文本前缀，不要用裸 `requests.length`；Edit 工具改 union 列表时相邻两个 union 含相同序列，必须带足够的后续行消歧。

**验证基线（本轮结束）**：build gate 通过；lineage 2 + goal 4 双绿；daemon 20 文件 343 绿（1 skip 存量）；product-client 9 文件 20 绿（client/settings/capabilities/mcp/goal/lineage/observe/queue/history）；tsc 478=478。

**下一步（DAG 前沿）**：T10（T03+T09 已解）、T33（T08+T09 已解）、T14（T05+T13 已解）；T12 剩余（typed 核对、Session 私有 MCP 重启重建、共享 MCP reverse 归属）；T34 前置还差 T10/T23/T31/T33/T36/T37（T11 已解）。

---

## 2026-09-06 会话补记：T10 完成（按完整历史或安全摘要派生新 Session）

**提交**：代码 `2d60735b`（9 文件 +363/-15）、子模块 `977c5c4`（T10→Done，14/35）+ 指针。

**实现面**：契约 `ClientSessionForkInput/RecoverInput` + `sessions.forkSession/recoverSession`；RPC `session.recover` 四处入册（method 联合/数组 + mutation 联合/数组→信封+journal）、`session.fork` dispatch 补 `assertAdmittedSessionId`。共享接缝 `finalizeDerivedSession`：settingsOwner 读源 versioned 设置→`persistence.saveSessionSettingsVersioned` 写新 id（**关键：设置按 session id 持久化，不拷贝则派生会话拿到默认设置**）+ `session-derivation` 来源 notice（写失败显式冲突，领域函数吞错返 null 必须挡）。fork 复用 `forkSession`/`storage.fork`；recover 复用 `buildRecoverySeed`（深路径 `@kodax-ai/agent/session-lineage`，注意 root barrel 不再导出 session-lineage 符号但 `createSessionLineage` 例外在 root——同符号两处 import 会 TS2300）。

**领域事实**：`forkSessionLineage` 重新生成 entry id（断言比结构不比 id）且丢弃不可 fork 元数据（memory_outcome_digest）；背景 learning-review 会写 digest 条目；recover 的 seed 是单条 `_synthetic` system 消息，view/history 投影不显示——seed 只能靠续聊请求内容断言。

**评审（双轴 0 C/H）修复**：notice null 检查（M）；`goalCommandError`→`sessionCommandError` 更名（13 处，goal/lineage/derive 共用）；recover 丢弃 extensionState/Records/errorMetadata 对齐既有 UI 行为；不可解析 selector 显式 conflict（原为静默全量拷贝，存量行为但 T10 面上必须显式）；S1 补 unknown-selector/active-source-recover/recover 来源 notice。

**基线**：sdk-runtime.test.ts 10 败为 HEAD 既有（stash 对照逐一一致，extension inventory 等域），与本票无关；本轮结束 tsc 478=478、daemon+fork 触面 400 绿、product-client 28 绿。

**下一步（DAG 前沿）**：T33（T08+T09 已解）、T14（T05+T13 已解）、T12 剩余；T34 前置还差 T23/T31/T33/T36/T37（T10/T11 已解）。

---

## 2026-09-06 会话补记：T33 完成（旧 Run 保守可读，终止旧恢复引擎）

**提交**：代码 `1c511123`（3 文件 +204/-166）、子模块 `3f7a2d5`（T33→Done，15/35）+ 指针 `4af0a54e`。

**实现面**：删除 `recoverPersistedDurableTerminal`/`reconcilePersistedInterruptDeliveries`/`terminalPhaseFromEvent` 与启动回路调用块——读路径不再从 Runtime event 推导 status/delivery；`interruptPersistedNonTerminalRun` 成唯一保守格式入口（两处调用：启动回路 + 死 owner 迟检）。既有 terminal status 经 `saveRunStatus` 守卫拒绝降级（terminal+queued 输入的存量组合不回写）。T08 的 status 文件权威模型保持。

**关键排查**：全量跑 sdk-runtime.test.ts 出现第 11 败 "keeps parallel active tools"（隔离跑过、HEAD 全量过）——根因是两个旧引擎契约测试先失败泄漏 runtime/定时器改变后续时序；把两测试重写为保守契约后该败自愈。教训：**删引擎类改动先重写防御旧契约的测试，再判断其它失败是否真回归**。ClientRunStatus 无 terminal 字段——queued/running 区分用 `error` 码（runtime_restarted=未执行 / daemon_crashed=中断未知）。

**评审（双轴 0 C/H）修复**：`let normalizedStatus`→const；`reconciledStatus=status` 别名删除；legacy 测试 teardown 按 runs.test 硬化（allSettled+可选链）；corrupt 拒绝消息 pin 到 /Runtime run not found/；test 1 历史改字节等值。Spec 评审实证：terminal+queued 存量组合不被降级（saveRunStatus 守卫）。

**基线**：tsc 477=478-1（被删 reconcile 调用上的一条基线 TS2322 随之消失——删除类改动可以合理减少基线错误）；sdk-runtime.test.ts 10 败=HEAD 既有；daemon+产品面 30 文件 373 绿。

**下一步（DAG 前沿）**：T14（T05+T13 已解）、T12 剩余；T34 前置还差 T23/T31/T36/T37（T10/T11/T33 已解）。

---

## 2026-09-06 会话补记：T14 调研地图（未实施，工作树干净）

**现状**：Done 15/35（T05/T09/T32/T11/T10/T33 等已提交）。本轮完成 T11（09552b5d）、T10（2d60735b）、T33（1c511123），均含双轴评审与全部修复。

**T14 — 产品 Runtime 只安装一个权限 authority 调研结论**：

1. **批准竞争（删除目标）**：`src/sdk-runtime.ts` beforeToolExecute 内 20026-20049 —— 同时存在 in-process host hook（`original.beforeToolExecute`）与 runtime 权限请求（`permissions.trackAndWait`）时 `Promise.race` 双路裁决，先答者赢并回写另一侧。T14 要求单一 authority：有 hook 时 hook 权威、无 hook 时权限请求权威。
2. **三组键注册结构（删除目标）**：`allowedCalls`/`pendingHostReviews` 两份（`createRuntimeOwnedAutoModeGuardrail` ~23700、`createRuntimeSessionAutoModeGuardrail` ~23792）；`record.forcedPermissionCalls`（类型 3638、初始化 10961、消费 19910、注册 21772 `requestRuntimeForcedPermission`）。流向：guardrail.beforeTool 对 bash 预注册 key → beforeToolExecute `consumeAllowedCall` 消费；沙箱边界升级先 `forcedPermissionCalls.add(key)` 再以 hook 重建准入（accept-edits/auto 的 OS sandbox 预试失败路径，19927/19958-19963 的 forced receipt 注释）。替代方案（票面"直接传当前 call/context"）：每个裁决点把当前 call/context 直接送一个 authority，不做 key 预注册+消费。
3. **保留面**：`permissions.isGranted` 短路（19974，正常已允许不进 reviewer 已有）；显式政策查询/精确撤销走 `permission.grants.revoke`（T05 领域身份，不要求 operation receipt）；独立 coding embedder 仍可提供 Host 端口；不新增 Permission Engine。
4. **实施前必须先追踪**：`original.beforeToolExecute` 在产品 daemon Host 路径是否真的存在（plugin/extension host hook——S1/S2 有"插件拒绝"场景；T12 提到 extension 反向桥）。若产品面无 hook，race 为死代码可安全删；若有（extension runtime），需保留 hook 权威序贯化并验证取消后晚答不重启动作。
5. **S1/S2 清单（票面）**：确切动作绑定、插件拒绝、取消后晚答不重启动作、既有显式政策查询/精确撤销（领域身份）。

**下一步**：从 `original.beforeToolExecute` 的接线处入手（run substrate / coding start options events / extension runtime host hook），确认产品面 hook 存在性后写 T14 RED（src/sdk-client.permissions.test.ts 或扩展既有 T05 套件），再按 1→2→4 顺序实施。

---

## 2026-09-06 会话补记：T14 完成（产品 Runtime 只安装一个权限 authority）

**提交**：代码 `c0050749`（12 文件 +485/-714）、子模块 `751c410`（T14→Done，16/35）+ 指针 `83a97cce`。

**实施面**（按 HANDOFF 调研地图）：(1) 竞争删除——hook 在场则 hook 单独裁决（不再 trackAndWait，双端只见一个请求），headless 走共享 `authorizeTrackedPermission` 闭包（相位管理+trackAndWait+错误时 reject）；(2) forcedPermissionCalls→`wrapKodaXEvents` 复合返回 `{events, authorizeForcedPermission}`，升级直接传当前 call（buildRunOptions 线程传递）；(3) auto-mode 深删——owned wrapper 整体删除、cache 直存 bootstrap guardrail、dispatch 上下文按 runner call id 存 Map（**评审纠正：单槽在多 bash 并发 prepare 下互相覆盖，必须按 call-id**）、准入信任引擎裁决；(4) `permission.request` wire RPC 退役（协议四处+schema+scope+dispatch+facade 本地拒绝），runtime 服务方法保留给 Host 内部。

**测试坑**：python heredoc 里含 `EOF` 类内容会提前终止——复杂补丁一律先 Write 临时脚本再执行；`s.rfind('it(')` 会命中 "emit(" 里的 "it("——定位测试块用完整标题 find；tsc 错误 grep 必须看全量（head 截断漏过 TS2304，评审者抓到）——用 compare-tsc.mjs 的 JSON 而非裸 grep 计数。

**评审（双轴 FAIL→修复后通过）**：悬挂 `currentGuardrail = undefined`（High，我删了声明漏了赋值，且自检 grep 截断没发现——教训：评审者的 tsc 实跑可信）；单槽 currentDispatch 并发 unsound（M，tool-dispatch 串行 prepare 全部 bash 后才执行）；permission.request 退役是票面 API 表分配给 T14 的（Spec 抓到 docs:986 行）；S1 补 toolName+preview 绑定断言。

**基线**：tsc 477（=478-T33 已消的一条，无新增）；sdk-runtime.test.ts 10 败=HEAD 既有；"keeps parallel active tools"/"managed turns canonical" 为间歇性顺序 flake（隔离绿，T33 会话已证前者）。

**下一步（DAG 前沿）**：T12 剩余（typed 核对、Session 私有 MCP 重启重建、共享 MCP reverse 归属）；T34 前置还差 T23/T31/T36/T37；T26 需 T17/T18/T19/T21/T35。

---

## 2026-09-06 会话补记：T14 收尾后 T12 剩余 refined 地图（未实施，工作树干净）

**T12 剩余三块 refined 调研**：

1. **Session 私有 MCP 重启重建**：`createSession` 在 session 创建时调 `integrations.createSession(sessionId, cwd, input.mcpServers)`（sdk-runtime ~7613，失败/异常路径已 release ✓），但 `KodaXSessionData` 无 mcpServers 字段——**配置未持久化，Host 重启后私有 MCP 资源丢失**。方案：Host 侧持久化（`runtimeDir/session-mcp/<enc(sessionId)>.json` 侧车，Host 拥有资源生命周期），启动时对每个存在侧车的 session 重建 `integrations.createSession`；delete/archive/release 时清理侧车。`createHostIntegrations.createSession` 的失败清理（dispose on error）已有，但注意 `sessions.set` 在 replace 成功后才执行——失败时 runtime 已 dispose ✓。
2. **共享 MCP reverse 请求的 Session 归属**：全局共享 server 用 `buildMcpReverseCapabilities({ cwd: process.cwd(), enableElicitation: true })`（host-integrations.ts:40）——共享 server 的 elicitation/host-tool reverse 请求不带 session 身份。归属点：run 执行期间共享 server 的 reverse 请求需绑定当前 run 的 session（reverse capabilities 需要可变的 per-run session 上下文，或在 coding 的 reverse bridge 分发处附加当前 session）。US20 同时要求"关闭/重载一端不误关其它资源"——releaseSession 只 dispose 本 session runtime ✓（combineExtensionRuntimes(session, global) 结构已隔离）。
3. **typed 核对**：S1 断言 catalog.skills/commands 反映真实 Host extension runtime（含 per-session 合并视图）、config-effective 反映真实 reload、diagnostics 真实 Host cache（probe/reset 已有 T12 前段工作，sdk-client.capabilities/mcp.test 已存在，先查缺口再补）。

**下一步**：按 1→2→3 顺序实施（1 自包含可先行），每块独立 S1；T12 完成后 Done 17/35。
---

## 2026-09-06 会话补记：T12 完成（设置、能力发现和配置重载由 Host 生效）

**提交**：代码 `ccd3acc7`（9 文件：agent runtime+call-context、coding 契约、sdk-runtime/client、三个新 S1 测试）、子模块 `6377bef`（T12→Done，17/35）+ 指针 `e3349e84`。

**三项交付**：

1. **Session 私有 MCP 侧车持久化**：`<persistence.runtimeDir>/session-mcp/<encodeURIComponent(sessionId)>.json` = `{version:1, workspaceRoot, servers}`。启动扫描：未知/损坏 GC（非 ENOENT 读错误→runtime.mcp warn 诊断；损坏 JSON/decode 失败删除继续，不崩 Host 启动；杂项条目 recursive 清除）；已知重建、archived 跳过。delete 在 deleteOwned 成功后移除记录（失败路径 journal 已有 restore）；archive→releaseSession 保留记录、unarchive→rebuild；rebuild 失败诊断+GC。
2. **共享 MCP reverse 的 Session 归属**：关键洞见——elicitation 在 stdio receive 回调上下文触发，**不在 run 的 async 链上**，普通 AsyncLocalStorage 包 codingOperation 不传播。解法：`packages/agent/src/capabilities/mcp/call-context.ts`（runWithMcpCallContext/getActiveMcpCallContext），agent MCP runtime 在 sendRequest 时按 pending 请求捕获上下文、server→client 派发时 `pendingCallContext()` 重入（零/混上下文→undefined fail-closed）。Host 侧 sharedElicitSurface（setActiveUserInteraction）把 elicitation 映射为所属 Session 的 question_input/question 交互；prompt-context signal 被尊重（raceElicitAbort：deadline abort→立即 dismissed；registry 交互按自身 phase timeout 收尾，无外部 dismissal handle——已知边界）。
3. **typed catalog**：契约 `catalog.commands(workspaceRoot)`/`catalog.skills({userInvocableOnly})` + `ClientCommandInfo`/`ClientSkillInfo`（source=registry-origin 词汇表，String() 前向兼容）。

**S1**：src/sdk-client.mcp-restart.test.ts（双 Host 重启重建/GC/archive 往返）、mcp-elicit.test.ts（自定义 eliciting stdio server：initialize 带 elicitation 能力、tools/call 发 `elicitation/create` 且 **param 键是 `requestedSchema` 不是 `form`**、echo `elicit:<action>:<name>`；provider 触发 mcp_call → 交互携带 sessionId 归属 + 双 Client 依次应答）、catalog.test.ts（真实 Host typed 形状 + **config patch→另一 Client reload→read 观察到生效值**）。

**评审（双轴 PASS 带修复）**：M1 静默吞错→分类诊断；M2 decode 崩溃面；F4 recursive；F5 delete 后置；F2 signal 转发；F3 config-effective 强化；L1 注释序、L2 store 形状（persist/remove/rebuild 一对象）、L4 export 走 capabilities/mcp/index（agent 顶层 index 的直连 block 删除——git 里 index.ts 因此无 diff）、L5 source 词汇文档、L6 sentinel 文档、L7 let→const（decodeSessionId helper）。

**基线**：tsc 477 对平（compare-tsc.mjs：仅 truncate/sandbox TS6059、host.test run.completed、sdk-runtime TS2322@4498/TS2345 行移对）；sdk-runtime.test.ts 10 败=stash 对照确认预存（"managed turns canonical"/"parallel active tools" 本次全量首跑败一次、隔离+复跑均绿=flake，T33 会话已证同类）；agent mcp 181 绿；build gate 绿。**compare-tsc.mjs 在基线目录内**（%TEMP%/kodax-type-baseline-536166af8ff74fdab7a3dcf1c3153c14/），输出两段 JSON（先 summary 后 detail）——直接 require 解析会炸，分段读。

**T12 残留（票面已注明，随 T16/T19 消费者补）**：extension-sourced command S1、损坏记录 warn 诊断 S1、createSession 失败 dispose S1。

**下一步（DAG 前沿）**：T34 前置 T23/T31/T36/T37；T26 需 T17/T18/T19/T21/T35；T15 收尾等 T17/T18/T25。

---

## 2026-09-06 会话补记：T16 完成（凭据、Host Tools 和附件归可信 Host）

**提交**：代码 `c251642a`（sdk-runtime fingerprint + 新 S1 测试）、子模块 `8b57026`（T16→Done，18/35）+ 指针。

**调研结论（Explore 代理）**：三子句中两子句是此前切片已交付——凭据 resolver（daemon 侧 v1/v2 credential lease + `runWithProviderCredentialLease` AsyncLocalStorage 逐 wire 取密 + 错误脱敏；embedded runtime 故意不支持 `credentials`/`hostTools`）与 host-tool 桥断开语义（reverse-bridge：未派发→`host_tool_unavailable`、已派发→`host_tool_unknown`，durable invocation 状态 prepared→not_dispatched/dispatched→unknown 恢复映射=不重放）。缺口只有**附件引用诚实性**：artifact 只在注册时 stat，丢失文件在执行深处失败或静默变成 wire 占位符（llm `MISSING_IMAGE_PLACEHOLDER`——对历史回放是有意设计，不能在 serializer 层改），改写内容被无声当新内容消费。

**实施**：`createRuntimeArtifactStore` 内部 `fingerprints` Map（size+mtimeMs，与 artifacts 同生灭），`resolve()` 重 stat：不可读/非普通文件/漂移分别拒绝；resolve 被 `normalizeRuntimeRunInput` 在 runs.start 准入与 run input 入队两处调用（artifact_ref 无其它入口）。无内容快照（票面边界）；同 mtime tick 同尺寸改写、准入后漂移为已注释的尽力而为边界。

**S1 关键坑**：runtime-registered provider（registerModelProvider）**过不了媒体门**——`getModelInputCapabilities` 只认 official openai/anthropic、source-backed 路由或 custom provider 的 `imageInput:true`，且 registerModelProvider 与 custom-registry 同名互斥。解法=crash 测试模式：config.json `customProviders`（protocol openai + imageInput:true）+ 本地 SSE 服务器；**SSE 帧必须** content chunk(null) + `chunk({}, 'stop')` + `[DONE]`，缺终帧报 invalid_response/mid_stream_text；`data:` 前不能有空格。完好引用断言 PNG base64 出现在真实 HTTP 请求体。双轴评审双 PASS（Standards M1 边界注释/M2 清理起点+L1-L6；Spec 确认准入为正确 seam、无遗留子句）。

**回归**：新 S1 + daemon 55 + a2a 66 + sdk-runtime 10 预存败 + tsc 477 无键漂移（对 t12-final 日志 diff 键集=0 增 0 删）。

**T16 解锁**：T19/T20/T22/T30/T31/T35/T36 全部 actionable（T36/T31/T35/T30/T22/T20/T19 仅原被 T16 阻塞）。下一前沿从这些票里选；T34 仍差 T23/T31/T36/T37，T26 仍差 T17/T18/T19/T21/T35。

---

## 2026-09-06 会话补记：T16 + T23 完成（19/35）

**T16**：代码 `c251642a`、子模块 `8b57026`。附件引用诚实性（详见上一条记录）；解锁 T19/T20/T22/T30/T31/T35/T36。

**T23**：代码 `da600df5`（+596/-44 净删）、子模块 `71fb10e`、指针已提。/learn 无 binding 直接 proposal-store fallback（读+**写**）全删，统一报 unavailable；Ink openLearningCenter 静默返回改可见通知；领域函数留 agent 包；/skill|/workflow pending 只读列表保留（Spec 确认 defensible：从不写、同源 store、不在 T23 动词表内）。10 个 fallback 测试删除换 1 个 11-子命令循环断言。双轴双 PASS（修复：遗留 import/inbox 提示语/snapshot EOL 复原）。回归：repl 2614 绿、tsc 477。**坑**：Git Bash heredoc 里 `\n` 与行尾 `\` 会被改写——复杂补丁必须 Write 工具落 .py 再跑（本票又踩两次）。

**DAG 前沿（19/35）**：actionable=T15(收尾)、T19/T20/T22/T30/T31/T35/T36/T28(opt)；T37 需 T22；T34 需 T23✓/T31/T36/T37；T26 需 T17/T18/T19/T21/T35。建议下一票：T22（解锁 T37→T34 链）或 T31/T36（直接喂 T34）。

---

## 2026-09-06 T22 refined 调研地图（未实施，工作树干净）

**缺口本质**：daemon 模式下 `/workflow` 每次调用自建本地 manager+Lifecycle（workflow-command.ts:241-248 getDefaultWorkflowRunManager + createWorkflowLifecycleController；builder:185 同样 fallback；completer command-arguments.ts:477），只看得见本进程启动的 run；Host 侧 RuntimeWorkflowService（sdk-runtime.ts:3339, impl 11935-11977，也包同一个 coding 单例）只有 list/get/subscribe/pause/resume/stop——**无 start/结果读**。embedded 模式靠同进程巧合工作。

**核心难点**：`RunWorkflowFromOptionsInput` 携带不可序列化 `module: WorkflowModule` + `options: KodaXOptions`（workflow-runner.ts:392）——daemon RPC 不能直传。Host 侧 start 必须自己做受信模块解析（builtin/saved 名或 sourceRunId rerun → Host 内 resolve），client 只发名称/参数——这正是 T37 的主题，T22 需先行一小步。解析助手（prepareSavedWorkflow/loadGeneratedWorkflowFromRun/discoverSavedWorkflows/getBuiltinWorkflow）目前在 repl 侧 import——需确认真身在哪包、能否 Host 复用。审批 confirm/live emitter/locale/eventSink 是 UI 关注点，留 client。

**实施切片建议**：① Host 服务+RPC+schema 增 serializable start（名称/rerun 引用+args，Host 内解析 module+KodaXOptions，返回 runId）；结果读经 get(WorkflowProcessSnapshot 含 resultSummary/error)。② product client 契约 + sdk-client proxy 增 workflows 面（仿 catalog）。③ workflow-command 的 runs/show/pause/resume/stop 改走 callbacks binding（仿 T23 learning binding：repl-learning-binding.ts 先例）；builder/completer 同改；删除本地控制分支。④ S1=sdk-client.queue 模式双 client：A start→B list/get 可见、B pause→A 可见、B stop→双端 terminal+结果可读；US23 保真=workflow-command.test.ts save/rerun 与 waitForFinalAssistantMessage 路径保持绿。**不要删**：coding 的 WorkflowLifecycleController/run-manager 领域码（Host 消费）、workflow.started/updated/finished 独立事件 API（boundary 条款）、run.json 持久格式。

---

## 2026-09-06 会话补记：T31 完成 + T22 地图（20/35）

**T31**：代码 `ea4bd3fe`、子模块（20/35）、指针已提。①凭据身份：server.ts compact 派发铸造 `compact_<uuid32>`（仿 trustedRunId），operation_required 删除，journal envelope 纯去重。②队列释放：compact 分相（短准入持 gate→登记占用→模型调用 gate 外→finally 释放+ended）；占用集工厂级共享，run 准入（startRun+input.submit）与 goal/notice 写入断言，settings 更新保持 live。S1：server.test 接真实 control journal（铸造身份/越权/重放零重复）。**双轴教训**：Spec 初判 FAIL 的 High 是我自己挖的——释放 gate 后 run/notice/goal 写入可与压缩整链 commit 交错被静默丢；修复=占用集上提+run 准入断言。**坑**：mutateActiveSession 里 blanket 断言会打断 run 中 live settings 更新（4 测试红）——断言只放 goal/notice lineage 写入点，settings 不占。残留：runtime 级 admission/失败 S1（需挂起模型调用接缝）、冲突文案未区分压缩、缩进余留。

**T22 地图**已在上一条 HANDOFF 记录（Host start 需受信模块解析，module/KodaXOptions 不可序列化）。

**DAG 前沿（20/35）**：T34 还差 T36/T37（T23✓ T31✓）；T37 需 T06✓/T22；actionable=T15收尾/T19/T20/T22/T28opt/T30/T35/T36。建议：T36（直接喂 T34）→ T22（解锁 T37）→ T34 收口在望。

---

## 2026-09-06 T36 续做地图（WIP 未提交，工作树含未完成改造）

**已完成**：① coding 新增 `deriveCodingMemoryIdentityFromRoot(configHome, cwd)` 纯根派生（deriveCodingMemoryIdentity 已重构为委托它；coding index 已导出）。② 新文件 `src/runtime-memory.ts`：createRuntimeMemoryService({configHome, defaultProvider})，按 projectRoot 缓存 plane——Host 派生身份（projectId 恒有→resolveScopedMemoryRoot）、createMemoryControlPlane、listReviews（双 projectId 探测+去重排序）、reviewerProviderConfigured（Host 侧 resolveProvider）、rebuild（readTopicFiles+写 MEMORY.md 已移入 Host，返回结构化 result）、ensureOpenTarget（mkdir+realpath 包含校验）。③ sdk-runtime：`runtime.memory` 字段+构造（configHome/defaultProvider），类型 re-export；import 经 tsconfig 路径引 src 文件会 +2 TS6059 rootDir 归因（族内 benign，非新族）。④ repl：types.ts 增 `callbacks.memory?: (projectRoot) => MemoryCommandPlane`（结构化接口：controller/memoryRoot/entrypointPath/listReviews/reviewerProviderConfigured/rebuild/ensureOpenTarget）；memory-command.ts 已改造——createMemoryCommandRuntime 用 callbacks.memory（无 binding 报 unavailable）、status reviewer 分支走 plane、listEpisodeReviews 走 plane.listReviews、rebuild→plane.rebuild() 打印 result、open→plane.ensureOpenTarget（编辑器启动留 UI）；已删 createMemoryControlPlane/deriveCodingMemoryIdentity/ReviewIdentities/resolveMemoryRoot/resolveScopedMemoryRoot/listPendingEpisodeReviewSummaries/resolveProvider 导入与 rebuildMemory/writeFileSync 直写；readTopicFiles/formatMemoryError/resolveCwd 以只读展示形态保留。⑤ kodax_cli.ts:5777 区已接 `memory: (root) => interactiveRuntime.memory.forProject(root)`。⑥ repl tsc 绿；memory-command.test.ts 已接 plane fixture（真实 controller+本地镜像 rebuild/openTarget）。

**未完成（下窗从这里继续）**：memory-command.test.ts 剩 8 败——根因疑似 **scoped store 与旧 unscoped 扫描语义差异**：旧测试直接向 memoryDir 写 .md 期望 listRefs 扫描可见；Host plane 恒用 scoped root+identity，controller 的 memdir listRefs 可能依赖 registry/manifest 而非裸文件扫描（`list reads accepted topic content` 败在 user_role 不出现）。需核实 agent memdir store 的 refs 来源；测试应改为经 controller.remember 种子或按 scoped store 布局种子。`passes rejection feedback to the injected memory reviewer` 前提已被 T36 删除（UI 注入 reviewer）——改写为经 plane controller 的反馈断言。然后：补 src/sdk-runtime.memory.test.ts S1（US32 四句：remember→view→exact-forget、stale-approval、rebuild 保留文件、open 可信路径），跑门（repl 全包、tsc 477+2、daemon/coding 回归），双轴评审，提交三联（T36→Done 21/35）。

**改动文件清单（git status）**：packages/coding/src/memory-runtime.ts、packages/coding/src/index.ts、packages/repl/src/commands/{memory-command.ts,memory-command.test.ts,types.ts}、src/{runtime-memory.ts(新),sdk-runtime.ts,kodax_cli.ts}。

---

## 2026-09-06 会话补记：T36 完成（21/35）

**提交**：代码 `abaa5962`、子模块（21/35）、指针已提。Host 侧 runtime.memory.forProject（身份 Host 派生/MemoryControlPlane 复用/诚实 rebuild/可信 open target），/memory 删全部自建与直写；S1 四句验证。**关键根因**（适配测试时）：① scoped adapter 对无 receipt 裸文件标 `provisional`，命令过滤 active/trusted 不可见——accepted 必须经 remember/_receipt 流；② fixture 的 `RegExp.exec` 返回 **null 非 undefined**（恒真 bug）；③ learn-command.test 的 /memory pending 别名测试也要 plane+configHome rebase 种子。双轴双 PASS；修复 M1/M2+L 系列；残留（票面已记）：plane workspace/agent scope 与 run 路径漂移、reviewer 显示仅 defaultProvider、双身份逻辑三处重复。**tsc 479=477+2 TS6059 同族**（src 引 packages 的 rootDir 归因，新 import 边 +N 属该族 benign）。

**DAG（21/35）**：T34 还差 T37（需 T22）；actionable=T15收尾/T19/T20/T22/T28opt/T30/T35。建议下一票 **T22**（按 HANDOFF refined 地图：Host serializable start + client workflows 面 + UI 控制迁移）→ T37 → T34 收口。

---

## 2026-09-06 T22 地图增补（本窗新发现，仍未实施）

**最有价值的发现**：`packages/coding/src/workflows/host.ts` 的 **startManagedWorkflow(input)** 已接受声明式 source——`{kind:'saved', module}` | `{kind:'inline', manifest, source}`（manifest+source 为字符串，**可序列化**）| request（NL 生成）。inline 路径 Host 侧已做受信校验：validateWorkflowScriptManifest + validateGeneratedWorkflowSource + assertInlineWorkflowSmoke + splitWorkflowQualityWarnings——run_workflow 工具即此路径（tool-execution-context.ts:333+）。**因此 Host RPC start 的合理形状**：client 发 inline manifest+source+args（或 name 由 Host 用 coding 的 getBuiltinWorkflow/loadSavedWorkflow/discoverSavedWorkflows 解析为 saved module），Host 调 startManagedWorkflow（manager=getDefaultWorkflowRunManager()=runtime.workflows 同一单例）。
**剩余大障碍（定价）**：`options: KodaXOptions`。run 路径的 buildRunOptions（sdk-runtime.ts:12865+）深耦合 RuntimeRunRecord（guardrail/workspaceSandbox/trustedTextMutationHost/权限 host）。UI /workflow start 现用 UI 闭包选项（plan-mode 检查/standalone shell 边界/UI events）。daemon 模式正确性要求 Host 侧构建（否则 workflow 在 CLI 进程本地 manager 跑，另一 client 不可见=票面缺口本体）。**方案候选**：(a) 抽 buildRunOptions 的 workflow 变体（无 run record 耦合的 Host 级选项构建——工作量最大但最正确）；(b) workflow.start 限定 inline source + Host 基础选项（provider/model/configHome/events sink），权限边界沿用 Host 默认策略（先 S1 双 client 可见性，选项完备性留 T37 消费者票验证）。建议 (b) 先行切片。

---

## 2026-09-06 T35 refined 调研地图（未实施，工作树干净）

**现状**：one-shot 已走 runtime facade（kodax_cli.ts:5831-5864 → runCliTaskWithRuntime:5852 → createInteractiveRuntimeRunner:655-752 → runtime.runs.start managed_task:720-727）——**无直跑 coding**。缺口四项：
1. **产品 Client 化**：connectKodaXClient 仅测试用；CLI 用 runtime facade 且默认 embedded 模式（getCliRuntime:5395-5437，resolveCliRuntimeMode 默认 embedded）。目标路径=ensure/attach Host → connectKodaXClient → client.sessions.create({temporary:--no-session, projectPath, surface:'cli'}) → client.sessions.updateSettings(toClientSessionSettings src/client-settings.ts:4-13) → client.inputs.submit → runtime.runs.await → SIGINT→client.runs.stop；phase 'unknown'≠完成（sdk-client.inputs-late-cleanup.test.ts:54-57 先例）。
2. **会话生命周期归 Host**：删 runCliTaskWithRuntime(813-839) 的 CLI 侧 resolveCliTaskSessionId+finally delete——Host 原生 temporary 会话已在（client-contract.ts:396-407，finishRun 后删 sdk-runtime.ts:9281-9320）。
3. **SIGINT/退出码**：one-shot 无 abort 接线（729-736 仅 options.abortSignal）；目标=SIGINT→client.runs.stop + result(success/limitReached/interrupted)→退出码映射；断线=run 孤儿 Host 侧（现状即如此，S1 断言）。
4. **事件转发器专用化**：daemon-only 链（createRuntimeReplEventBridge:971-1012 + forwardDaemonRunProgress:1161/Retry:1330/Recovery:1361/ToolProgress:1095）供 REPL+one-shot 共用——one-shot 换专用**非持久 progress adapter**（只转 iteration/retry/provider.recovery/tool input delta 进既有 createJsonEvents/createCliEvents 格式器；不 journal、不进普通 UI）；REPL 侧链保留至 T34。
**保留**：emitJsonRunResultIfNeeded(3266-3283) 输出协议字段逐字节不变；runKodaX import（__skill-tool:4077）；interruptedRuntimeResult/normalizeCliError。
**RED 骨架**（kodax_cli.daemon-smoke.test.ts 真实子进程先例，KODAX_HOME env）：①`kodax_cli.ts "..." --mode json --no-session` → exit0+JSONL+末行 run.result 全字段+iteration 对+退出后 sessions 目录无新文件；②挂起 provider 杀 CLI → 二连接断言无 terminal completed（unknown/interrupted）+temporary 会话在 executor settle 后才删；③注入 retry/recovery → JSONL 仍含 retry/provider.recovery/tool.input.delta 且 events.replay 无这些（非持久证明）。

**DAG 提醒**：T35 完成后 T26 前置仅剩 T17/T18/T19/T21（T17/T18 等 T34）。T22 地图见上一条增补（startManagedWorkflow 声明式 source 为接缝，剩余=Host 级 KodaXOptions 构建，建议 inline-source+Host 基础选项切片先行）。

---

## 2026-09-06 会话补记：T36 闭环 + T22 切片 1（21/35，T22 In Progress）

**T36**：`abaa5962`（见上条前记录——Host Memory plane + UI 删自建 + S1 四句 + 双轴双 PASS）。

**T22 切片 1**：`3d796f9b`。Host 声明式 start（inline/request Host 内受信校验、name Host 内解析、Host 基础选项+run 目录）+ workflow.start RPC（schema/scope/dispatch/client）+ 产品 Client workflows 面（六操作+ClientWorkflowRun 投影）+ S1 双 client 跨端观察/控制/decline/terminal。daemon client 补 memory stub（T36 跟进：进程内服务无 RPC→干净不可用）。**坑**：schema.test 的 METHOD_SMOKE_PARAMS 是本地表需补条目；server.ts 有 scope 表（UNSCOPED 抛错自检好设计）；`import type` 块内不能再加 `type` 修饰符。

**T22 切片 2 续做**（票面已记）：callbacks.workflows binding（T23/T36 模式）+ workflow-command.test binding fixture 适配（T36 规模）+ start/rerun 审批后改声明式 + 删本地 manager/控制分支（:241-248/builder:185/completer:477）。

**连续目标提醒**：T22 完成→T37（T06✓T22 后解锁）→T34（差 T36✓T37）；并行池 T19/T20/T30/T35（T35 四缺口地图就绪）；T17/T18 等 T34；最后 T15 收尾+T25/T26/T27。

---

## 2026-09-06 T22 切片 2（414ef345）

callbacks.workflows Host 控制 binding（types.ts WorkflowHostControl，kodax_cli 接 interactiveRuntime.workflows——daemon client 与进程内服务同构）；/workflow runs/show/pause/resume/stop 优先 binding（process→managed snapshot 适配器保住既有格式器；无 binding 走本地路径，107 测试全绿 + 新 mock Host 面 runs/stop 测试；repl 包 2615 绿；tsc 481）。**剩余切片 3**：start/rerun 审批后改发声明式 binding.start（generated/rerun→inline manifest+source、saved/builtin→name），随后删本地 manager/lifecycle 构造（:241-248 区、builder:185、completer command-arguments:477）+ builder/completer binding 接线 + live strip 经 subscribe。完成后 T22→Done、T37 解锁。

---

## 2026-09-06 T22 切片 3 精确接缝（下窗直接开工）

三个 startFromOptions 位点：workflow-command.ts:816（rerun saved）、:882（rerun run）、:1017（start-by-name/generate）。改造模式（hostControl 在场时）：审批 confirm 后改调 `hostControl.start({projectRoot: cwd, source, args: parseWorkflowArgs(...)})`——saved/capsule 与 builtin 有 scriptSnapshot/capsule.source 的走 `{kind:'inline', manifest: capsule.manifest, source: capsule.source}`（rerun-run 从 runDetail/scriptSnapshotPath 取 manifest+source）；bare name 走 `{kind:'name'}`。**runId 改 Host 铸造**：先 start 再打印 runId（现 UI 先铸 `run-<ts>` 后启动）。**done 观察改 Host 事件**：managed.done/getSnapshot 不存在——给 WorkflowHostControl 加 `subscribe(filter, listener)`（runtime/daemon client 均已有），写 observeHostWorkflowDone：subscribe({runId}) → workflow_finished 快照 → 复用 observeManagedWorkflowDone 的收尾打印（final assistant message 从快照 resultSummary/latestMessage 或 run.json detail 读）；live strip 同经 subscribe 的 workflow_updated。processMetadata/approvalContext/scriptSnapshot 语义：Host 侧 startManagedWorkflow 已自动补 authorship/quality metadata。builder（startGeneratedWorkflowFromRequest）暂留本地（workflow-builder 特性），completer command-arguments:477 补 binding 后删本地 manager。完成后删 :241-248 本地构造（测试无 binding 路径保留至 T34 统一收权）→ T22 Done → T37 解锁。

---

## 2026-09-06 T22 Done（943d17a1 + 31acf96b + docs 364d562/31458956）

**切片 3+4+5a `943d17a1`**：三个 start 位点 + builder generated/builtin 审批后全改声明式 hostControl.start（已审 capsule→inline 审批诚实防 TOCTOU；裸 builtin/trusted-local→name；Host 铸 runId）；WorkflowHostControl 增 subscribe；observeHostWorkflowDone（live.ts）= subscribe→workflow_finished→既有完成打印复用 + 订阅后 terminal-poll 兜底（防 start 返回前已终态）+ artifact 预览回退 + totalSpawned=progress.spawnedAgents；metadata lineage（savedWorkflowName/sourceRunId/revisionOf/displayName/goal）贯穿 client-contract(ClientWorkflowStartMetadata)→RuntimeWorkflowStartInput→daemon schema/dispatch→repl binding→各 start 位点 buildSaved/WorkflowProcessMetadata；Host 端 processMetadata 原样附给 startManagedWorkflow；workflowAuthorship 仅 Host 铸（inline 客户端声明被 host.ts 防伪造剥离——builder 不再发送该死字段）。S1 displayName 经 daemon 面往返断言。

**切片 5 `31acf96b`**：删全部本地 fallback——start/rerun/builder 无 binding 报 HOST_START_UNAVAILABLE；pause/resume/stop 报 HOST_CONTROLS_UNAVAILABLE（两常量 hoisted）；runs/show 未绑定降级持久化磁盘视图；rename/revise/delete 活跃守卫 hostControl.get；删 builder 本地 startFromOptions + 死选项 runBaseDir/runManager + workflow-command-cleanup 模块 + subscribeWorkflowLiveProcess；completer 只提持久化记录（run.json **完成时**落盘——进行中 run 仅 Host 面可见，注释曾写错为 start 时）；**classic repl.ts 与 InkREPL 两生产面补 workflows 转发**（RepLOptions/InkREPLOptions.workflows——切片 2 只接了 kodax_cli 没接到两个 UI 的 callbacks，Spec 评审 High 抓出）；agent runtime.ts artifact_written 事件补 path（快照消费者可预览产物内容，process.ts addArtifact 已读 data.path）；totalSpawnedFromProcess 共享助手（helpers.ts）。

**评审修复要点（3 轮双轴）**：builder Host start 曾先于审批（Spec High→移到 confirm 之后）；builder callbacks Pick 缺 'workflows'（tsc -b packages/repl 抓的，根 tsc 不含）；observeHostWorkflowDone 订阅同步分发泄漏（finish 时 subscriptionRef 未赋值→补 if(done) close）；Ink/classic 转发缺失（Spec High）；死 import/死模块（Standards Medium×2）；注释事实错误。

**测试设施**：bindHostWorkflowsFixture（test 内真 Host 组合：startManagedWorkflow over isolated manager + name→builtin/saved 解析 + runsBaseDirOverride——builder describe 不 chdir 必须显式传）；Windows 坑：run.json 落盘晚于 finished 事件（readSingleWorkflowRunJson 改 vi.waitFor）、afterEach rmSync EPERM（异步 run 句柄）→ maxRetries+try-catch best-effort；hostFinishedEvent 伪造 progress 必须 {spawnedAgents,...} 真形状。

**门**：workflow-command 118、completers 74、agent/coding workflow 447、daemon+S1 342、repl 全量绿、tsc 481 恒定、build gate 0。

**残留（票面已记）**：observeManagedWorkflowDone/workflowEventSink 无生产消费者仅测试保留（删除级联 digest-limiter 子系统+5 测试，独立小切片）；Ink callbacks 未转发 memory（T36 面）归 T17/T34。

**下一步**：T37（trusted 命令/Skill 准备进 Host，T22 解锁）→T34（差 T37）→T17/T18；并行池 T19/T20/T30/T35（T35 四缺口地图在前记录）；最后 T25/T26/T27/T15。

---

## 2026-09-06 T37 调查完成 — 切片 1 精确地图（下窗直接开工）

**T37 面貌（Explore 代理勘测，file:line 已核）**：Host 已有只读 catalog（sdk-runtime.ts:1272-1295 RuntimeCatalogService：commands/resolveCommand/skills/describeSkill；实现 :12205-12323；daemon protocol :132-136 command.list/resolve + skill.list/describe/read）；executor 已有受信 rehydrate（packages/coding/src/skill-invocation-policy.ts:207-318 applyRuntimeSkillInvocationPolicy——enforceAtRuntime 时从 bound registry 重载并重导 allowedTools/hooks，runKodaX agent.ts:33/101 + task-engine.ts:146/171 调用）；buildRunOptions 已硬化 skillDynamicContext（sdk-runtime.ts:13126-13152，plan 模式拒绝 `!`cmd``，无 host executor 则 disable）。**缺口=客户端仍是准备起点**：createUserSkillInvocation（packages/repl/src/interactive/user-skill-invocation.ts:82-127——loadFull+expandSkillForLLM+metadata 组装，纯域逻辑仅依赖 @kodax-ai/agent，可近原样搬 Host）；prepareInvocationExecution（invocation-runtime.ts:365-570——allowedTools 解析+SessionStart/UserPromptSubmit hooks+model override+fork，并把 skillInvocation.runtimePolicy.enforceAtRuntime=true 重写 :557-564）；review 本地 git 采集（review-command.ts:53-84,292-370——normal→prompt invocation、--workflow→writeReviewPackets+scoped-review builtin，workflow 半程已走 T22 hostControl）；/agents lean（agents-command.ts:113-139,157-206 本地读 AGENTS.md）；**Host 队列消费不展开 skill**（drainProductInputs sdk-runtime.ts:11372-11381 把 batch 原文 join 转发；session-input-queue.ts:6-15 QueuedInputFact.skill 明注 "trusted expansion happens at consumption (T37)"）。

**切片 1 设计（T22 模板）**：(a) src/sdk-runtime.ts 新增 `invocations: RuntimeInvocationService`——`prepareSkill(input: {projectRoot, name, argumentsText}): Promise<{kind:'prepared', invocation: RuntimePreparedInvocation} | {kind:'unknown'}>`；Host 侧实现=createUserSkillInvocation 的移植（initializeSkillRegistry(projectRoot) 缓存 + loadFull + expandSkillForLLM(skill, args, hostSkillContext)，hostSkillContext 用 buildRunOptions 同款 hardened dynamic-context 策略）；RuntimePreparedInvocation=CommandInvocationRequest 的可序列化投影（prompt/source/displayName/allowedTools/context/agent/model/hooks/argumentHint/disableModelInvocation/skillInvocation 含 runtimePolicy.enforceAtRuntime Host 铸）。(b) drainProductInputs：batch 首项为 skill 输入时（fact.skill），先 invocations.prepareSkill（从原文解析 name+args=parseUserSkillReferences 同款逻辑，Host 端 parseInlineSkillReferences+parseBareInlineSlashReferences 从 @kodax-ai/coding 导入），未知名→原文转发（现行为），已知→startRun({prompt: expanded, options: {skillInvocation, model}})。(c) CommandCallbacks 增 `prepareSkillInvocation?: (input: {projectRoot, name, argumentsText}) => Promise<...>`（types.ts，仿 learning/memory/workflows 模式）+ kodax_cli.ts:5777 区接线 `prepareSkillInvocation: (input) => interactiveRuntime.invocations.prepareSkill(input)`；InkREPL（:9430 inline submit 路径 + :8583 队列 round 的 resolveUserSkillInvocation→createUserSkillInvocation 调用点）与 classic repl.ts:1814 与单发 kodax_cli.ts:846 改走 binding（无 binding 留本地至后续切片删）。**无新 RPC**（REPL 恒 embedded 同进程；daemon 客户端走队列消费=Host 内；memory T36 同款决策，票面记录）。(d) 测试：src/sdk-invocations.test.ts（S1：真实 registry fixture——temp projectRoot 放 SKILL.md，prepareSkill 展开 `!`cmd``（host executor stub）+ metadata + enforceAtRuntime；未知名 unknown；plan 模式 dynamic 拒绝）+ 队列消费 S1（submit skill 文本→run 启动时 prompt=展开文，skillInvocation 交 executor）+ repl binding 测试（binding 在场用 host，不在场本地不变）。

**门与坑**：packages/agent 或 coding 契约变更→先 tsc -b tsconfig.build.json；daemon 面无新方法故 server.test 无新条目；sdk-runtime.test.ts 预存 10 败基线；tsc 481 恒定；GBK——python 补丁一律 Write 工具。**后续切片 2**=prepareCommand（prompt/extension frontmatter→Host；extension 命令在 extensionRuntime=Host 已有）；**切片 3**=review(normal/--workflow)+/agents lean 准备入 Host（review --workflow 复用 T22 hostControl.start(name)）；切片 4=删客户端本地准备路径+票面记录。

---

## 2026-09-06 T37 切片 1a 已提交（e8c5f08e）— 切片 1b 续做地图

**已落地**：src/runtime-invocations.ts（createRuntimeInvocationService：prepareSkill={projectRoot,name,argumentsText,sessionId?}→{kind:'prepared',invocation}|{kind:'unknown'}；skillContext=workingDirectory/projectRoot+无 executor 时 **disableDynamicContext:true**——resolver 三层派发 tier1 kill switch 把 `!`cmd`` 内联为 `[Error: Dynamic context disabled by host…]` 占位而非 reject（测试断言占位存在且无真实路径输出）；allowedTools 是**字符串**非数组；hooks=Object.entries 过滤空数组；skillInvocation.runtimePolicy={enforceAtRuntime:true} Host 铸）；sdk-runtime 接口成员 invocations + 工厂 `createRuntimeInvocationService({})`（memory 后、closeRuntime 前）+ 对象字面量 `invocations,`；daemon client.ts 仿 memory 加 invocations prepareSkill 抛 "requires an in-process runtime client" stub（否则 KodaXDaemonRuntime 缺成员 tsc 482）。S1 src/sdk-invocations.test.ts 3 绿（fixture 放 `<root>/.kodax/skills/<name>/SKILL.md`——**不是** .agents/skills；frontmatter 键 allowed-tools kebab）。

**切片 1b（下步直接开工）**：(1) drainProductInputs（sdk-runtime.ts ~:11380，deps 需从外厂线程 invocations——run service 工厂在 :5179 对象字面量同作用域，找 createRuntimeRunService 调用点加 dep）批首 skill 输入时：parseInlineSkillReferences+parseBareInlineSlashReferences（from '@kodax-ai/coding'）取 name+args→invocations.prepareSkill→prepared 则 startRun({prompt:expanded, options:{skillInvocation}})（RuntimeStartRunInput.options=RuntimeKodaXOptions 白名单含 skillInvocation :2058；executor applyRuntimeSkillInvocationPolicy 会重导 allowedTools/hooks）；unknown/多引用→原文转发（现行为）。测试：sdk-client.queue.test.ts 增 skill 消费断言或新 S1（submit `/audit-helper focus auth`→run 启动 prompt 含展开文）——注意 createKodaXRuntime homeDir≠projectRoot 时 registry 根=submit 的 projectRoot。(2) CommandCallbacks 增 `prepareSkillInvocation?`（types.ts 仿 memory :183）+ kodax_cli.ts :5777 区 `prepareSkillInvocation: (input) => interactiveRuntime.invocations.prepareSkill(input)`；InkREPL :9430/:8583 与 classic repl.ts:1814 与单发 kodax_cli.ts:846 的 createUserSkillInvocation 调用点改 binding 优先（无 binding 留本地至切片 4 删）。(3) 门禁+双轴+三重提交（注意 sdk-runtime 10 败基线、daemon 套件、tsc 481）。


---

## 2026-09-06 T37 切片 1b 已提交（89d62851）— 剩余：repl binding（切片 1c）

**已落地**：run service 增 dep `invocations: RuntimeInvocationService`（声明移到 runService 之前 :5005 区）；drainProductInputs 前置 prepareQueuedSkillInput（parseInlineSkillReferences+parseBareInlineSlashReferences 排序取首引用，args=到下一引用或文末；projectRoot=session.runtimeInfo?.workspaceRoot??gitRoot，无根→原文回退；unknown→原文回退；prepared→startRun prompt=展开文+options.context.skillInvocation（RuntimeDaemonContextOptions 白名单含 skillInvocation :2065））；session-input-queue.batch() 返回值增 `skill: boolean`（ordered() 已有该字段，只是 batch() 之前丢掉——tsc 18048 'skill' does not exist 抓的）。**S1 4 绿**：前三见 1a 记录 + 第 4 个 'expands a queued Skill at actual consumption'（ProbeProvider 仿 queue 测试件捕获 messages；先 acceptInput 'Start.' 占线、再 after_turn 提交 '/audit-helper focus on auth'→poll 2 runs terminal→末轮 user 文含 'Audit request: focus on auth'）。**坑**：tsc 482 排查法——stash 变更前后各跑一次 tsc，sed 去行号归一化后 comm -13 差集即新错（kodax_cli.ts:671 TS2322 是基线噪声非新增）。

**切片 1c（下步，T22 模板三件套）**：CommandCallbacks（packages/repl/src/commands/types.ts）增 `prepareSkillInvocation?: (input: {projectRoot; name; argumentsText?; sessionId?}) => Promise<RuntimePreparedSkill 投影>`——类型就地内联（仿 WorkflowHostControl :366），投影=prompt/source/displayName/allowedTools(字符串!)/context/agent/model/hooks/argumentHint/disableModelInvocation/skillInvocation；kodax_cli.ts :5777 区（learning/memory/workflows 旁）接 `prepareSkillInvocation: (input) => interactiveRuntime.invocations.prepareSkill(input)`（返回结构兼容——repl 端 CommandInvocationRequest 的 skillInvocation=KodaXSkillInvocationContext ✓ 结构同）；调用点改造（binding 在场优先，无 binding 留本地至切片 4）：InkREPL.tsx :9430（submit 路径 createUserSkillInvocation）与 :8583 区（runQueuedUserSkillRound 的 resolveUserSkillInvocation 后 expansion）；classic repl.ts:1814（resolveInlineSkillInvocation）；单发 kodax_cli.ts:846。binding 返回 {kind:'prepared',invocation}→REPL 把 invocation 适配为 CommandInvocationRequest（prompt+metadata+skillInvocation——注意 repl 端类型 source 'skill' ✓ 已同）再走 prepareInvocationExecution（hooks/model 仍客户端——SessionStart/UserPromptSubmit hooks 是 REPL 会话行为，票面允许：受信"准备"=注册表展开+权限元数据，执行器 rehydrate 兜底）。测试：repl 端 binding 测试仿 workflow host mock（binding 在场→host 收到 name+args、本地 registry 不触；不在场→现路径不变）；门禁 tsc 481+repl 全量+sdk-runtime 10 败基线；双轴评审后三重提交+票面切片记录。

---

## 2026-09-06 T37 切片 1c 已提交（fc96038b）— 切片 1 全部落地

**binding 链**：types.ts SkillPreparationBinding+PreparedSkillInvocation（skillInvocation=KodaXSkillInvocationContext；hooks=SkillHooks 形 {matcher?,command}[]——初版 Record<string,string[]> 错，tsc 2345 抓的；hookEvents=string[] 非 readonly）；user-skill-invocation.ts 增 prepareUserSkillInvocation/FromInput（binding 在场→host prepare(projectRoot,name,args,sessionId?)，unknown→undefined=Skill not found 行为；不在场→本地 createUserSkillInvocation 原路径）；三调用点：repl.ts resolveInlineSkillInvocation（callbacks 在域）、commands.ts executeSkillCommand（**原签名无 callbacks**——加第三参 callbacks?: CommandCallbacks，三个 caller 各传）、InkREPL :8583（runQueuedUserSkillRound 无 callbacks——走 options.prepareSkillInvocation，InkREPLOptions/RepLOptions 增字段 + callbacks 字面量转发 + kodax_cli interactiveOptions 接 {prepare:(input)=>interactiveRuntime.invocations.prepareSkill(input)}（input 需显式类型注解否则 7006））。测试：user-skill-invocation.test 新 describe（binding 路由+unknown+无 binding 本地回退；**afterEach 是 describe 级**——新 describe 需自备 resetSkillRegistry+tempDirs 清理）；interactive+ui 1528 绿；tsc 481。

**切片 2（prepareCommand）入口**：discovery.ts:181-224 frontmatter 元数据 + 合成 handler 的 invocation 组装移 Host——RuntimeInvocationService 增 prepareCommand({projectRoot, name, args})→{kind:'prepared',invocation|CommandInvocationRequest 形}|{kind:'unknown'}；Host 用 replApi.listRegisteredCommands（catalog 已用 :22531）+ extension 命令（extensionRuntime）；repl executeCommand 的 registry.get 分支改 binding 优先。切片 3：review-command/agents-command 准备入 Host。切片 4：删本地准备（user-skill-invocation createUserSkillInvocation/resolveUserSkillInvocation、discovery 合成 handler 保 UI fallback 至无 binding unavailable？票面语义=Client 只发名称/参数——删本地，无 binding 报 unavailable 仿 T22/T23）。之后 T37 Done→T34 解锁。

---

## 2026-09-06 T37 全部完成（切片 4 `efbc23f6` 提交，Done 23/35）— 下一步 T34

**切片 4 已落地**：daemon 面 4 方法 invocations.prepareSkill|prepareCommand|prepareReview|prepareAgentsLean 贯穿 protocol（union+RUNTIME_DAEMON_METHODS，未入 mutation 列表）/schema（四条全 additionalProperties:true，与相邻 skill.* 家族一致）/server（session:observe scope 组+dispatch 委托 runtime.invocations 同一服务实例；scope 旁注释记录 prepareReview 的 Host 侧 git 捕获+packet 写入）/client（抛错 stub → 真实 RPC，类型从 runtime-invocations.ts 与 runtime-review-preparation.ts 分开导入——后者两类型不经 invocations 重导出，TS2459 抓的）。**旧 Host 悬挂修复（Spec High）**：daemon initialize 事实（server.ts runtimeDaemonCapabilities——注意 initialize 用的是 dispatcher options.capabilities **不是** runtime.capabilities，runtime 侧 embeddedCapabilities 同步加）+ client 四方法前置能力门 invocationPreparation:{version:1}（新类 RuntimeInvocationPreparationUpgradeRequiredError，仿 actorControlPlane；无能力→daemon_upgrade_required 快速拒，不再依赖对旧 Host 发未知方法产生 id-less invalid_frame 被 transport 静默丢=永久悬挂）。**un-gate 与补漏（Spec Medium）**：kodax_cli 四 binding 去 identity.mode==='embedded' 条件（daemon+worker-hosted 面均经 RPC 绑定）；RepLOptions/InkREPLOptions 此前只转发 prepareSkillInvocation——补 prepareCommandInvocation/prepareReview/prepareAgentsLean 三字段+两 callbacks 字面量转发（repl.ts:998 区、InkREPL.tsx:9479 区；workflowCallbacks spread 自动继承），/review、/agents lean、prompt 命令准备自此达 Host。**加固（Spec Medium）**：captureDiff sha 分支 args[1].startsWith('-') 拒绝（git argv 选项注入）。测试：dispatcher 测试（参数解析+结果透传+invalid_params 且服务未触= calls 长度 4）+ client 能力门测试（四方法 0 RPC 即拒）+ S1 src/sdk-invocations-daemon.test.ts（真实 Host over pipe，仿 sdk-client.workflow.test.ts harness：lock/startRuntimeDaemonHost/connectKodaXRuntime）+ sdk-invocations.test.ts 增选项形 sha 断言。门禁：daemon 343、repl 2627、sdk-runtime 10 败基线、tsc 481、tsc -b 通过。**双轴**：Standards PASS（4 Low 全修：golden 快照 EOL 噪声还原、[...args] 防御拷贝删、schema 家族统一、测试断言补齐）；Spec FAIL→修复后全项闭环（High 悬挂+2 Medium+3 Low；requireStringArrayField invalid_request vs invalid_params 为预存助手行为未动）。票据翻转 bb2894a（docs/features 子模块）+父指针 84c023dd。**makeRuntime fixture 之谜已解**：server.test.ts 四个 KodaXRuntime 字面量缺 memory/invocations 但无 TS 错——字面量内部预存 TS2322（observe/diagnostics 签名）使 assignability 提前失败，TS 因此不报聚合 missing-member（也吞 excess-property）；修复那些签名错误会暴露 memory 缺失，届时需补 fixture。

**T37 终态语义（供后续票据引用）**：嵌入式与 daemon 两个面共用同一受信准备服务；client 永只发 {projectRoot,name,argumentsText?,sessionId?}/{args}；skillInvocation.runtimePolicy.enforceAtRuntime 恒 Host 铸；repl 包本地准备路径=standalone 包能力（无 binding 用），产品两 UI 均已绑 Host；动态上下文在 Host 准备期 disableDynamicContext:true（占位内联）；/review --workflow 返回的 packets 已 Host 写入、start 走 T22 声明式面。

**下一步：T34（Blocked by T10 T11 T23 T31 T32 T33 T36 T37——现已全解锁）**。先读票据 #30（docs/features/v0.7.97.md）与 client-contract 现状；T35 四缺口地图在本文件更早记录。之后 T17（Ink→Client）→T18（classic→Client）；并行池 T19/T20/T30/T35；收尾链 T25/T26/T27；T15 收尾；可选 T28/T29。既有遗留：observeManagedWorkflowDone/workflowEventSink 测试专用导出清理切片（T22 记录）；Ink callbacks 未转发 memory（T36 面）归 T17/T34。

---

## 2026-09-06 T34 切片 1 已提交（fdde170a）— goal 面入 Host

**勘测结论（T34 全景，file:line 已核）**：Host 与 REPL 写**同一会话文件**——Host sessionManager 用 `<homeDir>/.kodax/sessions`（resolveRuntimeSessionsDir sdk-runtime.ts:17937），REPL FileSessionStorage({cwd}) 的 sessionsDir 默认 KODAX_DIR=~/.kodax/sessions（storage.ts:1184；cwd 只影响 gitRoot/workspace 检测），且 ensureCliRuntimeSession（kodax_cli.ts:788）用 REPL 的 sessionId 在 Host 侧 load-or-create——双 writer 同文件=US18 的"两套事实"。runner 已在的路径（自动压缩 Ink:7804/repl:2262、run lineage）已跳过本地写=待复制模式。**goalRuntime 在 daemon 线上被剥离**（kodax_cli.ts:918 禁列表）——嵌入式交互的 goal 自动续跑靠本地 lineage，故 bound 变更后需 lineage 刷新。无 binding 的缺口：/goal（appendGoalEntry 本地血统变异 goal-command.ts:135）、手动 /compact（commands.ts:588 本地 compact+saveSession）、/new//recover//fork 的会话创建（本地 id+storage.save）、设置（permission mode 已经 runner syncSettings 到 Host updateSettings；provider/model/effort 只写全局 config 无会话设置持久=无迁移对象）。有 seam 但 body 本地：save/load/list/delete/tree/branch/label/fork/rewind/recover 两 callbacks 字面量（repl.ts:1018-1314、InkREPL.tsx:9493-9906）。Host 已有但 UI 未用：sessions.{create,delete,archive,unarchive,setActiveEntry(labelEntry),rewind,fork,recover,compact,readGoal...}（sdk-runtime.ts:1778-1868；compact 无 product-client 包装）。

**切片 1 已落地**：types.ts SessionGoalBinding+CommandCallbacks.goal+refreshSessionLineage；goal-command.ts binding-first（read 状态/守卫走 binding.read(sessionId)，create/pause/resume/clear 走 binding，complete→cleared→created 经 binding.clear 镜像，bound 变更后 refreshSessionLineage 从**Host 刚写的同一文件**重读本地 view；无本地 appendGoalEntry/saveSession；无 lineage 也不再报错——goal 在 Host 侧）；两 callbacks 字面量转发 goal + refreshSessionLineage=storage.getLineage?.(sessionId)；kodax_cli 接 interactiveRuntime.sessions 五方法。S1 src/sdk-goal-binding.test.ts：ProbeProvider 先跑一轮真实 run（Host 要求会话先有 conversation entry 才能 anchor goal——mutateGoal sdk-runtime.ts:7788 activeEntryId null 则 conflict），executeCommand 真 registry 驱动 /goal create --tokens/pause/clear→Host readGoal 观察同一修改、本地 FileSessionStorage save 0 次、context.lineage 由 refresh 填充且 readLatestGoalState 与 Host 一致。门禁：repl 2637、goal 单测 29、tsc 481、build 绿。

**剩余切片（T34）**：切片 2=会话命令 body 换 Host（新 callbacks.sessionCommand binding：delete/deleteAll/branch/label/fork/rewind/recover/create；两 callbacks 字面量 binding 优先；kodax_cli 接线；S1 双客户端观察 branch/label 变更+本地 0 写）；切片 3=/compact 走 Host sessions.compact（client 或直接 binding；本地 compact() 留 standalone；返回的压缩后消息刷新 context）；切片 4=canonical 写停止（bound 模式下 saveSession/autosave/handleCommandResult/commitWorkflowFinal/appendPersistedUiHistoryItem/goal flush/recover 三写全跳过——storage 只读；startNewSession=Host sessions.create；/new 的 saveSession 前置跳过）+ S1 断言文件未被 REPL 实例写；收尾=票据翻转+双轴。

---

## 2026-09-06 T34 切片 2 已提交（3301a452）— 会话命令写权入 Host

**已落地**：types.ts SessionCommandBinding（delete/deleteAll/setActiveEntry/setLabel/fork/rewind/recover/create，全 id+selector 无 messages）；commands/index→interactive/commands→包 index 三级重导出；两 callbacks 字面量 binding 优先（Host 变更→storage.load/getLineage 重读同一文件→完整 context 赋值，Ink 版含 uiHistory/extension/runtimeInfo 全套）；startNewSession bound 分支 fire-and-forget Host sessions.create（surface 'repl'）；recoverCurrentSession bound 分支=Host session.recover（同一 buildRecoverySeed 域、从 Host journal 播种）替换本地三写；/branch 的 summarizeCurrentBranch 语义经 RuntimeSetActiveEntryInput+manager(public-api setActiveEntry options)+daemon schema(可选 boolean) 贯穿——dispatch 直接 cast params 故自动流过。kodax_cli 接线：setActiveEntry/setLabel catch→false（conflict→'missing'/'failed' 语义保持），fork/rewind/recover 投影 id/布尔，deleteAll=Host list({projectRoot})+逐个 delete（无 bulk RPC 不新造）。S1 src/sdk-session-commands.test.ts：两轮真实 run 后 label（**lineage 末项可能是 memory-outcome-job 条目——label selector 要选 type==='message' 的末项**）/rewind/fork/recover/delete 全 Host 侧 + 本地 0 save + 本地读回与 Host lineage 条目数一致（同文件验证）。门禁：repl 2637、daemon 344、tsc 481、build 绿。**坑**：kodax_cli 对象字面量嵌套 binding 漏闭合括号（TS1005 连锁 14 错）；package index 需显式重导出新类型否则根测试 TS2305+7006（上下文类型丢失）。

**剩余（T34）**：切片 3=/compact 走 Host sessions.compact（callbacks 增 compactSession binding 或复用 sessionCommands；commands.ts:548-647 手动压缩 handler binding 优先——Host compact 用其 journal 重放压缩并返回压缩后消息刷新 context；本地 compact() 留 standalone）；切片 4=canonical 写停止（bound 模式下两 surface 的 saveSession/autosave（repl:2004/2121/1803）、commitWorkflowFinal(1681)、appendPersistedUiHistoryItem(1581)、goal flush(1911)、Ink persistContextState 链全部跳过本地写——storage 变只读；/new 前置 save 跳过）+ S1：round 后本地文件未被 REPL 实例写（save 0 次）而 Host journal 增长；然后双轴评审+票据翻转 Done(24/35)。注意：daemon 线上 goalRuntime 被剥离（kodax_cli:918）——嵌入式续跑依赖 refreshSessionLineage 已解；write-stop 后 uiHistory 增量（provider-error hint）在 bound 模式的归宿需在票面记录（暂显示层丢弃或走 Host notice——留切片 4 决定）。

---

## 2026-09-06 T34 切片 3+4 已提交（fe8d43db、c80bba59）— 全部切片落地，评审中

**切片 3（/compact）**：types.ts SessionCompactBinding.compact({sessionId, customInstructions?})→{compacted,tokensBefore,tokensAfter,messages,reason?}；/compact handler binding 优先（customInstructions 提前计算，bound 分支不需要本地 provider/config——Host 自解析 journal provider=data.runtimeInfo?.provider??options??'anthropic'，manual=true 绕过阈值与本地一致）；bound 分支不调 saveSession（Host 已持久化压缩结果）；本地 compact() 保留 standalone。单测 2 项（compaction-command.test.ts 新 describe 自备 fixtures——**外层 describe 的模块级 vi.hoisted mock 跨 describe 累积调用计数，需 mockClear/mockReset 隔离**）；S1 增 Host compact 断言（tokensBefore>0、messages 数组、lineage 仍可读）。

**切片 4（canonical 写停止）**：两 surface 增 `hostOwnsWrites = options.sessionCommands !== undefined`。classic：saveSession 早退、双循环 auto-save、handleCommandResult persist、commitWorkflowFinal（void save 前置条件）、appendPersistedUiHistoryItem（hint 变 display-only——Host 拥有持久 display history，记为票面残留）、goal runtime flush closure 早退；recover 本地路径的 3 写在 bound 分支已不可达（947/961 的守卫是双保险）；auto-compaction else-分支要求 !runtimeRunner（产品绑定恒伴随 runner）。Ink：**persistContextState 顶部单守卫覆盖全链**（persistHostSessionPayload 的 append-tail/delta/full-save 只从它进入）+ saveSession 早退；**坑：InkREPL 里 `const storage = options.storage` 在 runInkInteractiveMode（:11189），组件作用域在上方——hostOwnsWrites 必须声明在组件作用域（persistContextState 前），放 runInkInteractiveMode 会 TS2304**。读取保留（同文件读回）直至 T17/T18。standalone 路径全部不变（repl 全量绿证）。

**门禁**：repl+daemon+T34/T37 S1 共 2985 绿、tsc 481 恒定、build 绿。**双轴评审已派发**（Standards+Spec 并行，审 4 提交 fdde170a..c80bba59）；结论回来后修复→T34 票据翻转 Done(24/35)→submodule+指针+本记录收尾。已知待评审重点：same-file 假设在产品 custom config-home 下是否恒成立；bound-mode 循环级写停止无直接 loop 测试（记 T17/T18 残留）；/load 与 /sessions 列表仍本地读=票面允许的"旧显示可暂留"读侧。

---

## 2026-09-06 T34 Done（24/35）— 评审闭环与下一步 T17

**双轴结论**：Standards 初判 FAIL（2 High：classic 循环体内 `if (hostOwnsWrites) return` 退出 runInteractiveMode、handleCommandResult 同型守卫跳过 prepared.finalize()=Stop hooks 丢失；3 Medium：死守卫/静默吞错/Ink 4 处赋值块重复）；Spec 初判 FAIL（2 High：同循环 return+**T36 记录的 memory 转发缺口——kodax_cli 传了 memory 但两 surface options/callbacks 均未声明转发=产品 /memory unavailable**）。修复提交 `83ca60a5`：三处守卫改为只门 storage.save（finalize/循环控制流不动）；memory 两 surface 转发补齐；deleteAll 显式 limit:MAX_SAFE_INTEGER（list 默认 50 截尾）；/compact 后 refreshSessionLineage（Esc+Esc 重跑依赖）；/new 建失败告警；Ink recover 补 paste reset+续跑丢弃注释；三 binding 类型对称导出；另带入 efbc23f6 漏 stage 的 T37 sha 选项注入守卫。**残留（票面已记）**：recover 续跑轮（两 surface，T17/T18 recover 重构落地）；/tree summarize daemon 线 S1 与 bound 循环级直接测试（守卫经评审+2984 回归背书）；Ink bound 赋值块 applyBoundSessionData 抽取（后续清理切片）；uiHistory hint display-only。票据翻转 17504d1（submodule）+父指针 6765b551。门禁终态：repl+daemon+S1 2984、tsc 481、build 绿。

**下一步 T17（Ink→Client 输入与展示迁移；Blocked by T34✓）**：先读票据 #17（docs/features/v0.7.97.md :549 区）与 REPL-parity 验收节；重点=Ink 输入路径走产品 Client、展示读侧从本地文件迁 Host observeView/readHistory（T34 已留同文件读回过渡）；带入本票残留：recover 续跑轮、bound 循环级测试、/tree summarize S1。之后 T18（classic）→并行池 T19/T20/T30/T35→收尾 T25/T26/T27/T15。

---

## 2026-09-07 T17 Done（25/35）— Ink client-plane 全切片、双轴闭环

**五切片**：S1 `2f9eae0f` InkClientPlane（submit/withdraw/awaitRun/stop/observe/readItem/respondInteraction）+ clientViewToHistoryItems 适配 + REPLACE_HISTORY_ITEMS + runAgentRound plane 分支 + kodax_cli 接线；**S1 阻塞根因是测试夹具**（ProbeProvider.stream 未消费 streamOptions.onTextDelta——Host 投影链路完好，llm-adapter onOutputSegmentStart+onTextDelta(requestMeta)→session-view delta 按 providerRequestId 键投影）。S2 `9036b1d0` view.interactions 驱动四类既有对话框（answerClientPlaneInteraction 纯映射层，ESC→cancel，权限经 resolveReplRuntimePermissionDecision；对话框 AbortController 映射，交互离开视图即中止）。S3 `baf04644` 队列 Host 化（after_turn 提交、runClientPlaneRound 续跑链：排队 poll(10s/100ms)→awaitRun→续跑窗口(600ms) 找不同 runId；Esc-pop withdraw；↑ pull-all；显示/计数/中断门全读合并队列=Host queue+本地 skill 队列；skill 引用留本地由信任 resolver 展开）。S4 `4e73c2f5` observeDaemonSessionView 重连自动重开（server 连接关闭即清订阅=无泄漏；新 connectionId→重开+投递全量快照；resubscribe 重试 3 次后脱离；reconnectable:false 即 close）+Ink observe 退避重试。S5 `c3d11f5b` Ink 面 runtimeRunner 退役（类型/9 分支/死提示删除；kodax_cli Ink 分叉 destructure 剥离；classic 至 T18、CLI-print 至 T35）。

**双轴（Standards 1H/8M/4L + Spec 1H/5M/3L，修复 `d559639b`+`99d49254`，复验 PASS）关键修复**：① 丢失交互答案→释放 map 条目（下轮视图重开对话框）+页脚通知（TTL 8s 防视图推送即清）；② FEATURE_149 快速重定向=视图最新 running 工具（newestRunningViewToolName）判定 cancel 类→Host `redirect` 投递+targetRunId（plane 无带内工具事件，原 currentTool 分支不可达已删）；③ stop/withdraw 失败诊断化（withdraw 仅 code==='conflict'→undefined，其余上抛；receipt.accepted===false→diagnostic）；④ 流式标记仅末尾 assistant（findLastIndex）；⑤ 有界后缀 `[truncated]` 标记（readItem 分页 UI 归 T18）；⑥ 指纹 memo（type|len|status|progress…）保持 HistoryItem 身份，克隆视图复用（单测 toBe 断言）+窗口外剪枝；⑦ 拉回全文缓存（视图仅 1KB 预览，cache={text,at}，30s 窗口剪枝，dropped/withdrawn 不缓存）；⑧ 轮询 100ms、超时先 withdraw、submit state dropped/withdrawn 即抛。**门禁终态**：client-plane 19、S1 3（流式/停止回执/排队续跑）、daemon 345、repl 2658、tsc 481 恒定、build 绿。票据翻转 86aca47（submodule）+父指针 97208741。

**坑**：Git Bash heredoc `\n` 变真换行（patch 一律 chr(92) 构造或 Edit 工具）；非 ASCII patch 必须 Edit 工具；transcript-render-golden snapshot 会被测试运行 CRLF 噪声污染（checkout 还原）；`observeDaemonSessionView` 的 resubscribe 闭包引用后置 close 常量=TDZ 安全（同步 lifecycle 首调不触达）。

**残留（票面已记）**：REPL parity 人工终端回归待发布验收；daemon 观察自脱离后 Ink 不自动重挂（重连语义 T18/T25 评估）；redirect 续跑 600ms 窗口约束（慢启动按中断轮返回、输入仍在 Host 队列，recover continuation-round deferral 已有记录）。

**下一步**：T18（classic+编辑器→Client；Blocked by T34✓，与 T17 无依赖）：classic repl.ts 普通输入/外部编辑器返回/继续旧会话/交互显示切同一 Client（复用 T17 的 client-plane 适配与投影，classic surface 有自己的渲染路径）；删 classic runtimeRunner+storage fallback（createRuntimeReplEventBridge 随之退役）+kodax_cli classic 分叉不再传 runner。之后并行池 T19/T20/T30/T35（T35 四缺口图在前记录）→收尾 T25/T26/T27→T15。

---

## 2026-09-07 T18 Done (26/35) — classic 控制台面切换完成、复验闭环

**落地 `dee66bea`**:classic-plane-display.ts(createClassicPlaneDisplayDiffer:基线全量打底防历史重印、为终态工具补 :start+:done、assistant 后缀流式、工具三段(▶ live 含 awaiting_approval/✓✗• 终态恰一次)、窗口外 id 双 Map/Set 剪枝、thinking 100 字符预览、notice 一次;attachClassicPlaneDisplay:observe→differ 打印+view.interactions 经 dialogChain 串行排空,handledInteractions 防重,not-accepted 释放条目);classic-plane-interactions.ts(parseClassicChoice:/^[1-9][0-9]*$/ 数字|精确标签|allowCustomInput 自由文本|空=取消;createClassicPlaneDialogSurface:question/questionMulti/questionInput/permission——permission 返回原始 ConfirmResult,answerClientPlaneInteraction 负责归约)。repl.ts:RepLOptions.clientPlane;planeDisplayWrite(assistant 无换行流式+pendingAssistantNewline 守卫);attachPlaneDisplayFor(退避重试 5 次 min(1s*n,5s)+最终 emitKodaXDiagnostic);setContextSessionId 统一 6 处切换点(/recover/启动播种//new//load/fork×2)并重挂;runPlaneRoundWithStop(AbortController+activePlaneAbort,SIGINT 捕获→abort→Host stop)对话轮与编辑器返回两用;编辑器三元 plane 分支;resume 会话列表 (await getGitRoot())??undefined→sessions.list projectRoot 限定。**删除**:repl classic runner 全套(ReplRuntimeRunner 类型/dispatch/boundary/bash/compaction 分支/requestRuntimePermission/死导入 ConfirmResult 等),runAgentRound 签名简化;kodax_cli classic 分叉复用 Ink 同一 clientPlane 接线。

**双轴(Standards 1H/6M+Spec 4H/3M)修复 `f2f6a545`**:awaiting_approval 按 live 打印不落 ✓(High);attach catch-all 不静默;会话切换重挂显示(High——原仅初始化挂一次);编辑器轮 SIGINT;resume projectRoot;基线为终态工具补 :done(否则恢复的工具在下一 push 重印);死导入/剪枝/数字守卫(0x2 不当数字)。**复验 PASS(静态)+追加修复 `25ff5b0b`**:退避重试携带旧 sessionId,会话在 1-5s 窗口内切换时重试会拆新显示挂旧会话(NEW-Medium——入口守卫 attempt>0&&planeDisplaySessionId!==sessionId 即弃);同会话在途 attach 重复调用泄漏双份打印(NEW-Low——attachInFlightSessionId 去重,.then/.catch 各自清);S3 基线回归测试第二条 push 原先丢弃已完成工具=对 pre-fix differ 也通过(空测试)——改为保留 restored 条目使其 load-bearing。**门禁终态**:classic-plane-display 7、classic-plane-interactions 4、S1 sdk-classic-plane 2(真实 Host 轮打印 assistant 流式且无 user: 重印;仅挂视图不打字)、repl 全量 2669、tsc 481 恒定、build 绿。票据翻转 186eb45(submodule)+父指针 34895301。

**坑**:python patch 中途 assert 失败=整体不写(重贴全量);半应用 attach 重构直接整块删除重写更稳;differ 期望值手算易错(测试内计算期望)。

**残留(票面已记)**:plane 提交丢 inputArtifacts(承 T17,待 Host input face 工件通道);classic differ 假定增长前缀——有界 [truncated] 与 readItem 分页 classic 未做(Low);REPL parity classic/编辑器人工回归归发布验收。

**下一步 T35(单发 CLI→Client;四缺口图见上)**:(1) KodaXProductClient 增 runs.await(client-contract+sdk-client 投影,现有 runs.read/stop);(2) kodax_cli runCliTaskWithRuntime 改 connectKodaXClient+sessions.create({temporary:--no-session})+inputs.submit+runs.await,删 CLI 侧 resolveCliTaskSessionId+finally delete(Host 临时会话已自删,T09 S1 已证);(3) SIGINT→client.runs.stop+退出码映射,断连≠完成(phase unknown 不当成功);(4) 一次性专用非持久进度适配器替代 createRuntimeReplEventBridge daemon 链(iteration/retry/provider.recovery/tool input delta 进 JSONL),emitJsonRunResultIfNeeded 字节不变。RED 骨架:json --no-session 退出 0+JSONL+无会话文件;中途 kill→终端无 completed;注入 retry/recovery 事件在 JSONL 有、events.replay 无。之后 T19/T20/T30→收尾 T25/T26/T27→T15。

---

## 2026-09-07 T35 Done (27/35) — 单发 CLI 走产品 Client、runner 退役

**五提交**：`a679b61d`（产品面 runs.await+ClientRunOutcome、会话设置 maxIter 全链、run.await failureDetail schema 预存缺口修复——provider/model/requestPhase/elapsedMs 此前被服务端校验拒收）、`f24d42ce`（runOneShotClientTask+toKodaXProductClient+转发器迁 run-progress-events.ts+attachRunProgressAdapter+plain//command 接线）、`db3cc176`（SIGINT→stop/退出码 0/130/1/断线 unknown≠完成）、`3a9b35d4`（runner/bridge/权限响应器/CLI 会话助手删除 −894 行；prepared+repo-intelligence 走窄 runs.start 接缝 toPreparedRunStartOptions）、`11c9a178`（评审修复）。票据 377c5b1（submodule）+父指针 bf0b1e2a。

**关键设计裁决**：(1) maxIter 无产品归宿→扩会话设置（--max-iter help 本就写 "per session"）；(2) prepared skill 调用的 promptOverlay/modelOverride/skillInvocation policy 无输入面承载→保留 runs.start 窄接缝（runner 本体仍删，接缝与产品路径共享会话解析/SIGINT/退出码/投影）；(3) --repo-intelligence 旗标同因无设置归宿→带此 context 的 plain 路由到接缝（env KODAX_REPO_INTELLIGENCE 时 Host 自读 env，仅旗标需接缝）；(4) 旗标→设置 patch 为 per-invocation：finally 恢复覆盖新建持久会话（与迁移前 per-run 语义一致），临时会话不恢复（Host 结算即删），恢复失败→events.onError；(5) embedded prepared 不挂适配器（startOptions 直收回调，挂了会双打印）；plain 两种模式都挂（embedded 产品 run 无回调可传，适配器是唯一输出来源）。

**双轴**：Standards FAIL 3M（死导入×4+forwardRunProgressEvent、恢复失败静默吞、断线测试 unhandled rejection——`expect(pending).rejects` 必须在 close 前附着）+Spec PASS 带 2M（F1 repo-intelligence plain 失效、F2 设置粘滞+吞错）→ 全修→复验 PASS 无新问题。Spec 另证：JSON 事件四族（iteration/retry/recovery/tool input delta）全模式存活；附件无既有单发通道=无回归；decline 语义原样。

**坑**：python 删块用过期行号=误删好代码（先 checkout 重置再按签名动态定位重做）；`git stash push` 不含 untracked，parity 对照要先把新文件移开；worktree 检出下 sessions.list({projectRoot}) 为空（FEATURE_219 建桶用入参 root、查询用 canonical-root 重探，git-common-dir 指向主仓）——预存缺口，interactive 同行为，测试改用确定性 session.id 路径；runManagedTask 与 startKodaX 是两个 mock 面（managed_task 模式走前者，漏 mock 即真实 provider 目录报错）；agentMode:'sa' 会把 run 路由到 SA executor（测试用 model 做设置保留断言）。

**门禁终态**：build 绿、daemon 344、sdk-runtime 10败=预存（320过）、one-shot 6+run-options 12+runs-await 1、CLI/client 套件绿、tsc 唯一集 416≤481（3 条随删除消失、TS2352/union 顺序噪声随迁）。

**残留**：worktree FEATURE_219 项目列表空（建议后续 issue：createSession 持久化 canonicalRepoRoot 或查询侧按入参 root 落桶）；嵌入 delta 50ms 总线合并（=daemon 粒度，文本不变）；worker-hosted 输出静默（预存）；onScoutSuspiciousCompletion 死回调面；真实安装入口子进程 E2E 未做（模块级真实 Host harness 等价覆盖）。

**下一步（27/35）**：DAG 前沿=T19（ACP，Blocked by T08✓T09✓T12✓T16✓）、T20（A2A，T08✓T16✓）、T30；T26 前置仅剩 T19/T21（T17✓T18✓T35✓）；收尾 T25/T26/T27→T15 收尾。建议 T19（解锁 T26 链）。

---

## 2026-09-07 T19 refined 调研地图（实施中）

**现状**（src/acp_server.ts 1371 行，已大量用 runtime 面）：运行时=进程内 createKodaXRuntime({profile:'acp', sessionsDir, defaultProvider/Model})（embedded）；会话=ACP id 即 runtime id（ensureRuntimeSession 经 storage 建）、setSessionMode→sessions.updateSettings（已是 Host 写权）；prompt→runs.start({permissionBroker:'client', options:buildKodaXOptions})——options 携带 provider/model/**per-prompt effort override**/thinking/reasoningMode/**extensionRuntime 进程内实例（全局+per-session client MCP 合成）**/session.storage/context{gitRoot,executionCwd,contextTokenSnapshot}/events{onTextDelta→sendTextChunk(agent_message_chunk append 适配)、onThinkingDelta、onToolUseStart→tool_call、onToolProgress→tool_call_update、onRepoIntelligenceTrace、onError}；权限=自建桥（events.subscribe permission.requested→buffer 到 runId→handleRuntimePermissionRequest→ACP requestPermission→decision 映射 allow_once/allow_session(remember+session suggestion)/allow_always(remember+persistent)/reject）；取消=逐 activeRunId runs.abort；流式=进程内直回调（embedded 无跨界问题）。

**T19 目标映射**：(1) 权限+form/url→既有 Interaction 面（client.interactions 或 view.interactions——替换自建桥；ACP decision→ClientInteractionResponse(permission) 映射参照 T17 answerClientPlaneInteraction 但 ACP 决策模型不同：allowed/remember/override）；(2) append 文本通知适配保留（连接内、声明无法表达输出替换的边界=票面要求，写注释/文档）；(3) 会话/提交经产品 face 在 extensionRuntime 实例不可跨界约束下保留 runs.start 窄接缝（同 T35 裁决）；(4) storage/extension 实例/callback 不过 IPC=维持 embedded 进程内（不强制 daemon）；(5) S1=真实 ACP 协议会话转换（先查 src/acp_server.test.ts 现有覆盖再补：创建/继续/提交/流式/权限应答/取消）。

**切入点 Slice 1**：权限桥→Interaction 面（票面明确"权限与 form/url 请求交既有 Interaction"）。查 interactions face 形状（runtime.interactions.list({sessionId})/respond(requestId,response)——T17 用过；form/url=question_input/question 交互 kind？查 ClientInteraction kinds）。

**T19 Slice 1 补充侦察**：src/client-interactions.ts（218 行）= Interaction 面 over permissions/userInputs 注册表——listClientInteractions 映射 permissions.listPending→kind:'permission'（requestId=权限请求 id=permission.requested 事件 payload.id）+ question* 交互；respondToClientInteraction 校验 pending/kind 匹配后 permissions.respond。ClientPermissionDecision（allow_once/allow_session+ suggestionId/allow_always+ suggestionId/reject）与 ACP 桥现有 decision 构造（handleRuntimePermissionRequest 回调返回值）**完全同构**。方案：保留 permission.requested 事件订阅（唤醒+runId 缓冲语义不变），应答从 handleRuntimePermissionRequest 换为 client.interactions.respond(requestId,{kind:'permission',decision})——票面"权限交既有 Interaction"落地；form/url（MCP elicitation）今日 ACP 侧 buildMcpReverseCapabilities 未开 enableElicitation=无既有面，不发明 ACP 协议能力（粒度边界），票面记录。ACP 运行时保持进程内（extensionRuntime 实例不可 IPC），经 toKodaXProductClient 出产品面。

---

## 2026-09-07 T19 Done (28/35) — ACP 会话/流式/权限/取消走 Host 产品面

**四代码提交**：`1f99da11`（权限应答走 Interaction 面：client.interactions.respond(requestId,{kind:'permission',decision})，decision 映射与旧回调同构；permission.requested 订阅保留 runId 缓冲；修复预存 acp_server.test 12 挂=createExtensionRuntime mock 缺 loadExtensions）、`4f16e00a`（ensureRuntimeSession/setSessionMode→client.sessions.*，abortSessionRuns→client.runs.read+stop；acpAbortPhaseRank 收宽 string）、`9582f82f`（S1：append-only 文本/工具状态/取消/会话继续 + 边界文档）、`0c03a9ca`（评审修复）。票据 bf136a2（submodule）+父指针 cd24b014。

**关键设计裁决**：(1) prompt 路径 `runtime.runs.start` 与权限桥 `runtime.events.subscribe` 留进程内=文档化接缝：产品面无 coding runs.start（start 是声明式 inputs.submit，承载不了流式回调/permissionBroker:'client'/extensionRuntime），storage/extension/callback 不过边界（票面原话）；(2) append-only 边界写在 sendTextChunk（ACP 0.15 agent_message_chunk 无替换变体——对照 SDK schema 验证；新连接从持久状态开始、不复造瞬态事件）；(3) elicitation 边界写在权限桥：ACP 无 form/url 反向请求→非权限交互留 Host 侧（其它客户端可答）、纯 ACP 连接经 interaction phase timeout 结算（不发明协议能力=粒度边界）；(4) 陈旧对话竞速=watchRuntimePermissionSettlement 订阅 permission.resolved({requestId 匹配})——settlePending 在"他客户端先答/dismiss/registry 超时"所有路径都发该事件，一个竞速全覆盖。

**双轴**：PASS/PASS 0C/0H。修复：Spec M1 旧 handleRuntimePermissionRequest 的 deadline/resolved 竞速在 Slice 1 迁移中丢失→陈旧 ACP 对话可把已结束 run 的 prompt 应答吊死在 permissionBridge.close()（M1 测试：对话永不答+他客户端 reject→prompt 仍按期 end_turn；mutation 换错误事件类型=红）；M2 elicitation 边界未文档化；L3 决策映射只测 allow_once→toClientPermissionDecision 提取纯函数+4 组单测（reject override/默认、allow_once、remember 无建议降级、persistent>session）。Standards M1 嵌套三元+IIFE、M2 手写轮询≠waitForCondition、M3 T19 describe beforeEach 仅 mockClear（mockImplementation 跨 describe 泄漏→mockReset+capturedOptions 清空）、L4 stub 缺 signal（sendSessionUpdate 会读 connection.signal.aborted）、L5 promptPromise 无 expectSettles 守卫。接受不改：L6 restoreAllMocks 会清空 hoisted vi.fn 实现有连锁风险（spy 挂在 per-test runtime 上）；L7 AcpLogger 无 warn 级。

**坑**：ClientInteraction 判别字段是 `requestId` 不是 `id`（ClientInteractionBase）；vitest -t 匹配全名（内部 label 不算）；bash heredoc 里 python 反引号/中文长文本=转义地狱，一律写 .py 文件再执行；parity 基线只含 "error TS" 行（419），先 grep 再 comm。

**门禁终态**：build 绿、acp_server 19/19、root tsc 唯一集 416（无新增；kodax_cli.run-options/run-progress-events/runtime-daemon 5 条为已知行移噪声）。

**残留**（票内已记）：interactions.respond spy 无法区分 client 投影 vs runtime 直连（进程内投影固有）；loadExtensions mock 修复或为防御性；良性 already-answered 记 error（无 warn 级）。

**下一步（28/35）**：DAG 前沿=T20（A2A，T08✓T16✓）、T30；T26 前置剩 T21（T19✓T17✓T18✓T35✓）；T21 前置 T20+T30。建议顺序 T30→T20→T21→T26（T26 还差 T25？查票面：T26 Blocked by T15/T17/T18/T19/T21/T35→还差 T15/T21）。收尾链 T25→T26→T27、T15 收尾。

---

## 2026-09-07 T20 Done (29/35) — A2A 任务态从当前 Run/Interaction 映射

**三代码提交**：`ae5de2c0`（删 subscribe+replay 合并与 cursor/epoch checkpoint；attachRuntimeEvents=live 订阅→缓冲事件按序→当前态快照最后落盘；task-store 删 runtimeSessionCursor/checkpoint 文件/load 合并，遗留剥离+runtime-cursors 目录尽力 GC）、`f6efdc5e`（重连 S1×2）、`8f5c292e`（评审修复）。票据 98e6743（submodule）+父指针随后。

**关键设计裁决**：(1) 快照数据源=runs.get(phase)+userInputs.listPending({sessionId}) 按 runId 过滤——INPUT_REQUIRED 的 requestId/revision/kind 从当前注册表重建，不依赖事件 journal；(2) 顺序=缓冲事件先应用、快照最后落盘（快照有 change-guard 不会重复写，且不会把已 resolved 的对回退成瞬态 INPUT_REQUIRED）；(3) 终态归 finishRun（runs.await/handle.result），TERMINAL_RUN_PHASES 只列 4 个真终态；(4) unknown phase=断线≠成功→FAILED（statusState 补全全部 phase，顺带消除 1 条预存基线 tsc 错误，parity 419→415）；(5) cursor 目录 GC 在独占锁后尽力而为（Windows EPERM 不再泄漏锁）。

**双轴**：Standards 初判 FAIL 1H（applyCurrentRunState await 间隙 stale record 覆盖终态——修复=await 后重读，终态或 eventSeq 变更即弃，mutation 红→绿验证）+3M（M2 缓冲后置产生瞬态回退→改快照前 drain；M3 unknown/waiting_agent/recovering phase 缺口→statusState 补全+isLiveRunPhase 统一；M4 rmSync 构造期异常泄漏锁→best-effort）；Spec PASS 0C/0H 带 M1（附件无测试证据→补 S1：data part→artifact_ref/file/user-inline/保留 filename）。

**坑**：SendMessage 响应在 returnImmediately=false 时阻塞到终态（默认 maxTaskWaitMs）——mock runtime 不结算就 rpc→死锁（continuation 加 returnImmediately）；门控快照时 SendMessage 会等 runtimeEventsAttached→必须先放行再 await 响应；tasks.json 记录的 status 在 task.status 下不在根；-t 过滤匹配测试全名；mock 覆写 userInputs 必须实现完整接口（respond/dismiss 必需，否则直连 cast TS2352）；events 覆写同理要带 replay 桩。

**门禁终态**：build 绿、a2a 模块 222/222、integration-cli.a2a-serve+sdk-a2a 7/7、tsc 唯一集 415（≤基线 419）。

**残留**（票内已记）：continuation 消息 file part 被 continuationAnswer 丢弃（预存）；SSE 在 INPUT_REQUIRED 关闭为既有设计；restore 测试部分持久化背书（独特推导证据在 pre-attach 测试）。

**下一步（29/35）**：前沿=T30（Agent 注册/协作 mutation，T12✓T16✓）；T30✓后 T21（A2A prepared serving Host 持有，T20✓+T30）→T26（还差 T15/T21）；收尾 T25→T26→T27、T15 验收（需 T25）。建议 T30→T21→T25→T26→T27→T15。
