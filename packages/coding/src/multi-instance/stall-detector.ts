/**
 * FEATURE_178 (v0.7.42) — L1 stall detector (anti-loop, rule-based).
 *
 * Pairs with FEATURE_177's read-file-state cache. F177 suppresses the
 * re-read content; this module catches the case where a model keeps
 * emitting the *same tool call with the same input* despite the cache
 * stub or other signal telling it that nothing new has happened.
 *
 * **Two-tier classifier** (this module = L1 only):
 *   - L1 (here): cheap rule. Fires when `(toolName + JSON.stringify(input))`
 *     repeats ≥3 times in the window OR ≥2 times after at least one
 *     cache-hit on that key. Catches the structural pattern with zero
 *     LLM cost.
 *   - L2 (FEATURE_178 sidecar, separate module): on an L1 hit, a sidecar
 *     LLM call decides whether the repetition is a real stall or a
 *     legitimate iterative pattern (grep refinement, todo batch re-mark).
 *     The sidecar's value is *precision* on legitimate repeats.
 *
 * **Eval-driven design**: the `signalEnvelope` shape produced by
 * `evaluate()` matches the format the FEATURE_178 sidecar eval validated
 * (`benchmark/datasets/feature-178-stall-sidecar/cases.ts`). The 149/150
 * PASS verdict on canonical 5-alias panel pins this envelope as the
 * sidecar's input contract — production must produce the same string.
 *
 * **Window scope**: last `windowSize` tool-use events for the current
 * managed-task. Kimi-loop signature is across turns, not within a single
 * assistant message — turn-scoped buffers miss the pattern entirely.
 *
 * **Killswitch**: `KODAX_STALL_DETECT=0` makes every operation a no-op
 * (`recordToolUse` always returns `{kind:'no_stall'}`, `reset` is a
 * no-op). Mirrors F177's `KODAX_READ_DEDUP_KILLSWITCH` rollback hatch.
 *
 * Lifetime: per-managed-task. Created in `runner-driven.ts` alongside
 * `readFileStateCache`; cleared by the compaction post-hook because the
 * earlier `tool_result` content the model would be referencing has been
 * summarized away (carrying stale stall history forward would fire on
 * legitimate post-compact re-reads).
 *
 * DI-clean: no I/O. Pure in-memory ring buffer.
 */

import { REPO_EXPLORER_TOOL_NAMES } from '../construction/builtin-agents.js';

/**
 * Killswitch: when this env var is exactly the string '0', the detector
 * is disabled entirely (factory returns a no-op shim). Any other value —
 * including unset — enables the detector. This convention is the inverse
 * of F177's `KODAX_READ_DEDUP_KILLSWITCH=1` (which disables on '1')
 * because the stall detector is opt-OUT (enabled by default).
 */
const KILLSWITCH_ENV = 'KODAX_STALL_DETECT';

export interface StallDetectorOptions {
  /**
   * How many recent tool-use events to keep in the ring buffer. Default
   * 20 — empirically large enough to catch a 3-repeat across a few
   * intervening tool calls, small enough to bound memory and prevent a
   * day-long task from carrying ancient history.
   */
  readonly windowSize?: number;

  /**
   * Override the killswitch decision (test-only escape from env-var
   * reading). When unset, reads `process.env.KODAX_STALL_DETECT`.
   */
  readonly disabled?: boolean;

  /**
   * Number of consecutive repository-inspection probes with varied inputs
   * that should ask the L2 sidecar to check for a semantic loop. Default 8.
   * Any non-probe tool starts a fresh family epoch.
   */
  readonly probeFamilyThreshold?: number;
}

export type StallSignal =
  | { readonly kind: 'no_stall' }
  | {
      readonly kind: 'stall';
      /** Tool name that triggered the rule (e.g. 'read'). */
      readonly toolName: string;
      /** Stringified input as-seen (same hash as comparison key). */
      readonly inputJson: string;
      /** How many times the (toolName, inputJson) pair appears in the window. */
      readonly occurrenceCount: number;
      /** How many of those occurrences carried `cacheHit=true`. */
      readonly cacheHitCount: number;
      /** Semantic family that fired even though exact inputs differed. */
      readonly probeFamily?: 'repository-inspection';
      /**
       * The 1-based turn indices (relative to detector creation) where
       * each occurrence was recorded. Stable for sidecar prompts.
       */
      readonly turns: readonly number[];
      /**
       * The pre-rendered signal envelope string the sidecar's user
       * message will prefix. Format pinned by the F178 eval contract:
       *   `[Stall detector signal]\ntool=<name> input=<json> ` +
       *   `occurrence_count=<n> cache_hit_count=<m> turns=[t1,t2,t3]`
       */
      readonly envelope: string;
    };

