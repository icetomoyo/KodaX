# FEATURE_061: Scout-First AMA Architecture — Implementation Plan

> Design doc: [v0.8.0.md#feature_061](v0.8.0.md#feature_061-scout-first-ama-architecture-simplification)
>
> Last updated: 2026-04-11

---

## Progress Tracker

| Phase | Status | Summary |
|-------|--------|---------|
| Phase 1 | **Not started** | Remove pre-Scout routing layers |
| Phase 2 | Not started | Scout does actual work on H0 |
| Phase 3 | Not started | Context continuation across role upgrades |
| Phase 4 | Not started | Unify Tactical Flows into role-level subagents |
| Phase 5 | Not started | Replace H0/H1/H2 naming with worker-chain composition |
| Phase 6 | Not started | Simplify budget system |

---

## Key Files

| File | Lines (~) | Role |
|------|-----------|------|
| `packages/coding/src/task-engine.ts` | ~11000 | Core managed task engine |
| `packages/coding/src/reasoning.ts` | ~3070 | Routing decision and reasoning plan |
| `packages/coding/src/task-engine.test.ts` | ~2500 | Task engine tests |
| `packages/coding/src/types.ts` | ~950 | Type definitions |
| `packages/coding/src/managed-protocol.ts` | ~400 | Protocol block parsing |
| `packages/coding/src/orchestration.ts` | — | Orchestration infrastructure (keep) |
| `packages/coding/src/fanout-scheduler.ts` | — | Fan-out scheduling (Phase 4 target) |

---

## Phase 1: Remove Pre-Scout Routing Layers

**Goal**: Scout becomes the direct AMA entry point after Intent Gate. No LLM routing call, no bypass check, no harness guardrails before Scout.

**Risk**: Low-Medium (mostly deleting code, but tests need updating)

### Step 1A: Remove LLM routing from `createReasoningPlan`

**File**: `reasoning.ts`

**What to change**:
- Function `createReasoningPlan` (line 1261): currently has 3 branches:
  1. `!intentGate.shouldUseModelRouter` → uses `buildFallbackRoutingDecision` (heuristic, no LLM)
  2. `mode === 'auto'` → calls `routeTaskWithLLM` (**LLM call — DELETE THIS BRANCH**)
  3. else → uses `buildFallbackRoutingDecision`
- Make ALL paths use `buildFallbackRoutingDecision`. The function signature stays the same.
- Keep `routeTaskWithLLM` function body for now (dead code, clean up later)
- Add routing note: `'Pre-Scout LLM routing disabled (FEATURE_061 Phase 1); Scout is the routing authority.'`

**Why**: Scout will be the sole routing authority. The pre-Scout LLM call is redundant.

**Test impact**: Tests in `task-engine.test.ts` mock `createReasoningPlan` at the import level, so changing its implementation doesn't break mocks. Check `reasoning.test.ts` for any tests calling the real function.

### Step 1B: Delete `shouldBypassScoutForManagedH0` and its callsite

**File**: `task-engine.ts`

**What to delete**:
- Function `shouldBypassScoutForManagedH0` (line 869-899): determines if a task should skip Scout entirely
- Its callsite in `runManagedTask` (lines 10892-10919): the `if (shouldBypassScoutForManagedH0(...))` block that returns `runDirectKodaX(...)` directly
- Also delete the `shouldKeepLookupDirect` variable (lines 10892-10897) which only gates the bypass

**Why**: All AMA tasks must go through Scout. No bypass.

**Test impact**: Tests expecting H0 tasks to bypass Scout need updating:
- `'keeps obvious AMA H0 tasks on the direct path without scout'` → change to expect Scout is called
- Any test that asserts `mockRunDirectKodaX` was called exactly once for a simple H0 task

### Step 1C: Remove `resolveManagedHarnessGuardrail`, simplify `applyManagedHarnessGuardrailsToPlan`

**File**: `task-engine.ts`

**What to delete**:
- Function `resolveManagedHarnessGuardrail` (lines 2157-2188): computes minimum harness based on `needsIndependentQA`, `mutationSurface`, etc.

**What to simplify**:
- Function `applyManagedHarnessGuardrailsToPlan` (lines 2190-2250): currently calls `resolveManagedHarnessGuardrail` and forces harness upgrade. Change to a pass-through that only attaches `reviewTarget` to the decision without enforcing any harness floor.

New implementation:
```typescript
function applyManagedHarnessGuardrailsToPlan(
  plan: ReasoningPlan,
  reviewTarget: ManagedReviewTarget,
): { plan: ReasoningPlan; routingOverrideReason?: string } {
  const decisionWithTarget = cloneRoutingDecisionWithReviewTarget(plan.decision, reviewTarget);
  if (decisionWithTarget === plan.decision) {
    return { plan };
  }
  return {
    plan: {
      ...plan,
      decision: decisionWithTarget,
      amaControllerDecision: buildAmaControllerDecision(decisionWithTarget),
      promptOverlay: buildPromptOverlay(
        decisionWithTarget,
        plan.providerPolicy?.routingNotes,
        plan.providerPolicy,
        buildAmaControllerDecision(decisionWithTarget),
      ),
    },
  };
}
```

**Why**: Harness decisions are now Scout's job, not pre-Scout logic.

**Test impact**:
- `'keeps a minimum of H1 when the task explicitly requires independent verification'` → update: Scout (not guardrails) determines harness based on `needsIndependentQA` context
- `'keeps a minimum of H2 for high-risk system-level overwrite work'` → update: Scout determines harness based on risk context

### Step 1D: Simplify `applyCurrentDiffReviewRoutingFloor`

**File**: `task-engine.ts`

**What to change**:
- Function `applyCurrentDiffReviewRoutingFloor` (lines 2351-2428): currently computes reviewTarget + reviewScale, then calls `applyManagedHarnessGuardrailsToPlan` to enforce harness floors.
- Simplify: keep `inferReviewTarget()` and `deriveFallbackReviewScale()` (Scout needs this context), but stop enforcing harness floors. Just attach reviewTarget and reviewScale to the decision as informational context.

**Why**: Review target/scale info is useful for Scout's judgment, but shouldn't force pre-Scout harness decisions.

**Test impact**:
- `'allows large current-diff reviews to stay on H0 when Scout provides complete direct-review evidence'` → verify Scout receives reviewScale in context

### Step 1E: Update tests and verify build

**Tests to update** (in `task-engine.test.ts`):

1. Tests expecting Scout bypass → now expect Scout call
2. Tests expecting guardrail enforcement → now expect Scout receives context and makes decision
3. Verify all `mockRunDirectKodaX` setups include Scout response handling

**Verification**:
```bash
npx tsc --noEmit -p packages/coding/tsconfig.json
npm test -- --filter packages/coding
```

---

## Phase 2: Scout Does Actual Work on H0

**Goal**: When Scout determines H0, it completes the task itself instead of just producing a routing directive.

**Risk**: Medium

### Step 2A: Enhance Scout prompt to allow task completion

**File**: `task-engine.ts`

**What to change**:
- Function `createRolePrompt` (line 2965), `case 'scout'` block: currently instructs Scout to classify and optionally finish if H0. Strengthen the H0 completion path — Scout should produce the final user-facing answer directly.
- Remove the requirement for a separate `kodax-task-scout` structured block when H0 completes with a full answer. Instead, Scout can either:
  - Produce `kodax-task-scout` + final answer (H0 complete)
  - Produce `kodax-task-scout` with upgrade request (H1/H2)

### Step 2B: Simplify Scout-complete path in `runManagedTask`

**File**: `task-engine.ts`

**What to change**:
- Lines 11012-11112 (`createScoutCompleteTaskShape` path): simplify. If Scout's directive says H0 and includes a final answer, return it directly without creating an elaborate task shape.
- Merge the current Scout-complete path with the tactical flow entry conditions into a single clean branch.

### Step 2C: Remove `createScoutCompleteTaskShape` if redundant

**File**: `task-engine.ts`

**What to evaluate**:
- Function `createScoutCompleteTaskShape` (line 3709): may become a thin wrapper if Scout output is returned directly. Evaluate whether it's still needed.

### Step 2D: Update tests

- Update tests for Scout H0 to verify Scout produces actual task output, not just a directive
- Verify no regression in H1/H2 paths (Scout still produces upgrade directives)

---

## Phase 3: Context Continuation Across Role Upgrades

**Goal**: When Scout upgrades to Generator (H1) or Planner (H2), it preserves context from the Scout session instead of starting a fresh agent.

**Risk**: Medium-High (core flow change)

### Step 3A: Design context transfer mechanism

Two approaches (decide during implementation):

**Option A — Same session continuation**:
- Scout and Generator/Planner share a single `runDirectKodaX` session
- Scout produces its output, then the session continues with a new role prompt
- Simplest, zero context loss
- Limitation: long sessions may degrade quality (but Opus 4.6 handles this well per Anthropic article)

**Option B — Full context transfer**:
- Scout session ends, but its key findings (files read, diff analysis, structure understanding) are serialized into a context bundle
- Generator/Planner starts a new session with this bundle injected as system/user context
- Cleaner session boundary, but lossy

**Recommendation**: Option A for most tasks. Option B as fallback for sessions where Scout consumed heavy context.

### Step 3B: Modify `runManagedScoutStage` to optionally continue session

**File**: `task-engine.ts`

**What to change**:
- Function `runManagedScoutStage` (line 9244): currently returns `{ result, directive }` and the session ends
- Add option: if Scout confirms H1/H2, keep the session open and pass it to the next role
- Return type extends to include `session` or `continuation` handle

### Step 3C: Modify H1/H2 execution to accept continued session

**File**: `task-engine.ts`

**What to change**:
- `executeManagedTaskRound` (line 10437): the worker runner currently creates fresh sessions per worker. Add path to continue an existing session for the first worker.

### Step 3D: Ensure Evaluator gets independent context

**Critical constraint**: Evaluator must NOT inherit Scout/Generator context.

- Evaluator always starts a fresh session with: task original text + deliverable artifact
- This is already the design for Option A and B

### Step 3E: Implement revise/replan session resumption

- When Evaluator returns `revise`: resume Generator session with feedback
- When Evaluator returns `replan`: resume Planner session with feedback
- These are new capabilities that require session handle management

### Step 3F: Update tests

- Test that H1 Generator inherits Scout's context (or receives full context bundle)
- Test that Evaluator gets independent context
- Test revise path resumes Generator session
- Test replan path resumes Planner session

---

## Phase 4: Unify Tactical Flows into Role-Level Subagents

**Goal**: Replace 3 hardcoded Tactical Flows (review/investigation/lookup) with a general subagent capability available to every core role.

**Risk**: High (large deletion + new protocol)

### Step 4A: Design subagent protocol

Each core role can spawn subagents via a structured request:
```
[subagent-request]
- task: "Validate finding #3 in auth module"
- scope: "packages/auth/src/"
- tool_policy: read-only
```

The role's output includes subagent results before producing its final deliverable.

### Step 4B: Implement `runRoleSubagents` utility

**File**: new or in `task-engine.ts`

- Takes a list of subagent tasks from the role's output
- Runs them in parallel via `runOrchestration`
- Returns consolidated results to the role
- Uses existing `createKodaXTaskRunner` infrastructure

### Step 4C: Delete Tactical Flow functions

**File**: `task-engine.ts`

**Functions to delete** (~3000 lines):
- `shouldRunTacticalReviewFanout` (3800)
- `shouldRunTacticalInvestigationFanout` (3818)
- `shouldRunTacticalLookupFanout` (3836)
- `createTacticalReviewBaseShape` (3855)
- `createTacticalInvestigationBaseShape` (3917)
- `createTacticalLookupBaseShape` (3979)
- `buildTacticalReviewScannerPrompt` (4041)
- `buildTacticalInvestigationScannerPrompt` (4065)
- `buildTacticalLookupScannerPrompt` (4090)
- `buildTacticalReviewValidatorPrompt` (4115)
- `buildTacticalInvestigationValidatorPrompt` (4147)
- `buildTacticalLookupValidatorPrompt` (4180)
- `runTacticalReviewScanner` (4504)
- `runTacticalInvestigationScanner` (4542)
- `runTacticalLookupScanner` (4580)
- `runTacticalReviewFlow` (4618)
- `runTacticalInvestigationFlow` (5191)
- `runTacticalLookupFlow` (5933)
- All tactical reducer/validator/finder helpers in between
- All tactical child result helpers (7067-7728)
- `createTacticalFanoutStatusEvents` (10364)

### Step 4D: Remove Tactical Flow callsites from `runManagedTask`

**File**: `task-engine.ts`

- Lines 10949-11010: the three `if (!scoutDowngradedToDirect && shouldRunTactical*Fanout(...))` blocks → delete
- `scoutDowngradedToDirect` variable may no longer be needed

### Step 4E: Update Scout/Generator/Evaluator prompts

- Add subagent spawning instructions to each role prompt in `createRolePrompt`
- Roles decide when to spawn subagents based on task characteristics

### Step 4F: Update tests

- Delete tactical flow tests
- Add subagent spawning tests for each role
- Verify Scout can spawn subagents for H0 review tasks (replaces tactical review)

---

## Phase 5: Replace H0/H1/H2 Naming with Worker-Chain Composition

**Goal**: Remove named harness profiles and the promotion/demotion state machine. Replace with a pure function that resolves which workers are needed.

**Risk**: Medium (wide impact but conceptual simplification)

### Step 5A: Create `resolveWorkerChain` function

**File**: `task-engine.ts`

```typescript
function resolveWorkerChain(
  scoutDecision: ManagedTaskScoutDirective,
  plan: ReasoningPlan,
): { workers: KodaXTaskRole[]; needsPlanning: boolean; needsEvaluation: boolean } {
  // Scout says it can handle it → ['scout'] (already done in Phase 2)
  // Scout says needs execution + eval → ['generator', 'evaluator']
  // Scout says needs planning → ['planner', 'generator', 'evaluator']
}
```

### Step 5B: Remove `harnessProfile` from `KodaXTaskRoutingDecision`

**File**: `types.ts`

- Replace `harnessProfile: 'H0_DIRECT' | 'H1_EXECUTE_EVAL' | 'H2_PLAN_EXECUTE_EVAL'` with `workerChain` or equivalent
- This is a breaking type change — all consumers need updating

### Step 5C: Remove harness rank/upgrade/ceiling utilities

**File**: `task-engine.ts`

**Functions to delete**:
- `getHarnessRank` (1157)
- `isHarnessUpgrade` (1161)
- `getHarnessUpgradeCost` (1171)
- `clampHarnessToCeiling` (860)
- `resolveHarnessUpgrade` (9986)
- `consumeHarnessUpgradeBudget` (9881)
- `withHarnessTransition` (9909)
- `canProviderSatisfyHarness` (9860)

### Step 5D: Simplify `buildManagedTaskWorkers`

**File**: `task-engine.ts`

- Function `buildManagedTaskWorkers` (line 3385): currently switches on `harnessProfile`
- Replace with logic that reads `workerChain` from Scout's decision

### Step 5E: Update tests

- Replace all `harnessProfile: 'H0_DIRECT'` etc. in test assertions
- Verify worker chain composition matches expected behavior

---

## Phase 6: Simplify Budget System

**Goal**: Replace zone-based budget partitioning with a simple total cap + round limit.

**Risk**: Low

### Step 6A: Simplify `ManagedTaskBudgetController`

**File**: `task-engine.ts`

- Function `createManagedBudgetController` (line 1181): remove zone logic (green/yellow/orange/red), upgradeReserve, etc.
- Keep: `totalBudget`, `spentBudget`, `plannedRounds`

### Step 6B: Remove budget zone functions

**Functions to delete**:
- `resolveBudgetZone` (1221)
- `resolveWorkerIterLimits` (1244) — replace with single configurable limit
- `maybeRequestAdditionalWorkBudget` (1365)
- `shouldGrantBudgetExtension` (9959)
- `formatBudgetAdvisory` (1417)

### Step 6C: Simplify budget snapshot

- `createBudgetSnapshot` (1276): simplify to just `{ spent, total, round, maxRounds }`
- Remove zone and iteration-limit fields from snapshot type

### Step 6D: Update tests

- Update budget-related assertions
- Remove tests for zone transitions

---

## Cross-Phase Dependencies

```
Phase 1 ──→ Phase 2 ──→ Phase 3
                           │
Phase 4 (can start after Phase 2)
                           │
              Phase 5 (after Phase 3 + Phase 4)
                           │
              Phase 6 (after Phase 5, or independently)
```

- **Phase 1 → Phase 2**: Phase 2 builds on the simplified routing from Phase 1
- **Phase 2 → Phase 3**: Context continuation requires Scout to be the first worker (Phase 2)
- **Phase 4**: Can proceed in parallel with Phase 3 after Phase 2, since tactical flow deletion is independent of context continuation
- **Phase 5**: Needs Phase 3 (context model) and Phase 4 (no tactical flows) to be stable
- **Phase 6**: Budget simplification can happen after Phase 5, or independently at any point after Phase 1

---

## Estimated Code Impact

| Phase | Lines deleted (~) | Lines added (~) | Net |
|-------|-------------------|-----------------|-----|
| Phase 1 | ~200 | ~50 | -150 |
| Phase 2 | ~100 | ~80 | -20 |
| Phase 3 | ~50 | ~200 | +150 |
| Phase 4 | ~3000 | ~300 | -2700 |
| Phase 5 | ~400 | ~150 | -250 |
| Phase 6 | ~300 | ~50 | -250 |
| **Total** | **~4050** | **~830** | **-3220** |

The codebase should shrink by approximately **3200 lines** when all phases complete.

---

## How to Execute in a New Session

Start a new session and say:

> 执行 FEATURE_061 Phase 1。实施计划在 `docs/features/feature-061-impl-plan.md`，设计文档在 `docs/features/v0.8.0.md#feature_061-scout-first-ama-architecture-simplification`。按 1A→1B→1C→1D→1E 顺序执行，每步验证编译通过。

The session should:
1. Read the implementation plan
2. Read the design doc
3. Execute each step, running `tsc --noEmit` after each
4. Run tests at the end
5. Update the Progress Tracker at the top of this file
