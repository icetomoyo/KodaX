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

## Technology Stack

| Category | Technology | Version |
|---|---|---|
| Runtime | Node.js | >= 18.0.0 |
| Language | TypeScript | >= 5.3.0 |
| Package Manager | npm workspaces | — |
| CLI Framework | Ink (React for CLI) | ^4.x |
| Test | Vitest | ^3.2.4 |
| LLM Providers | Anthropic, OpenAI, DeepSeek, Kimi, Qwen, Zhipu, MiniMax, MiMo, Gemini CLI, Codex CLI, … | 12 total |

## Monorepo Structure

```
KodaX/
├── packages/
│   ├── ai/                  # LLM abstraction (standalone)
│   ├── agent/               # Agent framework
│   ├── coding/              # Coding tools + prompts
│   ├── core/                # Shared core primitives
│   ├── mcp/                 # MCP integration
│   ├── repl/                # Interactive terminal (Ink UI)
│   ├── repointel-protocol/  # Repo intelligence protocol
│   ├── session-lineage/     # Session lineage tracking
│   ├── skills/              # Agent skills (zero-dep)
│   └── tracing/             # Tracing/observability
├── src/                     # CLI entry point
└── docs/                    # Documentation
```

Each package must remain independently usable — never break layer independence.

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
