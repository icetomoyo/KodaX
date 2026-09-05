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
