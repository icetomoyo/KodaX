/**
 * FEATURE_079 — Task Engine Phase 1 Pure Extraction
 *
 * Primitive constants extracted from task-engine.ts. Zero-behavior-change move:
 * these are the same values previously defined as module-private `const` at the
 * top of task-engine.ts. They are grouped by concern below.
 *
 * Not moved in Slice 2 (reserved for later slices):
 * - CHECKPOINT_FILE / CHECKPOINT_MAX_AGE_MS — exposed via __checkpointTestables,
 *   moves in Slice 7 (checkpoint helpers) so the test surface stays intact.
 * - MANAGED_TASK_BUDGET_BASE — type-dependent, moves with budget helpers (Slice 6).
 * - REVIEW_*_THRESHOLD — duplicated in reasoning.ts (separate GLM-like DRY issue,
 *   handled in follow-up).
 * - WRITE_ONLY_TOOLS / SCOUT_ALLOWED_TOOLS / PLANNER_ALLOWED_TOOLS /
 *   H1_EVALUATOR_ALLOWED_TOOLS / H1_READONLY_GENERATOR_ALLOWED_TOOLS /
 *   INSPECTION_SHELL_PATTERNS / DOCS_ONLY_WRITE_PATH_PATTERNS /
 *   VERIFICATION_SHELL_PATTERNS / SHELL_WRITE_PATTERNS — tool-policy constants,
 *   move with tool-policy helpers (Slice 6/8).
 * - SHELL_PATTERN_CACHE / WRITE_PATH_PATTERN_CACHE — stateful Map caches, stay with
 *   their users.
 * - TOOL_TRUNCATION_MARKERS / REVIEW_PROGRESS_PREFIXES / MANAGED_CONTROL_PLANE_MARKERS
 *   — move with their consumers in later slices.
 */

// === Tactical-flow fenced-block names (managed-protocol auxiliaries) ===

export const TACTICAL_REVIEW_FINDINGS_BLOCK = 'kodax-review-findings';
export const TACTICAL_INVESTIGATION_SHARDS_BLOCK = 'kodax-investigation-shards';
export const TACTICAL_LOOKUP_SHARDS_BLOCK = 'kodax-lookup-shards';
export const TACTICAL_CHILD_RESULT_BLOCK = 'kodax-child-result';

// === Tactical-flow artifact filenames ===

export const TACTICAL_CHILD_RESULT_ARTIFACT_JSON = 'child-result.json';
export const TACTICAL_CHILD_HANDOFF_JSON = 'dependency-handoff.json';
export const TACTICAL_CHILD_LEDGER_JSON = 'child-result-ledger.json';
export const TACTICAL_CHILD_LEDGER_MARKDOWN = 'child-result-ledger.md';

// === Managed-task round budgeting ===

export const MANAGED_TASK_BUDGET_REQUEST_BLOCK = 'kodax-budget-request';
export const MANAGED_TASK_MAX_REFINEMENT_ROUND_CAP = 2;
export const MANAGED_TASK_MIN_REFINEMENT_ROUNDS = 1;
export const MANAGED_TASK_ROUTER_MAX_RETRIES = 2;

// === Evidence / budget thresholds ===

export const EVIDENCE_ONLY_ITERATION_THRESHOLD = 3;
export const GLOBAL_WORK_BUDGET_APPROVAL_THRESHOLD = 0.9;
export const GLOBAL_WORK_BUDGET_INCREMENT = 200;
export const DEFAULT_MANAGED_WORK_BUDGET = 200;

// === Timeline ===

export const MAX_MANAGED_TIMELINE_EVENTS = 64;
