/**
 * FEATURE_090 (v0.7.32) — Self-modify budget counter.
 *
 * Per-agent counter persisted at
 * `<cwd>/.kodax/constructed/agents/<name>/_self_modify.json`. The
 * counter caps how many cross-run self-modify cycles an agent can
 * accumulate before requiring a human unlock. Without this cap, an
 * agent that learns to self-modify could rewrite itself on every
 * session boot until it drifts arbitrarily far from the original
 * design — Layer A admission and the policy gate would each be a
 * single rubber-stamp click away.
 *
 * Why a separate file (not in the manifest):
 *   - Manifests are content-hashed and version-immutable
 *     (`stage()` refuses to rewrite an existing version). A counter
 *     that mutates across versions cannot live inside the hashed
 *     content without breaking the `contentHash` integrity guarantee.
 *   - The counter accumulates across versions; binding it to one
 *     `<version>.json` would lose state on every bump.
 *
 * Why hard-coded N=3 (not configurable):
 *   - System-level safety constants the agent cannot influence are
 *     part of the threat model. Allowing per-agent override would
 *     mean a self-modifying agent could lift its own ceiling — the
 *     opposite of what the budget is for. Users adjust by reset
 *     (CLI `kodax constructed reset-self-modify-budget <name>`),
 *     not by config.
 *
 * Threat model & hardening:
 *   The file is plain JSON in the user's workspace. An agent with
 *   filesystem write access (via Write/Edit tools) is an active
 *   threat for FEATURE_090 — the agent itself is the actor we
 *   gate against. We harden two ways:
 *
 *     - The persisted `limit` is IGNORED on read; `readBudget`
 *       always returns `DEFAULT_SELF_MODIFY_BUDGET` as the limit.
 *       Tampering the file to raise the cap is a no-op.
 *     - The persisted `count` is clamped to `>= 0` on read so a
 *       negative number cannot grant extra remaining budget.
 *
 *   What we do NOT defend against: an attacker with shell-level
 *   filesystem access can still delete the file, which resets the
 *   counter to zero. The audit log captures the behavioural gap
 *   (5 self-modifies recorded but post-modify counter shows 0)
 *   and an operator replaying the log notices.
 */

import path from 'path';
import fs from 'fs/promises';

/**
 * Default cross-run self-modify budget. N=3 was chosen as the
 * minimum that allows "two course corrections, then settle" while
 * forcing re-engagement before the agent drifts far from its
 * original design. Lifting this requires deliberately re-evaluating
 * whether the audit log + ratchet alone are sufficient.
 *
 * Not exported as a configurable knob — see module docstring for
 * the rationale.
 */
export const DEFAULT_SELF_MODIFY_BUDGET = 3;

const BUDGET_FILE = '_self_modify.json';

/**
 * On-disk shape of the per-agent budget file. `limit` and `count`
 * are stored as plain integers. `lastModifiedAt` is ISO-8601 (sortable
 * + human-readable) — the audit log carries millisecond timestamps,
 * which complement, not duplicate, this field.
 */
export interface BudgetState {
  readonly name: string;
  readonly limit: number;
  readonly count: number;
  readonly lastModifiedAt?: string;
}

/**
 * On-disk shape. `limit` is intentionally absent — we never trust a
 * file-supplied limit (an agent that gained write access could lift
 * its own ceiling). The persisted record is just a counter +
 * timestamp; the limit lives in code as `DEFAULT_SELF_MODIFY_BUDGET`.
 */
interface FileShape {
  name: string;
  count: number;
  lastModifiedAt?: string;
}

interface BudgetIO {
  readonly cwd?: string;
}

function budgetPath(cwd: string, name: string): string {
  return path.resolve(cwd, '.kodax', 'constructed', 'agents', name, BUDGET_FILE);
}

/**
 * Read the agent's current budget state, materialising the default
 * record on first access. The default record is NOT persisted at
 * read time — only `consumeBudget` and `resetBudget` write to disk.
 * Read-only callers (e.g. the CLI's `audit` listing) must remain
 * side-effect-free so a `--dry-run` mode is trivially possible later.
 */
export async function readBudget(
  name: string,
  io: BudgetIO = {},
): Promise<BudgetState> {
  const cwd = io.cwd ?? process.cwd();
  const file = budgetPath(cwd, name);
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as Partial<FileShape> & { limit?: unknown };
    // Hardened read:
    //   - `limit` is hard-coded; any value persisted on disk is
    //     ignored. An agent that gained write access cannot lift
    //     its own self-modify cap by editing this file.
    //   - `count` is clamped to >= 0; a tampered negative count
    //     cannot grant the agent more remaining slots than the
    //     fresh-counter case.
    const persistedCount = typeof parsed.count === 'number' ? parsed.count : 0;
    return {
      name,
      limit: DEFAULT_SELF_MODIFY_BUDGET,
      count: Math.max(0, persistedCount),
      lastModifiedAt: parsed.lastModifiedAt,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { name, limit: DEFAULT_SELF_MODIFY_BUDGET, count: 0 };
    }
    throw err;
  }
}

/**
 * Number of remaining self-modify slots. `limit - count`, clamped at
 * zero so a corrupt file that recorded `count > limit` doesn't show
 * a negative remaining count to the user.
 */
export function remaining(state: BudgetState): number {
  return Math.max(0, state.limit - state.count);
}

/**
 * Atomically increment the consumption counter and persist. Returns
 * the post-write state so callers can immediately render `remaining`
 * to the user without an extra read.
 *
 * The "atomic" qualifier here is best-effort: KodaX is a single-user
 * CLI, concurrent writers are not a real-world concern. We perform
 * read-modify-write on a single small JSON file and rely on the OS's
 * single-process filesystem semantics. Windows' lack of a true
 * atomic-replace primitive is acknowledged but not worked around —
 * matches the rest of the construction runtime's persistence model.
 */
export async function consumeBudget(
  name: string,
  io: BudgetIO = {},
): Promise<BudgetState> {
  const cwd = io.cwd ?? process.cwd();
  const before = await readBudget(name, { cwd });
  const next: BudgetState = {
    name,
    limit: before.limit,
    count: before.count + 1,
    lastModifiedAt: new Date().toISOString(),
  };
  await persist(cwd, next);
  return next;
}

/**
 * Reset the consumption counter to zero. Does not change the limit.
 * Surface to users via `kodax constructed reset-self-modify-budget`.
 *
 * Returns the post-write state so the CLI can confirm "now N/N
 * available" without an extra read.
 */
export async function resetBudget(
  name: string,
  io: BudgetIO = {},
): Promise<BudgetState> {
  const cwd = io.cwd ?? process.cwd();
  const before = await readBudget(name, { cwd });
  const next: BudgetState = {
    name,
    limit: before.limit,
    count: 0,
    lastModifiedAt: new Date().toISOString(),
  };
  await persist(cwd, next);
  return next;
}

async function persist(cwd: string, state: BudgetState): Promise<void> {
  const file = budgetPath(cwd, state.name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Persist only `name + count + lastModifiedAt`. We intentionally do
  // NOT write `limit` — see the module docstring: any value found on
  // disk is ignored, so writing it would only mislead operators
  // reading the file directly.
  const payload: FileShape = {
    name: state.name,
    count: state.count,
    ...(state.lastModifiedAt ? { lastModifiedAt: state.lastModifiedAt } : {}),
  };
  await fs.writeFile(file, JSON.stringify(payload, null, 2), 'utf8');
}
