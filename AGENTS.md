# KodaX Development Rules

Spend time on thinking. DO NOT send optional commentary.

---

**⚠️ CORE PHILOSOPHY: Minimalist & Intelligent**

> **Add code cautiously** — Before adding: Is it necessary? Is it minimal? Is it LLM-friendly?
> **Avoid over-engineering** — Requirements are the measure: fully meet functional & performance needs, add nothing beyond them.
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
- ❌ NEVER add "flexibility" for hypothetical futures (YAGNI)
- ❌ NEVER add config options unless required
- ❌ NEVER deep inheritance / nested factories / sprawling state machines

## LLM-First Design

- ✅ Predictable patterns, type hints, structured data — LLM uses them as context
- ✅ Use LLM for generation, review, refactoring, test-case generation, docs
- ✅ Let LLM handle boilerplate; humans focus on business logic

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

Allowed `.md` files — anything else goes under `docs/`:

- **Root (required)**: `README.md`, `README_CN.md`, `AGENTS.md`, `CHANGELOG.md` — optional: `CLAUDE.md`, `CONTRIBUTING.md`
- **`docs/` (required)**: `PRD.md`, `ADR.md`, `HLD.md`, `DD.md`, `FEATURE_LIST.md`, `features/v{VERSION}.md`, `test-guides/*.md` — optional: `KNOWN_ISSUES.md`
- **Test guide naming**: `FEATURE_{ID}_{VERSION}_TEST_GUIDE.md` / `ISSUE_{ID}_{VERSION}_REGRESSION_GUIDE.md`

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
- ❌ NEVER add configuration for hypothetical needs
- ❌ NEVER break layer independence

## References

- [Product Requirements](docs/PRD.md)
- [Architecture Decisions](docs/ADR.md)
- [Feature List](docs/FEATURE_LIST.md)
