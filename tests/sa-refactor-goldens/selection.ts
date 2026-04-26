/**
 * SA Refactor Goldens — Stratified Session Selection
 *
 * Companion: `tests/sa-refactor-goldens/record.ts` (DEFAULT_SELECTION criteria)
 *            `tests/sa-refactor-goldens/session-parser.ts` (RawSession shape)
 *
 * Two responsibilities:
 *
 *   1. Implement the 7 edge-case detectors that DEFAULT_SELECTION declares.
 *      Each detector is best-effort against the on-disk session log shape —
 *      they look at the parsed `RawSession` and return true/false based on
 *      stable signals (multimodal block presence, tool_result is_error,
 *      synthesized recovery user-message text, etc.).
 *
 *   2. Apply the stratified-sampling algorithm:
 *
 *        (a) length buckets (short / medium / long) by `turnCount`
 *        (b) per-task-family minimums (heuristic classification from the
 *            initial prompt text)
 *        (c) mandatory-capability coverage — every detector must match at
 *            least one selected session, OR be reported as uncovered
 *
 *      Output is a `SelectionReport` listing the chosen session ids plus
 *      diagnostic counts (which buckets are under-covered, which detectors
 *      have zero hits across the whole corpus, etc.).
 */

import type { RawSession } from './session-parser.js';

// ---------------------------------------------------------------------------
// Task-family classification — drives the per-family minimum-coverage rule
// ---------------------------------------------------------------------------

export type TaskFamily =
  | 'review'
  | 'lookup'
  | 'planning'
  | 'investigation'
  | 'implementation'
  | 'conversation'
  | 'unknown';

/**
 * Heuristic classifier from the initial prompt text. Best-effort — we lean on
 * obvious surface markers (verbs, question marks, "review"/"plan"/"why" etc.)
 * because there is no labelled corpus.
 *
 * Wrong classification → at worst, length-bucket coverage takes over and we
 * still ship a representative sample. The classifier is tunable; treat
 * mis-classification as low-stakes.
 */
export function classifyTaskFamily(promptText: string): TaskFamily {
  const t = promptText.trim().toLowerCase();
  if (!t) return 'unknown';

  // Note: `\b` is ASCII-only in JS regex; Chinese keywords match without it.
  // Order matters — earlier patterns win on overlap (e.g. "为什么" → investigation
  // even though the prompt also ends in "？" which would match lookup).
  if (/\breview\b|审查|审核|review一下|帮我review|检查一下/i.test(t)) return 'review';
  if (/\bplan\b|\bdesign\b|计划|怎么做|思路|如何实现|规划/i.test(t)) return 'planning';
  if (/\bwhy\b|\bdebug\b|\binvestigate\b|为什么|为啥|分析|排查|根因|是什么原因/i.test(t)) return 'investigation';
  if (/\b(implement|add|fix|change|refactor|migrate)\b|实现|重构|改一下|加一下/i.test(t)) return 'implementation';
  if (/\?$|？$|\bwhere\b|\bhow\b|\bwhat\b|哪里|怎么|什么|介绍|有没有/i.test(t)) return 'lookup';

  return 'conversation';
}

// ---------------------------------------------------------------------------
// Length bucketing
// ---------------------------------------------------------------------------

export type LengthBucket = 'short' | 'medium' | 'long';

export function bucketByLength(turnCount: number): LengthBucket {
  if (turnCount <= 2) return 'short';
  if (turnCount <= 7) return 'medium';
  return 'long';
}

// ---------------------------------------------------------------------------
// Edge-case detectors — wired against the parsed RawSession metadata
// ---------------------------------------------------------------------------

