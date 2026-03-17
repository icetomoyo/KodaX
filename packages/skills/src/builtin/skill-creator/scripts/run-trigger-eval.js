#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractJsonObject,
  loadSkill,
} from './utils.js';

function buildTriggerEvalPrompt(skillName, description, query) {
  return [
    'You are evaluating whether a KodaX skill description should trigger for a user request.',
    'Decide whether the skill should be used based only on the skill name, description, and query.',
    'Return JSON only with this exact shape:',
    '{"trigger": true, "reason": "short explanation"}',
    '',
    `Skill name: ${skillName}`,
    `Skill description: ${description}`,
    `User query: ${query}`,
  ].join('\n');
}

export function parseTriggerDecision(text) {
  const parsed = extractJsonObject(text);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Could not parse trigger decision JSON');
  }

  return {
    trigger: parsed.trigger === true,
    reason: typeof parsed.reason === 'string' ? parsed.reason.trim() : '',
  };
}

async function defaultRunPrompt(prompt, options) {
  const { runKodaX } = await import('@kodax/coding');
  const result = await runKodaX(
    {
      provider: options.provider,
      maxIter: options.maxIter ?? 12,
      model: options.model,
      reasoningMode: options.reasoningMode ?? 'off',
      thinking: options.reasoningMode ? options.reasoningMode !== 'off' : false,
    },
    prompt
  );

  return result.lastText;
}

export function summarizeTriggerResults(results) {
  const positives = results.filter((result) => result.should_trigger);
  const negatives = results.filter((result) => !result.should_trigger);
  const predictedPositives = results.filter((result) => result.predicted_trigger);
  const truePositives = positives.filter((result) => result.predicted_trigger).length;
  const falsePositives = negatives.filter((result) => result.predicted_trigger).length;

  const summary = {
    passed: 0,
    failed: 0,
    total: results.length,
    pass_rate: 0,
    precision: 0,
    recall: 0,
  };

  for (const result of results) {
    if (result.pass) {
      summary.passed += 1;
    } else {
      summary.failed += 1;
    }
  }

  summary.pass_rate = summary.total === 0 ? 0 : summary.passed / summary.total;
  summary.precision = predictedPositives.length === 0
    ? 0
    : truePositives / predictedPositives.length;
  summary.recall = positives.length === 0 ? 0 : truePositives / positives.length;

  return summary;
}

export async function runTriggerEval(options, runner = defaultRunPrompt) {
  const skill = await loadSkill(options.skillPath);
  const currentDescription = options.descriptionOverride
    ?? String(skill.frontmatter.description ?? '').trim();
  const evalFile = JSON.parse(await readFile(options.evalsPath, 'utf8'));
  const evals = Array.isArray(evalFile.evals) ? evalFile.evals : [];
  const runsPerQuery = Number.isFinite(options.runsPerQuery) && options.runsPerQuery > 0
    ? Math.floor(options.runsPerQuery)
    : 1;
  const threshold = Number.isFinite(options.triggerThreshold)
    ? Math.min(Math.max(options.triggerThreshold, 0), 1)
    : 0.5;
  const results = [];

  for (const item of evals) {
    const query = String(item.query ?? item.prompt ?? '').trim();
    if (!query) {
      continue;
    }

    const shouldTrigger = item.should_trigger === true;
    let triggers = 0;
    const attempts = [];

    for (let runIndex = 0; runIndex < runsPerQuery; runIndex += 1) {
      const response = await runner(
        buildTriggerEvalPrompt(skill.frontmatter.name, currentDescription, query),
        options
      );
      const parsed = parseTriggerDecision(response);
      if (parsed.trigger) {
        triggers += 1;
      }
      attempts.push(parsed);
    }

    const triggerRate = triggers / runsPerQuery;
    const predictedTrigger = triggerRate >= threshold;
    const pass = shouldTrigger
      ? predictedTrigger
      : !predictedTrigger;

    results.push({
      query,
      should_trigger: shouldTrigger,
      triggers,
      runs: runsPerQuery,
      trigger_rate: triggerRate,
      predicted_trigger: predictedTrigger,
      pass,
      attempts,
    });
  }

  const summary = summarizeTriggerResults(results);

  return {
    skill_name: skill.frontmatter.name,
    description: currentDescription,
    results,
    summary,
    meta: {
      provider: options.provider,
      model: options.model ?? null,
      runs_per_query: runsPerQuery,
      trigger_threshold: threshold,
      note: 'This is a KodaX-native description eval, not a Claude Code tool-trace replay.',
    },
  };
}

function parseArgs(argv) {
  const args = {
    skillPath: '',
    evalsPath: '',
    provider: 'anthropic',
    model: undefined,
    output: undefined,
    runsPerQuery: 1,
    triggerThreshold: 0.5,
    maxIter: 12,
    reasoningMode: 'off',
    descriptionOverride: undefined,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--skill-path' && argv[index + 1]) {
      args.skillPath = argv[++index];
    } else if (token === '--evals' && argv[index + 1]) {
      args.evalsPath = argv[++index];
    } else if (token === '--provider' && argv[index + 1]) {
      args.provider = argv[++index];
    } else if (token === '--model' && argv[index + 1]) {
      args.model = argv[++index];
    } else if (token === '--output' && argv[index + 1]) {
      args.output = argv[++index];
    } else if (token === '--runs-per-query' && argv[index + 1]) {
      args.runsPerQuery = Number(argv[++index]);
    } else if (token === '--trigger-threshold' && argv[index + 1]) {
      args.triggerThreshold = Number(argv[++index]);
    } else if (token === '--max-iter' && argv[index + 1]) {
      args.maxIter = Number(argv[++index]);
    } else if (token === '--reasoning' && argv[index + 1]) {
      args.reasoningMode = argv[++index];
    } else if (token === '--description' && argv[index + 1]) {
      args.descriptionOverride = argv[++index];
    }
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.skillPath || !args.evalsPath) {
    console.error('Usage: node scripts/run-trigger-eval.js --skill-path <dir> --evals <evals.json> [--provider anthropic] [--output results.json]');
    process.exit(1);
  }

  const results = await runTriggerEval(args);
  const outputText = `${JSON.stringify(results, null, 2)}\n`;

  if (args.output) {
    await writeFile(args.output, outputText, 'utf8');
    console.log(`Wrote ${path.resolve(args.output)}`);
  } else {
    process.stdout.write(outputText);
  }
}

const isDirectRun = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
