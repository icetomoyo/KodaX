# KodaX Feature 设计索引

> Last updated: 2026-03-28
>
> 当前 roadmap 以 `FEATURE_022` 为中心。
> 它承载的是从旧执行模型转向 `adaptive task engine + native multi-agent execution` 的架构变化。

> 阅读提示：
> 这里保留英文 feature 名称，是为了避免术语漂移。
> 但文档解释会尽量以中文为主。
> `FEATURE_022` 不只是控制面升级，也代表执行模型升级。

## 中文导读

这份文档是 feature design 的总索引，也是当前 feature 文档的阅读入口。

你可以这样理解：

- `README.md` 负责告诉你“哪份 feature 文档是当前 source of truth”
- `v0.7.0.md / v0.8.0.md / v0.9.0.md / v1.0.0.md` 是当前规划阶段最值得看的设计文档
- 更早的 release 文档更多是历史记录，不一定代表 current architecture

如果你只想快速找当前主线，请优先看：

1. `FEATURE_022`
2. `FEATURE_025`
3. `FEATURE_029`
4. `FEATURE_034`

---

## 1. 这个目录怎么读

- 已发布版本的设计文档主要是历史记录。
- 下面这些规划中的设计文档，才是当前 source of truth。
- 计划中的 features 已按新架构重新整理。
- `FEATURE_022` 是当前执行模型转向的 umbrella feature。
- `FEATURE_034` 仍然负责 runtime substrate，与新的 control plane 设计并不冲突。

### 目录结构

```text
docs/features/
|- README.md          # this file
|- v0.3.1.md          # plan mode, ask mode, early project mode
|- v0.3.3.md          # interactive UI improvements
|- v0.4.0.md          # architecture refactor and module decoupling
|- v0.5.0.md          # 5-layer architecture, skills, autocomplete
|- v0.5.20.md         # Project Mode enhancement
|- v0.5.22.md         # CLI-based OAuth providers
|- v0.6.0.md          # Command System 2.0, Project Mode 2.0
|- v0.6.10.md         # Project Harness
|- v0.6.15.md         # parallel toggle, ACP server, provider growth
|- v0.6.20.md         # JSON mode, token usage truth, TODO tree
|- v0.7.0.md          # engine foundation
|- v0.7.10.md         # repository intelligence, multi-agent mode toggle, retrieval tooling
|- v0.7.20.md         # roadmap integrity and planning hygiene
|- v0.8.0.md          # knowledge, retrieval, safe runtime
|- v0.9.0.md          # multimodal inputs + harness maturation
`- v1.0.0.md          # mature delivery surfaces
```

---

## 2. 当前发布状态

| Item | Value |
|---|---|
| Current release | `v0.7.4` |
| Roadmap reset date | `2026-03-25` |
| Main architectural direction | `FEATURE_022` -> adaptive task engine + native multi-agent control plane |

### 当前能力快照

这个仓库已经具备一套比较完整的基础能力，这些能力应该在索引里持续保持可见：

- 分层 monorepo 架构
- CLI、REPL、ACP 三类入口表面
- 同时支持 native provider 和 bridge-backed model 的 provider abstraction
- 内建 coding tools、prompts、sessions、permissions、skills
- Project Harness、`AGENTS.md`、pending user inputs、provider-aware reasoning 等基础工作流能力

| Area | Current baseline |
|---|---|
| Architecture | modular packages with reusable lower layers |
| Surfaces | CLI, REPL, ACP |
| Runtime | coding loop, prompts, tools, sessions |
| Workflow | Project Harness, `AGENTS.md`, reasoning budget policy |
| Extensibility | custom providers, skills, commands, early orchestration plumbing |

### 当前架构快照

```text
CLI Layer
  command parse | file storage | event handler
      ->
Interactive Layer (REPL)
  Ink UI | permission control | built-in commands
      ->
Coding Layer
  tools | prompts | agent loop
      ->
Agent Layer
  session management | messages | tokenizer
      ->
AI Layer
  providers | stream handling | errors

