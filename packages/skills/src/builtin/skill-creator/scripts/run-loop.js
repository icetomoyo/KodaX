#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSkill, pathExists, writeSkill } from './utils.js';
import { improveDescription } from './improve-description.js';
import { runTriggerEval } from './run-trigger-eval.js';

export function splitEvalSet(evals, holdout = 0.25, seed = 42) {
  if (holdout <= 0 || evals.length < 4) {
    return { train: [...evals], test: [] };
  }

  let random = seed;
  const nextRandom = () => {
    random = (random * 1664525 + 1013904223) % 4294967296;
    return random / 4294967296;
  };

  const shuffle = (items) => {
    const result = [...items];
    for (let index = result.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(nextRandom() * (index + 1));
      [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
    }
    return result;
  };

  const positives = evals.filter((item) => item.should_trigger === true);
  const negatives = evals.filter((item) => item.should_trigger !== true);
  const shuffledPositives = shuffle(positives);
  const shuffledNegatives = shuffle(negatives);

  const pickCount = (items) => {
    if (items.length <= 1) {
      return 0;
    }
    return Math.max(1, Math.floor(items.length * holdout));
  };

  const posCount = pickCount(shuffledPositives);
  const negCount = pickCount(shuffledNegatives);

  const test = [
    ...shuffledPositives.slice(0, posCount),
    ...shuffledNegatives.slice(0, negCount),
  ];
  const train = [
    ...shuffledPositives.slice(posCount),
    ...shuffledNegatives.slice(negCount),
  ];

  return { train, test };
}

async function writeTempEvalFile(workspaceDir, name, skillName, evals) {
  const filePath = path.join(workspaceDir, `${name}.json`);
  await writeFile(filePath, JSON.stringify({ skill_name: skillName, evals }, null, 2), 'utf8');
  return filePath;
}

export async function runDescriptionLoop(
  options,
  dependencies = {
    runTriggerEvalFn: runTriggerEval,
    improveDescriptionFn: improveDescription,
  }
) {
  const resolvedDependencies = {
    runTriggerEvalFn: runTriggerEval,
    improveDescriptionFn: improveDescription,
    ...dependencies,
  };
  const skill = await loadSkill(options.skillPath);
  const evalFile = JSON.parse(await readFile(options.evalsPath, 'utf8'));
  const allEvals = Array.isArray(evalFile.evals) ? evalFile.evals : [];
  const { train, test } = splitEvalSet(allEvals, options.holdout, options.seed);
  const historyPath = path.join(options.workspaceDir, 'description-history.json');

  let currentDescription = String(skill.frontmatter.description ?? '');
  const history = [];
  let best = null;

  for (let iteration = 1; iteration <= options.maxIterations; iteration += 1) {
    const trainFile = await writeTempEvalFile(options.workspaceDir, `train-iteration-${iteration}`, skill.frontmatter.name, train);
    const trainResults = await resolvedDependencies.runTriggerEvalFn({
      ...options,
      evalsPath: trainFile,
      descriptionOverride: currentDescription,
    });

    let testResults = null;
    if (test.length > 0) {
      const testFile = await writeTempEvalFile(options.workspaceDir, `test-iteration-${iteration}`, skill.frontmatter.name, test);
      testResults = await resolvedDependencies.runTriggerEvalFn({
        ...options,
        evalsPath: testFile,
        descriptionOverride: currentDescription,
      });
    }

    const score = `${trainResults.summary.passed}/${trainResults.summary.total}`;
    const record = {
      iteration,
      description: currentDescription,
      score,
      train: trainResults.summary,
      test: testResults?.summary ?? null,
      train_results: trainResults.results,
      test_results: testResults?.results ?? [],
    };
    history.push(record);

    const currentComparable = testResults?.summary.passed ?? trainResults.summary.passed;
    const bestComparable = best?.comparable ?? -1;
    if (currentComparable > bestComparable) {
      best = {
        comparable: currentComparable,
        record,
      };
    }

    if (trainResults.summary.failed === 0 || iteration === options.maxIterations) {
      break;
    }

    const improveInputPath = path.join(options.workspaceDir, `iteration-${iteration}-train-results.json`);
    await writeFile(improveInputPath, JSON.stringify(trainResults, null, 2), 'utf8');
    if (!await pathExists(historyPath)) {
      await writeFile(historyPath, JSON.stringify({ history }, null, 2), 'utf8');
    }
    const improved = await resolvedDependencies.improveDescriptionFn({
      ...options,
      evalResultsPath: improveInputPath,
      historyPath,
    });
    currentDescription = improved.description;
    await writeFile(
      historyPath,
      JSON.stringify({ history }, null, 2),
      'utf8'
    );
  }

  if (options.writeBest) {
    const finalDescription = best?.record.description ?? currentDescription;
    skill.frontmatter.description = finalDescription;
    await writeSkill(options.skillPath, skill.frontmatter, skill.body);
  }

  return {
    skill_name: skill.frontmatter.name,
    original_description: skill.frontmatter.description,
    final_description: currentDescription,
    best_description: best?.record.description ?? currentDescription,
    history,
    train_size: train.length,
    test_size: test.length,
  };
}

function parseArgs(argv) {
  const args = {
    skillPath: '',
    evalsPath: '',
    workspaceDir: '',
    provider: 'anthropic',
    model: undefined,
    maxIterations: 3,
    runsPerQuery: 1,
    triggerThreshold: 0.5,
    holdout: 0.25,
    seed: 42,
    maxIter: 18,
    reasoningMode: 'off',
    output: undefined,
    writeBest: false,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--skill-path' && argv[index + 1]) {
      args.skillPath = argv[++index];
    } else if (token === '--evals' && argv[index + 1]) {
      args.evalsPath = argv[++index];
    } else if (token === '--workspace' && argv[index + 1]) {
      args.workspaceDir = argv[++index];
    } else if (token === '--provider' && argv[index + 1]) {
      args.provider = argv[++index];
    } else if (token === '--model' && argv[index + 1]) {
      args.model = argv[++index];
    } else if (token === '--max-iterations' && argv[index + 1]) {
      args.maxIterations = Number(argv[++index]);
    } else if (token === '--runs-per-query' && argv[index + 1]) {
      args.runsPerQuery = Number(argv[++index]);
    } else if (token === '--trigger-threshold' && argv[index + 1]) {
      args.triggerThreshold = Number(argv[++index]);
    } else if (token === '--holdout' && argv[index + 1]) {
      args.holdout = Number(argv[++index]);
    } else if (token === '--seed' && argv[index + 1]) {
      args.seed = Number(argv[++index]);
    } else if (token === '--max-iter' && argv[index + 1]) {
      args.maxIter = Number(argv[++index]);
    } else if (token === '--reasoning' && argv[index + 1]) {
      args.reasoningMode = argv[++index];
    } else if (token === '--output' && argv[index + 1]) {
      args.output = argv[++index];
    } else if (token === '--write-best') {
      args.writeBest = true;
    }
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.skillPath || !args.evalsPath || !args.workspaceDir) {
    console.error('Usage: node scripts/run-loop.js --skill-path <dir> --evals <evals.json> --workspace <dir> [--max-iterations 3]');
    process.exit(1);
  }

  const report = await runDescriptionLoop(args);
  const outputText = `${JSON.stringify(report, null, 2)}\n`;

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
