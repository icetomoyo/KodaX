/**
 * FEATURE_104 v2 — Markdown REPORT.md generator for `BenchmarkResult`.
 *
 * The report is the single source of truth a human reads after a bench
 * run. Section structure adapted from the LiveCanvas prompt benchmark
 * recipe, with one KodaX-specific deviation: **quality is the only
 * scoring metric**. Latency is reported but not scored — for a coding
 * agent, a slow correct answer beats a fast wrong one.
 *
 *   1. Run summary             (cells, runs, format pass rate, wall-clock)
 *   2. Methodology             (scoring formula = quality only)
 *   3. Score matrix            (cells × variants, quality + per-category)
 *   4. Quality sub-dimensions  (per-category breakdown)
 *   5. Latency observed        (informational only, not scored)
 *   6. Variance                (pass-rate std-dev — flags noisy providers)
 *   7. Variant ranking         (quality, with statistical-significance note)
 *   8. Assertion failure patterns (what specifically failed, sorted by frequency)
 *   9. Reproduction commands
 *
 * No external deps — string assembly only. The eval file or runner CLI
 * decides whether to write the result to disk (see `./persist.ts`).
 */

import type {
  BenchmarkCellSummary,
  BenchmarkResult,
  DurationStats,
} from './harness.js';
import type { JudgeCategory } from './judges.js';

const SIGNIFICANCE_NOTE_PROSE =
  'Two cells within 3 quality points are statistically indistinguishable at n≤5. ' +
  'Bump runs to ≥5 on contested rows for decision-grade comparisons.';

function fmtPct(n: number, decimals = 1): string {
  if (Number.isNaN(n)) return 'n/a';
  return `${n.toFixed(decimals)}`;
}

function fmtMs(ms: number): string {
  if (ms <= 0) return '-';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtDuration(d: DurationStats): string {
  if (d.max === 0) return 'no completed runs';
  return `min=${fmtMs(d.min)} med=${fmtMs(d.median)} mean=${fmtMs(d.mean)} p95=${fmtMs(d.p95)} max=${fmtMs(d.max)}`;
}

function renderSection1Summary(r: BenchmarkResult): string {
  const totalCells = r.cells.length;
  const totalRuns = totalCells * r.config.runs;
  const completedRuns = r.cells.reduce((s, c) => s + c.completed, 0);
  const passedRuns = r.cells.reduce(
    (s, c) => s + Math.round((c.passRate / 100) * r.config.runs),
    0,
  );
  const formatTotal = r.cells.reduce((s, c) => s + (c.byCategory.format?.total ?? 0), 0);
  const formatPassed = r.cells.reduce((s, c) => s + (c.byCategory.format?.passed ?? 0), 0);
  const formatRate = formatTotal === 0 ? 100 : (formatPassed / formatTotal) * 100;

  return [
    '## 1. Run summary',
    '',
    `- Started: \`${r.startedAt}\``,
    `- Variants: ${r.variants.length} — ${r.variants.map((v) => `\`${v.id}\``).join(', ')}`,
    `- Models: ${r.models.length} — ${r.models.map((m) => `\`${m}\``).join(', ')}`,
    `- Cells: ${totalCells} (variants × models)`,
    `- Runs: ${totalRuns} total (${r.config.runs} per cell)`,
    `- Completed: ${completedRuns}/${totalRuns} (${fmtPct((completedRuns / Math.max(1, totalRuns)) * 100)}%)`,
    `- Passed: ${passedRuns}/${totalRuns} (${fmtPct((passedRuns / Math.max(1, totalRuns)) * 100)}%)`,
    formatTotal > 0
      ? `- Format pass rate: ${formatPassed}/${formatTotal} (${fmtPct(formatRate)}%)`
      : '- Format pass rate: (no format-category judges)',
    `- Wall-clock: ${r.totalSeconds.toFixed(1)}s`,
  ].join('\n');
}

function renderSection2Methodology(_r: BenchmarkResult): string {
  return [
    '## 2. Methodology',
    '',
    '- **Quality is the only scoring metric.** KodaX is a coding agent —',
    '  a slow correct answer is strictly better than a fast wrong one,',
    '  so latency does not feed into rank. (Multi-dimensional scoring',
    '  that combines quality and latency makes sense for interactive UIs',
    '  where the user waits; not here.)',
    '- **Quality**: per-cell pass rate across runs, gated by format —',
    '  if format-category judges fail, quality is multiplied by the format pass rate.',
    '- **Variance**: std-dev of per-run pass-or-fail (0/1) × 100. >20 means noisy.',
    '- **Categories**: judges declare `format` / `correctness` / `style` / `safety` / `custom`.',
    '  Aggregating per category lets you see WHY a variant wins, not just THAT it wins.',
    '- **Latency**: tracked per run (§5) for diagnostics only — outliers',
    '  (e.g. a provider hanging for 10 minutes) are still worth noticing,',
    '  but they do not affect ranking.',
  ].join('\n');
}

function renderSection3ScoreMatrix(r: BenchmarkResult): string {
  const headers = ['model', ...r.variants.map((v) => v.id)];
  const lines: string[] = [];
  lines.push(`## 3. Score matrix (quality 0-100, higher = better)`);
  lines.push('');
  lines.push(`| ${headers.join(' | ')} |`);
  lines.push(`| ${headers.map(() => '---').join(' | ')} |`);
  for (const m of r.models) {
    const row: string[] = [`\`${m}\``];
    for (const variant of r.variants) {
      const cell = r.cells.find((c) => c.variantId === variant.id && c.alias === m);
      if (!cell) {
        row.push('-');
        continue;
      }
      row.push(`**${fmtPct(cell.quality)}** (pass=${fmtPct(cell.passRate)}, ±${fmtPct(cell.passRateStdDev)})`);
    }
    lines.push(`| ${row.join(' | ')} |`);
  }
  return lines.join('\n');
}

