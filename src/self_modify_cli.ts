/**
 * FEATURE_090 (v0.7.32) — `kodax constructed <action>` CLI surface.
 *
 * Parallels `constructed_cli.ts`'s `kodax tools <action>` group but
 * targets constructed AGENTS (and their self-modify lifecycle) rather
 * than constructed TOOLS. Lives in its own file to keep FEATURE_088
 * (tool inventory) and FEATURE_090 (agent self-modify governance)
 * orthogonal — a future cleanup of either feature can move freely.
 *
 * Commands implemented in this file:
 *   - `kodax constructed reset-self-modify-budget <name>` — clear the
 *     per-agent self-modify counter. Use after a deliberate, audited
 *     decision to allow further self-modifications past the default
 *     N=3 budget. Writes a `self_modify_budget_reset` audit entry so
 *     the unlock event is replayable.
 *
 * Commands that will live here once P6 lands:
 *   - `kodax constructed rollback <name>`
 *   - `kodax constructed audit <name>`
 *   - `kodax constructed disable-self-modify <name>`
 *
 * Bootstrap policy: same as `constructed_cli.ts` — reject all activate
 * attempts. None of these commands trigger activation; they read /
 * mutate the persisted state and exit.
 */

import os from 'os';
import path from 'path';
import chalk from 'chalk';

import {
  configureRuntime,
  rehydrateActiveArtifacts,
  listArtifacts,
  readBudget,
  resetBudget,
  remainingSelfModifyBudget,
  DEFAULT_SELF_MODIFY_BUDGET,
  appendAuditEntry,
  readAuditEntries,
  disableSelfModify,
  readDisableState,
  rollbackSelfModify,
} from '@kodax/coding';

interface CliOpts {
  readonly cwd: string;
}

/**
 * Idempotent runtime bootstrap for non-REPL surfaces. Mirrors
 * `constructed_cli.ts::bootstrapForCli` — calling twice is harmless,
 * each call re-applies the policy override and re-runs rehydrate. The
 * rehydrate is needed so cross-version revoke targets (P6) resolve.
 */
async function bootstrapForCli(cwd: string): Promise<void> {
  configureRuntime({
    cwd,
    policy: async () => 'reject',
  });
  await rehydrateActiveArtifacts();
}

/**
 * `kodax constructed reset-self-modify-budget <name>`.
 *
 * Verifies the agent has at least one manifest on disk (cheap sanity
 * check — resetting the budget for a non-existent agent would be
 * harmless on its own but tends to indicate a typo). Reads the
 * pre-reset state so the audit entry can record both before/after
 * counts. Writes the reset, then writes the audit entry. Confirmation
 * is printed in green; warnings (e.g., budget was already zero) are
 * printed dimmed but the command still succeeds.
 *
 * Exit codes:
 *   0 — reset persisted (counter is now 0/N), audit recorded
 *   1 — agent unknown / IO failure / invalid input
 */
export async function runResetSelfModifyBudget(
  name: string,
  opts: CliOpts,
): Promise<void> {
  if (typeof name !== 'string' || name.trim().length === 0) {
    process.stderr.write(
      `kodax constructed reset-self-modify-budget: <name> is required.\n`,
    );
    process.exit(1);
  }

  await bootstrapForCli(opts.cwd);

  // Cheap "did you typo" check. listArtifacts is workspace-scoped and
  // cheap (≤ N file reads) for the agents directory only.
  const all = await listArtifacts('agent');
  const knownNames = new Set(all.map((a) => a.name));
  if (!knownNames.has(name)) {
    process.stderr.write(
      `kodax constructed reset-self-modify-budget: no constructed agent named '${name}' found in ${path.resolve(opts.cwd, '.kodax', 'constructed', 'agents')}.\n`,
    );
    process.exit(1);
  }

  const before = await readBudget(name, { cwd: opts.cwd });
  const beforeRemaining = remainingSelfModifyBudget(before);
  const after = await resetBudget(name, { cwd: opts.cwd });
  const afterRemaining = remainingSelfModifyBudget(after);

  await appendAuditEntry(
    {
      ts: new Date().toISOString(),
      event: 'self_modify_budget_reset',
      agentName: name,
      // Reset is not tied to a specific manifest version. Record the
      // active version (if any) so the operator has context, falling
      // back to a sentinel when the agent has only staged versions.
      toVersion: findActiveVersion(all, name) ?? '<no active version>',
      budgetRemaining: afterRemaining,
      user: safeOsUser(),
    },
    { cwd: opts.cwd },
  );

  if (beforeRemaining === DEFAULT_SELF_MODIFY_BUDGET) {
    console.log(
      chalk.dim(
        `Budget for '${name}' was already full (${beforeRemaining}/${DEFAULT_SELF_MODIFY_BUDGET}). Reset recorded.`,
      ),
    );
    return;
  }
  console.log(
    chalk.green(
      `✓ Self-modify budget for '${name}' reset to ${afterRemaining}/${DEFAULT_SELF_MODIFY_BUDGET} (was ${beforeRemaining}/${DEFAULT_SELF_MODIFY_BUDGET}).`,
    ),
  );
}

