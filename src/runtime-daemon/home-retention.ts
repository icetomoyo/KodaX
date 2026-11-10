import type { Stats } from 'node:fs';
import { lstat, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

/**
 * Idle-Host retention for agent-home state that no current code reads.
 *
 * Every rule names an exact location under the agent home. Anything not
 * listed is never touched, including Sessions, Run records (`status.json`,
 * `generation-recovery.json`), Session settings/orders/stops, pending inputs,
 * execution facts, tool results, traces, memory, extensions, Agent task and
 * Workflow ledgers, ACL poison/recovery markers and live sandbox gate files.
 * State owned by a single Session is removed only by an explicit Session
 * delete (`removeDeletedSessionRuntimeState` in sdk-runtime), never here.
 */
type Segment = string | RegExp;

interface RetentionRule {
  /** Path under the agent home; `*` matches every real child directory. */
  readonly path: readonly Segment[];
  readonly kind: 'file' | 'directory';
  /** Newest modification anywhere in the target must be at least this old. */
  readonly minAgeDays: number;
}

export interface HomeRetentionRound {
  readonly examined: number;
  readonly removed: number;
  /** Expired targets the OS refused to delete (open handle, ACL); retried next pass. */
  readonly retained: number;
  readonly passComplete: boolean;
}

const DAY_MS = 86_400_000;
/** Retired writers: the fence only protects a downgraded Host that is still writing. */
const RETIRED = 30;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PROFILE = ['runtime', 'profiles', '*'];
const RUN = [...PROFILE, 'runs', '*'];

export const HOME_RETENTION_RULES: readonly RetentionRule[] = [
  // Run event journals, retired when Session events became the only event store.
  { path: [...RUN, 'events.jsonl'], kind: 'file', minAgeDays: RETIRED },
  { path: [...RUN, 'event-journals.json'], kind: 'file', minAgeDays: RETIRED },
  { path: [...RUN, 'events.watermark'], kind: 'file', minAgeDays: RETIRED },
  { path: [...PROFILE, 'session-events'], kind: 'directory', minAgeDays: RETIRED },
  { path: [...PROFILE, 'event-sequence'], kind: 'file', minAgeDays: RETIRED },
  // Filesystem-effect ledgers; their writer was removed and the state is ignored.
  { path: ['runtime', /^test-filesystem-effects-[\w-]+$/], kind: 'directory', minAgeDays: RETIRED },
  { path: ['runtime', 'model-filesystem-effects.json'], kind: 'file', minAgeDays: RETIRED },
  { path: ['runtime', 'model-filesystem-effects.lock.queue'], kind: 'directory', minAgeDays: RETIRED },
  { path: ['runtime', 'model-filesystem-effect.lock.queue'], kind: 'directory', minAgeDays: RETIRED },
  // Sandbox request files and the runner staging copy from before the protected
  // native-artifact store; `kodax-asrt-gate-*` and ACL markers are still live.
  { path: ['sandbox-runtime', new RegExp(`^kodax-asrt-(?:observation|shell)-\\d+-${UUID}\\.json$`, 'i')],
    kind: 'file', minAgeDays: RETIRED },
  { path: ['sandbox-runtime', new RegExp(`^workspace-\\d+-${UUID}\\.json$`, 'i')], kind: 'file', minAgeDays: RETIRED },
  { path: ['sandbox-runtime', 'runner'], kind: 'directory', minAgeDays: RETIRED },
  // Child records whose owner could not be resolved are kept only as evidence.
  { path: ['runtime', 'processes', 'children', '.unresolved', new RegExp(`^[1-9]\\d*\\.${UUID}\\.json$`, 'i')],
    kind: 'file', minAgeDays: 90 },
];

const RETRYABLE_REMOVAL = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']);

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

async function isRealDirectory(target: string): Promise<boolean> {
  try { return (await lstat(target)).isDirectory(); }
  catch (error: unknown) { if (errorCode(error) === 'ENOENT') return false; throw error; }
}

/** Walks one rule without following links, so nothing outside the agent home is reached. */
async function* matches(directory: string, segments: readonly Segment[]): AsyncGenerator<string> {
  const [head, ...rest] = segments;
  if (head === undefined) return;
  if (typeof head === 'string' && head !== '*') {
    const target = path.join(directory, head);
    if (rest.length === 0) yield target;
    else if (await isRealDirectory(target)) yield* matches(target, rest);
    return;
  }
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    if (['ENOENT', 'ENOTDIR'].includes(errorCode(error) ?? '')) return [];
    throw error;
  });
  for (const entry of entries) {
    if (head === '*' ? !entry.isDirectory() : !head.test(entry.name)) continue;
    if (rest.length === 0) yield path.join(directory, entry.name);
    else if (entry.isDirectory()) yield* matches(path.join(directory, entry.name), rest);
  }
}

async function* candidates(home: string): AsyncGenerator<{ target: string; rule: RetentionRule }> {
  for (const rule of HOME_RETENTION_RULES) {
    for await (const target of matches(home, rule.path)) yield { target, rule };
  }
}

async function newestModification(target: string, stat: Stats): Promise<number> {
  if (!stat.isDirectory()) return stat.mtimeMs;
  let newest = stat.mtimeMs;
  for (const entry of await readdir(target)) {
    const child = path.join(target, entry);
    newest = Math.max(newest, await newestModification(child, await lstat(child)));
  }
  return newest;
}

async function expire(target: string, rule: RetentionRule): Promise<'kept' | 'removed' | 'retained'> {
  try {
    const stat = await lstat(target);
    if (rule.kind === 'file' ? !stat.isFile() : !stat.isDirectory()) return 'kept';
    if (await newestModification(target, stat) > Date.now() - rule.minAgeDays * DAY_MS) return 'kept';
    await rm(target, { recursive: rule.kind === 'directory', force: true });
    return 'removed';
  } catch (error: unknown) {
    // Another profile Host may expire the same shared target concurrently.
    if (errorCode(error) === 'ENOENT') return 'kept';
    if (RETRYABLE_REMOVAL.has(errorCode(error) ?? '')) return 'retained';
    throw error;
  }
}

/** One bounded pass per Host day; each round examines at most `budget` targets. */
export function createHomeRetention(home: string, budget = 256): {
  runOnce(signal?: AbortSignal): Promise<HomeRetentionRound>;
} {
  let pass: AsyncGenerator<{ target: string; rule: RetentionRule }> | undefined;
  let nextPassAt = 0;
  return {
    async runOnce(signal) {
      const round = { examined: 0, removed: 0, retained: 0, passComplete: false };
      if (signal?.aborted || (!pass && Date.now() < nextPassAt)) return round;
      pass ??= candidates(path.resolve(home));
      try {
        while (round.examined < budget && !signal?.aborted) {
          const next = await pass.next();
          if (next.done) {
            pass = undefined;
            nextPassAt = Date.now() + DAY_MS;
            round.passComplete = true;
            break;
          }
          round.examined += 1;
          const outcome = await expire(next.value.target, next.value.rule);
          if (outcome !== 'kept') round[outcome] += 1;
        }
      } catch (error: unknown) {
        // A failed walk restarts from the top on the next idle round.
        pass = undefined;
        throw error;
      }
      return round;
    },
  };
}
