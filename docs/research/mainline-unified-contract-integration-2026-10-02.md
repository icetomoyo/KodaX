# 如何把 KodaX rc.12–rc.14 合入统一 Product Client 分支

结论：建议在 `codex/product-client-refactor` 上完整合并最新 `origin/KodaX`，保留主线修复的用户能力，按 FEATURE_298 的 Host/Client 所有权改接实现。最关键的改接是中断恢复：当前分支已删除持久 Runtime journal，不能直接复制主线的事件回放依赖。统一契约设计仍属于 `v0.7.97 / FEATURE_298`，当前源码包版本是 `0.7.96-rc.11`。[设计](../features/v0.7.97.md)、[现行契约](../CLIENT_CONTRACT.md)、[迁移说明](../SDK_MIGRATION.md)

## 核对范围和冻结基线

本次只核对 Git、文档、源码与合并候选，没有执行实际分支合并，也没有运行构建、测试、真实模型或 eval。网络更新仅执行了使用既有 `GITHUB_TOKEN` 的非交互 fetch/ls-remote；没有改变两个仓库的 checkout。

| 项目 | 本次确认值 | 第一方依据 |
| --- | --- | --- |
| 主 checkout / 远程默认分支 | `KodaX`，不是名为 `main` 的分支 | `git worktree list`；`git ls-remote --symref origin HEAD refs/heads/KodaX` |
| 当前分支 | `codex/product-client-refactor`，`a63feede` | `git branch --show-current`；`git rev-parse HEAD` |
| 最新主分支 | `cad8b658797976ce22a4bd70c60d2251d537e542`，tag `v0.7.96-rc.14`，提交日期 2026-10-01 | `git log --decorate origin/KodaX`；`origin/KodaX:package.json:3` |
| 最近公共祖先 | `1031ab2df12884da68484577c1a8d559833c2247` | `git merge-base HEAD origin/KodaX` |
| 分叉提交数 | 当前独有 231；主线独有 26 | `git rev-list --left-right --count HEAD...origin/KodaX` |
| 当前设计子模块 | `docs/features` → `fd73eb81d274cc7dc47bc5d2c1c79928c11c4eaf` | `.gitmodules`；`git submodule status` |
| 主线设计子模块 | `664d8ba0365776b15764e33da8e47a65ee2366ae` | `git ls-tree origin/KodaX docs/features` |

此前已合入主线 rc.11 的记录在 [2026-09-24 合并复核](mainline-merge-gap-audit-2026-09-24.md)。本次的 26 个提交是在公共祖先之后新增，不能把双方完整 tree diff 中的 FEATURE_298 删除/新增当成主线最近新增变更。

## 当前设计具体落在哪里

- **主规格：** `docs/features/v0.7.97.md / FEATURE_298 — Product Host and Client Contract Simplification`。实施记录覆盖核心票、消费者补齐和后续修复，详细位置另见 [版本核对笔记](unified-contract-design-version-2026-10-02.md)。没有为 9/26–27 的契约修复另立设计版本。[规格](../features/v0.7.97.md)、[总表](../FEATURE_LIST.md:519)
- **当前行为与接入：** `docs/CLIENT_CONTRACT.md`、`docs/SDK_MIGRATION.md`，以及 `packages/coding/src/client-contract.ts`。`/client` 是产品业务契约；受信任宿主的 `/runtime` 仍是底层接缝。[迁移说明](../SDK_MIGRATION.md:3)、[类型](../../packages/coding/src/client-contract.ts:1)
- **源码包版本：** 根包及四个 workspace 当前仍为 `0.7.96-rc.11`，不能由 `v0.7.97` 设计文件推断已发布 v0.7.97。[根包](../../package.json:3)、[迁移说明](../SDK_MIGRATION.md:3)
- **文档有摘要漂移：** 主线总表仍写 FEATURE_298 implementation not started；当前分支总表写已实现，但只概括到 T47。规格头部的 Planned 概述也落后于详细 Done 记录。合并时保留本分支实施事实并同步概述，不能整份采用主线总表。主线总表 npm 栏仍为 rc.10，而源码 package 为 rc.14；本次没有查询 npm 实际发布状态。[当前总表](../FEATURE_LIST.md:18)、`origin/KodaX:docs/FEATURE_LIST.md:15–18`、`origin/KodaX:package.json:3`

必须继续保持的设计约束：

