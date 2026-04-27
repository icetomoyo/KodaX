# KodaX Development Rules

---

**⚠️ CORE PHILOSOPHY: Minimalist & Intelligent**

> **Add code cautiously** - Before adding: Is it necessary? Is it minimal? Is it LLM-friendly?
> **Avoid over-engineering** - Never design for hypothetical needs. Abstract only after 3+ real cases
> **Leverage LLM intelligence** - Design for LLM comprehension. Use LLM for generation, review, and testing

---

> This file contains project-specific rules and constraints.
> For general coding standards, see global rules in `~/.claude/rules/`.
>
> **Documentation & Testing**:
> - **TDD First**: Write tests before implementation (RED-GREEN-REFACTOR)
> - **Doc First**: Update docs before coding (PRD, ADR, Feature Design)
> - **Doc Location**: ALL `.md` files go to `docs/` directory (see Documentation Standards)

---

## First Message
If the user did not give you a concrete task in their first message, read README.md, then check docs/ for relevant documentation:
- docs/PRD.md - Product requirements
- docs/ADR.md - Architecture decisions
- docs/FEATURE_LIST.md - Feature planning

## Development Philosophy

### Minimalist & Intelligent

**Core Principle**: Write less code, leverage LLM intelligence, maintain high quality.

**KodaX Philosophy**: 极致轻量化 - each of the 5 layers is independently usable.

### Code Addition Discipline

**Before Adding Code, Ask**:
1. Is this code **necessary**? Can existing code solve the problem?
2. Is this the **minimal** solution? Can I achieve the same with less code?
3. Is this code **LLM-friendly**? Can LLM understand and extend it easily?

**Rules**:
- ✅ Prefer composition over inheritance (simpler for LLM to understand)
- ✅ Write small, focused functions (< 50 lines, single responsibility)
- ✅ Use clear naming (LLM-friendly, self-documenting)
- ✅ Prefer data-driven logic over complex control flow
- ❌ NEVER add "flexibility" for hypothetical future needs (YAGNI)
- ❌ NEVER create abstractions until you have 3+ concrete use cases
- ❌ NEVER add configuration options unless absolutely necessary

### LLM-First Design

**Design for LLM Intelligence**:
- ✅ Use clear, predictable patterns (LLM learns faster)
- ✅ Prefer explicit over implicit (reduces LLM confusion)
- ✅ Use structured data formats (JSON, TypeScript types)
- ✅ Provide type hints and interfaces (LLM uses them as context)
- ✅ Write self-documenting code (LLM reads code, not comments)

**Leverage LLM Capabilities**:
- ✅ Use LLM for code generation, review, and refactoring
- ✅ Use LLM for test case generation (human-test-guide skill)
- ✅ Use LLM for documentation generation
- ✅ Let LLM handle boilerplate (focus on business logic)

### Quality Over Quantity

**Code Quality Checklist**:
- [ ] Is this the simplest solution that works?
- [ ] Will this code be easy for LLM to understand and modify?
- [ ] Are there fewer than 3 levels of nesting?
- [ ] Is the code testable with minimal setup?
- [ ] Does this avoid premature optimization?

**Red Flags (Avoid)**:
- Deep inheritance hierarchies (hard for LLM to trace)
- Complex state machines (hard for LLM to reason about)
- Excessive configuration/options (indicates over-engineering)
- Abstract factories of abstract factories (LLM confusion)

## Technology Stack

| Category | Technology | Version |
|----------|-----------|---------|
| Runtime | Node.js | >= 20.0.0 |
| Language | TypeScript | >= 5.3.0 |
| Package Manager | npm workspaces | - |
| CLI Framework | Ink (React for CLI) | ^4.x |
| Test | Vitest | ^1.2.0 |
| LLM Providers | Anthropic, OpenAI, Google, Zhipu, Kimi, MiniMax, DeepSeek, etc. | 11 total |

## Monorepo Structure

```
KodaX/
├── packages/
│   ├── ai/              # LLM abstraction layer (独立库)
│   ├── agent/           # Agent framework
│   ├── coding/          # Coding tools + prompts
│   ├── repl/            # Interactive terminal (Ink UI)
│   └── skills/          # Agent skills (零外部依赖)
├── src/                 # CLI entry point
└── docs/                # Documentation
```

**Layer Independence**:
- `@kodax/ai` - Can be used standalone in any project
- `@kodax/agent` - Can be used with any LLM provider
- `@kodax/coding` - Can be embedded in other agents
- `@kodax/repl` - Full REPL experience
- `@kodax/skills` - Zero external dependencies

