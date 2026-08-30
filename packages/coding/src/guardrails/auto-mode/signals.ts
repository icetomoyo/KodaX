/**
 * Tool-Call Signals — FEATURE_158 Step 2 (v0.7.39).
 *
 * Mechanical pattern matches over a tool call. Signals are NOT verdicts;
 * the classifier consumes them as informational input alongside transcript
 * + user rules and produces the final Auto[LLM] decision (allow / ask).
 *
 * Two invariants the producers must hold:
 *
 *   1. **Pure**: same `call` + path context ⇒ same signals. No I/O, no
 *      timestamps, no env reads inside collectors. Collectors run on every
 *      non-Tier-1 tool call, so they must be cheap and deterministic.
 *
 *   2. **Fact-only**: a `protected_path` signal says "this command names
 *      path X which is under ~/.kodax/", not "this should be blocked".
 *      Severity stays on the producer side (e.g. `dangerous_pattern.severity`)
 *      so the classifier can weight signals, but the verdict is not encoded
 *      here.
 *
 * The historical Tier 0 detector is a separate module, but its matches are
 * also pre-verdict facts in Auto[LLM].
 *
 * Design ref: ADR-025, FEATURE_158 (docs/features/v0.7.39.md).
 */

import type { RunnerToolCall } from '@kodax-ai/agent';

/**
 * One mechanical signal about a tool call. Discriminated union — consumers
 * narrow on `kind` to access the kind-specific fields.
 */
export type ToolCallSignal =
  | {
      readonly kind: 'dangerous_pattern';
      /** Pattern source (e.g. regex .source) that matched. */
      readonly pattern: string;
      /**
       * Severity hint for the classifier.
       *   `high`   — destructive intent typical (e.g. `git push --force`,
       *              `chmod 777`, `curl | bash`). Classifier should lean
       *              toward escalate/block.
       *   `medium` — risk-shaped but contextual (e.g. broad `rm`, `sudo`).
       *              Classifier weighs against transcript context.
       */
      readonly severity: 'high' | 'medium';
    }
  | {
      readonly kind: 'protected_path';
      /** Path token that triggered the match (as it appeared in the call). */
      readonly path: string;
      /**
       *   `project-kodax` — under `<projectRoot>/.kodax/`
       *   `user-kodax`    — under `~/.kodax/` (credentials zone)
       */
      readonly zone: 'project-kodax' | 'user-kodax';
    }
  | {
      readonly kind: 'outside_project';
      readonly path: string;
    }
  | {
      readonly kind: 'shell_redirect_outside';
      /** Redirection target path (`>`, `>>`, `tee` etc.). */
      readonly target: string;
    }
  | {
      readonly kind: 'package_install';
      readonly manager: 'npm' | 'pnpm' | 'yarn' | 'pip' | 'cargo' | 'apt' | 'brew';
    }
  | {
      readonly kind: 'git_write';
      readonly verb: 'commit' | 'push' | 'reset' | 'clean' | 'rebase' | 'cherry-pick' | 'revert';
    }
  | {
      readonly kind: 'network';
      readonly tool: 'curl' | 'wget' | 'fetch';
    }
  | {
      readonly kind: 'file_modification';
      readonly targets: readonly string[];
    };

/**
 * Pulls signals from one tool call. A collector declares which tool names
 * it applies to via `toolNames`; the dispatcher in `collectAllSignals`
 * skips non-matching collectors so each one only sees calls it was
 * designed for.
 *
 * `collect` returns the signals; an empty array is fine and the common
 * case for benign calls.
 */
export interface SignalCollector {
  /**
   * Tool names this collector reacts to (lowercase). Other tool names
   * never reach `collect`. Empty set = matches nothing (effectively
   * disabled — useful only for tests).
   */
  readonly toolNames: ReadonlySet<string>;

  /**
   * Inspect the call and produce zero or more signals.
   *
   * Must be pure: no I/O, no timing, no global state reads. The
   * `projectRoot` is the authorization boundary. `executionCwd` is the
   * directory relative paths resolve from and defaults to `projectRoot` for
   * backward compatibility.
   */
  collect(
    call: RunnerToolCall,
    projectRoot: string,
    executionCwd?: string,
  ): readonly ToolCallSignal[];
}

/**
 * Run every applicable collector on `call` and return the merged signal
 * list. Order preserved: collectors run in array order; per-collector
 * signal order preserved within their slice.
 *
 * Duplicates intentionally not deduped here — different collectors may
 * legitimately surface the same kind for different reasons (e.g. a
 * `protected_path` from a bash redirect target AND a `protected_path`
 * from an argv token in the same command). The classifier prompt
 * tolerates duplicates; dedup would risk dropping load-bearing context.
 */
export function collectAllSignals(
  call: RunnerToolCall,
  projectRoot: string,
  collectors: readonly SignalCollector[],
  executionCwd = projectRoot,
): readonly ToolCallSignal[] {
  const result: ToolCallSignal[] = [];
  for (const collector of collectors) {
    if (!collector.toolNames.has(call.name)) continue;
    const signals = collector.collect(call, projectRoot, executionCwd);
    if (signals.length === 0) continue;
    for (const signal of signals) result.push(signal);
  }
  return result;
}
