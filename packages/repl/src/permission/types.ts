/**
 * Permission Types
 */

// ============== Permission Mode ==============

/**
 * Permission mode
 * - plan: Read-only planning, all modifications blocked unless explicitly whitelisted
 * - accept-edits: File edits auto-approved, shell commands require confirmation
 * - auto-in-project: All tools auto-approved within project, outside requires confirmation
 */
export type PermissionMode = "plan" | "accept-edits" | "auto-in-project";

export const PERMISSION_MODES: PermissionMode[] = [
  "plan",
  "accept-edits",
  "auto-in-project",
];

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
