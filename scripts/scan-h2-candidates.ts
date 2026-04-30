// FEATURE_107 P1.0 — scan ~/.kodax/sessions/ for "should-have-been-H2" candidates.
//
// Reads all session jsonl files (read-only), extracts harness verdict + heuristic
// signals, scores each H0_DIRECT session against "should-be-H2" criteria, and
// outputs structured candidates for human review at P1.5.
//
// Run: npx tsx scripts/scan-h2-candidates.ts
//
// DELETE WITH FEATURE_107 P6 cleanup.

import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SESSIONS_DIR = join(homedir(), '.kodax', 'sessions');
const OUT_DIR = resolve(
  SCRIPT_DIR,
  '..',
  'benchmark',
  'datasets',
  'h2-plan-execute-boundary',
);

const TARGET_GITROOTS = [
  'C:/Works/GitWorks/KodaX-author/KodaX',
  'C:/Works/GitWorks/KodaX',
];

const MULTI_FILE_KEYWORDS = [
  '多文件',
  '跨包',
  '跨模块',
  '重构',
  '重新设计',
  '重新组织',
  'refactor',
  'multi-file',
  'multiple files',
  'cross-package',
  'cross-module',
  'restructure',
  'redesign',
  '架构',
  'architecture',
];

const PLAN_LANGUAGE_KEYWORDS = [
  '计划',
  '步骤',
  '阶段',
  '分步',
  '先...再',
  '首先',
  '然后',
  'plan',
  'step',
  'phase',
  'first',
  'then',
  'finally',
  'design',
  '设计',
];

const HEURISTIC_THRESHOLDS = {
  promptLength: 200,
  fileEditCount: 3,
  toolCallCount: 5,
  minScore: 2,
};

interface SessionMeta {
  readonly id: string;
  readonly title: string;
  readonly gitRoot: string;
  readonly createdAt: string;
  readonly scope: string | undefined;
}

interface CandidateRecord {
  readonly sessionFile: string;
  readonly sessionId: string;
  readonly gitRoot: string;
  readonly createdAt: string;
  readonly title: string;
  readonly userPrompt: string;
  readonly harnessActual: string;
  readonly harnessRationale: string;
  readonly gitHeadSha: string | null;
  readonly gitDirty: boolean | null;
  readonly fileEditCount: number;
  readonly toolCallCount: number;
  readonly lineageEntryCount: number;
  readonly durationMinutes: number;
  readonly multiFileKeywordsMatched: readonly string[];
  readonly planKeywordsMatched: readonly string[];
  readonly score: number;
  readonly scoreBreakdown: {
    readonly multiFileKeyword: boolean;
    readonly fileEditThreshold: boolean;
    readonly promptLengthAndPlanLang: boolean;
    readonly toolCallThreshold: boolean;
  };
}

interface ScanSummary {
  readonly totalSessions: number;
  readonly parseFailures: number;
  readonly skippedNonTargetGitRoot: number;
  readonly h0DirectCount: number;
  readonly h1Count: number;
  readonly h2Count: number;
  readonly otherHarnessCount: number;
  readonly candidatesByScore: Record<number, number>;
  readonly candidatesAboveThreshold: number;
}

function parseJsonlLines(content: string): readonly unknown[] {
  return content
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((v): v is unknown => v !== null);
}

function extractMeta(records: readonly unknown[]): SessionMeta | null {
  for (const r of records) {
    if (typeof r !== 'object' || r === null) continue;
    const rec = r as Record<string, unknown>;
    if (rec._type === 'meta') {
      return {
        id: typeof rec.id === 'string' ? rec.id : 'unknown',
        title: typeof rec.title === 'string' ? rec.title : '',
        gitRoot: typeof rec.gitRoot === 'string' ? rec.gitRoot : '',
        createdAt: typeof rec.createdAt === 'string' ? rec.createdAt : '',
        scope: typeof rec.scope === 'string' ? rec.scope : undefined,
      };
    }
  }
  return null;
}

const HARNESS_VALUES = ['H0_DIRECT', 'H1_EXECUTE_EVAL', 'H2_PLAN_EXECUTE_EVAL'];

