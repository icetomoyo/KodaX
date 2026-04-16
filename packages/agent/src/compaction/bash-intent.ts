/**
 * Bash Intent Extraction
 *
 * Extracts the "meaningful command" from complex bash strings for
 * compact placeholder display. Skips noise prefixes (cd, export, env vars)
 * and picks the core operation from chained/piped commands.
 *
 * Examples:
 *   "cd /path && git push origin main"  → "git push origin main"
 *   "DOCKER_BUILDKIT=1 docker build ."  → "docker build ."
 *   "cat file | grep pattern | head"    → "grep pattern file"
 *   "npm run test -- --coverage"        → "npm test --coverage"
 */

const MAX_PREVIEW_LENGTH = 60;

/** Prefixes to skip — these don't express intent */
const SKIP_PREFIXES = /^(cd|pushd|popd|export|source|\.)\b/;

/** Pattern matching env var assignments: VAR=val command ... */
const ENV_ASSIGNMENT = /^[A-Z_][A-Z0-9_]*=/i;

/**
 * Extract the intent command from a potentially complex bash string.
 *
 * Strategy:
 * 1. Split on `&&` and `||` — take the last non-skip segment
 * 2. For pipe chains — take the first non-trivial command (not cat/echo)
 * 3. Strip leading env var assignments
 * 4. Truncate to MAX_PREVIEW_LENGTH
 */
export function extractBashIntent(command: string): string {
  const trimmed = command.trim();
  if (trimmed.length === 0) return 'bash';

  // Split on && and || to find chained commands
  const segments = trimmed.split(/\s*(?:&&|\|\|)\s*/).filter(Boolean);

  // Find the last segment that isn't a skip prefix (cd, export, etc.)
  let meaningful = 'bash';
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i]?.trim();
    if (seg && !SKIP_PREFIXES.test(seg)) {
      meaningful = seg;
      break;
    }
  }

  // Handle pipe chains: pick the core command (not cat/echo feeder)
  if (meaningful.includes('|') && !meaningful.includes('||')) {
    meaningful = extractFromPipe(meaningful);
  }

  // Strip leading env var assignments: VAR=val VAR2=val2 actual-command ...
  meaningful = stripEnvAssignments(meaningful);

  // Normalize npm run shortcuts
  meaningful = normalizeNpmCommand(meaningful);

  return truncate(meaningful, MAX_PREVIEW_LENGTH);
}

/**
 * From a pipe chain, pick the most meaningful command.
 * For `cat file | grep pattern | head`, we want `grep pattern file`.
 * For `echo text | command`, we want `command`.
 */
function extractFromPipe(command: string): string {
  const parts = command.split(/\s*\|\s*/);
  const trivialFeeders = /^(cat|echo|printf|type)\b/;

  // Find first non-trivial command in the pipe (strip env vars before checking)
  for (const part of parts) {
    const trimmed = stripEnvAssignments(part.trim());
    if (trimmed && !trivialFeeders.test(trimmed)) {
      return trimmed;
    }
  }

  // All trivial? Return the last one
  return stripEnvAssignments(parts[parts.length - 1]?.trim() ?? command);
}

/** Strip leading env var assignments: `VAR=val command args` → `command args` */
function stripEnvAssignments(command: string): string {
  const tokens = command.split(/\s+/);
  let startIdx = 0;

  while (startIdx < tokens.length && ENV_ASSIGNMENT.test(tokens[startIdx] ?? '')) {
    startIdx++;
  }

  return startIdx > 0 && startIdx < tokens.length
    ? tokens.slice(startIdx).join(' ')
    : command;
}

/** Normalize `npm run test -- --coverage` → `npm test --coverage` */
function normalizeNpmCommand(command: string): string {
  const match = command.match(/^npm\s+run\s+(\S+)\s*(?:--\s*)?(.*)$/);
  if (!match) return command;

  const script = match[1];
  const args = match[2]?.trim();
  return args ? `npm ${script} ${args}` : `npm ${script}`;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}…`;
}
