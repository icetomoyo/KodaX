# P3 Worker prompt 实施记录

本文保留切片实施时的记录；后续全量测试、模型评估及提交状态见[汇总报告](first-turn-optimization-implementation-2026-10-14.md)。下文“没有付费 eval/没有提交”描述本切片最初完成时的状态。

基线：`bd4479d59cab3d082f07c2d34681fff198d82fa0`。实施以主计划 P3、`prompt-guidance-risk-kodax-2026-10-14.md`、ADR-033/043 为约束。使用 implement/TDD 流程；父任务已冻结 baseline 并授权内部 context/runner 最小接线。本记录不代表模型行为验证通过；没有付费 eval，没有提交。

## 义务映射

| 基线义务 | 候选位置/表达 | 时机与独立入口 |
|---|---|---|
| managed envelope 来源、位置、边界、用户纠正、压缩证据可信性 | Worker managedRunContextTrust 原文保留 | 首请求 stable；压缩保留；没有移到 tool result |
| 多条独立 lane 同响应并行、review 默认多 lane、solo 例外 | parallelFirstCollaboration 保留 | 首次分工前，不由任务关键词开关 |
| 关键路径留 root、互斥写所有权、共享改动不重复应用、worktree merge-back | parallelFirstCollaboration 原文保留 | root/managed child；readonly/write/specialist 原有执行约束未改 |
| 验证只对稳定目标并行、root 最终集成核验 | parallelFirstCollaboration 与 EXECUTION_GUIDANCE 原文保留 | 首次动作前；child completed 仍不等于质量通过 |
| trivial 豁免、多步先里程碑、增长时补计划、resume 复用 | planFirstContract 原文保留 | 首次计划前与续跑 |
| todo subject/description 字段、状态枚举、JSON 调用范例 | 移除 Worker 重复教程，保留工具局部合同；Worker 留 activeForm 与 evaluator 选择/副作用提示 | todo 当前核心工具始终直接展示；独立 SDK/child 的工具合同由 P2 保留 |
| 同 owner 单 active todo、里程碑不等于 Actor | planFirstContract 保留并按现行工具合同明确 per owner | 首次动作前 |
| 增量 create/patch、删除/取消区别 | Worker 短句保留选择理由；参数在 schema | 不改 handler/store |
| freshness 只在 wait/resume/Actor 可能修改时刷新、initial plan 不先 dedup | planListHygiene 原文保留 | 不新增每轮读 todo 的仪式 |
| 里程碑完成及时更新、terminal child 先整合再 wait、多个 child 支撑一个里程碑 | planFirstContract + dispatchRules 原文保留 | 等待/下一里程碑/结束前 |
| plan 可修订、证据推翻假设后转向、已确认事实不反复探测 | scopeCommitment 原文保留 | 全程 |
| read-first 强度、edit/write/multi_edit、已知内容禁止 shell 写绕追踪 | mutationDiscipline 原文保留 | 不调和 SA/tool 的现存 read-first 强度差异 |
| scratch session 路径/fallback、禁止共享根/project root/.agent root/system temp | Worker mutationDiscipline 合并为一处 | standalone Worker 与 managed role 都保留；R 只留 helper last resort、write mkdir、shell guidance |
| 子任务 goal/scope/constraints/evidence/output、路由 tier、objective 语言 | dispatchRules 保留 | 去掉重复工具逐项例子，不删限定目标/证据要求 |
| send 不启动 idle；followup 才启动/更新；interrupt 何时合理 | dispatchRules + childSteeringRules 保留选择义务 | 仅删除第二份调用签名例子；工具契约继续解释参数/生命周期 |
| broadcast cap、满槽不重试、wait ack/mailbox、wait_expired 不轮询、agent_output 只补缺失终态 | dispatchRules 保留 | cap 20 从被删签名例子移入短语；其他协议说明未删 |
| 父 Agent 不遗弃子树、final 验证/阻塞责任/机器 closing contract | dispatchRules/handoff/shared closing 保留 | 旧 completion authority 文案本轮未偷偷纠偏 |
| repo 工具首次选择、relationship/module/symbol/process/impact/LSP/semantic/text 区别 | 一次短任务选择表；移除列表+WHEN+重复例子 | rich description 延迟时仍在首轮；按实际能力逐条组合 |
| review scope→fanout→root diff、不扩 scope、精确源码及失败 fallback | 短 repo 策略与 broad-review 动态合同保留 | 确实不可调用的工具不点名；无结构化 diff 时不保留“禁止所有 shell diff”的死路 |
| primary/work/risk/complexity/review/QA/brainstorm + assurance | 统一 `buildWorkerRoutingContext`，role context/combined 仅一份 | stable 不混动态路由事实；保留 current round 与 original task |
| 用户语言覆盖 response/progress/final、todo 字段、child objective、Actor resume | EXECUTION_GUIDANCE、todo/dispatch 专用规则保留；R 收成 Actor resume 补充 | 每类独立入口都有规则；代码/路径/引用保持源语言 |