function extractHarness(content: string): { harness: string; rationale: string } {
  for (const h of HARNESS_VALUES) {
    if (content.includes(`"${h}"`)) {
      const rationaleMatch = content.match(/"harness_rationale":"([^"]*)"/);
      return {
        harness: h,
        rationale: rationaleMatch?.[1] ?? '',
      };
    }
  }
  return { harness: 'UNKNOWN', rationale: '' };
}

function extractGitInfo(
  content: string,
): { sha: string | null; dirty: boolean | null } {
  const shaMatch = content.match(/head=([0-9a-f]{8,40})/);
  const dirtyMatch = content.match(/dirty=(yes|no)/);
  return {
    sha: shaMatch?.[1] ?? null,
    dirty: dirtyMatch ? dirtyMatch[1] === 'yes' : null,
  };
}

function extractUserPrompt(records: readonly unknown[]): string {
  for (const r of records) {
    if (typeof r !== 'object' || r === null) continue;
    const rec = r as Record<string, unknown>;
    if (rec._type === 'meta') {
      const ui = rec.uiHistory;
      if (Array.isArray(ui)) {
        for (const item of ui) {
          if (
            typeof item === 'object' &&
            item !== null &&
            (item as Record<string, unknown>).type === 'user' &&
            typeof (item as Record<string, unknown>).text === 'string'
          ) {
            return (item as { text: string }).text;
          }
        }
      }
    }
    if (rec._type === 'lineage_entry') {
      const entry = rec.entry as Record<string, unknown> | undefined;
      const message = entry?.message as Record<string, unknown> | undefined;
      if (
        message?.role === 'user' &&
        typeof message.content === 'string'
      ) {
        return message.content;
      }
    }
  }
  return '';
}

function countUniqueFileEdits(content: string): number {
  const editCallPattern =
    /"name":"(edit|write|multi_edit)"[\s\S]{0,2000}?"path":"([^"]+)"/g;
  const paths = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = editCallPattern.exec(content)) !== null) {
    paths.add(m[2]);
  }
  return paths.size;
}

function countToolCalls(content: string): number {
  return (content.match(/"type":"tool_use"/g) ?? []).length;
}

function computeDurationMinutes(records: readonly unknown[]): number {
  const timestamps: Date[] = [];
  for (const r of records) {
    if (typeof r !== 'object' || r === null) continue;
    const rec = r as Record<string, unknown>;
    if (rec._type === 'lineage_entry') {
      const entry = rec.entry as Record<string, unknown> | undefined;
      const ts = entry?.timestamp;
      if (typeof ts === 'string') {
        const d = new Date(ts);
        if (!Number.isNaN(d.getTime())) timestamps.push(d);
      }
    }
  }
  if (timestamps.length < 2) return 0;
  timestamps.sort((a, b) => a.getTime() - b.getTime());
  const ms = timestamps[timestamps.length - 1].getTime() - timestamps[0].getTime();
  return Math.round((ms / 60000) * 10) / 10;
}

function findKeywordsIn(text: string, keywords: readonly string[]): readonly string[] {
  const lower = text.toLowerCase();
  return keywords.filter((kw) => lower.includes(kw.toLowerCase()));
}

function scoreCandidate(
  prompt: string,
  fileEditCount: number,
  toolCallCount: number,
  multiFileKw: readonly string[],
  planKw: readonly string[],
): { score: number; breakdown: CandidateRecord['scoreBreakdown'] } {
  const breakdown = {
    multiFileKeyword: multiFileKw.length > 0,
    fileEditThreshold: fileEditCount >= HEURISTIC_THRESHOLDS.fileEditCount,
    promptLengthAndPlanLang:
      prompt.length > HEURISTIC_THRESHOLDS.promptLength && planKw.length > 0,
    toolCallThreshold: toolCallCount >= HEURISTIC_THRESHOLDS.toolCallCount,
  };
  const score = Object.values(breakdown).filter(Boolean).length;
  return { score, breakdown };
}