function findActiveVersion(
  all: ReadonlyArray<{ name: string; version: string; status: string }>,
  name: string,
): string | undefined {
  return all.find((a) => a.name === name && a.status === 'active')?.version;
}

async function assertAgentExists(name: string, cwd: string): Promise<void> {
  const all = await listArtifacts('agent');
  if (!all.some((a) => a.name === name)) {
    process.stderr.write(
      `kodax constructed: no constructed agent named '${name}' found in ${path.resolve(cwd, '.kodax', 'constructed', 'agents')}.\n`,
    );
    process.exit(1);
  }
}

/**
 * `kodax constructed audit <name>`.
 *
 * Print every recorded self-modify lifecycle entry for `name`,
 * sorted oldest-first. Read-only — no disk mutations. Exits 0 even
 * on empty audit (legitimate state for a freshly-staged agent).
 */
export async function runConstructedAudit(
  name: string,
  opts: CliOpts,
): Promise<void> {
  if (typeof name !== 'string' || name.trim().length === 0) {
    process.stderr.write(`kodax constructed audit: <name> is required.\n`);
    process.exit(1);
  }
  await bootstrapForCli(opts.cwd);
  await assertAgentExists(name, opts.cwd);

  const entries = await readAuditEntries({ cwd: opts.cwd, agentName: name });
  if (entries.length === 0) {
    console.log(chalk.dim(`No audit entries recorded for '${name}'.`));
    return;
  }

  // Stable sort by timestamp ascending — oldest event first so the
  // operator reads top-down chronologically.
  const sorted = [...entries].sort((a, b) => a.ts.localeCompare(b.ts));
  console.log(chalk.cyan(`\nSelf-modify audit log for '${name}' (${sorted.length} entries):\n`));
  for (const e of sorted) {
    const versionLine = e.fromVersion
      ? `${e.fromVersion} → ${e.toVersion}`
      : e.toVersion;
    const verdict = e.policyVerdict ? ` policy=${e.policyVerdict}` : '';
    const severity = e.severity ? ` severity=${e.severity}` : '';
    const budget =
      typeof e.budgetRemaining === 'number'
        ? ` budget=${e.budgetRemaining}/${DEFAULT_SELF_MODIFY_BUDGET}`
        : '';
    console.log(`  ${chalk.dim(e.ts)}  ${chalk.bold(e.event)}  ${versionLine}${verdict}${severity}${budget}`);
    if (e.llmSummary) {
      console.log(chalk.dim(`    summary: ${e.llmSummary}`));
    }
    if (e.flaggedConcerns && e.flaggedConcerns.length > 0) {
      for (const concern of e.flaggedConcerns) {
        console.log(chalk.yellow(`    flag: ${concern}`));
      }
    }
    if (e.rejectRule) {
      console.log(
        chalk.red(`    reject: rule=${e.rejectRule} reason=${e.rejectReason ?? '(none)'}`),
      );
    }
  }
  console.log();
}