export interface StallDetector {
  /**
   * Record a tool_use observed in the current task. Returns the L1
   * verdict synchronously.
   *
   * @param toolName  the tool's registered name (e.g. 'read', 'bash').
   * @param input     the tool's input object — will be JSON.stringify'd
   *                  with stable key ordering so equivalent inputs hash
   *                  identically regardless of key order.
   * @param cacheHit  did this invocation hit the read-file-state cache
   *                  (or any equivalent "already known" signal)? When
   *                  true, the threshold drops from 3 to 2 — the model
   *                  has been explicitly told nothing changed and is
   *                  still re-calling.
   */
  recordToolUse(toolName: string, input: unknown, cacheHit?: boolean): StallSignal;

  /**
   * Drop all recorded history. Called by the compaction post-hook —
   * after the conversation has been summarized, the earlier tool_results
   * the model was implicitly referencing are gone, so a fresh re-read is
   * legitimate.
   */
  reset(): void;

  /** Test/diagnostic accessor. */
  size(): number;
}

interface RecordedEvent {
  readonly toolName: string;
  readonly inputJson: string;
  readonly cacheHit: boolean;
  readonly turn: number;
  readonly probeFamily?: 'repository-inspection';
  readonly familyEpoch: number;
}

/**
 * Stable-key-order JSON.stringify so `{a:1,b:2}` and `{b:2,a:1}` produce
 * the same hash. Strings, numbers, booleans, null and arrays are
 * preserved as-is. Functions / undefined / symbols are normalized to the
 * literal string `'__non_serializable__'` so the hash is stable across
 * unusual inputs without crashing.
 */
