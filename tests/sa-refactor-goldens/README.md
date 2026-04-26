# SA Refactor Goldens

Golden trace test suite locking the behaviour of the SA execution path **before** the v0.7.29 FEATURE_100 refactor (Unified Agent Execution Substrate). After the refactor lands, replay must produce shape-identical recordings — any diff must have an explanation and a test that captures the deliberate change.

This is **mechanism 2** of the 5 重保险 listed in [v0.7.29.md](../../docs/features/v0.7.29.md#5-重保险机制--3-项加强).

## Layout

| File | Purpose |
|---|---|
| `providers.ts` | `RecorderProvider` + `ReplayProvider` (extend `KodaXBaseProvider`); record / replay protocol with shape diffing |
| `session-parser.ts` | Parse user's `.kodax/sessions/*.jsonl` (legacy flat + lineage tree formats) |
| `selection.ts` | 7 edge-case detectors + stratified sampling algorithm + task-family classifier |
| `record-goldens.ts` | Recording driver — wraps inner provider with `RecorderProvider`, runs `runKodaX` per session, writes to `recordings/` |
| `dry-run-selection.ts` | CLI report (no API calls) — prints which sessions would be selected and detector coverage |
| `record.ts` | Higher-level `GoldenSessionSnapshot` types + orchestration entry points (P2 still uses raw recordings via `providers.ts`) |
| `recordings/` | **gitignored** — per-session JSON files, one per recorded session, ~12 MB for full corpus |
| `selection.test.ts` / `providers.test.ts` | Vitest smoke tests, including in-the-wild guard against `~/.kodax/sessions/` |

## How to use

### 1. Dry-run (no API calls)

Inspects the on-disk session corpus and prints which sessions would be selected for recording:

```bash
npx tsx tests/sa-refactor-goldens/dry-run-selection.ts
# or with explicit dir:
npx tsx tests/sa-refactor-goldens/dry-run-selection.ts /path/to/sessions
```

Output reports `[CORPUS-MISS]` for any detector with zero matches in the user's history — those CAPs cannot be golden-traced from existing sessions and need fixture synthesis (or rely on the contract test stub for coverage).

### 2. Record baseline (real API calls — costs money)

```bash
# Smoke-test (1 session, ~$0.005, ~40s)
npx tsx tests/sa-refactor-goldens/record-goldens.ts \
  --inner-provider deepseek --inner-model deepseek-v4-flash \
  --limit 1 --max-iter 5

# Full corpus (~45 sessions, ~$0.25, ~37 min on deepseek-v4-flash)
npx tsx tests/sa-refactor-goldens/record-goldens.ts \
  --inner-provider deepseek --inner-model deepseek-v4-flash \
  --limit 50 --max-iter 8
```

Per-session execution runs inside a `git worktree add` of HEAD so file-mutation tools don't touch the live working copy. Worktrees are cleaned up unconditionally on exit.

Available `--inner-provider`: any built-in (`deepseek`, `kimi-code`, `zhipu-coding`, `minimax-coding`, `mimo-coding`, `ark-coding`, …). The recorder registers a virtual provider name (`__recorder_${innerName}_${sessionId}__`) and points `runKodaX` at it.

### 3. Verify (P2/P3 — when SA refactor lands)

For each `recordings/<sessionId>.json`, replay through `ReplayProvider.fromFile` against the post-refactor `runKodaX`. Any shape mismatch fails with a structured diff identifying which call diverged on which field.

```typescript
import { ReplayProvider } from './providers.js';

const replay = await ReplayProvider.fromFile('recordings/20260419_001250.json');
await runKodaX({ provider: registerVirtual(replay), ... }, prompt);
// throws ReplayMismatchError if post-refactor diverges
```

(The full verify driver is the P3 deliverable; goldens currently provide the recording substrate but not yet the verify CLI.)

## Privacy / git policy

`recordings/` is **gitignored** because each file contains:
- The actual prompt the user typed (may include proprietary task descriptions)
- File paths from the user's machine (e.g. `C:\Users\…\.kodax\skills\…`)
- Model thinking blocks that may reveal task context

Treat as PII-adjacent. Regenerate locally with `record-goldens.ts` rather than checking in.

## Selection algorithm

Source: `~/.kodax/sessions/*.jsonl` (user's actual KodaX session log; supports both legacy flat and lineage-tree formats).

Stratified sampling in `selection.ts`:
1. **Mandatory edge-case coverage first** — for each detector with corpus hits, pick the session matching the most-uncovered detectors
2. **Length-bucket fill** — top up `short` (≤ 2 turns) / `medium` (3–7) / `long` (8+) toward configurable quotas
3. **Per-family minimum** — top up `review` / `lookup` / `planning` / `investigation` / `implementation` toward `perFamilyMin`
4. **Hard cap** — trim from over-represented buckets if total exceeds `maxTotal`, preserving mandatory-coverage picks

Default options: `{ perBucket: { short: 8, medium: 15, long: 8 }, perFamilyMin: 5, maxTotal: 50 }`.

## Determinism strategy

Real LLM calls are non-deterministic. Goldens replay through `ReplayProvider`:

- **Record**: `runKodaX` runs against a real provider wrapped by `RecorderProvider`; every `provider.stream` request envelope + ordered callback timeline + result is captured into `recordings/<sessionId>.json`
- **Replay**: `runKodaX` runs against `ReplayProvider`, which returns recorded results in sequence. Any shape mismatch (message count / role pattern / tool names / reasoning depth / modelOverride) throws `ReplayMismatchError` at the offending call

This locks **two layers**:
1. Provider request shape (does the substrate still build the same prompt?)
2. Downstream behaviour given a known response (tool dispatch order, event firing sequence, history reshaping)

## Status

| Phase | Item | State |
|---|---|---|
| P1 | `RecorderProvider` / `ReplayProvider` with config-query delegation | ✅ |
| P1 | Session parser (legacy + lineage formats) | ✅ |
| P1 | Selection algorithm + 7 edge-case detectors | ✅ |
| P1 | Recording driver with sandbox isolation | ✅ |
| P1 | Baseline recording (45 sessions × 200 calls × 12.9 MB) | ✅ |
| P1 | `record.ts` high-level `GoldenSessionSnapshot` orchestration | ⏳ deferred — raw recordings are sufficient for shape-diff regression detection |
| P3 | Verify CLI driver | ⏳ |
| P3 | `goldens:coverage` matrix tool (CAP × session cross-reference) | ⏳ |
| P3 | CI integration | ⏳ |

## Known corpus limitations

The user's existing session log is a message history, not an event audit trail. Some CAPs cannot be golden-traced from existing sessions:

- `CAP-007` rate-limit retry (events go to `console.log` / `onRateLimit` callback only)
- `CAP-009` multimodal image input (depends on user habits — the recorded user has no image-paste sessions)
- `CAP-015` edit anchor recovery (depends on user actually hitting anchor failures)
- `CAP-020` extension-runtime queued message drain (depends on extensions in use)

The dry-run report flags these as `[CORPUS-MISS]`. Fixture synthesis for these CAPs is a P3 task; until then, contract tests cover them.
