/**
 * LineageCompaction — `CompactionPolicy` adapter for the coding preset's
 * FEATURE_072 lineage-native compaction runtime.
 *
 * FEATURE_082 (v0.7.24): introduced alongside the lineage extraction so the
 * coding preset can implement `CompactionPolicy` without re-implementing the
 * compaction loop. The actual compaction runtime (microcompaction, post-
 * compact reconstruction, summary generation) stays in
 * `@kodax/agent/src/compaction/` until FEATURE_084 (v0.7.26) consolidates it.
 *
 * Usage (inside @kodax/coding):
 *
 *   const policy = new LineageCompaction({
 *     shouldCompact: (session, used, budget) => runFeature072Heuristic(used, budget),
 *     compact: async (session, ctx) => runFeature072Compaction(session, ctx),
 *   });
 *
 * The injected delegates keep this package free of coding-specific imports,
 * preserving the dependency direction
 * `@kodax/coding -> @kodax/session-lineage -> @kodax/core`.
 */

import type {
  CompactionContext,
  CompactionPolicy,
  CompactionResult,
  Session,
} from '@kodax/core';

/**
 * Delegates required to implement `LineageCompaction`. The coding preset
 * supplies implementations that bridge to the existing FEATURE_072 code
 * paths.
 */
export interface LineageCompactionDelegates {
  readonly shouldCompact: (
    session: Session,
    tokensUsed: number,
    budget: number,
  ) => boolean;
  readonly compact: (
    session: Session,
    ctx: CompactionContext,
  ) => Promise<CompactionResult>;
  readonly restore?: (session: Session, hint: unknown) => Promise<void>;
}

/**
 * `CompactionPolicy` implementation that preserves FEATURE_072 lineage-native
 * compaction semantics by delegating to injected coding-preset functions.
 */
export class LineageCompaction implements CompactionPolicy {
  readonly name = 'lineage-compaction';
  private readonly delegates: LineageCompactionDelegates;

  constructor(delegates: LineageCompactionDelegates) {
    if (!delegates || typeof delegates.shouldCompact !== 'function' || typeof delegates.compact !== 'function') {
      throw new Error(
        'LineageCompaction: `shouldCompact` and `compact` delegates are required',
      );
    }
    this.delegates = delegates;
  }

  shouldCompact(session: Session, tokensUsed: number, budget: number): boolean {
    return this.delegates.shouldCompact(session, tokensUsed, budget);
  }

  async compact(session: Session, ctx: CompactionContext): Promise<CompactionResult> {
    return this.delegates.compact(session, ctx);
  }

  async restore(session: Session, hint: unknown): Promise<void> {
    if (this.delegates.restore) {
      await this.delegates.restore(session, hint);
    }
  }
}