export function stableStringify(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value !== 'object') {
    if (
      typeof value === 'function'
      || typeof value === 'undefined'
      || typeof value === 'symbol'
    ) {
      return JSON.stringify('__non_serializable__');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${parts.join(',')}}`;
}

/**
 * Build the signal envelope string the sidecar sees as the prefix of its
 * user message. Format pinned by the FEATURE_178 eval `cases.ts`
 * `signalEnvelope` field — production must produce the same shape so
 * the eval's 149/150 PASS verdict transfers.
 */
export function buildStallSignalEnvelope(params: {
  readonly toolName: string;
  readonly inputJson: string;
  readonly occurrenceCount: number;
  readonly cacheHitCount: number;
  readonly turns: readonly number[];
}): string {
  return (
    `[Stall detector signal]\n`
    + `tool=${params.toolName} `
    + `input=${params.inputJson} `
    + `occurrence_count=${params.occurrenceCount} `
    + `cache_hit_count=${params.cacheHitCount} `
    + `turns=[${params.turns.join(',')}]`
  );
}

const DEFAULT_WINDOW_SIZE = 20;
const DEFAULT_PROBE_FAMILY_THRESHOLD = 8;
const REPOSITORY_PROBE_TOOLS = new Set(REPO_EXPLORER_TOOL_NAMES);
const PROGRESS_BOUNDARY_TOOLS = new Set([
  'edit',
  'write',
  'multi_edit',
  'insert_after_anchor',
  'undo',
  'delete',
  'remove',
  'rename',
  'apply_patch',
  'spawn_agent',
  'followup_task',
]);

function isReadOnlyShellProbe(command: string): boolean {
  const repositoryInspection = /(?:^|[\s|;&])(?:rg|grep|findstr)(?:\s|$)|git\s+(?:grep|log|show|status|diff|ls-files|rev-parse)\b|\b(?:Get-Content|Get-ChildItem|Get-Item|Select-String)\b/i;
  if (repositoryInspection.test(command)) return true;
  if (!/\bgit\s+branch\b/i.test(command)) return false;
  return !/\bgit\s+branch\s+(?:-[dDmMcC]\b|--(?:delete|move|copy)\b)/i.test(command);
}

function repositoryProbeFamily(
  toolName: string,
  input: unknown,
): 'repository-inspection' | undefined {
  if (REPOSITORY_PROBE_TOOLS.has(toolName)) {
    return 'repository-inspection';
  }
  if (toolName !== 'bash' || input === null || typeof input !== 'object') {
    return undefined;
  }
  const command = (input as Record<string, unknown>).command;
  if (typeof command !== 'string') return undefined;
  return isReadOnlyShellProbe(command)
    ? 'repository-inspection'
    : undefined;
}

export function isProbeProgressBoundary(toolName: string, input: unknown): boolean {
  if (PROGRESS_BOUNDARY_TOOLS.has(toolName)) return true;
  if (toolName === 'bash') return repositoryProbeFamily(toolName, input) === undefined;
  if (toolName !== 'todo_update' || input === null || typeof input !== 'object') {
    return false;
  }
  const status = (input as Record<string, unknown>).status;
  return status === 'completed' || status === 'cancelled' || status === 'deleted';
}

/** Bind a delayed intervention to the same exact call or existing probe family. */
export function matchesStallSignal(signal: Extract<StallSignal, { kind: 'stall' }>, toolName: string, input: unknown): boolean {
  return signal.probeFamily !== undefined
    ? repositoryProbeFamily(toolName, input) === signal.probeFamily
    : signal.toolName === toolName && signal.inputJson === stableStringify(input);
}

/**
 * Build a fresh per-task stall detector. Cheap — call once at managed
 * task entry; pass the same instance to every tool execution path that
 * needs to record.
 */
export function createStallDetector(
  options: StallDetectorOptions = {},
): StallDetector {
  const disabled =
    options.disabled ?? process.env[KILLSWITCH_ENV] === '0';

  if (disabled) {
    return {
      recordToolUse: () => ({ kind: 'no_stall' }),
      reset: () => {},
      size: () => 0,
    };
  }

  const windowSize = options.windowSize ?? DEFAULT_WINDOW_SIZE;
  const probeFamilyThreshold = Math.max(
    3,
    options.probeFamilyThreshold ?? DEFAULT_PROBE_FAMILY_THRESHOLD,
  );
  const events: RecordedEvent[] = [];
  let nextTurn = 1;
  let familyEpoch = 0;
  let firedProbeFamilyEpoch = -1;

  return {
    recordToolUse(toolName, input, cacheHit = false) {
      const inputJson = stableStringify(input);
      const turn = nextTurn++;
      const probeFamily = repositoryProbeFamily(toolName, input);
      if (probeFamily === undefined && isProbeProgressBoundary(toolName, input)) {
        familyEpoch += 1;
      }
      events.push({ toolName, inputJson, cacheHit, turn, probeFamily, familyEpoch });
      if (events.length > windowSize) {
        events.splice(0, events.length - windowSize);
      }

      const matches = events.filter(
        (e) => e.toolName === toolName && e.inputJson === inputJson,
      );
      const cacheHitCount = matches.filter((e) => e.cacheHit).length;

      // Two firing rules — matches the F178 design doc.
      //   (a) ≥3 occurrences in the window (raw repeat).
      //   (b) ≥2 occurrences AND ≥1 cache_hit (model was told nothing
      //       changed and still re-called).
      const ruleA = matches.length >= 3;
      const ruleB = matches.length >= 2 && cacheHitCount >= 1;
      if (!ruleA && !ruleB) {
        if (probeFamily !== undefined) {
          const familyMatches = events.filter(
            (event) => event.probeFamily === probeFamily
              && event.familyEpoch === familyEpoch,
          );
          if (
            familyMatches.length >= probeFamilyThreshold
            && firedProbeFamilyEpoch !== familyEpoch
          ) {
            firedProbeFamilyEpoch = familyEpoch;
            const familyTurns = familyMatches.map((event) => event.turn);
            const familyCacheHits = familyMatches.filter((event) => event.cacheHit).length;
            const distinctCalls = new Set(
              familyMatches.map((event) => `${event.toolName}:${event.inputJson}`),
            ).size;
            const envelope = `${buildStallSignalEnvelope({
              toolName,
              inputJson,
              occurrenceCount: familyMatches.length,
              cacheHitCount: familyCacheHits,
              turns: familyTurns,
            })} probe_family=${probeFamily} family_occurrence_count=${familyMatches.length} distinct_call_count=${distinctCalls}`;
            return {
              kind: 'stall',
              toolName,
              inputJson,
              occurrenceCount: familyMatches.length,
              cacheHitCount: familyCacheHits,
              probeFamily,
              turns: familyTurns,
              envelope,
            };
          }
        }
        return { kind: 'no_stall' };
      }

      const turns = matches.map((e) => e.turn);
      const envelope = buildStallSignalEnvelope({
        toolName,
        inputJson,
        occurrenceCount: matches.length,
        cacheHitCount,
        turns,
      });
      return {
        kind: 'stall',
        toolName,
        inputJson,
        occurrenceCount: matches.length,
        cacheHitCount,
        turns,
        envelope,
      };
    },

    reset() {
      events.length = 0;
      nextTurn = 1;
      familyEpoch = 0;
      firedProbeFamilyEpoch = -1;
    },

    size() {
      return events.length;
    },
  };
}
