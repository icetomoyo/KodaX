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
 * **Storage failure isolation (CAP-013-003 / CAP-SESSION-SNAPSHOT-003)**:
 * `storage.save` rejections are absorbed locally and logged via
 * `console.error('[SessionSnapshot] ...')`. The function NEVER propagates
 * a storage error to the caller. Rationale: snapshots are best-effort
 * session continuity, NOT load-bearing for the run's success/failure.
 * Particularly important inside the catch-block cleanup chain
 * (`runCatchCleanup`) where a storage failure would otherwise clobber
 * the original error we are trying to record. Closed in FEATURE_100
 * P3.6a (was P3-deferred during P2 byte-for-byte migration).
 *
 * Migration history: extracted from `agent.ts:844-872` (function) and
 * `agent.ts:3154-3156` (`getGitRoot` private helper) — pre-FEATURE_100
 * baseline — during FEATURE_100 P2. Storage isolation added in P3.6a.
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
  // CAP-013-003 / CAP-SESSION-SNAPSHOT-003: storage failures are absorbed
  // here so a transient backend issue (disk full, FS permission, race) cannot
  // mask the caller's original error nor abort an otherwise-successful run.
  // Snapshots are best-effort; resume just won't see the latest state.
  try {
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
  } catch (storageError) {
    console.error(
      '[SessionSnapshot] storage.save failed; continuing without snapshot persistence:',
      storageError,
    );
  }
}
