# Feature 总表

> Last updated: 2026-04-04

> 中文阅读说明：
> 这份 `FEATURE_LIST` 是 roadmap 的总索引。
> 除了 feature 名称本身保留英文外，其余内容尽量用中文来说明“现在做到哪了、接下来做什么、该去哪里看设计”。
> `FEATURE_022` 是当前架构转向的总 feature，`019/025/029/034` 是它下面的关键支撑切片。

---

## 当前概况

| Item | Value |
|---|---|
| Tracked feature IDs | `001-053` |
| Total tracked features | `53` |
| Completed | `44` |
| InProgress | `0` |
| Planned | `9` |
| Current released version | `v0.7.14` |

### 各版本待做分布

| Version | Planned features |
|---|---|
| `v0.7.20` | `1` |
| `v0.8.0` | `2` |
| `v0.9.0` | `4` |
| `v1.0.0` | `2` |

---

## 计划中的 Feature

| ID | Title | Category | Priority | Planned | Design |
|---|---|---|---|---|---|
| `007` | Theme System Consolidation | Enhancement | Medium | `v0.8.0` | [v0.8.0](features/v0.8.0.md#feature_007-theme-system-consolidation) |
| `023` | Dual-Mode Terminal UX | Enhancement | High | `v1.0.0` | [v1.0.0](features/v1.0.0.md#feature_023-dual-mode-terminal-ux) |
| `026` | Roadmap Integrity and Planning Hygiene | Internal | High | `v0.7.20` | [v0.7.20](features/v0.7.20.md#feature_026-roadmap-integrity-and-planning-hygiene) |
| `030` | Multi-Surface Delivery | Enhancement | High | `v1.0.0` | [v1.0.0](features/v1.0.0.md#feature_030-multi-surface-delivery) |
| `031` | Multimodal Artifact Inputs | New | High | `v0.9.0` | [v0.9.0](features/v0.9.0.md#feature_031-multimodal-artifact-inputs) |
| `042` | Incremental Repository Intelligence Refresh and Java/C++ Structural Semantics | Enhancement | High | `v0.9.0` | [v0.9.0](features/v0.9.0.md#feature_042-incremental-repository-intelligence-refresh-and-javac-structural-semantics) |
| `053` | Canonical Repo Identity and Managed Worktree Runtime | Enhancement | High | `v0.9.0` | [v0.9.0](features/v0.9.0.md#feature_053-canonical-repo-identity-and-managed-worktree-runtime) |
| `043` | Harness Calibration, Pivoting, Profiling, and Safe Checkpoints | Enhancement | High | `v0.9.0` | [v0.9.0](features/v0.9.0.md#feature_043-harness-calibration-pivoting-profiling-and-safe-checkpoints) |
| `038` | Official Sandbox Extension | New | High | `v0.8.0` | [v0.8.0](features/v0.8.0.md#feature_038-official-sandbox-extension) |

---

## 阅读说明

- `FEATURE_022` 是当前架构转向的 umbrella feature，`FEATURE_019`、`FEATURE_025`、`FEATURE_027`、`FEATURE_028`、`FEATURE_029`、`FEATURE_034` 是它的关键支撑切片。
- 当前正式执行模型是：`SA` 直达；`AMA` 只保留 `H0 / H1 / H2`；`H3` 已移除。
- `Scout` 是 pre-harness 牵引层；`H0` 支持 `Scout-complete H0`，但不允许 `Scout` 判 `H0` 后再 handoff 给第二个 direct agent。
- `read-only / docs-only` 默认停留在 `H0`，只有用户明确要求更强校验时才允许 `H1`，永远不进入 `H2`。
- `H1` 是 `Generator + 轻量 Evaluator` 的 lightweight checked-direct：无 `Planner`、无 contract negotiation、无默认多轮 refine。
- `H2` 主骨架固定为 `Planner -> Generator <-> Evaluator`，只留给真正长时的 `code / system` mutation work，且默认单主 pass。
- `Project + SA` 是一等路径，但只写 lightweight run record，不写 managed task。
- `kodax -c` 属于 `user session` 恢复语义，不属于 internal worker-session recovery。

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
| `024` | Project Harness | `v0.6.10` | [v0.6.10](features/v0.6.10.md) |
| `025` | Adaptive Task Intelligence and Harness Router | `v0.7.4` | [v0.7.0](features/v0.7.0.md#feature_025-adaptive-task-intelligence-and-harness-router) |
| `027` | Adaptive Multi-Agent Mode Toggle and Team-Mode Sunset | `v0.7.10` | [v0.7.10](features/v0.7.10.md#feature_027-adaptive-multi-agent-mode-toggle-and-team-mode-sunset) |
| `028` | First-Class Retrieval, Context, and Evidence Tooling | `v0.7.10` | [v0.7.10](features/v0.7.10.md#feature_028-first-class-retrieval-context-and-evidence-tooling) |
| `029` | Provider Capability Transparency and Harness Policy | `v0.7.1` | [v0.7.0](features/v0.7.0.md#feature_029-provider-capability-transparency-and-harness-policy) |
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
| `051` | Host-Aware Fullscreen TUI Substrate and Transcript UX | `v0.7.25` (unreleased) | [v0.7.25](features/v0.7.25.md#feature_051-host-aware-fullscreen-tui-substrate-and-transcript-ux) |
| `052` | Dual-Profile AMA Harness and Child Fan-Out Boundaries | `v0.8.0` (unreleased) | [v0.8.0](features/v0.8.0.md#feature_052-dual-profile-ama-harness-and-child-fan-out-boundaries) |

> `FEATURE_051` close-out posture: keep the current REPL status/footer/task/message surfaces frozen, and limit follow-up work to invisible substrate maturity for transcript, scroll/selection, and input behavior.

---

## 相关文档入口

- [Feature 设计索引](features/README.md)
- [ADR](ADR.md)
- [HLD](HLD.md)
- [DD](DD.md)
- [PRD](PRD.md)