1. Host 持有执行、配置、Session 写入、队列和 Interaction；产品消费者观察并调用领域能力。[Client 契约](../CLIENT_CONTRACT.md)、[迁移表](../SDK_MIGRATION.md:20)
2. canonical 消息与显示 checkpoint 各自保持职责，正式提交后按身份退役 draft，不形成双份正文权威。[规格](../features/v0.7.97.md:273)
3. observe 是当前事实替换；重连重新观察；不恢复持久 cursor、journal 或逐 token replay。[规格](../features/v0.7.97.md:289)
4. Run status 是终态权威；旧非终态记录保守投影，不由 Runtime 事件反向修补成功或输入交付。[规格](../features/v0.7.97.md:297)、[现行恢复实现](../../src/sdk-runtime.ts:17668)
5. 断开、请求 Stop、Run 终态与 OS 清理确认是不同事实，不能互相代替。[迁移说明](../SDK_MIGRATION.md:42)、主线 `869461ab`

## 主线更新如何吸收

| 更新组 | 主要提交 | 合并处理 |
| --- | --- | --- |
| Anthropic 兼容供应商的认证隔离 | `f2cb876b` | 保留 `authToken: null` 和凭据加载测试，避免兼容供应商继承 Anthropic Bearer token。属于 llm 层，独立性不变。 |
| Windows NUL ACL、自包含测试缓存、8.3 路径 | `c8ed4383`、`588995ab`、`cad8b658` | 保留 native/sandbox 修复与 smoke 诊断，继续由受信任 Host 执行 setup/验证。 |
| Vitest/fflate、发布 CI | `53debfdf`、`55868a89` | 接入锁文件、Vitest 4.1.11 配置变更及 release 前完整 CI；保留本分支 Client 的构建/声明检查。主线 CI 改为 workflow_call/dispatch，不能假设普通 PR 自动触发完整 CI。 |
| Runner 真实迭代数和子任务耗尽结果 | `2dae4cd4` | 保留 Actor 的 iteration、iteration_limit 与 partial output 事实，核对 Product agents/IPC 字段能传递；界面使用现有 Session activity，不复活旧 live projection。 |
| 消息提交边界的持久化 | `7c0bfd79` | 接入 Runner 的 transcript 参数和每次实际新消息提交后的 canonical 保存，同时保留通知回执提交、inputId、outputId 及 managed context 剥离。 |
| 历史工具配对、旧损坏恢复、copy-of-copy、不可证明边界截断 | `c232d7b5`、`866aff7f`、`7c21993c` | 吸收 agent 的配对/lineage 修复与 conversation 构建逻辑，保持本分支来源索引、全文补读和跨页顺序。无法证明的旧边界要返回可见诊断。 |
| 不确定 Shell 清理不阻塞新对话 | `c5d7b856`、`869461ab`、`586b64fc`、`44fff8d3` | 接入 deferred cleanup，保留持久 child 注册和后续回收；Run 可结算不等于 Stop confirmed，effects 仍可 unknown。复核 Product 输入排队、Stop 和 Host close。 |
| 下一轮读取中断 Run 的操作/回复证据 | `c232d7b5`、`866aff7f`、`931e65c8` | 保留能力目标，改写 journal 证据来源，详见下节。不能直接调用已经不存在的 persistence.replay。 |
| Ink 单一 transcript writer | `efe33d7d` | 保留单写者目标。本分支产品 Ink 已禁止本地 canonical 写入，因此不能接回旧 runtimeRunner helper；以 Host/Client 路径回归证明同一目标。 |
| 文档、发布记录、eval 记录、scratch 清理 | `345e301b`、`70b586ae`、`c5a901c2`、`f7d1c3d5` 及 rc.12–14 release commits | 保留实际历史与主线能力证据；公共指南以本分支 `/client` 入口融合改写。eval 历史不能当作适配后版本的验收，本次不重跑付费 eval。 |

上述归类来自 `git log HEAD..origin/KodaX` 及对应提交 patch；它们描述主线意图，不表示合并候选已经通过测试。

### 中断恢复是本次必须显式设计的接缝

