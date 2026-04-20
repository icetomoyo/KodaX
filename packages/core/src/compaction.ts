/**
 * Layer A Primitive: CompactionPolicy + DefaultSummaryCompaction
 *
 * FEATURE_081 (v0.7.23): Pluggable compaction for generic agent loops.
 *
 * Two layers:
 *   - Layer A (here): `CompactionPolicy` interface + `DefaultSummaryCompaction`
 *     — a minimal "token threshold → LLM summary of old messages" policy that
 *     any external Agent can pick up with zero KodaX runtime dependency.
 *   - Layer B (`@kodax/session-lineage/src/lineage.ts`): `LineageCompaction`
 *     wraps the full FEATURE_072 lineage-native compaction for the coding
 *     preset.
 *
 * The `compaction` entry shape written by `DefaultSummaryCompaction` is the
 * same type used by `LineageExtension`, so the two layers interoperate on
 * the same Session log.
 *
 * Moved to `@kodax/core` in FEATURE_082 (v0.7.24).
 */

import type { AgentMessage } from './agent.js';
import type { MessageEntry, Session, SessionEntry } from './session.js';

/**
 * Runtime context for a compaction pass. Abstracts the LLM/tokenizer
 * dependencies so policies stay independent of any specific provider.
 */
export interface CompactionContext {
  readonly tokensUsed: number;
  readonly budget: number;
  /**
   * Summarizer implementation. Callers inject a function that maps a list of
   * messages to a short summary string. In coding-preset mode this is wired
   * to `runKodaX` internally; for external consumers it can call any LLM.
   */
  readonly summarize: (messages: readonly AgentMessage[]) => Promise<string>;
}

/**
 * Payload written to the `compaction` entry appended by `compact()`.
 */
export interface CompactionEntryPayload {
  readonly summary: string;
  readonly replacedMessageEntryIds: readonly string[];
}

/**
 * Typed compaction entry. `type` is `'compaction'`; extensions (LineageExtension)
 * may claim this same type.
 */
export interface CompactionEntry extends SessionEntry {
  readonly type: 'compaction';
  readonly payload: CompactionEntryPayload;
}

/**
 * Outcome of a compaction pass.
 */
export interface CompactionResult {
  readonly summary: string;
  readonly replacedMessageEntryIds: readonly string[];
}

/**
 * Pluggable compaction policy. Any multi-turn Agent loop can check
 * `shouldCompact()` at round boundaries and call `compact()` when it returns
 * true.
 */
export interface CompactionPolicy {
  readonly name: string;
  shouldCompact(session: Session, tokensUsed: number, budget: number): boolean;
  compact(session: Session, ctx: CompactionContext): Promise<CompactionResult>;
  /** Optional: rehydrate compacted content when a restore hint is available. */
  restore?(session: Session, hint: unknown): Promise<void>;
}

/**
 * Configuration for `DefaultSummaryCompaction`.
 */
export interface DefaultSummaryCompactionOptions {
  /**
   * Fraction of `budget` at which compaction triggers. Default 0.8 (i.e.
   * 80% of the token budget). Must be in (0, 1].
   */
  readonly thresholdRatio?: number;
  /**
   * Number of most-recent message entries to preserve verbatim. Default 10.
   * Must be non-negative.
   */
  readonly keepRecent?: number;
  /**
   * Optional clock override (ms epoch). Useful for deterministic tests.
   */
  readonly now?: () => number;
  /**
   * Optional random-string override. Useful for deterministic tests.
   */
  readonly randomSuffix?: () => string;
}

let _compactionCounter = 0;

/**
 * Minimal "token threshold + LLM summary" compaction policy. Works on any
 * Session that stores `message` entries.
 *
 * Behavior:
 *   - `shouldCompact` returns true when `tokensUsed >= budget *
 *     thresholdRatio`.
 *   - `compact` reads all `message` entries, keeps the last `keepRecent`
 *     untouched, summarizes the rest via `ctx.summarize`, and appends a
 *     single `compaction` entry to the session.
 *
 * Caller is responsible for invoking `shouldCompact` and for interpreting the
 * appended entry when building the next turn's prompt.
 */
export class DefaultSummaryCompaction implements CompactionPolicy {
  readonly name = 'default-summary';
  private readonly thresholdRatio: number;
  private readonly keepRecent: number;
  private readonly now: () => number;
  private readonly randomSuffix: () => string;

  constructor(opts: DefaultSummaryCompactionOptions = {}) {
    const ratio = opts.thresholdRatio ?? 0.8;
    if (ratio <= 0 || ratio > 1) {
      throw new Error(
        `DefaultSummaryCompaction.thresholdRatio must be in (0, 1]; got ${ratio}`,
      );
    }
    const keepRecent = opts.keepRecent ?? 10;
    if (!Number.isFinite(keepRecent) || keepRecent < 0) {
      throw new Error(
        `DefaultSummaryCompaction.keepRecent must be >= 0; got ${keepRecent}`,
      );
    }
    this.thresholdRatio = ratio;
    this.keepRecent = keepRecent;
    this.now = opts.now ?? (() => Date.now());
    this.randomSuffix = opts.randomSuffix ?? (() => Math.random().toString(36).slice(2, 8));
  }

  shouldCompact(_session: Session, tokensUsed: number, budget: number): boolean {
    if (!Number.isFinite(tokensUsed) || !Number.isFinite(budget)) return false;
    if (budget <= 0) return false;
    return tokensUsed >= budget * this.thresholdRatio;
  }

  async compact(session: Session, ctx: CompactionContext): Promise<CompactionResult> {
    const messageEntries: MessageEntry[] = [];
    for await (const entry of session.entries()) {
      if (entry.type === 'message') {
        messageEntries.push(entry as MessageEntry);
      }
    }
    if (messageEntries.length <= this.keepRecent) {
      return { summary: '', replacedMessageEntryIds: [] };
    }
    const toCompact = messageEntries.slice(0, messageEntries.length - this.keepRecent);
    const messages: AgentMessage[] = toCompact.map((entry) => ({
      role: entry.payload.role,
      content: entry.payload.content,
    }));
    const summary = await ctx.summarize(messages);
    _compactionCounter += 1;
    const entry: CompactionEntry = {
      id: `compaction-${this.now()}-${_compactionCounter}-${this.randomSuffix()}`,
      ts: this.now(),
      type: 'compaction',
      payload: {
        summary,
        replacedMessageEntryIds: toCompact.map((e) => e.id),
      },
    };
    await session.append(entry);
    return {
      summary,
      replacedMessageEntryIds: toCompact.map((e) => e.id),
    };
  }
}