+ Skills Layer
  skill discovery | skill execution | natural-language triggers
```

### 核心能力快照

| Capability | Current baseline |
|---|---|
| Agent loop | `runKodaX()` core loop with up to 200 iterations |
| Session management | JSONL persistence with git-aware workspace context; `user session` vs internal worker scope are now separated |
| Compaction | token-threshold-based message compaction |
| Prompting | dynamic system prompt and platform-aware shell guidance |
| Parallel tools | non-bash tool calls can execute in parallel |
| Permissions | `plan`, `default`, `accept-edits`, `auto-in-project` |

### CLI surface snapshot

| Flag or command | Purpose |
|---|---|
| `-h, --help [TOPIC]` | topic-oriented help |
| `-p, --print TEXT` | one-shot task mode |
| `-c, --continue` | resume latest session |
| `--agent-mode sa|ama` | switch between `SA` and `AMA` execution modes |
| `-t, --thinking` | stronger reasoning mode |
| `-y, --auto` | auto mode |
| `-j, --parallel` | parallel tool execution |
| `--team TASKS` | deprecated legacy multi-agent entry |
| `--init TASK` | start managed long-running work |
| `--auto-continue` | continue long-running work non-interactively |
| `acp serve` | ACP server mode for editor and IDE hosts |

### Interactive command snapshot

| Command | Purpose |
|---|---|
| `/mode [code|ask]` | switch interaction mode |
| `/plan [on|off|once]` | manage plan mode |
| `/model [name]` | switch model |
| `/reasoning [off|auto|quick|balanced|deep]` | set reasoning budget |
| `/agent-mode [sa|ama|toggle]` | switch execution mode between `SA` and `AMA` |
| `/parallel [on|off|toggle]` | toggle parallel tool execution |
| `/status` | show current state |
| `/project [subcommand]` | project and managed-task control surface |
| `@file` | reference file content |
| `!command` | run shell command |

### Tool system snapshot

| Tool | Purpose |
|---|---|
| `read` | read files with offset/limit support |
| `write` | write files and create parent directories |
| `edit` | exact string replacement with `replace_all` support |
| `bash` | run shell commands |
| `glob` | file pattern search |
| `grep` | regex content search |
| `undo` | revert last edit |
| `diff` | inspect file changes |
| `ask-user` | request user decisions |

### Provider snapshot

| Provider | Default model | Reasoning style | Context window |
|---|---|---|---|
| `anthropic` | `claude-sonnet-4-6` | native-budget | 200K |
| `openai` | `gpt-5.3-codex` | native-effort | 400K |
| `kimi` | `k2.5` | native-effort | 256K |
| `kimi-code` | `k2.5` | native-budget | 256K |
| `qwen` | `qwen3.5-plus` | native-budget | 256K |
| `zhipu` | `glm-5` | native-budget | 200K |
| `zhipu-coding` | `glm-5` | native-budget | 200K |
| `minimax-coding` | `MiniMax-M2.7` | native-budget | 204K |
| `gemini-cli` | `Gemini (CLI)` | native-budget | varies |
| `codex-cli` | `Codex (CLI)` | native-budget | varies |
| `deepseek` | `deepseek-chat` | native-toggle | 128K |

### Reasoning mode snapshot

| Mode | Budget strategy |
|---|---|
| `off` | disable deliberate reasoning |
| `auto` | provider-aware automatic selection |
| `quick` | low budget, fast response |
| `balanced` | balanced budget |
| `deep` | high budget for harder reasoning |

### Feature highlights already shipped

| Highlight | Meaning |
|---|---|
| Reasoning modes | provider-aware reasoning budget matrix |
| Promise signals | `COMPLETE`, `BLOCKED`, `DECIDE` control signals |
| Parallel execution | parallel non-bash tool execution |
| Plan mode | plan generation and confirmation workflows |
| Project Harness | action-level verification and proof-carrying completion |
| `AGENTS.md` | project-level AI context rules |
| Pending inputs | runtime user-input interruption queue |
| ACP server | editor and IDE integration surface |
| Plan dual-write whitelist | allows `.agent/plan_mode_doc.md` and system temp paths in plan mode |

### Released version map

Released design docs remain useful as implementation history:

| Version range | Main themes |
|---|---|
| `v0.3.x` | plan mode, ask mode hardening, interactive project mode, early UI |
| `v0.4.x` | monorepo refactor and architecture separation |
| `v0.5.x` | 5-layer architecture, skills, permissions, compaction, provider growth |
| `v0.6.x` | command system, Project Mode 2.0, Project Harness, ACP, provider-aware reasoning |

### Released versions

| Version | Release date | Feature count | Design doc |
|---|---|---:|---|
| `v0.3.1` | `2026-02-19` | 3 | [v0.3.1.md](./v0.3.1.md) |
| `v0.3.3` | `2026-02-20` | 1 | [v0.3.3.md](./v0.3.3.md) |
| `v0.4.0` | `2026-02-24` | 1 | [v0.4.0.md](./v0.4.0.md) |
| `v0.4.6` | `2026-02-27` | 1 | [v0.5.0.md#feature_008-permission-control-system-improvements](./v0.5.0.md#feature_008-permission-control-system-improvements) |
| `v0.5.0` | `2026-02-27` | 7 | [v0.5.0.md](./v0.5.0.md) |
| `v0.5.5` | `2026-03-02` | 1 | [v0.5.0.md#feature_010-architecture-split-agent-core--skills](./v0.5.0.md#feature_010-architecture-split-agent-core--skills) |
| `v0.5.13` | `2026-03-05` | 1 | [v0.5.0.md#feature_012-tui-autocomplete-enhancement](./v0.5.0.md#feature_012-tui-autocomplete-enhancement) |
| `v0.5.14` | `2026-03-06` | 1 | [v0.5.0.md#feature_011-intelligent-context-compaction](./v0.5.0.md#feature_011-intelligent-context-compaction) |
| `v0.5.20` | `2026-03-07` | 1 | [v0.5.20.md](./v0.5.20.md) |
| `v0.5.22` | `2026-03-08` | 1 | [v0.5.22.md](./v0.5.22.md) |
| `v0.5.34` | `2026-03-13` | 1 | [v0.6.0.md#feature_020-agentsmd-project-level-ai-context-rules](./v0.6.0.md#feature_020-agentsmd-project-level-ai-context-rules) |
| `v0.5.37` | `2026-03-15` | 1 | [v0.6.0.md#feature_021-provider-aware-reasoning-budget-matrix](./v0.6.0.md#feature_021-provider-aware-reasoning-budget-matrix) |
| `v0.6.0` | `2026-03-16` | 6 | [v0.6.0.md](./v0.6.0.md) |
| `v0.6.4` | `2026-03-18` | 1 | [v0.6.0.md#feature_023-history-review-mode-and-mouse-wheel](./v0.6.0.md#feature_023-history-review-mode-and-mouse-wheel) |
| `v0.6.10` | `2026-03-18` | 1 | [v0.6.10.md](./v0.6.10.md) |
| `v0.6.13` | `2026-03-21` | 1 | [v0.6.15.md#feature_033-repl-parallel-toggle](./v0.6.15.md#feature_033-repl-parallel-toggle) |
| `v0.6.14` | `2026-03-22` | 2 | [v0.6.15.md#feature_036-deepseek-built-in-provider](./v0.6.15.md#feature_036-deepseek-built-in-provider) |
| `v0.6.15` | `2026-03-22` | 4 | [v0.6.15.md](./v0.6.15.md) |
| `v0.7.0` | `2026-03-25` | 5 | [v0.7.0.md](./v0.7.0.md) |
| `v0.7.10` | `2026-03-27` | 3 | [v0.7.10.md](./v0.7.10.md) |

---

## 3. Planned roadmap

### v0.7.0: Engine Foundation

Focus:

- `FEATURE_022` as the umbrella product feature
- task-first persistence
- harness routing
- native multi-agent control plane
- provider-aware policy
- runtime substrate

Features:

- [FEATURE_022](v0.7.0.md#feature_022-adaptive-task-engine-and-native-multi-agent-control-plane)
- [FEATURE_019](v0.7.0.md#feature_019-session-tree-checkpoints-and-rewindable-task-runs)
- [FEATURE_025](v0.7.0.md#feature_025-adaptive-task-intelligence-and-harness-router)
- [FEATURE_029](v0.7.0.md#feature_029-provider-capability-transparency-and-harness-policy)
- [FEATURE_034](v0.7.0.md#feature_034-extension-and-capability-runtime)

### v0.7.20: Roadmap Integrity

Focus:

- roadmap and tracker consistency
- planning hygiene tooling
- design doc integrity validation

Features:

- [FEATURE_026](v0.7.20.md#feature_026-roadmap-integrity-and-planning-hygiene)

### v0.8.0: Knowledge, Retrieval, and Safe Runtime

Focus:

- capability providers
- sandbox safety
- theme cleanup

Features:

- [FEATURE_007](v0.8.0.md#feature_007-theme-system-consolidation)
- [FEATURE_035](v0.8.0.md#feature_035-mcp-capability-provider)
- [FEATURE_038](v0.8.0.md#feature_038-official-sandbox-extension)

### v0.9.0: Multimodal Inputs and Harness Maturation

Focus:

- bring non-text artifacts into the task engine
- continue evolving the adaptive project / AMA harness into a more calibratable, pivot-capable, and safe long-running system
- continue repo-intelligence maturation without changing the public surface

Features:

- [FEATURE_031](v0.9.0.md#feature_031-multimodal-artifact-inputs)
- [FEATURE_042](v0.9.0.md#feature_042-incremental-repository-intelligence-refresh-and-javac-structural-semantics)
- [FEATURE_043](v0.9.0.md#feature_043-harness-calibration-pivoting-profiling-and-safe-checkpoints)

### v1.0.0: Delivery Surfaces

Focus:

- terminal UX maturity
- cross-surface delivery

Features:

- [FEATURE_023](v1.0.0.md#feature_023-dual-mode-terminal-ux)
- [FEATURE_030](v1.0.0.md#feature_030-multi-surface-delivery)

---

## 4. Historical docs

Released or historical design docs remain available:

- `v0.3.1.md`
- `v0.3.3.md`
- `v0.4.0.md`
- `v0.5.0.md`
- `v0.5.20.md`
- `v0.5.22.md`
- `v0.6.0.md`
- `v0.6.10.md`
- `v0.6.15.md`

These files remain useful as implementation history, but they are not the source of truth for future architecture.

### Why they still matter

Older docs still carry useful material such as:

- current-state architecture references
- prior implementation constraints
- detailed design records for features that were later reframed
- UX research and migration notes that remain valid after roadmap changes

### Historical feature index snapshot

The current source of truth for planning is [FEATURE_LIST.md](../FEATURE_LIST.md), but the older feature index is still useful as a cross-reference when reading historical design docs.

| ID | Feature | Version | Meaning |
|---|---|---|---|
| `001` | Plan Mode | `v0.3.1` | plan generation and confirmation |
| `002` | Ask Mode hardening | `v0.3.1` | enforce read-only behavior |
| `003` | Interactive Project Mode | `v0.3.1` | early `/project` command group |
| `004` | Interactive UI improvements | `v0.3.3` | multiline input, status bar, autocomplete, markdown |
| `005` | Architecture refactor and module decoupling | `v0.4.0` | refactor into independent packages |
| `006` | Skills system | `v0.5.0` | markdown-defined, natural-language-triggered skills |
| `007` | Theme system consolidation | `v0.8.0` | theme cleanup and persistence |
| `008` | Permission control system improvements | `v0.4.6` | 4 permission modes |
| `009` | AI layer independence | `v0.5.0` | separate AI and permission concerns |
| `010` | Agent core + skills split | `v0.5.5` | 5-layer architecture shape |
| `011` | Intelligent context compaction | `v0.5.14` | token-threshold compaction |
| `012` | TUI autocomplete enhancement | `v0.5.13` | multi-source completion |
| `013` | Command System 2.0 | `v0.6.0` | user commands + LLM-callable interaction tools |
| `014` | Project Mode enhancement | `v0.5.20` | AI-first project workflow |
| `015` | Project Mode 2.0 | `v0.6.0` | brainstorm, plan, quality workflows |
| `016` | CLI-based OAuth providers | `v0.5.22` | OAuth-authenticated providers |
| `017` | Pending Inputs Queue | `v0.6.0` | runtime user-input interruption |
| `018` | task-aware repo intelligence substrate | `v0.7.10` | durable repository intelligence for the task engine |
| `019` | Session tree, checkpoints, rewindable task runs | `v0.7.0` | task-aware lineage and rollback-friendly state |
| `020` | `AGENTS.md` | `v0.5.34` | project-level AI context rules |
| `021` | Provider-aware reasoning budget | `v0.5.37` | provider-aware reasoning matrix |
| `022` | Adaptive task engine + native multi-agent control plane | `v0.7.0` | umbrella execution-model shift |
| `023` | Dual-mode terminal UX | `v1.0.0` | inline + stronger TUI interaction model |
| `024` | Project Harness | `v0.6.10` | action-level verification execution |
| `025` | Adaptive task intelligence and harness router | `v0.7.0` | task intake and harness selection |
| `026` | Roadmap integrity and planning hygiene | `v0.7.20` | tracker and metadata consistency |
| `027` | Adaptive multi-agent mode toggle and team-mode sunset | `v0.7.10` | explicit `SA` / `AMA` control and legacy `--team` retirement |
| `028` | Retrieval, context, evidence tooling | `v0.7.10` | progressive local/external retrieval and evidence |
| `029` | Provider capability transparency and harness policy | `v0.7.0` | native vs bridge capability truth |
| `030` | Multi-surface delivery | `v1.0.0` | IDE / desktop / web surface strategy |
| `031` | Multimodal artifact inputs | `v0.9.0` | image and artifact input support |
| `032` | JSON output mode | `v0.6.20` | structured event output |
| `033` | REPL parallel toggle | `v0.6.15` | runtime `/parallel` toggle |
| `034` | Extension + capability runtime | `v0.7.0` | programmable headless runtime substrate |
| `035` | MCP capability provider | `v0.8.0` | MCP ecosystem access |
| `036` | DeepSeek built-in provider | `v0.6.15` | 11th built-in provider |
| `037` | API token usage truth-first accounting | `v0.6.20` | real usage preferred, estimate fallback |
| `038` | Official sandbox extension | `v0.8.0` | optional `@kodax/sandbox` package |
| `039` | Plan dual-write whitelist | `v0.6.15` | `.agent/plan_mode_doc.md` and temp dir |
| `040` | ACP server support | `v0.6.15` | ACP server for editors and IDEs |
| `041` | TODO dependency tree integration | `v0.6.20` | TODO graph and dependency awareness |
| `043` | Harness calibration, pivoting, profiling, and safe checkpoints | `v0.9.0` | Phase 2 maturation for the adaptive project / AMA harness |

---

## 5. Key architecture boundaries

### 5.1 `FEATURE_034`

`FEATURE_034` owns:

- extension and capability runtime
- tool override semantics
- diagnostics and provenance
- host-neutral runtime loading

It does not own:

- task routing
- role semantics
- multi-agent control plane
- completion judgment

### 5.2 `FEATURE_022`

`FEATURE_022` is now the umbrella feature for the task-engine transition. Its multi-agent control plane remains central, but it also owns the product-level shift away from mode-led execution.

### 5.3 `FEATURE_025`

`FEATURE_025` generalizes old project intelligence into task intelligence and harness routing for every request, not only explicit project flows.

---

## 6. Related documents

- [Feature List](../FEATURE_LIST.md)
- [ADR](../ADR.md)
- [HLD](../HLD.md)
- [DD](../DD.md)
- [PRD](../PRD.md)
