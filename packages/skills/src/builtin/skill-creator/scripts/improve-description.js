#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractTaggedText,
  loadSkill,
  pathExists,
  writeSkill,
} from './utils.js';

function buildImprovePrompt({ skillName, body, currentDescription, evalResults, history }) {
  const failed = evalResults.results.filter((item) => !item.pass);
  const historyText = history.length === 0
    ? 'None.'
    : history.map((item, index) => `${index + 1}. ${item.description} (${item.score})`).join('\n');

  return [
    `You are improving the trigger description for a KodaX skill named "${skillName}".`,
    'Write a better description that stays under 1024 characters and focuses on user intent.',
    'Respond with only the new description inside <new_description> tags.',
    '',
    `Current description: ${currentDescription}`,
    '',
    'Skill body for context:',
    body,
    '',
    'Failed eval cases:',
    failed.length === 0 ? 'None.' : JSON.stringify(failed, null, 2),
    '',
    'Previous attempts:',
    historyText,
  ].join('\n');
}

export function extractDescriptionCandidate(text) {
  const tagged = extractTaggedText(text, 'new_description');
  return (tagged ?? text).trim().replace(/^"|"$/g, '');
}

async function defaultGenerate(prompt, options) {
  const { runKodaX } = await import('@kodax/coding');
  const result = await runKodaX(
    {
      provider: options.provider,
      model: options.model,
      maxIter: options.maxIter ?? 18,
      reasoningMode: options.reasoningMode ?? 'off',
      thinking: options.reasoningMode ? options.reasoningMode !== 'off' : false,
    },
    prompt
  );

  return result.lastText;
}

export async function improveDescription(options, generator = defaultGenerate) {
  const skill = await loadSkill(options.skillPath);
  const evalResults = JSON.parse(await readFile(options.evalResultsPath, 'utf8'));
  const history = options.historyPath && await pathExists(options.historyPath)
    ? JSON.parse(await readFile(options.historyPath, 'utf8')).history ?? []
    : [];

  const prompt = buildImprovePrompt({
    skillName: skill.frontmatter.name,
    body: skill.body,
    currentDescription: String(evalResults.description ?? skill.frontmatter.description ?? ''),
    evalResults,
    history,
  });

  const rawResponse = await generator(prompt, options);
  const description = extractDescriptionCandidate(rawResponse);
  if (!description) {
    throw new Error('No description candidate was produced.');
  }
  if (description.length > 1024) {
    throw new Error(`Generated description is too long (${description.length}/1024).`);
  }

  return {
    description,
    rawResponse,
    prompt,
  };
}

function parseArgs(argv) {
  const args = {
    skillPath: '',
    evalResultsPath: '',
    provider: 'anthropic',
    model: undefined,
    output: undefined,
    write: false,
    historyPath: undefined,
    maxIter: 18,
    reasoningMode: 'off',
  };

  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--skill-path' && argv[index + 1]) {
      args.skillPath = argv[++index];
    } else if (token === '--eval-results' && argv[index + 1]) {
      args.evalResultsPath = argv[++index];
    } else if (token === '--provider' && argv[index + 1]) {
      args.provider = argv[++index];
    } else if (token === '--model' && argv[index + 1]) {
      args.model = argv[++index];
    } else if (token === '--output' && argv[index + 1]) {
      args.output = argv[++index];
    } else if (token === '--write') {
      args.write = true;
    } else if (token === '--history' && argv[index + 1]) {
      args.historyPath = argv[++index];
    } else if (token === '--max-iter' && argv[index + 1]) {
      args.maxIter = Number(argv[++index]);
    } else if (token === '--reasoning' && argv[index + 1]) {
      args.reasoningMode = argv[++index];
    }
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.skillPath || !args.evalResultsPath) {
    console.error('Usage: node scripts/improve-description.js --skill-path <dir> --eval-results <results.json> [--write] [--output result.json]');
    process.exit(1);
  }

  const result = await improveDescription(args);
  const output = `${JSON.stringify(result, null, 2)}\n`;

  if (args.write) {
    const skill = await loadSkill(args.skillPath);
    skill.frontmatter.description = result.description;
    await writeSkill(args.skillPath, skill.frontmatter, skill.body);
  }

  if (args.output) {
    await writeFile(args.output, output, 'utf8');
    console.log(`Wrote ${path.resolve(args.output)}`);
  } else {
    process.stdout.write(output);
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