function processSessionFile(filePath: string, fileName: string): {
  candidate: CandidateRecord | null;
  harness: string;
  inTargetGitRoot: boolean;
} {
  const content = readFileSync(filePath, 'utf-8');
  const records = parseJsonlLines(content);
  const meta = extractMeta(records);
  if (!meta) {
    return { candidate: null, harness: 'PARSE_FAIL', inTargetGitRoot: false };
  }
  const inTarget = TARGET_GITROOTS.some((g) =>
    meta.gitRoot.replace(/\\/g, '/').startsWith(g),
  );
  const { harness, rationale } = extractHarness(content);

  if (!inTarget || harness !== 'H0_DIRECT') {
    return { candidate: null, harness, inTargetGitRoot: inTarget };
  }

  const userPrompt = extractUserPrompt(records);
  const fileEditCount = countUniqueFileEdits(content);
  const toolCallCount = countToolCalls(content);
  const lineageEntryCount = records.filter(
    (r) =>
      typeof r === 'object' &&
      r !== null &&
      (r as Record<string, unknown>)._type === 'lineage_entry',
  ).length;
  const durationMinutes = computeDurationMinutes(records);
  const { sha, dirty } = extractGitInfo(content);

  const searchText = `${userPrompt} ${rationale}`;
  const multiFileKw = findKeywordsIn(searchText, MULTI_FILE_KEYWORDS);
  const planKw = findKeywordsIn(searchText, PLAN_LANGUAGE_KEYWORDS);

  const { score, breakdown } = scoreCandidate(
    userPrompt,
    fileEditCount,
    toolCallCount,
    multiFileKw,
    planKw,
  );

  if (score < HEURISTIC_THRESHOLDS.minScore) {
    return { candidate: null, harness, inTargetGitRoot: inTarget };
  }

  return {
    candidate: {
      sessionFile: fileName,
      sessionId: meta.id,
      gitRoot: meta.gitRoot,
      createdAt: meta.createdAt,
      title: meta.title.slice(0, 120),
      userPrompt: userPrompt.slice(0, 500),
      harnessActual: harness,
      harnessRationale: rationale,
      gitHeadSha: sha,
      gitDirty: dirty,
      fileEditCount,
      toolCallCount,
      lineageEntryCount,
      durationMinutes,
      multiFileKeywordsMatched: multiFileKw,
      planKeywordsMatched: planKw,
      score,
      scoreBreakdown: breakdown,
    },
    harness,
    inTargetGitRoot: inTarget,
  };
}

function buildSummary(
  total: number,
  parseFailures: number,
  skipped: number,
  harnessCounts: Record<string, number>,
  candidates: readonly CandidateRecord[],
): ScanSummary {
  const candidatesByScore: Record<number, number> = {};
  for (const c of candidates) {
    candidatesByScore[c.score] = (candidatesByScore[c.score] ?? 0) + 1;
  }
  return {
    totalSessions: total,
    parseFailures,
    skippedNonTargetGitRoot: skipped,
    h0DirectCount: harnessCounts.H0_DIRECT ?? 0,
    h1Count: harnessCounts.H1_EXECUTE_EVAL ?? 0,
    h2Count: harnessCounts.H2_PLAN_EXECUTE_EVAL ?? 0,
    otherHarnessCount:
      (harnessCounts.UNKNOWN ?? 0) + (harnessCounts.PARSE_FAIL ?? 0),
    candidatesByScore,
    candidatesAboveThreshold: candidates.length,
  };
}