export const EDGE_CASE_DETECTORS = {
  /** CAP-015 — synthesized edit-recovery user message present. */
  editRecovery: (s: RawSession): boolean => s.metadata.hasEditRecoveryMessage,
  /** CAP-009 — multimodal image block present in any message content. */
  multimodalImage: (s: RawSession): boolean => s.metadata.hasImageBlock,
  /** CAP-008 — heuristic: meta has `resumedFrom`, OR session has a system message
   *  followed immediately by a non-empty assistant message before any user input
   *  (initialMessages seed). The on-disk shape doesn't carry an explicit flag. */
  sessionResume: (s: RawSession): boolean => {
    if (s.meta && (s.meta as Record<string, unknown>).resumedFrom) return true;
    const first = s.messages[0];
    const second = s.messages[1];
    return Boolean(
      first?.role === 'system' && second?.role === 'assistant',
    );
  },
  /** CAP-007 — rate-limit retry events are emitted via `onRateLimit` callback
   *  + `console.log`; the on-disk session log does NOT capture either. The
   *  only reliable signal is the specific terminal error from
   *  `KodaXRateLimitError`, which surfaces when retries exhaust and the
   *  error message reaches a tool_result or assistant message.
   *  Loose patterns like /rate.?limit/i fire on JS symbols inside pasted code
   *  ("rateLimitedCall", "RateLimiter") and produce 225/504 false positives
   *  in a sample run — see commit history of this file.
   *  Limitation: most rate-limit events are NOT recoverable from session logs. */
  rateLimit: (s: RawSession): boolean => {
    for (const m of s.messages) {
      const text = extractFlatText(m.content);
      if (/API rate limit exceeded after \d+ retries/.test(text)) return true;
    }
    return false;
  },
  /** CAP-019 — auto-reroute fired. The on-disk log doesn't record the event
   *  directly, but the `_synthetic` flag on user messages is the closest
   *  observable proxy (auto-reroute pops + re-injects the last user message). */
  autoReroute: (s: RawSession): boolean => {
    return s.messages.some((m) => m.role === 'user' && m._synthetic === true);
  },
  /** CAP-020 — extension queue drain emitted a synthetic user message at the
   *  tail of the active path. Same proxy as autoReroute but tail-only — both
   *  may be true together. */
  extensionQueue: (s: RawSession): boolean => s.metadata.hasSyntheticTail,
  /** CAP-013 — terminal exited via error. Heuristic: any tool_result with
   *  is_error AND the session's last assistant message is empty / very short
   *  (suggesting we never recovered before the run ended). */
  errorSnapshot: (s: RawSession): boolean => {
    if (!s.metadata.hasToolError) return false;
    const lastAssistant = [...s.messages].reverse().find((m) => m.role === 'assistant');
    if (!lastAssistant) return true;
    const text = typeof lastAssistant.content === 'string'
      ? lastAssistant.content
      : lastAssistant.content
          .filter((b) => (b as { type?: string }).type === 'text')
          .map((b) => (b as { text?: string }).text ?? '')
          .join('\n');
    return text.trim().length < 50;
  },
} as const;

export type DetectorName = keyof typeof EDGE_CASE_DETECTORS;

// ---------------------------------------------------------------------------
// Selection algorithm
// ---------------------------------------------------------------------------

export interface SelectionOptions {
  perBucket: { short: number; medium: number; long: number };
  perFamilyMin: number;
  maxTotal: number;
}

export const DEFAULT_OPTIONS: SelectionOptions = {
  perBucket: { short: 8, medium: 15, long: 8 },
  perFamilyMin: 5,
  maxTotal: 50,
};

export interface SelectedSession {
  sessionId: string;
  filePath: string;
  bucket: LengthBucket;
  family: TaskFamily;
  matchedDetectors: DetectorName[];
}

export interface SelectionReport {
  selected: SelectedSession[];
  totalCandidates: number;
  bucketCoverage: Record<LengthBucket, number>;
  familyCoverage: Record<TaskFamily, number>;
  detectorCoverage: Record<DetectorName, { totalInCorpus: number; selected: number }>;
  warnings: string[];
}

/**
 * Apply stratified sampling. Pure function — does not touch disk.
 *
 * Order of operations:
 *   1. For each detector with `totalInCorpus > 0`, force-pick one session that
 *      matches it (mandatory-capability coverage). Prefer matches that are
 *      already in an under-filled bucket.
 *   2. Fill length buckets up to `perBucket` quotas.
 *   3. Top up to `perFamilyMin` per task family.
 *   4. If we exceed `maxTotal`, keep mandatory-coverage picks and trim the
 *      rest from the over-represented bucket.
 *   5. Emit `warnings` for under-covered buckets / families / detectors.
 */
