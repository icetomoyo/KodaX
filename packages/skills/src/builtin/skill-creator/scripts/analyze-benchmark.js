#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildBenchmarkDocument,
  loadRunResults,
} from './aggregate-benchmark.js';
import {
  extractJsonObject,
  loadRelativeText,
  readJsonFile,
  truncateText,
} from './utils.js';

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => String(item ?? '').trim())
    .filter(Boolean);
}

function summarizeFailureClusters(configRuns) {
  const clusters = {};

  for (const [configName, runs] of Object.entries(configRuns)) {
    const failureCounts = new Map();
    const notes = [];

    for (const run of runs) {
      for (const expectation of run.expectations ?? []) {
        if (expectation?.passed === true) {
          continue;
        }
        const text = String(expectation?.text ?? '').trim();
        if (!text) {
          continue;
        }
        failureCounts.set(text, (failureCounts.get(text) ?? 0) + 1);
      }

      for (const note of run.notes ?? []) {
        const normalized = String(note ?? '').trim();
        if (normalized) {
          notes.push(normalized);
        }
      }
    }

    clusters[configName] = {
      repeated_failures: Array.from(failureCounts.entries())
        .sort((left, right) => right[1] - left[1])
        .slice(0, 10)
        .map(([text, count]) => ({ text, count })),
      notes: notes.slice(0, 10),
    };
  }

  return clusters;
}

function normalizeAnalysisResult(rawText, benchmark, failureClusters) {
  const parsed = extractJsonObject(rawText) ?? {};

  return {
    skill_name: benchmark.skill_name,
    generated_at: new Date().toISOString(),
    workspace: benchmark.workspace,
    verdict: ['improves', 'regresses', 'mixed', 'inconclusive'].includes(parsed.verdict)
      ? parsed.verdict
      : 'inconclusive',
    release_readiness: ['ready', 'needs_iteration', 'needs_manual_review'].includes(parsed.release_readiness)
      ? parsed.release_readiness
      : 'needs_manual_review',
    recommendation: String(parsed.recommendation ?? '').trim(),
    key_findings: normalizeStringArray(parsed.key_findings),
    variance_hotspots: normalizeStringArray(parsed.variance_hotspots),
    suggested_actions: normalizeStringArray(parsed.suggested_actions),
    watchouts: normalizeStringArray(parsed.watchouts),
    supporting_metrics: {
      pass_rate_delta: benchmark.delta?.pass_rate ?? 'n/a',
      time_seconds_delta: benchmark.delta?.time_seconds ?? 'n/a',
      tokens_delta: benchmark.delta?.tokens ?? 'n/a',
    },
    failure_clusters: failureClusters,
  };
}

export function buildAnalysisPrompt(input) {
  return `${input.agentInstructions.trim()}

Return JSON with this shape:
{
  "verdict": "improves | regresses | mixed | inconclusive",
  "release_readiness": "ready | needs_iteration | needs_manual_review",
  "recommendation": "short recommendation",
  "key_findings": [],
  "variance_hotspots": [],
  "suggested_actions": [],
  "watchouts": []
}

## Benchmark Summary
${truncateText(JSON.stringify({
  skill_name: input.benchmark.skill_name,
  configs: input.benchmark.configs,
  delta: input.benchmark.delta,
}, null, 2), 12000)}

## Failure Clusters
${truncateText(JSON.stringify(input.failureClusters, null, 2), 8000)}
`;
}

async function defaultRunAnalyst(prompt, options) {
  const { runKodaX } = await import('@kodax/coding');
  const result = await runKodaX(
    {
      provider: options.provider ?? 'anthropic',
      model: options.model,
      maxIter: options.maxIter ?? 20,
      reasoningMode: options.reasoningMode ?? 'balanced',
      thinking: options.reasoningMode ? options.reasoningMode !== 'off' : true,
      context: {
        gitRoot: path.resolve(options.cwd ?? options.workspaceDir ?? process.cwd()),
      },
    },
    prompt
  );
  return result.lastText;
}