/**
 * `kodax constructed disable-self-modify <name>`.
 *
 * Permanently disable an agent's self-modify capability. Writes the
 * marker file then records the audit entry. Idempotent — disabling
 * an already-disabled agent rewrites the marker timestamp and
 * appends a fresh audit row.
 *
 * No symmetrical re-enable command exists by design (FEATURE_090
 * spec: "用户可以永久拒绝某个 agent 的 self-modify 能力"). To
 * regain a self-modifiable agent, stage a separately-named
 * replacement.
 */
export async function runDisableSelfModify(
  name: string,
  opts: CliOpts,
): Promise<void> {
  if (typeof name !== 'string' || name.trim().length === 0) {
    process.stderr.write(`kodax constructed disable-self-modify: <name> is required.\n`);
    process.exit(1);
  }
  await bootstrapForCli(opts.cwd);
  await assertAgentExists(name, opts.cwd);

  const before = await readDisableState(name, { cwd: opts.cwd });
  await disableSelfModify(name, { cwd: opts.cwd, user: safeOsUser() });

  const all = await listArtifacts('agent');
  await appendAuditEntry(
    {
      ts: new Date().toISOString(),
      event: 'self_modify_disabled',
      agentName: name,
      toVersion: findActiveVersion(all, name) ?? '<no active version>',
      user: safeOsUser(),
    },
    { cwd: opts.cwd },
  );

  if (before.disabled) {
    console.log(
      chalk.dim(
        `Self-modify for '${name}' was already disabled (${before.disabledAt ?? 'unknown timestamp'}); marker re-stamped and audit entry appended.`,
      ),
    );
    return;
  }
  console.log(chalk.green(`✓ Self-modify permanently disabled for '${name}'.`));
  console.log(
    chalk.dim(
      '  Future stage_self_modify attempts will be rejected with rule=self-modify-disabled. There is no re-enable command — stage a separately-named replacement to author further changes.',
    ),
  );
}

/**
 * `kodax constructed rollback <name>`.
 *
 * Restore the previously-active version of an agent. Delegates to
 * `rollbackSelfModify()` which performs the revoke + re-register
 * dance and re-runs admission against the rollback target. Records
 * an audit entry with the from/to version pair.
 *
 * Exit codes:
 *   0 — rollback succeeded
 *   1 — no current active / no rollback target / admission failed /
 *       agent unknown
 */
export async function runConstructedRollback(
  name: string,
  opts: CliOpts,
): Promise<void> {
  if (typeof name !== 'string' || name.trim().length === 0) {
    process.stderr.write(`kodax constructed rollback: <name> is required.\n`);
    process.exit(1);
  }
  await bootstrapForCli(opts.cwd);
  await assertAgentExists(name, opts.cwd);

  let result: Awaited<ReturnType<typeof rollbackSelfModify>>;
  try {
    result = await rollbackSelfModify(name);
  } catch (err) {
    process.stderr.write(`kodax constructed rollback: ${(err as Error).message}\n`);
    process.exit(1);
  }

  await appendAuditEntry(
    {
      ts: new Date().toISOString(),
      event: 'self_modify_rolled_back',
      agentName: name,
      fromVersion: result.fromVersion,
      toVersion: result.toVersion,
      user: safeOsUser(),
    },
    { cwd: opts.cwd },
  );

  console.log(
    chalk.green(
      `✓ Rolled back '${name}' from ${result.fromVersion} to ${result.toVersion}.`,
    ),
  );
  console.log(
    chalk.dim(
      `  ${result.fromVersion} is now status='revoked'; the resolver returns ${result.toVersion} for new Runner.run calls.`,
    ),
  );
}

/**
 * Best-effort OS username for audit attribution. `os.userInfo()`
 * throws on rare platforms when the uid lookup fails (e.g. some
 * containerised environments). The audit entry treats `user` as
 * informational, so swallowing the error and recording `undefined`
 * is acceptable.
 */
function safeOsUser(): string | undefined {
  try {
    return os.userInfo().username;
  } catch {
    return undefined;
  }
}
