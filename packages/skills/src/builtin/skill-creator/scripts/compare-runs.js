#!/usr/bin/env node

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractJsonObject,
  loadRelativeText,
  readJsonFile,
  truncateText,
} from './utils.js';

async function listDirectories(dirPath) {
  const entries = await readdir(dirPath, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dirPath, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => String(item ?? '').trim())
    .filter(Boolean);
}

function normalizeComparisonResult(rawText) {
  const parsed = extractJsonObject(rawText) ?? {};
  const winner = ['A', 'B', 'tie', 'inconclusive'].includes(parsed.winner)
    ? parsed.winner
    : 'inconclusive';
  const confidenceValue = Number(parsed.confidence);

  return {
    winner,
    confidence: Number.isFinite(confidenceValue)
      ? Math.max(0, Math.min(1, Number(confidenceValue.toFixed(4))))
      : 0,
    rationale: String(parsed.rationale ?? '').trim(),
    strengths_a: normalizeStringArray(parsed.strengths_a),
    strengths_b: normalizeStringArray(parsed.strengths_b),
    risks: normalizeStringArray(parsed.risks),
  };
}

async function loadComparisonPair(evalDir, configA, configB, pairIndex) {
  const runsA = (await listDirectories(path.join(evalDir, configA)))
    .filter((dirPath) => path.basename(dirPath).startsWith('run-'));
  const runsB = (await listDirectories(path.join(evalDir, configB)))
    .filter((dirPath) => path.basename(dirPath).startsWith('run-'));
  const left = runsA[pairIndex];
  const right = runsB[pairIndex];

  if (!left || !right) {
    return null;
  }

  const evalMetadata = await readJsonFile(path.join(evalDir, 'eval_metadata.json'), {});
  const outputA = await readFile(path.join(left, 'outputs', 'result.md'), 'utf8').catch(() => '');
  const outputB = await readFile(path.join(right, 'outputs', 'result.md'), 'utf8').catch(() => '');

  return {
    evalDir,
    evalMetadata,
    runA: {
      runDir: left,
      runId: path.basename(left),
      configName: configA,
      output: outputA,
    },
    runB: {
      runDir: right,
      runId: path.basename(right),
      configName: configB,
      output: outputB,
    },
  };
}

export function buildComparisonPrompt(input) {
  const pair = input.presentPrimaryFirst
    ? { A: input.runA, B: input.runB }
    : { A: input.runB, B: input.runA };

  return `${input.agentInstructions.trim()}

Return JSON with this shape:
{
  "winner": "A | B | tie | inconclusive",
  "confidence": 0.0,
  "rationale": "short explanation",
  "strengths_a": [],
  "strengths_b": [],
  "risks": []
}

Judge only the visible outputs. Do not mention hidden config names in the rationale.

## Eval Prompt
${truncateText(input.evalMetadata.prompt ?? '', 4000)}

## Expected Outcome
${truncateText(input.evalMetadata.expected_output ?? '', 2000)}

## Assertions
${truncateText(JSON.stringify(input.evalMetadata.assertions ?? [], null, 2), 4000)}

## Candidate A
${truncateText(pair.A.output, 12000)}

## Candidate B
${truncateText(pair.B.output, 12000)}
`;
}

