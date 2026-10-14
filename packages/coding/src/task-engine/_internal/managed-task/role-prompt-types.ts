/**
 * Role-prompt context types and scope inference helpers — restored from
 * v0.7.22 task-engine (FEATURE_079 Slice 8). Re-added v0.7.26 during
 * parity audit: `createRolePrompt` + downstream tool-policy builders both
 * read these, so they travel together as a single module.
 */

import type {
  KodaXRoleRoundSummary,
  KodaXSkillInvocationContext,
  KodaXSkillMap,
  KodaXTaskRole,
} from '../../../types.js';

export interface ManagedRolePromptContext {
  originalTask: string;
  /** Executable tools after role/host policy. Omitted preserves standalone guidance. */
  availableToolNames?: readonly string[];
  skillInvocation?: KodaXSkillInvocationContext;
  skillMap?: KodaXSkillMap;
  skillExecutionArtifactPath?: string;
  skillMapArtifactPath?: string;
  previousRoleSummaries?: Partial<Record<KodaXTaskRole, KodaXRoleRoundSummary>>;
  /** FEATURE_067: Evaluator review prompt for write fan-out diffs from Generator's child agents. */
  childWriteReviewPrompt?: string;
  /**
   * v0.7.26 NEW-1 — workspace environment the role should assume.
   * Without this the managed-worker system prompt never tells the LLM
   * where it is running; the SA path injects `Working Directory: ...`
   * via `buildSystemPrompt`, but the Runner-driven path bypassed that
   * builder entirely, causing managed workers to guess paths (e.g.
   * bash-cd into invented directories).
   */
  workspace?: {
    executionCwd: string;
    gitRoot?: string;
    /**
     * Session-scoped directory for helper scripts and scratch outputs.
     * Rendered in the hidden run-context carrier, never in stable System.
     */
    scratchDir?: string;
    platform: NodeJS.Platform;
    osRelease?: string;
    /**
     * Active provider name (e.g. `ark-coding`, `kimi-code`). Surfaced in the
     * `## Environment` block so the LLM answers identity questions from
     * runtime configuration instead of pretraining guesswork. Optional —
     * legacy callers that omit it leave the previous behavior unchanged.
     */
    provider?: string;
    /** Active model id (post `modelOverride` resolution). See `provider`. */
    model?: string;
  };
  /**
   * v0.7.35.1 FEATURE_144 — capability-context sections the AMA worker
   * needs but `workspaceSection` does not cover. Built ONCE in
   * `runner-driven.ts` via `buildCapabilityContextSections()` and
   * filtered to the 6 sections that aren't already injected through
   * other Runner paths:
   *   - `mcp-capability-context`  (active MCP server visibility)
   *   - `skills-addendum`         (skill-specific guidance)
   *   - `project-agents`          (AGENTS.md / CLAUDE.md project rules)
   *   - `tool-construction`       (tool self-construction guidance)
   *   - `git-context`             (branch / status snapshot)
   *   - `project-snapshot`        (lightweight repo tree)
   *
   * `environment-context` / `working-directory` / `runtime-fact` are
   * already in `workspaceSection`; `repo-intelligence-context` and
   * `prompt-overlay` ride on the user prompt via separate Runner
   * paths (`prebuiltRepoIntelligenceContext` / Shard 6d-L overlay
   * stitching). Filtering avoids duplicate emission.
   *
   * Pre-computed parent-side so each per-role prompt invocation does
   * NOT trigger fresh AGENTS.md / git status / project FS walks.
   */
  capabilityContextBlock?: string;
  /**
   * Capability rules that are stable for the session and retain System-level
   * authority (for example project AGENTS rules and fixed tool-construction
   * guidance). A real rule/config change may legitimately change the provider
   * cache prefix; ordinary per-run facts stay in `capabilityContextBlock`.
   */
  stableCapabilityContextBlock?: string;
  /**
   * FEATURE_143 (v0.7.36) — routing-notes overlay (`plan.promptOverlay`)
   * that v0.7.26 FEATURE_084 mistakenly stitched onto the user prompt
   * head. Now flows here instead so the role-prompt builder can emit
   * it as a system-prompt section, matching the SA path's
   * `capability-sections.ts` behavior. Carries: task-family guidance,
   * work intent, brainstorm directives, provider-policy notes,
   * explicit-reason trail.
   */
  promptOverlay?: string;
  /**
   * FEATURE_114 v0.7.36 — Worker resume signal. The runner-driven V2 path
   * sets this to `true` when re-invoking the Worker after the Evaluator
   * returned `revise` and the previous Worker turn had failed/cancelled
   * todo items. The Worker prompt picks it up and prepends a one-line
   * retrospective so the LLM treats prior `failed` items as ground truth
   * (don't repeat the same approach). Default `false` / omitted preserves
   * fresh-run wording. Read only by the `case 'worker':` branch in
   * `createRolePrompt`; legacy roles ignore it.
   */
  isResumeAfterReviseFailure?: boolean;
  /**
   * FEATURE_125 v0.7.41 — Team Mode "Other active KodaX sessions" block.
   * Re-rendered at Runner turn boundaries via
   * `buildOtherInstancesPromptBlock(discoverInstances(...))`. Empty string
   * (or omitted) means no siblings were alive at round start; the block
   * is skipped in the section list — same composition pattern as
   * `capabilityContextBlock` / `promptOverlay`. NOT cached in the stable
   * prefix: sibling state changes between rounds, so the block must be
   * emitted only when the snapshot changes.
   */
  teamModeSection?: string;
  /** Clock-free identity for Team Mode change detection. */
  teamModeFingerprint?: string;
  /** Per-round Actor scheduler facts used to size a spawn wave before tool calls. */
  actorCapacity?: {
    readonly maxConcurrentThreads: number;
    readonly activeNonRootTurns: number;
  };
}

// FEATURE_193 / ADR-043: isReviewEvidenceTask (a Scout-era review-evidence
// predicate) was removed — it had no production caller after the Scout/Generator
// chain was retired.
