#!/usr/bin/env node

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadKodaXSDK,
  loadSkill,
  writeSkill,
} from './utils.js';

const RECORDED_NOT_RUN = 'Trigger eval: this call was recorded and not run.';

/**
 * Stage the candidate as a project Skill. Project Skills outrank user, plugin
 * and builtin Skills, so the candidate shadows an installed copy of itself and
 * competes with everything else the product catalog shows.
 */
async function stageCandidateProject(skill, description) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'kodax-trigger-eval-'));
  const skillDir = path.join(projectRoot, '.kodax', 'skills', skill.frontmatter.name);
  await mkdir(skillDir, { recursive: true });
  await writeSkill(skillDir, { ...skill.frontmatter, description }, skill.body);
  return projectRoot;
}

/**
 * The first response of the product AMA root. Every call is recorded as it
 * starts; the gate stops each one from running. A batch with a Skill call defers
 * its other calls before the gate, so only the start event sees all of them.
 */
async function defaultObserveFirstTurn(query, options) {
  const { runKodaX } = await loadKodaXSDK();
  const calls = [];
  await runKodaX(
    {
      provider: options.provider,
      model: options.model,
      agentMode: 'ama',
      maxIter: 1,
      reasoningMode: options.reasoningMode ?? 'off',
      context: { gitRoot: options.projectRoot },
      events: {
        onToolUseStart: (tool) => {
          calls.push({ tool: tool.name, input: tool.input ?? {} });
        },
        beforeToolExecute: async () => RECORDED_NOT_RUN,
      },
    },
    query
  );
  return calls;
}

function describeCall(call) {
  if (call.tool !== 'skill') return call.tool;
  return `skill:${String(call.input?.skill ?? '').replace(/^\//, '')}`;
}

export function scoreFirstTurn(calls, skillName) {
  const toolCalls = calls.map(describeCall);
  return { trigger: toolCalls.includes(`skill:${skillName}`), tool_calls: toolCalls };
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

export async function runTriggerEval(options, observe = defaultObserveFirstTurn) {
  const skill = await loadSkill(options.skillPath);
  if (skill.frontmatter['disable-model-invocation'] === true) {
    throw new Error('This Skill sets disable-model-invocation, so the model catalog never shows it and it cannot trigger.');
  }
  const skillName = skill.frontmatter.name;
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
  const projectRoot = await stageCandidateProject(skill, currentDescription);

  try {
    for (const item of evals) {
      const query = String(item.query ?? item.prompt ?? '').trim();
      if (!query) {
        continue;
      }

      const shouldTrigger = item.should_trigger === true;
      let triggers = 0;
      const attempts = [];

      for (let runIndex = 0; runIndex < runsPerQuery; runIndex += 1) {
        const attempt = scoreFirstTurn(await observe(query, { ...options, projectRoot }), skillName);
        if (attempt.trigger) {
          triggers += 1;
        }
        attempts.push(attempt);
      }

      const triggerRate = triggers / runsPerQuery;
      const predictedTrigger = triggerRate >= threshold;
      results.push({
        query,
        should_trigger: shouldTrigger,
        triggers,
        runs: runsPerQuery,
        trigger_rate: triggerRate,
        predicted_trigger: predictedTrigger,
        pass: shouldTrigger === predictedTrigger,
        attempts,
      });
    }
  } finally {
    await rm(projectRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }

  return {
    skill_name: skillName,
    description: currentDescription,
    results,
    summary: summarizeTriggerResults(results),
    meta: {
      provider: options.provider,
      model: options.model ?? null,
      runs_per_query: runsPerQuery,
      trigger_threshold: threshold,
      evaluation_kind: 'observed_skill_call',
      note: 'First response of the AMA root. The candidate is staged as a project Skill over the installed catalog; tool calls are recorded, not run.',
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

const isDirectRun = process.env.KODAX_MODULE_BUNDLE !== 'true'
  && process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