## 能力接线

`ManagedRolePromptContext.availableToolNames` 是内部快照，不新增用户配置。`runner-driven.ts` 在 `buildRunnerAgentChain` 后读取完整 `chain.worker.tools`，传给 stable repo guidance 以及动态 broad-review scope 指引。它来自 role/host 已裁剪的可执行工具，而非工具是否被模型表暂时隐藏或一个任务关键词分类结果。

`undefined` 表示旧 standalone caller 没有能力快照，保留完整指导；明确 `[]` 才表示已知没有 repo 工具。部分集合逐条保留可用工具选择指导，并始终保留范围、分工、精确源码和失败恢复规则，不能用 `hasTool=false` 删掉全部静态策略。

root 和 managed Actor child 都经过相同 runner。child-executor 的 read/write child 通过 `agentMode: options.actorControl ? 'ama' : 'sa'` 和其独立 context/exclude/policy 到此。SA child 和 specialist 自有 system override 没有在本批替换为 Worker 规则，工具局部合同继续承担独立入口义务。

## 实际 builder 尺寸

测量脚本：[measure-worker-prompt-p3-2026-10-14.ts](measure-worker-prompt-p3-2026-10-14.ts)。结果：[worker-prompt-p3-measurement-2026-10-14.json](worker-prompt-p3-measurement-2026-10-14.json)。baseline 取固定 `bd4479d` 源码编译后的真实纯 builder，candidate 用当前 builder；共享未修改 formatting/execution-guidance。固定 Windows 路径/任务，无 AGENTS/skills/provider tools。两边 capability 都 omitted，比较完整 standalone 指导；不是全 REPL 请求或 API usage。

| 组件 | 基线字符 / 估算 token | 候选字符 / 估算 token | 估算差值 |
|---|---:|---:|---:|
| Worker stable fragment | 24,118 / 6,076 | 19,426 / 4,880 | -1,196 |
| role stable（已含 Worker，勿重复相加） | 26,943 / 6,789 | 21,626 / 5,438 | -1,351 |
| role dynamic context | 480 / 121 | 305 / 77 | -44 |
| role stable + context | 27,423 / 6,910 | 21,931 / 5,515 | -1,395（约 20.2%） |

数字来自项目 countTokens 估算，实际 UTF-8 bytes 另存 JSON。没有将工具Agent同时修改的 schema 收益混入 P3。部分 capability fixture `read/grep/module_context` 的 Worker fragment 经下述能力修正后为 2,127 估算 token；不是默认场景收益承诺。

## 验证与限制

1. RED：真实 `createRolePrompt` context/combined 的 Primary/Risk 各出现两次；GREEN：统一 routing builder，保留 assurance 与 resume current-round。
2. RED：限制 repo capability 后首请求仍指导 changed_scope/relationship_scan；GREEN：实际 role builder 的 stable + dynamic 合并输出在 root/child 标识、空/部分能力下保留正确选择与 scope/fallback。
3. 新增 `role-prompt-capabilities.test.ts`：空隔离 home/workspace，调用真实 `runManagedTaskViaRunner`，通过 injected stream 在首次 provider 入口截获 tools/system 随即抛出 sentinel 停止；root 和 child上下文各一例。确证 runner 接线使用实际 executable table，无工具执行、无外部模型调用。它不冒称完整 `executeChildAgents` lifecycle 测试。
4. Worker/role/managed context/compaction context 4 组 70 tests 已通过；实际 runner capability 2 tests 通过；typecheck:src 与 typecheck:tests 通过。language-continuity 的 Worker 断言通过；工具description原文断言在并行 P2 修改时曾失败，主会话随后报告已恢复原等义短语并通过 110 项相关测试。
5. 静态义务覆盖与测试不能证明弱模型采纳率不回退；没有运行模型 A/B。repo 长示例删除仍需按主计划受控 probe 验证。read-first、旧 SA plan approval、legacy role authority 不在本批改变。

