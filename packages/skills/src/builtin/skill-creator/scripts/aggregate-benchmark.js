#!/usr/bin/env node

import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { calculateStats, formatDelta } from './utils.js';

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function listDirectories(dirPath) {
  const entries = await readdir(dirPath, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dirPath, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

export async function loadRunResults(iterationDir) {
  const runsRoot = await pathExists(path.join(iterationDir, 'runs'))
    ? path.join(iterationDir, 'runs')
    : iterationDir;

  const evalDirs = (await listDirectories(runsRoot))
    .filter((dirPath) => path.basename(dirPath).startsWith('eval-'));

  const configs = {};

  for (const evalDir of evalDirs) {
    const metadataPath = path.join(evalDir, 'eval_metadata.json');
    const metadata = await readJson(metadataPath).catch(() => ({}));
    const evalId = metadata.eval_id ?? path.basename(evalDir);

    for (const configDir of await listDirectories(evalDir)) {
      const configName = path.basename(configDir);
      const runDirs = (await listDirectories(configDir))
        .filter((dirPath) => path.basename(dirPath).startsWith('run-'));

      if (runDirs.length === 0) {
        continue;
      }

      configs[configName] ??= [];

      for (const runDir of runDirs) {
        const grading = await readJson(path.join(runDir, 'grading.json')).catch(() => null);
        if (!grading) {
          continue;
        }

        const timing = await readJson(path.join(runDir, 'timing.json')).catch(() => ({}));

        configs[configName].push({
          eval_id: evalId,
          run_id: path.basename(runDir),
          pass_rate: grading.summary?.pass_rate ?? 0,
          passed: grading.summary?.passed ?? 0,
          failed: grading.summary?.failed ?? 0,
          total: grading.summary?.total ?? 0,
          time_seconds: timing.total_duration_seconds ?? grading.timing?.total_duration_seconds ?? 0,
          tokens: timing.total_tokens ?? grading.execution_metrics?.output_chars ?? 0,
          tool_calls: grading.execution_metrics?.total_tool_calls ?? 0,
          errors: grading.execution_metrics?.errors_encountered ?? 0,
          expectations: Array.isArray(grading.expectations) ? grading.expectations : [],
          notes: [
            ...(grading.user_notes_summary?.uncertainties ?? []),
            ...(grading.user_notes_summary?.needs_review ?? []),
            ...(grading.user_notes_summary?.workarounds ?? []),
          ],
        });
      }
    }
  }

  return configs;
}

export function summarizeConfigs(configRuns) {
  const summary = {};

  for (const [configName, runs] of Object.entries(configRuns)) {
    summary[configName] = {
      pass_rate: calculateStats(runs.map((run) => Number(run.pass_rate ?? 0))),
      time_seconds: calculateStats(runs.map((run) => Number(run.time_seconds ?? 0))),
      tokens: calculateStats(runs.map((run) => Number(run.tokens ?? 0))),
    };
  }

  const orderedConfigs = Object.keys(summary);
  const primary = summary[orderedConfigs[0]] ?? {
    pass_rate: { mean: 0 },
    time_seconds: { mean: 0 },
    tokens: { mean: 0 },
  };
  const baseline = summary[orderedConfigs[1]] ?? {
    pass_rate: { mean: 0 },
    time_seconds: { mean: 0 },
    tokens: { mean: 0 },
  };

  return {
    configs: summary,
    delta: {
      pass_rate: formatDelta(primary.pass_rate.mean - baseline.pass_rate.mean),
      time_seconds: formatDelta(primary.time_seconds.mean - baseline.time_seconds.mean),
      tokens: formatDelta(primary.tokens.mean - baseline.tokens.mean),
    },
  };
}

export function buildBenchmarkDocument(iterationDir, skillName, configRuns) {
  const summary = summarizeConfigs(configRuns);

  return {
    skill_name: skillName,
    generated_at: new Date().toISOString(),
    workspace: path.resolve(iterationDir),
    configs: summary.configs,
    delta: summary.delta,
    runs: configRuns,
  };
}

export function renderBenchmarkMarkdown(benchmark) {
  const lines = [
    `# Benchmark: ${benchmark.skill_name}`,
    '',
    `Generated: ${benchmark.generated_at}`,
    '',
    '| Config | Pass Rate | Time (s) | Tokens |',
    '| --- | --- | --- | --- |',
  ];

  for (const [configName, metrics] of Object.entries(benchmark.configs)) {
    lines.push(
      `| ${configName} | ${metrics.pass_rate.mean} ± ${metrics.pass_rate.stddev} | ${metrics.time_seconds.mean} ± ${metrics.time_seconds.stddev} | ${metrics.tokens.mean} ± ${metrics.tokens.stddev} |`
    );
  }

  lines.push('');
  lines.push('## Delta');
  lines.push('');
  lines.push(`- Pass rate: ${benchmark.delta.pass_rate}`);
  lines.push(`- Time (s): ${benchmark.delta.time_seconds}`);
  lines.push(`- Tokens: ${benchmark.delta.tokens}`);

  return lines.join('\n');
}

function parseArgs(argv) {
  const args = {
    iterationDir: argv[2],
    skillName: 'unknown-skill',
  };

  for (let index = 3; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--skill-name' && argv[index + 1]) {
      args.skillName = argv[index + 1];
      index += 1;
    }
  }

  return args;
}

async function main() {
  const { iterationDir, skillName } = parseArgs(process.argv);
  if (!iterationDir) {
    console.error('Usage: node scripts/aggregate-benchmark.js <iteration-dir> --skill-name <name>');
    process.exit(1);
  }

  const configRuns = await loadRunResults(iterationDir);
  if (Object.keys(configRuns).length === 0) {
    console.error(`No benchmark runs found in ${iterationDir}`);
    process.exit(1);
  }

  const benchmark = buildBenchmarkDocument(iterationDir, skillName, configRuns);
  const benchmarkJsonPath = path.join(iterationDir, 'benchmark.json');
  const benchmarkMdPath = path.join(iterationDir, 'benchmark.md');

  await writeFile(benchmarkJsonPath, JSON.stringify(benchmark, null, 2));
  await writeFile(benchmarkMdPath, `${renderBenchmarkMarkdown(benchmark)}\n`);

  console.log(`Wrote ${benchmarkJsonPath}`);
  console.log(`Wrote ${benchmarkMdPath}`);
}

const isDirectRun = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
