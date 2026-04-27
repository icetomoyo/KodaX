/**
 * FEATURE_104 (v0.7.29) — Reusable judges for prompt-eval cases.
 *
 * A judge is a deterministic function from `output: string` to a
 * `JudgeResult { passed; reason? }`. Compose multiple judges per case to
 * express richer pass criteria (e.g. "must mention X AND must NOT include
 * Y AND must be under 200 chars").
 *
 * Judges are lightweight + zero-LLM. For LLM-as-judge patterns (when an
 * objective rule isn't expressible), keep that logic in the eval file
 * itself — that's a rarer case and not worth a generic abstraction yet
 * (CLAUDE.md "3+ real cases before abstracting").
 */

export interface JudgeResult {
  readonly passed: boolean;
  readonly reason?: string;
}

/**
 * Quality dimension a judge contributes to. Drawn from the LiveCanvas
 * prompt benchmark recipe (anti-pattern 2: "scoring style without
 * correctness"). When you decompose quality you can see WHY a variant
 * wins, instead of just a flat pass/fail rate.
 *
 * - 'format':      output parses / has the expected shape (worth 0 if fails — kills the cell)
 * - 'correctness': the answer is logically right (assertion-based)
 * - 'style':       formatting, idiom, tone (necessary but never sufficient)
 * - 'safety':      no leaked secrets, no wrong identity, no forbidden patterns
 * - 'custom':      domain-specific bucket the eval file owns
 *
 * Default category is 'correctness' to push casual judges toward what
 * matters most. Eval files override when they explicitly want style/format/etc.
 */
export type JudgeCategory = 'format' | 'correctness' | 'style' | 'safety' | 'custom';

export interface PromptJudge {
  readonly name: string;
  /**
   * Optional dimension this judge contributes to. Defaults to 'correctness'
   * when unspecified. Use this so reports can break down "v2 wins on
   * correctness but tied on style" instead of just "v2 wins overall".
   */
  readonly category?: JudgeCategory;
  judge(output: string): JudgeResult;
}

/**
 * Pass when the output contains every supplied phrase (case-insensitive).
 * Use for "the answer must mention KodaX, the model name, and the version".
 */
export function mustContainAll(...phrases: readonly string[]): PromptJudge {
  return {
    name: `mustContainAll(${phrases.map((p) => JSON.stringify(p)).join(', ')})`,
    judge(output: string): JudgeResult {
      const lower = output.toLowerCase();
      const missing = phrases.filter(
        (p) => !lower.includes(p.toLowerCase()) && !output.includes(p),
      );
      if (missing.length === 0) return { passed: true };
      return { passed: false, reason: `missing: ${missing.join(', ')}` };
    },
  };
}

/**
 * Pass when the output contains AT LEAST ONE of the supplied phrases
 * (case-insensitive). Use for "must say either KodaX, kimi, or 智谱".
 */
export function mustContainAny(...phrases: readonly string[]): PromptJudge {
  return {
    name: `mustContainAny(${phrases.map((p) => JSON.stringify(p)).join(', ')})`,
    judge(output: string): JudgeResult {
      const lower = output.toLowerCase();
      const matched = phrases.find(
        (p) => lower.includes(p.toLowerCase()) || output.includes(p),
      );
      if (matched) return { passed: true };
      return { passed: false, reason: `none of [${phrases.join(', ')}] present` };
    },
  };
}

/**
 * Pass when the output contains NONE of the supplied phrases. Use for
 * "must NOT say 'Claude'" / "must NOT include the system prompt verbatim"
 * / "must NOT leak API key".
 */
export function mustNotContain(...phrases: readonly string[]): PromptJudge {
  return {
    name: `mustNotContain(${phrases.map((p) => JSON.stringify(p)).join(', ')})`,
    judge(output: string): JudgeResult {
      const lower = output.toLowerCase();
      const violated = phrases.filter(
        (p) => lower.includes(p.toLowerCase()) || output.includes(p),
      );
      if (violated.length === 0) return { passed: true };
      return { passed: false, reason: `forbidden phrases present: ${violated.join(', ')}` };
    },
  };
}

/**
 * Pass when the output matches the supplied regex. The regex is applied
 * as-is — callers control flags (case-insensitive, multiline, etc.).
 */