export function renderAnalysisMarkdown(analysis) {
  const lines = [
    `# Benchmark Analysis: ${analysis.skill_name}`,
    '',
    `Generated: ${analysis.generated_at}`,
    '',
    `- Verdict: ${analysis.verdict}`,
    `- Release readiness: ${analysis.release_readiness}`,
    `- Recommendation: ${analysis.recommendation || 'n/a'}`,
    '',
  ];

  const sections = [
    ['key_findings', 'Key Findings'],
    ['variance_hotspots', 'Variance Hotspots'],
    ['suggested_actions', 'Suggested Actions'],
    ['watchouts', 'Watchouts'],
  ];

  for (const [field, title] of sections) {
    lines.push(`## ${title}`);
    lines.push('');
    const items = Array.isArray(analysis[field]) ? analysis[field] : [];
    if (items.length === 0) {
      lines.push('- None');
    } else {
      for (const item of items) {
        lines.push(`- ${item}`);
      }
    }
    lines.push('');
  }

  lines.push('## Supporting Metrics');
  lines.push('');
  lines.push(`- Pass rate delta: ${analysis.supporting_metrics.pass_rate_delta}`);
  lines.push(`- Time delta: ${analysis.supporting_metrics.time_seconds_delta}`);
  lines.push(`- Tokens delta: ${analysis.supporting_metrics.tokens_delta}`);

  return `${lines.join('\n')}\n`;
}

export async function analyzeBenchmark(
  options,
  runner = defaultRunAnalyst
) {
  const workspaceDir = path.resolve(options.workspaceDir);
  const benchmarkPath = path.resolve(options.benchmarkPath ?? path.join(workspaceDir, 'benchmark.json'));
  let benchmark = await readJsonFile(benchmarkPath, null);

  if (!benchmark) {
    const configRuns = await loadRunResults(workspaceDir);
    if (Object.keys(configRuns).length === 0) {
      throw new Error(`No benchmark data found in ${workspaceDir}`);
    }
    benchmark = buildBenchmarkDocument(workspaceDir, options.skillName ?? path.basename(workspaceDir), configRuns);
    await writeFile(benchmarkPath, `${JSON.stringify(benchmark, null, 2)}\n`, 'utf8');
  }

  const configRuns = await loadRunResults(workspaceDir);
  const failureClusters = summarizeFailureClusters(configRuns);
  const agentInstructions = await loadRelativeText(import.meta.url, '../agents/analyzer.md');
  const prompt = buildAnalysisPrompt({
    agentInstructions,
    benchmark,
    failureClusters,
  });
  const rawResponse = await runner(prompt, {
    ...options,
    workspaceDir,
    benchmarkPath,
    benchmark,
  });
  const analysis = normalizeAnalysisResult(rawResponse, benchmark, failureClusters);
  const analysisJsonPath = path.resolve(options.outputPath ?? path.join(workspaceDir, 'analysis.json'));
  const analysisMdPath = path.resolve(options.markdownPath ?? path.join(workspaceDir, 'analysis.md'));

  await writeFile(analysisJsonPath, `${JSON.stringify(analysis, null, 2)}\n`, 'utf8');
  await writeFile(analysisMdPath, renderAnalysisMarkdown(analysis), 'utf8');

  return {
    analysis,
    prompt,
    rawResponse,
    analysisJsonPath,
    analysisMdPath,
  };
}

function parseArgs(argv) {
  const args = {
    workspaceDir: argv[2] ?? '',
    benchmarkPath: undefined,
    outputPath: undefined,
    markdownPath: undefined,
    skillName: undefined,
    provider: 'anthropic',
    model: undefined,
    reasoningMode: 'balanced',
    maxIter: 20,
    cwd: process.cwd(),
  };

  for (let index = 3; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--benchmark' && argv[index + 1]) {
      args.benchmarkPath = argv[++index];
    } else if (token === '--output' && argv[index + 1]) {
      args.outputPath = argv[++index];
    } else if (token === '--markdown' && argv[index + 1]) {
      args.markdownPath = argv[++index];
    } else if (token === '--skill-name' && argv[index + 1]) {
      args.skillName = argv[++index];
    } else if (token === '--provider' && argv[index + 1]) {
      args.provider = argv[++index];
    } else if (token === '--model' && argv[index + 1]) {
      args.model = argv[++index];
    } else if (token === '--reasoning' && argv[index + 1]) {
      args.reasoningMode = argv[++index];
    } else if (token === '--max-iter' && argv[index + 1]) {
      args.maxIter = Number(argv[++index]);
    } else if (token === '--cwd' && argv[index + 1]) {
      args.cwd = argv[++index];
    }
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.workspaceDir) {
    console.error('Usage: node scripts/analyze-benchmark.js <workspace> [--benchmark benchmark.json] [--output analysis.json] [--markdown analysis.md]');
    process.exit(1);
  }

  const result = await analyzeBenchmark(args);
  process.stdout.write(`${JSON.stringify({
    analysis: result.analysis,
    analysis_json: result.analysisJsonPath,
    analysis_md: result.analysisMdPath,
  }, null, 2)}\n`);
}

const isDirectRun = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
