/**
 * FEATURE_090 (v0.7.32) — Per-agent self-modify disable marker.
 *
 * The marker file at `.kodax/constructed/agents/<name>/_self_modify_disabled.json`
 * indicates the operator has explicitly disabled an agent's self-modify
 * capability through the `kodax constructed disable-self-modify <name>`
 * CLI. `validateSelfModify` consults this state and hard-rejects with
 * the `self-modify-disabled` rule when the marker exists.
 *
 * One-way ratchet by design:
 *
 *   The CLI exposes `disable-self-modify` but no symmetrical `enable`.
 *   Re-enabling self-modify is intentionally NOT supported — once an
 *   operator decides an agent shouldn't be able to rewrite itself,
 *   that decision sticks for the lifetime of the agent. To regain a
 *   "can self-modify" agent, stage a separately-named replacement
 *   through `stage_agent_construction`.
 *
 * Why a separate file (not a flag inside `_self_modify.json`):
 *   - Concerns are independent: budget consumption is a counter that
 *     legitimately mutates every activation cycle; disable is a
 *     permanent operator decision. Mixing them would force the
 *     budget read path to discriminate "is the file just a counter
 *     update, or did someone also flip the disable flag?"
 *   - File presence as the truth value is dead simple to detect
 *     (`fs.access` returns OK / ENOENT).
 *
 * Threat model: same as the rest of FEATURE_090's persisted state —
 * single-user CLI workspace integrity (DD §14.5). An agent with
 * filesystem write access could create the marker itself, which is
 * actually fine: writing the marker only DISABLES (one-way safety
 * ratchet). Removing it would re-enable, but `validateSelfModify`
 * still requires the marker to be present to reject — if a
 * resourceful agent removes the marker AND submits a self-modify in
 * the same session, the modify still has to pass admission /
 * guardrail ratchet / user approval. The marker is one layer of
 * defense, not the only one.
 */

import path from 'path';
import fs from 'fs/promises';

const DISABLE_FILE = '_self_modify_disabled.json';

export interface DisableState {
  readonly name: string;
  readonly disabled: boolean;
  readonly disabledAt?: string;
  readonly user?: string;
}

interface DisableIO {
  readonly cwd?: string;
}

function disablePath(cwd: string, name: string): string {
  return path.resolve(cwd, '.kodax', 'constructed', 'agents', name, DISABLE_FILE);
}

/**
 * Read the disable marker for `name`. Returns
 * `{ disabled: false, name }` when the file does not exist (the
 * common case). Malformed JSON content is treated as "not disabled"
 * with a stderr warning — we don't want a corrupt marker to silently
 * permit self-modifies on an agent the operator meant to disable.
 *
 * No, wait — we DO want corrupt markers to fail safe in the
 * "disabled" direction so an attacker can't bypass disable by
 * corrupting the file. Override: malformed → treat as disabled.
 */
export async function readDisableState(
  name: string,
  io: DisableIO = {},
): Promise<DisableState> {
  const cwd = io.cwd ?? process.cwd();
  const file = disablePath(cwd, name);
  try {
    const raw = await fs.readFile(file, 'utf8');
    let parsed: Partial<DisableState>;
    try {
      parsed = JSON.parse(raw) as Partial<DisableState>;
    } catch {
      console.warn(
        `[ConstructionRuntime] Treating malformed disable marker at ${file} as disabled (fail-safe).`,
      );
      return { name, disabled: true };
    }
    return {
      name,
      // The presence of the marker file is the primary truth — even
      // a `disabled: false` field gets coerced to `true` because the
      // operator-facing CLI never writes a "disabled: false" record.
      // (Removing the marker file is the only legitimate way to
      // re-enable, and the CLI deliberately refuses to do so.)
      disabled: true,
      disabledAt: typeof parsed.disabledAt === 'string' ? parsed.disabledAt : undefined,
      user: typeof parsed.user === 'string' ? parsed.user : undefined,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { name, disabled: false };
    }
    throw err;
  }
}

export interface DisableOptions {
  readonly cwd?: string;
  readonly user?: string;
}

/**
 * Write the disable marker. Idempotent — calling on an
 * already-disabled agent rewrites the timestamp, preserving the
 * one-way ratchet semantics (the CLI surface still records the new
 * audit entry separately).
 */
export async function disableSelfModify(
  name: string,
  options: DisableOptions = {},
): Promise<DisableState> {
  const cwd = options.cwd ?? process.cwd();
  const file = disablePath(cwd, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const state: DisableState = {
    name,
    disabled: true,
    disabledAt: new Date().toISOString(),
    ...(options.user ? { user: options.user } : {}),
  };
  await fs.writeFile(file, JSON.stringify(state, null, 2), 'utf8');
  return state;
}
