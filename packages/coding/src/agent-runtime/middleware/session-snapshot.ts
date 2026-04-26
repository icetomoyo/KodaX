/**
 * Session snapshot middleware — CAP-011 + CAP-013
 *
 * Capability inventory:
 * - docs/features/v0.7.29-capability-inventory.md#cap-011-savesessionsnapshot-at-terminal-sites
 * - docs/features/v0.7.29-capability-inventory.md#cap-013-error-snapshot-persistence-on-crash
 *
 * Persists `.kodax/sessions/<id>.json` so that `/resume <id>` and
 * `--continue` can reload a run mid-flight. Called at four sites in the
 * SA loop:
 *
 *   1. mid-flow after auto-reroute (CAP-019 plan accepted) — persists
 *      so that a crash between iterations is recoverable.
 *   2. success terminal (turn loop ended cleanly).
 *   3. error terminal (catch branch) — CAP-013, includes
 *      `errorMetadata` so the user sees the reason on resume.
 *   4. limit-reached terminal.
 *
 * **Behavior preserved verbatim from FEATURE_100 baseline**:
 * - When `options.session?.storage` is absent, returns immediately
 *   (silent no-op).
 * - When `data.gitRoot` is not provided, falls back to `getGitRoot()`
 *   (a `git rev-parse --show-toplevel` call), then `''` if git fails.
 * - `extensionState` is snapshotted via `snapshotRuntimeExtensionState`
 *   (drops empty buckets, returns `undefined` if no records).
 * - `extensionRecords` are deep-cloned at the field level so subsequent
 *   in-memory mutations do not mutate the persisted snapshot.
 *
 * **Open contract gap (P3 territory, NOT fixed in P2)**: today storage
 * `.save` rejection propagates to the caller. CAP-SESSION-SNAPSHOT-003
 * ("storage failure does not fail the run") is aspirational — it
 * describes the post-substrate-adoption contract where the executor's
 * terminal hook is wrapped in best-effort isolation. P2 migration is
 * byte-for-byte parity, so the bug is preserved.
 *
 * Migration history: extracted from `agent.ts:844-872` (function) and
 * `agent.ts:3154-3156` (`getGitRoot` private helper) — pre-FEATURE_100
 * baseline — during FEATURE_100 P2.
 */

import { exec } from 'child_process';
import { promisify } from 'util';

import type { KodaXMessage } from '@kodax/ai';

import type { KodaXOptions, SessionErrorMetadata } from '../../types.js';
import {
  type RuntimeSessionState,
  snapshotRuntimeExtensionState,
} from '../runtime-session-state.js';

const execAsync = promisify(exec);

async function getGitRoot(): Promise<string | null> {
  try {
    const { stdout } = await execAsync('git rev-parse --show-toplevel');
    return stdout.trim();
  } catch {
    return null;
  }
}

export async function saveSessionSnapshot(
  options: KodaXOptions,
  sessionId: string,
  data: {
    messages: KodaXMessage[];
    title: string;
    gitRoot?: string;
    errorMetadata?: SessionErrorMetadata;
    runtimeSessionState?: RuntimeSessionState;
  },
): Promise<void> {
  if (!options.session?.storage) {
    return;
  }

  const gitRoot = data.gitRoot ?? (await getGitRoot()) ?? '';
  await options.session.storage.save(sessionId, {
    messages: data.messages,
    title: data.title,
    gitRoot,
    scope: options.session.scope ?? 'user',
    errorMetadata: data.errorMetadata,
    extensionState: data.runtimeSessionState
      ? snapshotRuntimeExtensionState(data.runtimeSessionState.extensionState)
      : undefined,
    extensionRecords: data.runtimeSessionState?.extensionRecords.map((record) => ({ ...record })),
  });
}
