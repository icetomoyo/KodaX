# KodaX Development Rules

> Project-specific rules. For general standards see `~/.claude/rules/`.

---

**⚠️ CORE PHILOSOPHY: Minimalist & Intelligent**

> **Add code cautiously** — Before adding: Is it necessary? Is it minimal? Is it LLM-friendly?
> **Avoid over-engineering** — Never design for hypothetical needs. Abstract only after 3+ real cases.
> **Leverage LLM intelligence** — Design for LLM comprehension. Use LLM for generation, review, and testing.

**KodaX 极致轻量化** — every package is independently usable.

---

## First Message
If the user did not give a concrete task, read `README.md`, then check `docs/` for context:
- `docs/PRD.md` — product requirements
- `docs/ADR.md` — architecture decisions
- `docs/FEATURE_LIST.md` — feature planning

## Code Addition Discipline

**Before adding code, ask**:
1. Is it **necessary**? Can existing code solve it?
2. Is it the **minimal** solution? Can I do the same with less?
3. Is it **LLM-friendly**? Can an LLM understand and extend it?

**Rules**:
- ✅ Composition over inheritance
- ✅ Small focused functions (< 50 lines, single responsibility)
- ✅ Clear, self-documenting names
- ✅ Data-driven over complex control flow
- ✅ Explicit over implicit; structured types as context
- ❌ NEVER add "flexibility" for hypothetical futures (YAGNI)
- ❌ NEVER abstract until 3+ concrete use cases
- ❌ NEVER add config options unless required
- ❌ NEVER deep inheritance / nested factories / sprawling state machines

## LLM-First Design

- ✅ Predictable patterns, type hints, structured data — LLM uses them as context
- ✅ Use LLM for generation, review, refactoring, test-case generation, docs
- ✅ Let LLM handle boilerplate; humans focus on business logic

## Prompt Design Principles (ADR-033)

When writing or modifying any LLM-facing prompt (role prompts in `packages/coding/src/agents/*-role-prompt.ts`, tool `description` fields, system prompt sections, etc.), follow these 5 principles. Full rationale + evidence in [`docs/ADR.md` ADR-033](docs/ADR.md).

1. **Qualitative criteria over quantitative thresholds** — write "when independent work would fill your context with raw output you won't need again" not "when ≥3 investigations". LLM is colleague making judgment, not a program looking up a table.
2. **Single-concept sentences** — never compound `do X AND do Y` rules. One concept per sentence. Compound ✗-clauses cause cross-case regression (FEATURE_177 panel C5 kimi -60pp).
3. **✗ 反模式 sparing, must include WHY** — every "do NOT X" must explain the failure mode it prevents. Bare negation lets the LLM over-suppress adjacent behavior.
4. **No enumerated taxonomies** — don't classify with "RULE A/B/C/D" labels. Use informal use-case examples (claudecode style: "Research:..." / "Implementation:..."). Taxonomies make LLM treat dispatch as a classification problem rather than a judgment.
5. **No version metadata in prompt body** — `FEATURE_xxx vX.Y.Z` annotations belong in code comments, not in the prompt the LLM reads. They're noise + break prompt cache.

**Trigger**: any change touching LLM-facing prompt content must (a) review against ADR-033 + (b) add/update a prompt eval per `benchmark/EVAL_GUIDELINES.md`.

## Technology Stack

| Category | Technology | Version |
|---|---|---|
| Runtime | Node.js | >= 20.0.0 |
| Language | TypeScript | >= 5.7.0 (root uses 5.9.x) |
| Package Manager | npm workspaces | — |
| CLI Framework | Ink (React for CLI) | ^6.7.0 / React >= 19 |
| Test | Vitest | 4.1.11 |
| LLM Providers | Anthropic, OpenAI, DeepSeek, Kimi, Qwen, Zhipu, Zai, MiniMax, MiMo, Ark, Gemini CLI, Codex CLI, … | 16 built-in aliases |

## Monorepo Structure

```
KodaX/
├── packages/
│   ├── llm/                 # LLM abstraction (standalone)
│   ├── agent/               # Agent framework + inline mcp/skills/session-lineage/tracing/workflow
│   ├── coding/              # Coding tools + prompts + repo-intelligence protocol
│   └── repl/                # Interactive terminal (Ink UI)
├── src/                     # CLI entry point
├── docs/                    # Documentation
├── clients/                 # External clients / protocol adapters
└── benchmark/               # Eval harness and datasets
```

Each workspace package must remain independently usable — never break layer independence. Inline subtrees such as MCP, skills, tracing, session lineage, and repo intelligence are no longer standalone workspace packages.

## Documentation Layout

Only the files in the tables below are allowed. Any other `.md` must go under `docs/`.

**Project docs (`docs/`)**

| File | Purpose | Required |
|---|---|---|
| `PRD.md` | Product Requirements | ✅ |
| `ADR.md` | Architecture Decision Records | ✅ |
| `HLD.md` | High-Level Design | ✅ |
| `DD.md` | Detailed Design | ✅ |
| `FEATURE_LIST.md` | Feature tracking | ✅ |
| `KNOWN_ISSUES.md` | Known issues / workarounds | ⚠️ Optional |
| `features/v{VERSION}.md` | Per-version feature design | ✅ |
| `test-guides/*.md` | Human test guides | ✅ |

**Root docs**

| File | Purpose | Required |
|---|---|---|
| `README.md` | Project overview / quick start | ✅ |
| `README_CN.md` | Chinese README | ✅ |
| `AGENTS.md` | Agent development rules (this file) | ✅ |
| `CLAUDE.md` | Claude Code project rules | ⚠️ Optional |
| `CHANGELOG.md` | Release notes | ✅ |
| `CONTRIBUTING.md` | Contribution guidelines | ⚠️ Optional |

**Test guide naming**: `FEATURE_{ID}_{VERSION}_TEST_GUIDE.md` / `ISSUE_{ID}_{VERSION}_REGRESSION_GUIDE.md`

## Test Requirements

- **Coverage**: ≥ 80%
- **Layout**: unit tests next to source (`packages/*/src/**/*.test.ts`); E2E in `tests/`. No `__tests__/` directories.
- **TDD**: write test first (RED) → fail → minimal impl (GREEN) → pass → refactor.

## Benchmark / Eval Workflow

Before any benchmark/eval work (datasets, eval design, runs, analysis), **MUST** read [benchmark/EVAL_GUIDELINES.md](benchmark/EVAL_GUIDELINES.md) and follow it.

## **CRITICAL** Forbidden Items

**Code**
- ❌ NEVER use `any`
- ❌ NEVER circular dependencies
- ❌ NEVER hardcode config (use env vars)
- ❌ NEVER commit `console.log` (use logger)
- ❌ NEVER silently swallow errors

**Architecture**
- ❌ NEVER add abstractions without 3+ use cases
- ❌ NEVER add configuration for hypothetical needs
- ❌ NEVER break layer independence

## References

- [Product Requirements](docs/PRD.md)
- [Architecture Decisions](docs/ADR.md)
- [Feature List](docs/FEATURE_LIST.md)
