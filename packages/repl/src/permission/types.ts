/**
 * Permission Types
 */

// ============== Permission Mode ==============

/**
 * Permission mode
 * - plan: Read-only planning, all modifications blocked unless explicitly whitelisted
 * - accept-edits: File edits auto-approved, shell commands require confirmation
 * - auto: All tools auto-approved (with optional LLM classifier review when
 *         auto-mode engine === 'llm'; FEATURE_092 v0.7.33). When engine === 'rules',
 *         falls back to the legacy "all tools approved within project, outside
 *         requires confirmation" behavior — i.e., the v0.7.32 `auto-in-project`
 *         shape. The `auto-in-project` name is preserved as a deprecated alias
 *         for 5 minor versions (removed in v0.7.38).
 */
export type PermissionMode = "plan" | "accept-edits" | "auto" | "auto-in-project";

export const PERMISSION_MODES: PermissionMode[] = [
  "plan",
  "accept-edits",
  "auto",
  "auto-in-project", // deprecated alias; behavior identical to 'auto'
];

/**
 * Canonical mode names that should appear in user-facing UI / Shift-Tab
 * cycling (excludes deprecated aliases).
 */
export const CANONICAL_PERMISSION_MODES: PermissionMode[] = [
  "plan",
  "accept-edits",
  "auto",
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
export function canonicalizePermissionMode(mode: PermissionMode): PermissionMode {
  return mode === "auto-in-project" ? "auto" : mode;
}

/**
 * Status-bar display name for a permission mode. Title-Case short labels
 * (mirrors Claude Code's `shortTitle` convention in
 * `src/utils/permissions/PermissionMode.ts`):
 *   - `plan`             → `Plan`
 *   - `accept-edits`     → `Edits`
 *   - `auto`             → `Auto`
 *   - `auto-in-project`  → `Auto`  (deprecated alias folds into the canonical
 *                                   display name; the deprecation notice
 *                                   surfaces once per session at startup)
 *
 * Single source of truth — both the readline status-bar
 * (`packages/repl/src/interactive/status-bar.ts`) and the Ink view-model
 * (`packages/repl/src/ui/view-models/status-bar.ts`) consume this so the two
 * surfaces never drift on capitalization or short-form choice.
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
  }
}

// ============== Deprecated alias soft-warning (FEATURE_092 phase 2b.7b slice E) ==============

/**
 * One-line user-facing notice surfaced when the user explicitly chooses
 * `auto-in-project` (either at REPL startup from `~/.kodax/config.json` or
 * via `/mode auto-in-project`). The alias is preserved for 5 minor versions
 * for backward compat — design doc validation §4 requires the warning emit
 * once per session, not per-call.
 */
export const AUTO_IN_PROJECT_DEPRECATION_MSG =
  '[deprecated] permissionMode "auto-in-project" is now an alias for "auto" (FEATURE_092, v0.7.33). '
  + 'The alias will be removed in v0.7.38 — please update ~/.kodax/config.json to use "auto".';

/**
 * Build a once-per-session emitter for the auto-in-project deprecation
 * notice. The factory shape (vs. a module-scoped `let emitted = false`)
 * makes the once-semantics testable without resetting module state and
 * lets the REPL own the lifecycle (one emitter per session).
 *
 * `printer` defaults to `console.warn` so the warning lands on stderr —
 * doesn't pollute piped stdout (e.g. `kodax | jq`).
 */
export function createAutoInProjectDeprecationEmitter(
  printer: (msg: string) => void = console.warn,
): () => void {
  let emitted = false;
  return () => {
    if (emitted) return;
    emitted = true;
    printer(AUTO_IN_PROJECT_DEPRECATION_MSG);
  };
}

// ============== Confirm Result ==============

export interface ConfirmResult {
  confirmed: boolean;
  always?: boolean;
}

// ============== Tool Categories ==============

/** Modification tools that are blocked in plan mode. */
export const MODIFICATION_TOOLS = new Set(["write", "edit", "bash", "undo"]);

/** File modification tools (not commands). */
export const FILE_MODIFICATION_TOOLS = new Set(["write", "edit"]);

/**
 * Bash commands that have write side-effects (blocked in plan mode).
 *
 * This is a blacklist approach: only explicitly listed commands are blocked here.
 * Additional write detection for redirection and PowerShell cmdlets lives in
 * `permission.ts`.
 */
export const BASH_WRITE_COMMANDS = new Set([
  // Package managers
  "npm install", "npm i", "npm uninstall", "npm remove", "npm update", "npm ci",
  "yarn add", "yarn remove", "yarn upgrade",
  "pnpm add", "pnpm remove", "pnpm update",

  // Git write operations
  "git clean", "git reset", "git checkout", "git switch", "git merge", "git rebase",
  "git cherry-pick", "git revert", "git commit", "git push", "git pull",

  // File operations
  "rm", "mv", "cp", "mkdir", "rmdir", "touch", "chmod", "chown",
  "del", "erase", "rd", "copy", "move", "ren",

  // Download/create
  "curl", "wget", "dd", "tar",

  // Process control
  "kill", "pkill", "killall",
]);

/**
 * Strict whitelist of bash commands considered safe for read-only exploration in plan mode.
 * Any bash command not matching these bases will require user confirmation.
 */
export const BASH_SAFE_READ_COMMANDS = new Set([
  // Basic shell inspection
  "ls", "cat", "pwd", "echo", "whoami", "date", "which", "whereis", "tree",
  "dir", "type", "get-childitem", "get-content", "select-string", "get-location",

  // Search and find
  "grep", "find", "awk", "sed", "head", "tail", "less", "more", "wc",

  // Git operations (read-only)
  "git status", "git diff", "git log", "git show", "git branch",
  "git remote", "git ls-files", "git rev-parse", "git grep",

  // Language toolchains (version/info only)
  "node", "npm", "yarn", "pnpm", "tsc", "python", "pip", "go", "cargo", "rustc",
]);

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
): PermissionMode | undefined {
  if (isPermissionMode(value)) {
    return value;
  }

  return fallback;
}