async function defaultRunComparator(prompt, options) {
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

function mapWinnerToConfig(winner, presentPrimaryFirst, configA, configB) {
  if (winner === 'A') {
    return presentPrimaryFirst ? configA : configB;
  }
  if (winner === 'B') {
    return presentPrimaryFirst ? configB : configA;
  }
  return winner;
}

export function renderComparisonMarkdown(document) {
  const lines = [
    `# Blind Comparison: ${document.config_a} vs ${document.config_b}`,
    '',
    `Generated: ${document.generated_at}`,
    '',
    `- ${document.config_a} wins: ${document.summary.config_a_wins}`,
    `- ${document.config_b} wins: ${document.summary.config_b_wins}`,
    `- ties: ${document.summary.ties}`,
    `- inconclusive: ${document.summary.inconclusive}`,
    '',
  ];

  for (const comparison of document.comparisons) {
    lines.push(`## Eval ${comparison.eval_id ?? comparison.eval_name ?? comparison.index}`);
    lines.push('');
    lines.push(`- Winner: ${comparison.winner_config}`);
    lines.push(`- Confidence: ${comparison.confidence}`);
    lines.push(`- Rationale: ${comparison.rationale || 'n/a'}`);
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

export async function compareWorkspace(
  options,
  runner = defaultRunComparator
) {
  const workspaceDir = path.resolve(options.workspaceDir);
  const configA = options.configA ?? 'with_skill';
  const configB = options.configB ?? 'without_skill';
  const maxPairs = Number.isFinite(options.maxPairs) && options.maxPairs > 0
    ? Math.floor(options.maxPairs)
    : Number.POSITIVE_INFINITY;
  const agentInstructions = await loadRelativeText(import.meta.url, '../agents/comparator.md');
  const comparisons = [];

  for (const evalDir of await listDirectories(workspaceDir)) {
    if (!path.basename(evalDir).startsWith('eval-')) {
      continue;
    }

    for (let pairIndex = 0; pairIndex < maxPairs; pairIndex += 1) {
      const pair = await loadComparisonPair(evalDir, configA, configB, pairIndex);
      if (!pair) {
        break;
      }

      const presentPrimaryFirst = comparisons.length % 2 === 0;
      const prompt = buildComparisonPrompt({
        agentInstructions,
        evalMetadata: pair.evalMetadata,
        runA: pair.runA,
        runB: pair.runB,
        presentPrimaryFirst,
      });
      const rawResponse = await runner(prompt, {
        ...options,
        workspaceDir,
        evalDir,
        pairIndex,
        configA,
        configB,
      });
      const parsed = normalizeComparisonResult(rawResponse);
      const winnerConfig = mapWinnerToConfig(parsed.winner, presentPrimaryFirst, configA, configB);

      comparisons.push({
        index: comparisons.length + 1,
        eval_id: pair.evalMetadata.eval_id ?? null,
        eval_name: pair.evalMetadata.eval_name ?? null,
        run_a: path.relative(workspaceDir, pair.runA.runDir).replace(/\\/g, '/'),
        run_b: path.relative(workspaceDir, pair.runB.runDir).replace(/\\/g, '/'),
        presented_as: presentPrimaryFirst
          ? { A: configA, B: configB }
          : { A: configB, B: configA },
        winner_label: parsed.winner,
        winner_config: winnerConfig,
        confidence: parsed.confidence,
        rationale: parsed.rationale,
        strengths_a: parsed.strengths_a,
        strengths_b: parsed.strengths_b,
        risks: parsed.risks,
      });
    }
  }

  if (comparisons.length === 0) {
    throw new Error(`No comparable run pairs found for ${configA} vs ${configB} in ${workspaceDir}`);
  }

  const document = {
    workspace: workspaceDir,
    generated_at: new Date().toISOString(),
    config_a: configA,
    config_b: configB,
    summary: {
      total_pairs: comparisons.length,
      config_a_wins: comparisons.filter((item) => item.winner_config === configA).length,
      config_b_wins: comparisons.filter((item) => item.winner_config === configB).length,
      ties: comparisons.filter((item) => item.winner_config === 'tie').length,
      inconclusive: comparisons.filter((item) => item.winner_config === 'inconclusive').length,
    },
    comparisons,
  };

  const outputPath = path.resolve(options.outputPath ?? path.join(workspaceDir, 'comparison.json'));
  const markdownPath = path.resolve(options.markdownPath ?? path.join(workspaceDir, 'comparison.md'));
  await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  await writeFile(markdownPath, renderComparisonMarkdown(document), 'utf8');

  return {
    document,
    outputPath,
    markdownPath,
  };
}

function parseArgs(argv) {
  const args = {
    workspaceDir: argv[2] ?? '',
    configA: 'with_skill',
    configB: 'without_skill',
    outputPath: undefined,
    markdownPath: undefined,
    provider: 'anthropic',
    model: undefined,
    reasoningMode: 'balanced',
    maxIter: 20,
    maxPairs: undefined,
    cwd: process.cwd(),
  };

  for (let index = 3; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--config-a' && argv[index + 1]) {
      args.configA = argv[++index];
    } else if (token === '--config-b' && argv[index + 1]) {
      args.configB = argv[++index];
    } else if (token === '--output' && argv[index + 1]) {
      args.outputPath = argv[++index];
    } else if (token === '--markdown' && argv[index + 1]) {
      args.markdownPath = argv[++index];
    } else if (token === '--provider' && argv[index + 1]) {
      args.provider = argv[++index];
    } else if (token === '--model' && argv[index + 1]) {
      args.model = argv[++index];
    } else if (token === '--reasoning' && argv[index + 1]) {
      args.reasoningMode = argv[++index];
    } else if (token === '--max-iter' && argv[index + 1]) {
      args.maxIter = Number(argv[++index]);
    } else if (token === '--max-pairs' && argv[index + 1]) {
      args.maxPairs = Number(argv[++index]);
    } else if (token === '--cwd' && argv[index + 1]) {
      args.cwd = argv[++index];
    }
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.workspaceDir) {
    console.error('Usage: node scripts/compare-runs.js <workspace> [--config-a with_skill] [--config-b without_skill] [--output comparison.json]');
    process.exit(1);
  }

  const result = await compareWorkspace(args);
  process.stdout.write(`${JSON.stringify({
    comparison: result.document.summary,
    output: result.outputPath,
    markdown: result.markdownPath,
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