关键文件：`agents/worker-role-prompt.ts`、`task-engine/_internal/managed-task/role-prompt.ts`、`role-prompt-types.ts`、`task-engine/runner-driven.ts`；相邻 prompt tests。公共包 API、工具 registry、adapter、permission dispatch 未由 P3 修改。

## Spec 评审后的能力修正

原 P3 仅按真实工具集合裁剪 repo 指导；受限 Worker 仍收到不存在的 todo/协作调用要求。RED 在真实 `createRolePrompt` stable+context（root/child 标识、空能力及 read/grep/module_context）发现 `todo_create` 仍在首请求中。修正使用两个明确的小型 family 分支：完整 todo/协作集合继续原文，部分集合逐项给出可用操作的用途；没有工具时采用纯本地执行/简要计划兜底。保留 trivial 直接执行、resume 复用、每 owner 一项、语义里程碑、终态证据整合、最终验证及不能静默丢弃 live child 的责任。没有采用文本关键字过滤或改变权限。

`buildWorkerReviewFanoutContract` 和 Actor capacity 在无 spawn 时不再要求分派；role 外层 ULTRA/workflow 策略以及 `resolveRoleRuntimeStateContext` 的后续 delta 同样使用 capabilities，防止动态上下文重新注入不存在的调用。内部公开 builder `buildWorkerInstructions` 新增可选末参用于同一能力组合；旧调用/未传能力仍为完整指导。部分 spawn 能力仍保留 parallel-first、只读/写入边界和容量上限，部分消息/todo 能力保留其独立职责。没有变动 runtime registry、工具协议或实际 dispatch。

验证：Worker/role/真实 runner root+child/managed context 共 71 tests GREEN，typecheck:src GREEN。新增测试覆盖仅 todo_update/get/send_message 的续跑、仅 spawn 的容量限制，以及受限 dynamic refresh。重新运行纯 builder 量尺，omitted/full fixture 的字符、UTF-8 bytes 与估算 token 均保持上表数值；受限 fixture 更新为 8,463 chars / 8,491 bytes / 2,127 estimated tokens。未运行模型或 eval；静态测试不证明行为采纳率。

## 独立 Runner chain 无 promptContext 的修正

Spec 复查发现 `buildRunnerAgentChain` 也可由独立 SDK 消费者直接交给 `Runner.run`；原注释“仅 topology test”不准确。真实 Runner 首次 llm seam 的 root/child 两例 RED：实际工具只有 read，固定 fallback 仍列出 todo_create/spawn_agent。修正 `agent-chain.ts` 的 instructions closure，把最终 `worker.tools` 名称传给 `resolveRoleInstructions` 的可选末参；仅无 promptContext 的 Worker 分支生成最小 fallback。已有完整 managed prompt 分支和已冻结的模型 case inputs 未改动、未重新捕获。

最小 fallback 保留身份、trivial 直接执行、resume 复用、语义里程碑、终态证据整合与验证/文本终止责任；todo_create/update、spawn/wait/message/followup/interrupt 各自只在可调用时讲其用途，menu 直接来自实际工具集合。既有 EXECUTION_GUIDANCE 只含任务选择与验收边界，未注入强制不存在的 API；保留其全文。未把完整 Worker 的 4,880 token 指令移入这个独立入口，未创建通用框架或改变 SDK 工具执行。

验证：真实 `Runner.run` 的只读 root/child、空集合、todo_update+send_message 四个独立 SDK case；原 managed runner root/child 两例仍通过。合跑 worker/role/capability/runner-driven 共 174 tests GREEN；完整 src/tests typecheck GREEN。未调用外部模型；本次改变生产源哈希，但不会改变有 promptContext 的已冻结 case 输入逻辑。