## Documentation Standards

### Allowed Documentation Files

#### Project Documentation (`docs/`)

| File | Purpose | Required |
|------|---------|----------|
| `PRD.md` | Product Requirements Document | ✅ Yes |
| `ADR.md` | Architecture Decision Records | ✅ Yes |
| `HLD.md` | High-Level Design | ✅ Yes |
| `DD.md` | Detailed Design | ✅ Yes |
| `FEATURE_LIST.md` | Feature tracking | ✅ Yes |
| `KNOWN_ISSUES.md` | Known issues and workarounds | ⚠️ Optional |
| `release.md` | Binary release & distribution pipeline | ⚠️ Optional |
| `features/v{VERSION}.md` | Feature design by version | ✅ Yes |
| `test-guides/*.md` | Human test guides | ✅ Yes |

#### Root Documentation

| File | Purpose | Required |
|------|---------|----------|
| `README.md` | Project overview and quick start | ✅ Yes |
| `README_CN.md` | Chinese README | ✅ Yes |
| `CONTRIBUTING.md` | Contribution guidelines | ⚠️ Optional |

### Feature Tracking
**Location**: `docs/FEATURE_LIST.md` and `docs/features/`

**Commands**:
```bash
/add-feature "description"        # Add feature
/start-next-feature [id]          # Start feature development
/complete-feature [id]            # Mark feature complete
```

### Issue Tracking
**Location**: `docs/KNOWN_ISSUES.md`

**Commands**:
```bash
/add-issue "problem description"  # Add issue
/resolve-next-issue [id]          # Resolve issue
```

### Test Guides
**Location**: `docs/test-guides/`

**File Naming**:
```
Feature: FEATURE_{ID}_{VERSION}_TEST_GUIDE.md
Issue:   ISSUE_{ID}_{VERSION}_REGRESSION_GUIDE.md
```

## Commands

```bash
npm install          # Install dependencies
npm run test         # Run all tests
npm run build        # Build all packages
npm run dev          # Development mode (tsx)
npm run start        # Production mode
```

## Test Requirements

**Minimum Coverage**: 80%

**File Organization**:
- **Unit tests**: `packages/*/src/**/*.test.ts` (next to source files)
- **E2E tests**: `tests/` (root directory)
- **No `__tests__/` directories** - keep tests close to source

**TDD Workflow**:
1. Write test first (RED)
2. Run test - should FAIL
3. Write minimal implementation (GREEN)
4. Run test - should PASS

### Prompt Eval (FEATURE_104, v0.7.29)

Any change that touches **LLM-facing prompt content** must include a
prompt-eval case under `tests/*.eval.ts` using the `benchmark/harness/`
module (`aliases.ts` + `judges.ts` + `harness.ts` + `report.ts` + `persist.ts`).

**Triggers** (must add/update an eval):
- `packages/coding/src/agent-runtime/system-prompt-*.ts`
- `packages/coding/src/task-engine/_internal/managed-task/role-prompt.ts`
- Tool `description` fields in `packages/coding/src/tools/`
- `coding-preset.ts:DEFAULT_CODING_INSTRUCTIONS`
- `packages/coding/src/agents/protocol-emitters.ts` prompts

**Non-triggers** (no eval needed):
- Reasoning depth / parameter changes (FEATURE_078 / FEATURE_103 L1-L5 chain)
- Routing / dispatcher logic (no prompt content change)
- Compaction / session persistence infrastructure

**Run**: `npm run test:eval` (skips when API keys absent).

**Folder layout** (FEATURE_104 v2 restructure):
- `benchmark/README.md` — convention guide + patterns + statistical caveats
- `benchmark/harness/` — code modules + zero-LLM self-test (version-tracked)
- `benchmark/datasets/` — test cases / golden inputs (version-tracked)
- `benchmark/results/` — run outputs (**NOT** version-tracked)
5. Refactor (IMPROVE)

## **CRITICAL** Forbidden Items

### Code
- ❌ NEVER use `any` type
- ❌ NEVER circular dependencies
- ❌ NEVER hardcode config (use environment variables)
- ❌ NEVER commit console.log (use logger)
- ❌ NEVER silently swallow errors

### Architecture
- ❌ NEVER add abstractions without 3+ use cases
- ❌ NEVER add configuration for hypothetical needs
- ❌ NEVER break layer independence

## References

- [Product Requirements](docs/PRD.md)
- [Architecture Decisions](docs/ADR.md)
- [Feature List](docs/FEATURE_LIST.md)