export function selectSessions(
  candidates: RawSession[],
  options: SelectionOptions = DEFAULT_OPTIONS,
): SelectionReport {
  const annotated = candidates.map((s) => ({
    session: s,
    bucket: bucketByLength(s.metadata.turnCount),
    family: classifyTaskFamily(s.metadata.initialPromptText),
    detectors: detectorsThatMatch(s),
  }));

  const detectorCoverage = initDetectorCoverage();
  for (const a of annotated) {
    for (const d of a.detectors) {
      detectorCoverage[d].totalInCorpus += 1;
    }
  }

  const picked = new Set<string>();
  const selected: SelectedSession[] = [];
  const warnings: string[] = [];

  function pick(annotation: typeof annotated[number], reason: string): void {
    if (picked.has(annotation.session.sessionId)) return;
    picked.add(annotation.session.sessionId);
    selected.push({
      sessionId: annotation.session.sessionId,
      filePath: annotation.session.filePath,
      bucket: annotation.bucket,
      family: annotation.family,
      matchedDetectors: annotation.detectors,
    });
    for (const d of annotation.detectors) {
      detectorCoverage[d].selected += 1;
    }
    void reason;
  }

  // Step 1: mandatory-capability coverage. For each detector with hits,
  // pick the session that matches the most under-covered detectors first
  // (to avoid wasting picks on sessions that only cover one thing).
  for (const detector of Object.keys(EDGE_CASE_DETECTORS) as DetectorName[]) {
    if (detectorCoverage[detector].totalInCorpus === 0) {
      warnings.push(`detector "${detector}" has 0 matches in the corpus — cannot satisfy mandatory coverage`);
      continue;
    }
    if (detectorCoverage[detector].selected > 0) continue;
    const bestMatch = annotated
      .filter((a) => a.detectors.includes(detector) && !picked.has(a.session.sessionId))
      .sort((a, b) => b.detectors.length - a.detectors.length)[0];
    if (bestMatch) pick(bestMatch, `mandatory:${detector}`);
  }

  // Step 2: fill bucket quotas.
  const bucketCounts: Record<LengthBucket, number> = { short: 0, medium: 0, long: 0 };
  for (const s of selected) bucketCounts[s.bucket] += 1;

  for (const bucket of ['short', 'medium', 'long'] as const) {
    const quota = options.perBucket[bucket];
    while (bucketCounts[bucket] < quota) {
      const next = annotated.find(
        (a) => a.bucket === bucket && !picked.has(a.session.sessionId),
      );
      if (!next) {
        warnings.push(
          `bucket "${bucket}" has only ${bucketCounts[bucket]}/${quota} sessions available`,
        );
        break;
      }
      pick(next, `bucket:${bucket}`);
      bucketCounts[bucket] += 1;
    }
  }

  // Step 3: top up per-family minimums.
  const familyCounts: Record<TaskFamily, number> = {
    review: 0, lookup: 0, planning: 0, investigation: 0,
    implementation: 0, conversation: 0, unknown: 0,
  };
  for (const s of selected) familyCounts[s.family] += 1;

  for (const family of Object.keys(familyCounts) as TaskFamily[]) {
    if (family === 'unknown') continue;
    while (familyCounts[family] < options.perFamilyMin) {
      const next = annotated.find(
        (a) => a.family === family && !picked.has(a.session.sessionId),
      );
      if (!next) {
        const corpusFamilyCount = annotated.filter((a) => a.family === family).length;
        if (corpusFamilyCount < options.perFamilyMin) {
          warnings.push(
            `family "${family}" has only ${corpusFamilyCount} sessions in corpus (target ${options.perFamilyMin})`,
          );
        }
        break;
      }
      pick(next, `family:${family}`);
      familyCounts[family] += 1;
    }
  }

  // Step 4: cap at maxTotal. Trim from over-represented buckets, preserve
  // mandatory-coverage picks (always at the front of `selected`).
  if (selected.length > options.maxTotal) {
    warnings.push(
      `selection exceeded maxTotal (${selected.length} > ${options.maxTotal}); trimming from largest bucket`,
    );
    // Mandatory-coverage picks come first because Step 1 ran first; keep them.
    const mandatoryCount = countMandatoryPicks(detectorCoverage);
    const trimFrom = selected.slice(mandatoryCount);
    trimFrom.sort((a, b) => bucketSize(b.bucket, selected) - bucketSize(a.bucket, selected));
    while (selected.length > options.maxTotal && trimFrom.length > 0) {
      const victim = trimFrom.pop()!;
      const idx = selected.findIndex((s) => s.sessionId === victim.sessionId);
      if (idx >= 0) selected.splice(idx, 1);
    }
  }

  return {
    selected,
    totalCandidates: candidates.length,
    bucketCoverage: countBuckets(selected),
    familyCoverage: countFamilies(selected),
    detectorCoverage,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Flatten message content (string OR block array) into a single text blob
 *  for pattern matching. Includes text + tool_result content, drops
 *  tool_use input (which contains code/data and would produce false positives). */
function extractFlatText(content: import('@kodax/ai').KodaXMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map((b) => {
      const t = (b as { type?: string }).type;
      if (t === 'text') return (b as { text?: string }).text ?? '';
      if (t === 'tool_result') return (b as { content?: string }).content ?? '';
      return '';
    })
    .join('\n');
}

function detectorsThatMatch(session: RawSession): DetectorName[] {
  const matched: DetectorName[] = [];
  for (const [name, fn] of Object.entries(EDGE_CASE_DETECTORS)) {
    if (fn(session)) matched.push(name as DetectorName);
  }
  return matched;
}

function initDetectorCoverage(): SelectionReport['detectorCoverage'] {
  const out: Partial<SelectionReport['detectorCoverage']> = {};
  for (const name of Object.keys(EDGE_CASE_DETECTORS) as DetectorName[]) {
    out[name] = { totalInCorpus: 0, selected: 0 };
  }
  return out as SelectionReport['detectorCoverage'];
}

function countBuckets(selected: SelectedSession[]): Record<LengthBucket, number> {
  const out: Record<LengthBucket, number> = { short: 0, medium: 0, long: 0 };
  for (const s of selected) out[s.bucket] += 1;
  return out;
}

function countFamilies(selected: SelectedSession[]): Record<TaskFamily, number> {
  const out: Record<TaskFamily, number> = {
    review: 0, lookup: 0, planning: 0, investigation: 0,
    implementation: 0, conversation: 0, unknown: 0,
  };
  for (const s of selected) out[s.family] += 1;
  return out;
}

function bucketSize(bucket: LengthBucket, selected: SelectedSession[]): number {
  return selected.filter((s) => s.bucket === bucket).length;
}

function countMandatoryPicks(coverage: SelectionReport['detectorCoverage']): number {
  let n = 0;
  for (const c of Object.values(coverage)) {
    if (c.totalInCorpus > 0) n += 1;
  }
  return n;
}
