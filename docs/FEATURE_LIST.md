# Feature 总表

> Last updated: 2026-04-11

> 中文阅读说明：
> 这份 `FEATURE_LIST` 是 roadmap 的总索引。
> 除了 feature 名称本身保留英文外，其余内容尽量用中文来说明“现在做到哪了、接下来做什么、该去哪里看设计”。
> `FEATURE_022` 是当前架构转向的总 feature，`019/025/029/034` 是它下面的关键支撑切片。

---

## 当前概况

| Item | Value |
|---|---|
| Tracked feature IDs | `001-069` |
| Total tracked features | `69` |
| Completed | `53` |
| InProgress | `2` |
| Planned | `14` |
| Current released version | `v0.7.16` |

### 各版本待做分布

| Version | Planned features |
|---|---|
| `v0.7.16` | `2` |
| `v0.7.20` | `1` |
| `v0.7.25` | `0` |
| `v0.7.30` | `1` |
| `v0.7.35` | `7` |
| `v0.8.0` | `3` |
| `v0.9.0` | `0` |
| `v1.0.0` | `1` |

---

## 进行中的 Feature

| ID | Title | Planned | Design |
|---|---|---|---|
| `057` | Claude-Aligned TUI Substrate Refactor | `v0.7.30` | [v0.7.30](features/v0.7.30.md#feature_057-claude-aligned-tui-substrate-refactor) |

---

## 计划中的 Feature

| ID | Title | Category | Priority | Planned | Design |
|---|---|---|---|---|---|
| `007` | Theme System Consolidation | Enhancement | Medium | `v0.8.0` | [v0.8.0](features/v0.8.0.md#feature_007-theme-system-consolidation) |
| `058` | Transcript Native Scrollback Dump | Enhancement | Medium | `v0.8.0` | [v0.8.0](features/v0.8.0.md#feature_058-transcript-native-scrollback-dump) |
| `059` | Managed Task Structured Protocol V2 | Internal | High | `v0.8.0` | [v0.8.0](features/v0.8.0.md#feature_059-managed-task-structured-protocol-v2) |
| `061` | Scout-First AMA Architecture Simplification | Refactor | High | `v0.7.16` | [v0.7.16](features/v0.7.16.md#feature_061-scout-first-ama-architecture-simplification) |
| `062` | Managed Task Budget Simplification | Refactor | Medium | `v0.7.16` | [v0.7.16](features/v0.7.16.md#feature_062-managed-task-budget-simplification) |
| `060` | Claude-Aligned Bounded-Memory Runtime and OOM Hardening | Internal | High | `v0.7.30` | [v0.7.30](features/v0.7.30.md#feature_060-claude-aligned-bounded-memory-runtime-and-oom-hardening) |
| `026` | Roadmap Integrity and Planning Hygiene | Internal | High | `v0.7.20` | [v0.7.20](features/v0.7.20.md#feature_026-roadmap-integrity-and-planning-hygiene) |
| `063` | Extensible Hook & Automation Substrate | Enhancement | High | `v0.7.35` | [v0.7.35](features/v0.7.35.md#feature_063-extensible-hook--automation-substrate) |
| `064` | Multi-Provider Cost Observatory | Enhancement | High | `v0.7.35` | [v0.7.35](features/v0.7.35.md#feature_064-multi-provider-cost-observatory) |
| `065` | MCP Protocol Maturity | Enhancement | Medium | `v0.7.35` | [v0.7.35](features/v0.7.35.md#feature_065-mcp-protocol-maturity) | **基础已完成 (v0.7.16)**：传输层、工具链路、fallback、配置扁平化。剩余：OAuth、Elicitation、ACP 链路 (#108)、mcp_get_prompt (#109)、/mcp 命令 (#110)、SSE/HTTP 测试 (#111) |
| `066` | Permission Hardening | Enhancement | Medium | `v0.7.35` | [v0.7.35](features/v0.7.35.md#feature_066-permission-hardening) |
| `067` | Parallel Task Dispatch | Enhancement | High | `v0.7.35` | [v0.7.35](features/v0.7.35.md#feature_067-parallel-task-dispatch) |
| `068` | Worktree Isolation Tool | Enhancement | Medium | `v0.7.35` | [v0.7.35](features/v0.7.35.md#feature_068-worktree-isolation-tool) |
| `069` | Session Rewind, Shell Completion & Microcompaction | Enhancement | Medium | `v0.7.35` | [v0.7.35](features/v0.7.35.md#feature_069-session-rewind-shell-completion--microcompaction) |
| `030` | Multi-Surface Delivery | Enhancement | High | `v1.0.0` | [v1.0.0](features/v1.0.0.md#feature_030-multi-surface-delivery) |

---

## 阅读说明

- `FEATURE_022` 是当前架构转向的 umbrella feature，`FEATURE_019`、`FEATURE_025`、`FEATURE_027`、`FEATURE_028`、`FEATURE_029`、`FEATURE_034` 是它的关键支撑切片。
- `FEATURE_061` 是 AMA 架构简化重构：Scout 成为 AMA 唯一入口（既判断又干活），角色升级保留上下文，每个角色可拉 subagent 并行，去掉预路由层和 Tactical Flow。
- 当前正式执行模型是：`SA` 直达；`AMA` 只保留 `H0 / H1 / H2`；`H3` 已移除。
- `Scout` 是 AMA 的入口和第一执行者：H0 时 Scout 直接完成任务；H1/H2 时 Scout 升级为 Generator 或 Planner 并保留上下文。
- `H1` 是 `Generator + 轻量 Evaluator`：无 `Planner`、无 contract negotiation。Evaluator 打回最多 1 次，再不合格则升级到 H2。
- `H2` 主骨架固定为 `Planner -> Generator <-> Evaluator`。Evaluator 区分 `revise`（执行问题）和 `replan`（计划问题），各最多 1 次。
- `FEATURE_054` 的目标方向是把 `Project` 模式吸收进 AMA H2；后续设计应默认以“单主 authority + Planner 吸收 brainstorm”为目标，不再扩独立 project/planner 表面。
- `kodax -c` 属于 `user session` 恢复语义，不属于 internal worker-session recovery。
- `FEATURE_023` 只应继续承担更高层 terminal/delivery ergonomics，不应重新打开 `FEATURE_051 / FEATURE_055` 已冻结的 REPL shell。
- `FEATURE_057` 是 `FEATURE_023` 下的 renderer-boundary 迁移切片：目标是保留当前 shell 的视觉与信息架构，同时把 transcript/prompt/footer 的视口隔离和 host-aware 降级下沉到自有渲染层，而不是重做一个新的 shell。
- `FEATURE_031` 只承担 multimodal artifact intake，不应滑向 gallery、media workbench 或 design-review surface。
- `FEATURE_042` 只应继续加强 repo-intelligence substrate，不应扩成 repo graph / workbench UI。
- `FEATURE_038 / 043 / 053 / 054 / 056` 与 `023 / 031 / 042` 现统一收编到 `v0.7.30`，便于在同一版本内同步推进 runtime clarity、harness safety 与 transcript-native interaction maturity。
- `FEATURE_056` 的目标是补 tool interaction 的解释层与 transcript-native 交互成熟度，不是把 KodaX 做成更重的 coordinator/task cockpit。

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
| `035` | MCP Capability Provider | `v0.8.0` (unreleased) | [v0.8.0](features/v0.8.0.md#feature_035-mcp-capability-provider) |
| `036` | DeepSeek Built-in Provider | `v0.6.15` | [v0.6.15](features/v0.6.15.md) |
| `037` | API Token Usage Priority and Estimation Fallback | `v0.6.20` (unreleased) | [v0.6.20](features/v0.6.20.md) |
| `039` | Plan-Mode Dual-Write Allowlist | `v0.6.15` | [v0.6.15](features/v0.6.15.md) |
| `040` | ACP Server Support | `v0.6.15` | [v0.6.15](features/v0.6.15.md) |
| `041` | Tool Output Guardrails and Context Overflow Protection | `v0.6.20` (unreleased) | [v0.6.20](features/v0.6.20.md) |
| `044` | Durable Compression Anchors and Artifact Recall | `v0.8.0` (unreleased) | [v0.8.0](features/v0.8.0.md#feature_044-durable-compression-anchors-and-artifact-recall) |
| `045` | Provider Stream Resilience and Graceful Recovery | `v0.7.15` (unreleased) | [v0.7.15](features/v0.7.15.md#feature_045-provider-stream-resilience-and-graceful-recovery) |
| `046` | AMA Handoff Integrity and Final-Answer Convergence | `v0.8.0` (unreleased) | [v0.8.0](features/v0.8.0.md#feature_046-ama-handoff-integrity-and-final-answer-convergence) |
| `047` | Invisible Adaptive Parallelism and Evidence-Driven Fan-Out | `v0.8.0` (unreleased) | [v0.8.0](features/v0.8.0.md#feature_047-invisible-adaptive-parallelism-and-evidence-driven-fan-out) |
| `048` | Sectionized Prompt Assembly and Dynamic Capability Truth | `v0.8.0` (unreleased) | [v0.8.0](features/v0.8.0.md#feature_048-sectionized-prompt-assembly-and-dynamic-capability-truth) |
| `049` | First-Class Search, Fetch, Code Search, and Semantic Retrieval | `v0.8.0` (unreleased) | [v0.8.0](features/v0.8.0.md#feature_049-first-class-search-fetch-code-search-and-semantic-retrieval) |
| `050` | Prompt Contracts, Snapshots, and Regression Evaluation | `v0.8.0` (unreleased) | [v0.8.0](features/v0.8.0.md#feature_050-prompt-contracts-snapshots-and-regression-evaluation) |
| `042` | Incremental Repository Intelligence Refresh and Java/C++ Structural Semantics | `v0.7.30` (unreleased) | [v0.7.30](features/v0.7.30.md#feature_042-incremental-repository-intelligence-refresh-and-javac-structural-semantics) |
| `051` | Host-Aware Fullscreen TUI Substrate and Transcript UX | `v0.7.25` (unreleased) | [v0.7.25](features/v0.7.25.md#feature_051-host-aware-fullscreen-tui-substrate-and-transcript-ux) |
| `052` | Dual-Profile AMA Harness and Child Fan-Out Boundaries | `v0.8.0` (unreleased) | [v0.8.0](features/v0.8.0.md#feature_052-dual-profile-ama-harness-and-child-fan-out-boundaries) |
| `053` | Canonical Repo Identity and Managed Worktree Runtime | `v0.7.30` (unreleased) | [v0.7.30](features/v0.7.30.md#feature_053-canonical-repo-identity-and-managed-worktree-runtime) |
| `055` | REPL Substrate Hardening and Summary-Only AMA UX | `v0.9.0` (unreleased) | [v0.9.0](features/v0.9.0.md#feature_055-repl-substrate-hardening-and-summary-only-ama-ux) |
| `056` | Tool Interaction Maturity and Transcript-Native Explanation Layer | `v0.7.30` (unreleased) | [v0.7.30](features/v0.7.30.md#feature_056-tool-interaction-maturity-and-transcript-native-explanation-layer) |
| `054` | AMA-Project Convergence: Absorb Project Mode into Adaptive H2 | `v0.7.30` (unreleased) | [v0.7.30](features/v0.7.30.md#feature_054-ama-project-convergence-absorb-project-mode-into-adaptive-h2) |
| `043` | Harness Calibration, Pivoting, Profiling, and Safe Checkpoints | `v0.7.30` (unreleased) | [v0.7.30](features/v0.7.30.md#feature_043-harness-calibration-pivoting-profiling-and-safe-checkpoints) |
| `038` | Official Sandbox Extension | `v0.7.30` (unreleased) | [v0.7.30](features/v0.7.30.md#feature_038-official-sandbox-extension) |

> `FEATURE_051` close-out posture: keep the current REPL status/footer/task/message surfaces frozen, limit follow-up work to invisible substrate maturity for transcript, scroll/selection, and input behavior, and treat the design doc as a completed close-out record rather than an open rollout plan.

> `FEATURE_055` completed the follow-up REPL hardening work: docs-first substrate maturity, summary-only AMA mapping, and no new visible worker/task shell.

> `FEATURE_031` now treats inline image refs as true structured multimodal inputs: provider-facing text uses stable image anchors such as `[Image #1]` and clean unavailable-image placeholders instead of leaking raw `@image-path` syntax.

> `v0.7.35` 主题：Engineering Shell Maturity（工程外壳成熟度）。基于 KodaX vs Claude Code 全面对比分析，补齐工程外壳层面的真实差距：Hook 自动化管道 (063)、多 Provider 成本追踪 (064)、MCP 协议成熟 (065)、权限细化 (066)。四个 Feature 无相互依赖，可并行开发。IDE Bridge (#093) 在 Vibe Coding 时代已降级为长期可选目标。

---

## 相关文档入口

- [Feature 设计索引](features/README.md)
- [ADR](ADR.md)
- [HLD](HLD.md)
- [DD](DD.md)
- [PRD](PRD.md)