function renderSection4SubDimensions(r: BenchmarkResult): string {
  const allCategories = new Set<JudgeCategory>();
  for (const c of r.cells) {
    for (const cat of Object.keys(c.qualityByCategory)) allCategories.add(cat as JudgeCategory);
  }
  if (allCategories.size === 0) {
    return ['## 4. Quality sub-dimensions', '', '_(no category-tagged judges; nothing to decompose)_'].join('\n');
  }
  const cats = Array.from(allCategories).sort() as JudgeCategory[];
  const lines: string[] = [];
  lines.push('## 4. Quality sub-dimensions (per-cell category pass rate %)');
  lines.push('');
  for (const variant of r.variants) {
    lines.push(`### Variant \`${variant.id}\``);
    lines.push('');
    const headers = ['model', ...cats];
    lines.push(`| ${headers.join(' | ')} |`);
    lines.push(`| ${headers.map(() => '---').join(' | ')} |`);
    for (const m of r.models) {
      const cell = r.cells.find((c) => c.variantId === variant.id && c.alias === m);
      const row = [`\`${m}\``];
      for (const cat of cats) {
        if (!cell || !cell.byCategory[cat]) {
          row.push('-');
          continue;
        }
        const counts = cell.byCategory[cat];
        row.push(`${fmtPct(cell.qualityByCategory[cat])} (${counts.passed}/${counts.total})`);
      }
      lines.push(`| ${row.join(' | ')} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function renderSection5Time(r: BenchmarkResult): string {
  const lines: string[] = [];
  lines.push('## 5. Latency observed (informational only — not part of scoring)');
  lines.push('');
  lines.push('_Reported for diagnostics: outlier providers (e.g. one hanging for minutes) are worth noticing. Does not affect rank or quality._');
  lines.push('');
  lines.push('| variant | model | duration |');
  lines.push('| --- | --- | --- |');
  for (const cell of r.cells) {
    lines.push(`| \`${cell.variantId}\` | \`${cell.alias}\` | ${fmtDuration(cell.duration)} |`);
  }
  return lines.join('\n');
}

function renderSection6Variance(r: BenchmarkResult): string {
  const lines: string[] = [];
  lines.push('## 6. Variance (pass-rate std-dev across runs)');
  lines.push('');
  lines.push('| variant | model | pass rate | std-dev | runs |');
  lines.push('| --- | --- | --- | --- | --- |');
  const sortedByVariance = [...r.cells].sort((a, b) => b.passRateStdDev - a.passRateStdDev);
  for (const cell of sortedByVariance) {
    const flag = cell.passRateStdDev > 20 ? ' ⚠️' : '';
    lines.push(
      `| \`${cell.variantId}\` | \`${cell.alias}\` | ${fmtPct(cell.passRate)}% | ${fmtPct(cell.passRateStdDev)}${flag} | ${cell.completed}/${cell.runs} |`,
    );
  }
  if (sortedByVariance.some((c) => c.passRateStdDev > 20)) {
    lines.push('');
    lines.push('_⚠️ marked rows are noisier than ±20pp — consider more runs before treating as decision-grade._');
  }
  return lines.join('\n');
}

function renderSection7Ranking(r: BenchmarkResult): string {
  const variantTotals = r.variants.map((v) => {
    const cells = r.byVariant[v.id] ?? [];
    const totalQuality = cells.reduce((s, c) => s + c.quality, 0);
    const avgQuality = cells.length === 0 ? 0 : totalQuality / cells.length;
    return { id: v.id, avgQuality, n: cells.length };
  });
  variantTotals.sort((a, b) => b.avgQuality - a.avgQuality);
  const lines: string[] = [];
  lines.push('## 7. Variant ranking (quality, averaged across models)');
  lines.push('');
  lines.push('| rank | variant | avg quality | n cells |');
  lines.push('| --- | --- | --- | --- |');
  for (let i = 0; i < variantTotals.length; i++) {
    const t = variantTotals[i]!;
    lines.push(`| ${i + 1} | \`${t.id}\` | ${fmtPct(t.avgQuality)} | ${t.n} |`);
  }
  if (r.variantsDominantOnEveryModel.length > 0) {
    lines.push('');
    lines.push(
      `**Variants strictly ≥ every other variant on every model (by quality)**: ${r.variantsDominantOnEveryModel
        .map((id) => `\`${id}\``)
        .join(', ')}`,
    );
  } else if (r.variants.length > 1) {
    lines.push('');
    lines.push('_No variant is strictly dominant. Inspect §3 + §6 to pick a winner._');
  }
  lines.push('');
  lines.push(`> ${SIGNIFICANCE_NOTE_PROSE}`);
  return lines.join('\n');
}

function renderSection8FailurePatterns(r: BenchmarkResult): string {
  // Aggregate (judge name, reason) across all runs and rank by failure count.
  const failureCounts = new Map<string, { count: number; example: string; reason: string }>();
  for (const cell of r.cells) {
    for (const run of cell.runsRaw) {
      for (const j of run.judges) {
        if (j.passed) continue;
        const key = `${j.name}::${j.reason ?? '(no reason)'}`;
        const existing = failureCounts.get(key);
        if (existing) {
          existing.count += 1;
        } else {
          failureCounts.set(key, {
            count: 1,
            example: `${cell.variantId}/${cell.alias}#${run.runIndex}`,
            reason: j.reason ?? '(no reason)',
          });
        }
      }
    }
  }
  if (failureCounts.size === 0) {
    return ['## 8. Assertion failure patterns', '', '_All judges passed on every run — no failure patterns to report._'].join('\n');
  }
  const sorted = Array.from(failureCounts.entries())
    .map(([key, v]) => ({ key, ...v }))
    .sort((a, b) => b.count - a.count);
  const lines: string[] = [];
  lines.push('## 8. Assertion failure patterns (sorted by frequency)');
  lines.push('');
  lines.push('| count | judge | reason | first hit |');
  lines.push('| --- | --- | --- | --- |');
  for (const f of sorted) {
    const judgeName = f.key.split('::')[0]!;
    lines.push(
      `| ${f.count} | \`${judgeName}\` | ${f.reason.slice(0, 120)} | \`${f.example}\` |`,
    );
  }
  lines.push('');
  lines.push(
    '_The top of this list is your prompt-improvement opportunity. Form a hypothesis (§9), edit ONE prompt section, smoke-test, then re-run._',
  );
  return lines.join('\n');
}