主线 `collectInterruptedRunJournals` 从 `persistence.replay` 还原工具操作和回复尾部，后续将有界说明注入 SA/managed 的临时请求上下文。工具已开始但未记录结果时明确为 unknown；Thinking 不进入说明；已在正式历史中的证据被去重。`931e65c8` 优先保留操作证据，再分配回复摘录预算。[主线实现](https://github.com/icetomoyo/KodaX/blob/cad8b658797976ce22a4bd70c60d2251d537e542/src/runtime-interrupted-run-journal.ts)、[主线渲染器](https://github.com/icetomoyo/KodaX/blob/cad8b658797976ce22a4bd70c60d2251d537e542/packages/coding/src/task-engine/_internal/interrupted-run-recovery.ts)

当前分支 `RuntimePersistence` 没有 replay；T26 明确删除持久事件日志，T33 禁止 event→status 恢复。机械合并还会把主线 `recoverPersistedDurableTerminal`、`reconcilePersistedInterruptDeliveries` 带回来。这些不符合现行设计。[接口](../../src/sdk-runtime.ts:3863)、[T26](../features/v0.7.97.md:721)、[T33 约束](../features/v0.7.97.md:297)

建议按以下顺序适配：

1. 先吸收 `7c0bfd79`，把已经生成的消息与工具结果在正式提交边界保存，缩小只存在于流式输出中的窗口。[现行接入点](../../packages/coding/src/task-engine/runner-driven.ts:2646)、主线 `7c0bfd79`
2. 从已有 canonical Session/lineage、Run status 和已保存显示 checkpoint 提取下一轮恢复材料；保留 inputId/turnId/outputId/callId 的来源约束，不能靠正文或时间猜测归属。[既有 checkpoint](../../src/session-view.ts:305)、[显示写入](../../src/sdk-runtime.ts:4480)
3. 对上述存储确实没有的工具副作用证据，先用确定性崩溃案例证明缺口；如保持主线能力必须持久化额外事实，在现有 Run 数据中加入有限、明确的恢复事实，并补充 v0.7.97 设计条款。它只能说明“记录到的操作/部分输出”，不能裁定成功、自动续跑或重放 mutation。这是建议的新实现接缝，不是已存在能力。
4. 继续复用有界渲染、同 Session/活动分支筛选、正式历史去重、操作优先和临时 wire context；持久正文剥离所有内部恢复说明。[主线渲染器](https://github.com/icetomoyo/KodaX/blob/cad8b658797976ce22a4bd70c60d2251d537e542/packages/coding/src/task-engine/_internal/interrupted-run-recovery.ts)、[现行 managed 持久化](../../packages/coding/src/task-engine/runner-driven.ts:2176)
5. 保留“没有保存的 token 不承诺硬崩溃后恢复”的现行边界。若实际要求超出这个边界，应写明新保证及保存成本，不能把 journal 依赖隐藏在合并里。[规格](../features/v0.7.97.md:275)

### Shell cleanup 不能只替换判断函数

主线把尚未验证的 OS 清理从阻塞 Run 的状态改成 durable deferred child reference，允许后续对话继续，同时不删除所有权、不确认 Stop、不把 effectOutcome 写成 known。当前分支还有 product queue、sessionControl、extension command/workflow 和 MCP call context；这些额外接线必须保留。[主线 `869461ab` patch](https://github.com/icetomoyo/KodaX/commit/869461ab)、[Product Run 接入](../../src/sdk-runtime.ts:10596)

尤其要验证旧 Run 的 deferred cleanup 不拦死新 Run，后续清理又不能误杀新 Run 的进程；重启后仍能由保存的身份回收。用旧测试仅断言 phase 终态不够，还要检查 child 注册、Stop outcome、错误/PID/cwd/partial output 和 Host close。

## 实际合并预演

执行 `git merge-tree --write-tree --name-only HEAD origin/KodaX`，候选 tree 为 `07cfc1c4bc912fafade3537dc5fcffbe510696f3`，退出码 1。它只生成 Git 对象，没有改动工作区和索引。共 **13 个冲突路径：12 个文本文件 + 1 个子模块指针**。

| 冲突路径 | 解决原则 |
| --- | --- |
| `src/sdk-runtime.ts`、`src/sdk-runtime.test.ts` | 融合 deferred cleanup 和恢复能力；保留 Product queue/MCP/sessionControl/command/workflow；删除误带回的 replay、event→status 及旧 live projection。测试改用真实 Product Client/当前事实。 |
| `packages/coding/src/task-engine/runner-driven.ts`、`.test.ts` | 保留本分支 currentUserIndex/inputId 与真实输入身份，融合提交边界保存、临时恢复 context、失败 transcript 剥离。 |
| `packages/repl/src/session/conversation-page-cache.ts`、`.test.ts` | 当前 v7 有 sourceKeys，主线 v9 有旧配对修复/压缩截断；融合为新缓存版本（建议 v10），完整保留两侧字段和回归。不能仅采用数字较大的 v9，因为主线 v9 并不包含 sourceKeys。 |
| `docs/DD.md`、`docs/HLD.md` | 保留 v0.7.97 Host/Client 架构，吸收主线可靠性更新，明确恢复事实与执行终态边界。 |
| `docs/FEATURE_LIST.md` | 保留 F298 已实现状态，更新 rc.14 release baseline，区分源码包版本、设计目标和发布状态。 |
| `docs/KNOWN_ISSUES.md` | 解决 ID 冲突并按最终 ledger 重算统计，不能用一方覆盖另一方的不同问题。 |
| `public_docs/README.md`、`public_docs/sdk/embedder-guide.md` | 保留 `/client` 产品入口和迁移说明，融合凭据/safeStorage、历史诊断、恢复说明；底层 `/runtime` 文档放在其真实适用范围。 |
| `docs/features` | 先在子模块融合 fd73eb81 和 664d8ba0，再记录新 gitlink，不能直接切到主线指针丢失本分支详细 Done 记录。 |

**自动合并也不等于可用：** 候选 Ink 引用了 `options.runtimeRunner`，而当前分支已经没有该属性；候选 Runtime 加回 `persistence.replay` 调用，但 persistence 接口没有该方法，还加回旧 `RuntimeSessionLiveProjectionState` 等辅助实现。以上是读取候选源码确认的静态问题，未运行候选 typecheck。[现行 Ink 写保护](../../packages/repl/src/ui/InkREPL.tsx:8890)、[现行 persistence](../../src/sdk-runtime.ts:3863)、主线 `efe33d7d`、候选 tree `07cfc1c4`

**子模块本体可清洁融合：** fetch 后，`git -C docs/features rev-list --left-right --count fd73eb81...664d8ba0` 为 57/3。主线独有三次 rc.12–14 文档发布，只修改 `README.md`、`v0.7.96.md`，没有修改 `v0.7.97.md`。子模块 `merge-tree --write-tree` 成功，tree 为 `5996cd3e15ee560271243958f26ac37bd1d0497c`；仍需真正创建合并提交才能更新根仓库 gitlink。

**Issue 编号发生实质碰撞：** 当前分支 340–344 是页序、协议标记截断、普通历史浏览、notice 排序和命令反馈；主线相同 ID 是中断进度、NUL ACL、Windows REPL 退出、sandbox 测试缓存和 eval 预算。建议保留发布主线 ID，将当前分支五项迁到未占用新 ID，更新活跃引用/测试指南和统计，并保存旧编号映射，避免把主线 Open 问题误记为本分支 Resolved。当前 345/346 可以继续保留。[当前 ledger](../KNOWN_ISSUES.md:1091)、`origin/KodaX:docs/KNOWN_ISSUES.md:1065–1069`

## 建议执行顺序和验收

1. **冻结当前 HEAD 与主线 SHA，完整 merge 最新主线。** 26 个提交相互依赖，整体合并比逐个 cherry-pick 更能保存历史和删除意图。按领域处理冲突，最后形成一个根仓库 merge commit；子模块先形成自己的合并提交。
2. **先融合基础依赖、Provider/native 修复、历史修复和消息边界保存。** 缓存使用新版本；保持 input/output/source identities 和现有通知回执。
3. **改接 deferred Shell cleanup 与中断恢复。** 先写失败回归，再落实最小适配，保留 Host queue/MCP/interaction/sessionControl。中断恢复的必要设计增量仍写入 v0.7.97。
4. **整理产品消费者及文档。** 移除误带回的 runtimeRunner/旧 projection；验证真实 iteration 和 iteration_limit 可由 Client agents/Session activity 读到。融合 Issue 编号、指南与版本摘要。
5. **完成现有发布门禁后才认定融合完成。** 构建和源码/测试类型检查、分层 fast/unit/contract/system、bundle、Client 真实 IPC、Ink/classic PTY。重点覆盖：同 inputId 只接收一次；普通排队/steer/redirect；Shell unknown 后新对话；Stop 受理与确认；崩溃/重复重启；消息级持久化；history 全文/跨页/fork/rewind；MCP elicitation；ACP/A2A；断开观察不停止 Run。跨平台 native/人工验收仍需对应平台证据。

契约测试层不是全部 `sdk-client.*` 的替代，必须包含公共 Product Client 行为回归。既有 9/26 验收记录可以用于选回归，不能复用其通过数字为本次合并背书。[9/26 验收](unified-contract-fix-verification-2026-09-26.md)、[历史/操作能力核对](product-contract-assurance-2026-09-26.md)

主线 eval 记录可以作为历史证据保留；本次实现适配先用确定性 Layer 1 验证。需要后续真实模型证据时，遵守 [Eval Guidelines](../../benchmark/EVAL_GUIDELINES.md)，主线已有 eval timeout/budget/raw 保存缺口仍需照实追踪。[指南](../../benchmark/EVAL_GUIDELINES.md)、`origin/KodaX:docs/KNOWN_ISSUES.md:1065`

## 未证实

- 合并后的构建、类型、测试与跨平台行为：本次没有执行实际合并，不能报告通过。
- 已有 Session/Run/checkpoint 能否覆盖主线全部中断证据：需要实际 crash fixture 比较后确定额外持久事实是否必要。
- 主线 Open 的 Windows REPL 退出问题是否在 Product Client 分支同样复现：两边执行入口不同，不能仅凭 Issue 名称判定已修或未修。
- npm 实际已发布版本：本次没有查询 registry；tracker 与 package.json 不是相同事实。

## 未解问题

- 中断恢复是否需要比当前“已保存 checkpoint 可恢复”更强的硬崩溃保证；若需要，在 v0.7.97 内明确有限恢复事实的保存点和边界。
- Issue 重编号采用哪些空闲 ID，应在实际融合 ledger 时统一分配，并保留历史编号映射。

