# KodaX Feature Design Index

> Last updated: 2026-03-25
>
> The current roadmap centers on `FEATURE_022`, which now carries the shift to an adaptive task engine with native multi-agent execution.

---

## 1. How to read this directory

- Released design docs remain historical records.
- Planned design docs below are the current source of truth.
- Planned features were reorganized to match the new architecture.
- `FEATURE_022` is the umbrella feature for the current execution-model shift.
- `FEATURE_034` remains the runtime substrate and does not conflict with the new control plane design.

### Directory structure

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
|- v0.8.0.md          # knowledge, retrieval, safe runtime
|- v0.9.0.md          # multimodal inputs
`- v1.0.0.md          # mature delivery surfaces
```

---

## 2. Current release state

| Item | Value |
|---|---|
| Current release | `v0.6.15` |
| Roadmap reset date | `2026-03-25` |
| Main architectural direction | `FEATURE_022` -> adaptive task engine + native multi-agent control plane |

### Current capability snapshot

The repo already ships a substantial baseline that should remain visible in this index:

- layered monorepo architecture
- CLI, REPL, and ACP entry surfaces
- provider abstraction with native and bridge-backed models
- built-in coding tools, prompts, sessions, permissions, and skills
- Project Harness, `AGENTS.md`, pending user inputs, and provider-aware reasoning behavior

| Area | Current baseline |
|---|---|
| Architecture | modular packages with reusable lower layers |
| Surfaces | CLI, REPL, ACP |
| Runtime | coding loop, prompts, tools, sessions |
| Workflow | Project Harness, `AGENTS.md`, reasoning budget policy |
| Extensibility | custom providers, skills, commands, early orchestration plumbing |

### Architecture snapshot

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

### Core functionality snapshot

| Capability | Current baseline |
|---|---|
| Agent loop | `runKodaX()` core loop with up to 200 iterations |
| Session management | JSONL persistence with git-aware workspace context |
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
| `-t, --thinking` | stronger reasoning mode |
| `-y, --auto` | auto mode |
| `-j, --parallel` | parallel tool execution |
| `--team TASKS` | legacy parallel subagent plumbing |
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
- [FEATURE_026](v0.7.0.md#feature_026-roadmap-integrity-and-planning-hygiene)
- [FEATURE_029](v0.7.0.md#feature_029-provider-capability-transparency-and-harness-policy)
- [FEATURE_034](v0.7.0.md#feature_034-extension-and-capability-runtime)

### v0.8.0: Knowledge, Retrieval, and Safe Runtime

Focus:

- knowledge substrate
- evidence tooling
- extensible runtime capabilities
- sandbox safety
- theme cleanup

Features:

- [FEATURE_007](v0.8.0.md#feature_007-theme-system-consolidation)
- [FEATURE_018](v0.8.0.md#feature_018-codewiki-and-task-knowledge-substrate)
- [FEATURE_028](v0.8.0.md#feature_028-first-class-search-retrieval-and-evidence-tooling)
- [FEATURE_035](v0.8.0.md#feature_035-mcp-capability-provider)
- [FEATURE_038](v0.8.0.md#feature_038-official-sandbox-extension)

### v0.9.0: Multimodal Inputs

Focus:

- bring non-text artifacts into the task engine

Features:

- [FEATURE_031](v0.9.0.md#feature_031-multimodal-artifact-inputs)

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
| `018` | CodeWiki / task knowledge substrate | `v0.8.0` | durable project knowledge |
| `019` | Session tree, checkpoints, rewindable task runs | `v0.7.0` | task-aware lineage and rollback-friendly state |
| `020` | `AGENTS.md` | `v0.5.34` | project-level AI context rules |
| `021` | Provider-aware reasoning budget | `v0.5.37` | provider-aware reasoning matrix |
| `022` | Adaptive task engine + native multi-agent control plane | `v0.7.0` | umbrella execution-model shift |
| `023` | Dual-mode terminal UX | `v1.0.0` | inline + stronger TUI interaction model |
| `024` | Project Harness | `v0.6.10` | action-level verification execution |
| `025` | Adaptive task intelligence and harness router | `v0.7.0` | task intake and harness selection |
| `026` | Roadmap integrity and planning hygiene | `v0.7.0` | tracker and metadata consistency |
| `028` | Search, retrieval, evidence tooling | `v0.8.0` | web/code search and evidence |
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