function renderSection9Reproduction(r: BenchmarkResult): string {
  return [
    '## 9. Reproduction',
    '',
    '```bash',
    '# Re-run this benchmark:',
    'npm run test:eval -- <path-to-eval-file>',
    '',
    '# Iterate workflow:',
    '# 1. Read §8 — pick a high-frequency failure to address',
    '# 2. Edit ONE prompt section that targets that failure mode',
    '# 3. Smoke-test against 1 case + 2 strong models',
    '# 4. Full re-run; diff §3 + §8 vs this baseline',
    '```',
    '',
    `_Config: runs=${r.config.runs}, scoring=quality-only (latency reported but not scored — KodaX coding-agent design choice)_`,
  ].join('\n');
}

/**
 * Render a complete markdown REPORT.md for a `BenchmarkResult`. Pass-through
 * to disk via `./persist.ts:writeBenchmarkReport`, or `console.log` directly
 * for ad-hoc inspection.
 */
export function renderBenchmarkReport(result: BenchmarkResult): string {
  return [
    `# Prompt Benchmark Report`,
    '',
    renderSection1Summary(result),
    '',
    renderSection2Methodology(result),
    '',
    renderSection3ScoreMatrix(result),
    '',
    renderSection4SubDimensions(result),
    '',
    renderSection5Time(result),
    '',
    renderSection6Variance(result),
    '',
    renderSection7Ranking(result),
    '',
    renderSection8FailurePatterns(result),
    '',
    renderSection9Reproduction(result),
    '',
  ].join('\n');
}

/**
 * Compact one-line per-cell summary suitable for `console.log` mid-run.
 * Use when you want quick feedback during iteration without rendering
 * the full markdown.
 */
export function renderCompactSummary(cell: BenchmarkCellSummary): string {
  return (
    `${cell.variantId}/${cell.alias}: ` +
    `pass=${fmtPct(cell.passRate)}% (±${fmtPct(cell.passRateStdDev)}) ` +
    `quality=${fmtPct(cell.quality)} ` +
    `dur=${fmtMs(cell.duration.median)} (informational)`
  );
}