function renderReport(
  summary: ScanSummary,
  candidates: readonly CandidateRecord[],
): string {
  const lines: string[] = [];
  lines.push('# H2 Plan-Execute Boundary Eval — Should-Have-Been-H2 Candidates');
  lines.push('');
  lines.push(
    '> FEATURE_107 P1.0 output. Generated by `scripts/scan-h2-candidates.ts`.',
  );
  lines.push('> Read-only scan of `~/.kodax/sessions/`. No production data touched.');
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Total sessions scanned: **${summary.totalSessions}**`);
  lines.push(`- Parse failures: ${summary.parseFailures}`);
  lines.push(`- Outside target gitRoot (skipped): ${summary.skippedNonTargetGitRoot}`);
  lines.push('');
  lines.push('### Harness verdict distribution (target gitRoots only)');
  lines.push('');
  lines.push('| Harness | Count |');
  lines.push('|---|---|');
  lines.push(`| H0_DIRECT | ${summary.h0DirectCount} |`);
  lines.push(`| H1_EXECUTE_EVAL | ${summary.h1Count} |`);
  lines.push(`| H2_PLAN_EXECUTE_EVAL | ${summary.h2Count} |`);
  lines.push(`| Other / unknown | ${summary.otherHarnessCount} |`);
  lines.push('');
  lines.push(
    `**Real H2 sessions: ${summary.h2Count}**. Confirms FEATURE_107 telemetry pivot rationale.`,
  );
  lines.push('');
  lines.push('### Should-be-H2 candidates by heuristic score');
  lines.push('');
  lines.push('| Score | Count |');
  lines.push('|---|---|');
  for (let s = 4; s >= HEURISTIC_THRESHOLDS.minScore; s--) {
    lines.push(`| ${s}/4 | ${summary.candidatesByScore[s] ?? 0} |`);
  }
  lines.push('');
  lines.push(`Total above threshold (score ≥ ${HEURISTIC_THRESHOLDS.minScore}): **${summary.candidatesAboveThreshold}**`);
  lines.push('');
  lines.push('## Candidates (sorted by score desc)');
  lines.push('');
  lines.push(
    '| Rank | Score | Session | git head | dirty | files | tools | dur(min) | Title preview |',
  );
  lines.push('|---|---|---|---|---|---|---|---|---|');
  candidates.forEach((c, i) => {
    const sha = c.gitHeadSha ? c.gitHeadSha.slice(0, 8) : 'n/a';
    const dirty = c.gitDirty === null ? 'n/a' : c.gitDirty ? 'yes' : 'no';
    const titlePreview = c.title.slice(0, 60).replace(/\|/g, '\\|').replace(/\n/g, ' ');
    lines.push(
      `| ${i + 1} | ${c.score}/4 | \`${c.sessionFile}\` | \`${sha}\` | ${dirty} | ${c.fileEditCount} | ${c.toolCallCount} | ${c.durationMinutes} | ${titlePreview} |`,
    );
  });
  lines.push('');
  lines.push('## Next steps (P1.5)');
  lines.push('');
  lines.push(
    '1. Human review of `candidates.jsonl` — confirm each candidate is genuinely H2-class',
  );
  lines.push('2. Verify each `gitHeadSha` exists: `git cat-file -e <sha>`');
  lines.push('3. Pick 15–18 confirmed cases; supplement with hand-curated to reach 25–30 total');
  lines.push('4. Author golden signals (must_touch_files / must_not_touch / acceptance_criteria)');
  lines.push('5. Final dataset committed to `cases.ts` in this directory');
  return lines.join('\n');
}

function main(): void {
  const files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.jsonl'));
  const candidates: CandidateRecord[] = [];
  const harnessCounts: Record<string, number> = {};
  let parseFailures = 0;
  let skipped = 0;

  for (const fileName of files) {
    const filePath = join(SESSIONS_DIR, fileName);
    try {
      const result = processSessionFile(filePath, fileName);
      if (result.harness === 'PARSE_FAIL') {
        parseFailures++;
        continue;
      }
      if (!result.inTargetGitRoot) {
        skipped++;
        continue;
      }
      harnessCounts[result.harness] = (harnessCounts[result.harness] ?? 0) + 1;
      if (result.candidate) candidates.push(result.candidate);
    } catch (err) {
      parseFailures++;
      process.stderr.write(`error processing ${fileName}: ${String(err)}\n`);
    }
  }

  candidates.sort((a, b) => b.score - a.score || b.fileEditCount - a.fileEditCount);

  const summary = buildSummary(
    files.length,
    parseFailures,
    skipped,
    harnessCounts,
    candidates,
  );

  mkdirSync(OUT_DIR, { recursive: true });
  const candidatesJsonl = candidates.map((c) => JSON.stringify(c)).join('\n') + '\n';
  writeFileSync(join(OUT_DIR, 'candidates.jsonl'), candidatesJsonl, 'utf-8');
  writeFileSync(join(OUT_DIR, 'candidates-report.md'), renderReport(summary, candidates), 'utf-8');
  writeFileSync(
    join(OUT_DIR, 'scan-summary.json'),
    JSON.stringify(summary, null, 2),
    'utf-8',
  );

  process.stdout.write(
    `Scanned ${summary.totalSessions} sessions; ` +
      `${summary.h0DirectCount} H0_DIRECT in target gitRoots; ` +
      `${summary.candidatesAboveThreshold} candidates (score ≥ ${HEURISTIC_THRESHOLDS.minScore}).\n` +
      `Output: ${OUT_DIR}\n`,
  );
}

main();
