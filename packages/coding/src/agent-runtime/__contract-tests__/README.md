# Capability Contract Tests

Test suite asserting that each `CAP-XXX` entry in [`docs/features/v0.7.29-capability-inventory.md`](../../../../../docs/features/v0.7.29-capability-inventory.md) **exists and is reachable**, independent of any specific user session.

This is **加强 B** of the 5 重保险 listed in [v0.7.29.md](../../../../../docs/features/v0.7.29.md#5-重保险机制--3-项加强).

## Why this is separate from goldens

Goldens (`tests/sa-refactor-goldens/`) lock end-to-end behavior shape. They catch "did this session change?". But:

- Goldens depend on session sample coverage — a capability that fires only in rare corner cases (e.g., post-tool failure with strong evidence) might not appear in any of the 30-50 selected sessions
- Goldens depend on provider determinism — mock provider hides certain real-provider variance

Contract tests fill the gap: they **directly invoke the capability with a minimal, controlled context** and assert the capability fires + produces the expected outputs. They are the lower-bound coverage; goldens are the upper-bound integration coverage.

## Layout

```
__contract-tests__/
├── README.md                          (this file)
├── _helpers.ts                        Shared helpers — buildMinimalAgentCtx, ReplayProviderStub, etc.
├── cap-001-repo-intelligence.contract.test.ts
├── cap-002-history-cleanup.contract.test.ts
├── cap-003-events-session-start.contract.test.ts
├── ...
└── cap-040-tool-exclude.contract.test.ts
```

One file per CAP-XXX. Each file contains 1-3 `it(...)` blocks asserting the contract test obligations declared in the inventory's `Test obligation` field.

## File naming convention

`cap-NNN-<kebab-name>.contract.test.ts` where:

- `NNN` is the 3-digit zero-padded CAP id
- `<kebab-name>` is a short stable handle (e.g., `history-cleanup`, `auto-reroute`, `events-stream-end`)
- Suffix `.contract.test.ts` so vitest picks it up via the existing `src/**/*.test.ts` include pattern

## Contract test contract

Each contract test must:

1. Import the capability under test from its **post-refactor** location (e.g., `from '../middleware/microcompact.js'`). Pre-refactor in P1, the import will fail; that's expected — the file body asserts behavior assuming the migration target. The test imports MUST point to the new file path so they fail loudly until P2 / P3 lands the migration.
2. Build a **minimal** agent context using `_helpers.buildMinimalAgentCtx()` — do not pull in full session machinery
3. Trigger the capability under test **directly**, not via session replay
4. Assert one of:
   - capability fired (event emitted, hook called, side effect produced)
   - capability produced expected output shape
   - capability respects time-ordering constraint (e.g., "must not fire before X")
5. Each assertion mapped to a `Test obligation` ID from the inventory (e.g., `CAP-AUTO-REROUTE-002`)

## Phase status

- **P1**: this README + `_helpers.ts` skeleton + 1 representative example file (`cap-002-history-cleanup.contract.test.ts`) lock the contract pattern
- **P2 / P3**: each migration PR adds the corresponding contract tests for the CAP-XXX entries it migrates; PR CI fails if contract tests are missing or red
- **P4**: full coverage matrix — every CAP entry has its contract tests passing; reverse audit confirms no CAP entry without tests

## Anti-patterns

DO NOT:

- Import `runKodaX` directly from `agent.ts` and run a full mini-session — that's what goldens do
- Mock the entire substrate executor — defeats the purpose of testing the real middleware
- Skip a CAP entry because "it's covered by golden" — golden coverage is necessary but not sufficient (see top of file)
- Add contract tests outside this directory — keeping all CAP contracts here makes the coverage matrix trivially auditable

## Coverage matrix tool

A future tool (`scripts/contract-coverage.ts`) will:

1. Walk `__contract-tests__/cap-*.contract.test.ts`
2. Cross-reference against `docs/features/v0.7.29-capability-inventory.md` CAP entries
3. Report:
   - CAP entries with no contract test → P3 gate failure
   - Contract tests with no matching CAP entry → outdated test, possibly stale capability
   - `Test obligation` IDs declared in inventory but not asserted in any contract test → coverage gap