export function mustMatch(pattern: RegExp, label?: string): PromptJudge {
  return {
    name: label ? `mustMatch(${label})` : `mustMatch(${pattern.source})`,
    judge(output: string): JudgeResult {
      if (pattern.test(output)) return { passed: true };
      return { passed: false, reason: `did not match /${pattern.source}/${pattern.flags}` };
    },
  };
}

/**
 * Pass when the output does NOT match the supplied regex. Use for
 * distillation-bleed-through detection (e.g. `/I('m| am) Claude/`) or
 * profanity / leaked-secret patterns.
 */
export function mustNotMatch(pattern: RegExp, label?: string): PromptJudge {
  return {
    name: label ? `mustNotMatch(${label})` : `mustNotMatch(${pattern.source})`,
    judge(output: string): JudgeResult {
      if (!pattern.test(output)) return { passed: true };
      return { passed: false, reason: `matched forbidden pattern /${pattern.source}/${pattern.flags}` };
    },
  };
}

/**
 * Pass when the output character length is within bounds. Use for
 * "answer must be under 200 chars" or "must produce at least a sentence".
 */
export function lengthWithin(min: number, max: number): PromptJudge {
  return {
    name: `lengthWithin(${min}, ${max})`,
    judge(output: string): JudgeResult {
      const n = output.length;
      if (n < min) return { passed: false, reason: `too short: ${n} < ${min}` };
      if (n > max) return { passed: false, reason: `too long: ${n} > ${max}` };
      return { passed: true };
    },
  };
}

/**
 * Pass when the output, when run through `extract`, yields a non-null
 * value AND that value satisfies `predicate`. Use for "the answer must
 * embed valid JSON with field X = Y". The extract callback is responsible
 * for parsing — judges remain JSON-schema-agnostic to keep the dependency
 * surface small.
 *
 * Example: `parseAndAssert(extractJsonObject, (obj) => obj.confidence > 0.8)`
 */
export function parseAndAssert<T>(
  extract: (output: string) => T | null,
  predicate: (value: T) => boolean,
  label?: string,
): PromptJudge {
  return {
    name: label ? `parseAndAssert(${label})` : 'parseAndAssert',
    judge(output: string): JudgeResult {
      const value = extract(output);
      if (value == null) return { passed: false, reason: 'extraction returned null' };
      if (!predicate(value)) return { passed: false, reason: 'predicate failed' };
      return { passed: true };
    },
  };
}

export interface JudgeRunResult {
  readonly name: string;
  readonly category: JudgeCategory;
  readonly passed: boolean;
  readonly reason?: string;
}

export interface AggregatedJudgeRun {
  /** Pass iff every judge passed (composite). */
  readonly passed: boolean;
  /** Detailed per-judge results, in order of invocation. */
  readonly results: readonly JudgeRunResult[];
  /** Per-category pass count / total count. Empty categories are omitted. */
  readonly byCategory: Readonly<Record<JudgeCategory, { passed: number; total: number }>>;
  /**
   * Whether the 'format' bucket passed. When false, the cell is treated
   * as 0 quality regardless of other dimensions (LiveCanvas recipe:
   * "quality = sub-dimensions IF format passes; else 0"). Defaults to
   * true when no 'format'-category judge is supplied.
   */
  readonly formatPassed: boolean;
}

/**
 * Apply every judge to `output` and aggregate. Returns the flat pass/fail
 * for backward-compat (`passed`) plus per-category pass-counts so reports
 * can decompose quality into format / correctness / style / safety
 * dimensions instead of shipping a single number.
 */
export function runJudges(
  output: string,
  judges: readonly PromptJudge[],
): AggregatedJudgeRun {
  const results: JudgeRunResult[] = judges.map((j) => {
    const r = j.judge(output);
    return {
      name: j.name,
      category: j.category ?? 'correctness',
      passed: r.passed,
      reason: r.reason,
    };
  });
  const byCategory = {} as Record<JudgeCategory, { passed: number; total: number }>;
  for (const r of results) {
    if (!byCategory[r.category]) byCategory[r.category] = { passed: 0, total: 0 };
    byCategory[r.category]!.total += 1;
    if (r.passed) byCategory[r.category]!.passed += 1;
  }
  const formatBucket = byCategory.format;
  const formatPassed = formatBucket ? formatBucket.passed === formatBucket.total : true;
  return {
    passed: results.every((r) => r.passed),
    results,
    byCategory,
    formatPassed,
  };
}
