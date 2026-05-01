/**
 * FEATURE_090 (v0.7.32) — Self-modify audit log.
 *
 * Append-only JSONL at `<cwd>/.kodax/constructed/_audit.jsonl`. Every
 * self-modify lifecycle event (staged / activated / rejected / rolled-
 * back / disabled / budget-reset) becomes one line. The file is the
 * sole record an operator can replay to answer "what did this agent
 * do to itself, when, and who approved each step."
 *
 * Why JSONL not JSON:
 *   - Append is a one-line write, atomic against partial-flush concerns
 *     (each line is independently parseable).
 *   - Read can stream line-by-line without parsing the whole history.
 *   - Standard tooling (jq, grep) works on the file directly.
 *
 * Why no rotation / truncation:
 *   - Audit completeness > disk usage. A 100k-line file is ~10 MB and
 *     remains tail-readable. The `kodax constructed audit` CLI surfaces
 *     a warning when an agent crosses 100 entries — escalation cue,
 *     not a hard cap.
 *   - Truncating the audit log would defeat the point: a malicious
 *     agent that gained write access could erase its own history.
 *     Keeping the file append-only at the tooling level means
 *     tampering shows up as JSONL the rest of the system can detect.
 *
 * Threat model:
 *   The file lives in the same workspace the agent runs in, so an
 *   agent with arbitrary filesystem write access could mutate it
 *   directly. This module does NOT defend against that — KodaX's
 *   single-user CLI threat model (DD §14.5) treats workspace
 *   integrity as the user's responsibility. Each entry carries a
 *   `diffHash` that downstream replay tools can re-compute against
 *   the corresponding manifest version on disk; mismatches are an
 *   alarm signal, not silently masked.
 */

import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';

import type { AgentContent } from './types.js';

const AUDIT_LOG_SUBPATH = path.join('.kodax', 'constructed', '_audit.jsonl');

/**
 * Discriminated union of audit event kinds. Every self-modify-related
 * lifecycle transition writes exactly one entry; rollback / disable /
 * budget-reset are also recorded for full operator visibility.
 *
 * `event` is the discriminant. Keep the constant names stable — CLI
 * filters and replay tooling pivot on these strings.
 */
export type AuditEventKind =
  | 'self_modify_staged'
  | 'self_modify_tested'
  | 'self_modify_activated'
  | 'self_modify_rejected'
  | 'self_modify_rolled_back'
  | 'self_modify_disabled'
  | 'self_modify_budget_reset';

// Severity for an audit entry comes straight from the LLM diff summary.
// Keep one canonical type in `self-modify-summary.ts` and re-import here
// — the alternative (two parallel `'minor'|'moderate'|'major'` aliases)
// drifts the moment one definition gains a fourth bucket.
import type { SelfModifyDiffSeverity } from './self-modify-summary.js';

/**
 * Single line in `_audit.jsonl`. Frozen after write — entries are
 * never updated in place. Optional fields are omitted (not nulled)
 * when the event kind doesn't carry them, so JSON.parse round-trips
 * to a TS narrowing-friendly shape.
 */
export interface AuditEntry {
  readonly ts: string;
  readonly event: AuditEventKind;
  readonly agentName: string;
  readonly toVersion: string;
  /** Prior active version. Undefined for first-time staging events. */
  readonly fromVersion?: string;
  /** SHA-256 of the canonicalised `{ prev, next }` content pair. */
  readonly diffHash?: string;
  readonly llmSummary?: string;
  readonly severity?: SelfModifyDiffSeverity;
  readonly flaggedConcerns?: readonly string[];
  /**
   * Verdict surfaced by the policy gate. `force-ask-user` records the
   * (hypothetical) fact that self-modify path bypassed any global
   * auto-approve policy and forced a user prompt, distinct from the
   * default `ask-user`.
   */
  readonly policyVerdict?: 'approve' | 'reject' | 'ask-user' | 'force-ask-user';
  readonly budgetRemaining?: number;
  /** Hard-reject rule id when `event === 'self_modify_rejected'`. */
  readonly rejectRule?: string;
  readonly rejectReason?: string;
  /** OS user who took the action; informational, not authoritative. */
  readonly user?: string;
}

export interface AppendOptions {
  /** Repo root (defaults to `process.cwd()`). */
  readonly cwd?: string;
}

/**
 * Append a single entry to the audit log. The directory is created on
 * first call. JSON serialisation enforces the line-per-entry shape:
 * one `JSON.stringify` followed by a literal `\n`. Multi-line JSON
 * (pretty-printed) would corrupt the JSONL contract.
 *
 * Concurrency note: Node `fs.appendFile` on a single small write is
 * atomic at the syscall level on the platforms KodaX targets
 * (Linux/macOS/Windows). KodaX is single-user CLI so concurrent
 * writers are not a real concern; defending against them would
 * require a lock file the rest of the construction runtime doesn't
 * carry.
 */
export async function appendAuditEntry(
  entry: AuditEntry,
  options: AppendOptions = {},
): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const filePath = path.resolve(cwd, AUDIT_LOG_SUBPATH);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const line = JSON.stringify(entry) + '\n';
  await fs.appendFile(filePath, line, 'utf8');
}

export interface ReadOptions {
  readonly cwd?: string;
  /** Filter to a single agent. Undefined returns all entries. */
  readonly agentName?: string;
  /** Filter to specific event kinds. Undefined matches every kind. */
  readonly events?: readonly AuditEventKind[];
}

/**
 * Stream the audit log line-by-line, parse each, and return entries
 * matching the optional filters. Malformed lines are skipped with a
 * stderr warning — a single corrupted entry must not poison the
 * entire history. (This mirrors `loadAllArtifacts` in runtime.ts.)
 *
 * Returns an empty array when the audit file does not exist (fresh
 * workspace, no self-modify ever recorded).
 */
export async function readAuditEntries(
  options: ReadOptions = {},
): Promise<AuditEntry[]> {
  const cwd = options.cwd ?? process.cwd();
  const filePath = path.resolve(cwd, AUDIT_LOG_SUBPATH);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const wantedAgent = options.agentName;
  const wantedEvents = options.events ? new Set(options.events) : undefined;

  const out: AuditEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: AuditEntry;
    try {
      parsed = JSON.parse(trimmed) as AuditEntry;
    } catch {
      console.warn(`[ConstructionRuntime] Skipping malformed audit line: ${trimmed.slice(0, 80)}…`);
      continue;
    }
    if (wantedAgent !== undefined && parsed.agentName !== wantedAgent) continue;
    if (wantedEvents !== undefined && !wantedEvents.has(parsed.event)) continue;
    out.push(parsed);
  }
  return out;
}

/**
 * Compute the SHA-256 over a canonicalised `{ prev, next }` content
 * pair. Used as the `diffHash` field on activated / rejected entries.
 *
 * Canonicalisation = stable JSON: `JSON.stringify` is *not* stable
 * for object key order on its own, so we sort keys via the second
 * argument's replacer. Keeps the hash deterministic across runs even
 * when the manifest's authoring tooling re-orders fields.
 */
export function computeDiffHash(prev: AgentContent, next: AgentContent): string {
  const canonical = JSON.stringify({ prev, next }, sortedReplacer);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function sortedReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      sorted[k] = obj[k];
    }
    return sorted;
  }
  return value;
}
