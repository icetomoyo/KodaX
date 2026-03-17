#!/usr/bin/env node

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDirectory, getDefaultSkillsDir, pathExists } from './utils.js';

function titleFromSlug(name) {
  return name
    .split('-')
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ');
}

export function renderSkillTemplate(name, description) {
  const title = titleFromSlug(name);
  return `---
name: ${name}
description: ${description}
user-invocable: true
allowed-tools: "Read, Grep, Glob"
compatibility: "Optimized for KodaX and Agent Skills style directories."
---

# ${title}

Describe the task this skill handles, the trigger boundary, and the expected outcome.

## When to use

- Use this skill when the user asks for ${title.toLowerCase()}.
- Do not use this skill when the request only needs a short explanation or is out of scope.

## Workflow

1. Restate the task boundary in one sentence.
2. Gather the minimum context needed to do the work well.
3. Execute the task, preferring small, verifiable steps.
4. Summarize what changed, what was validated, and any remaining risks.

## References

- Put deeper guidance in \`references/\`.
- Put reusable templates or static files in \`assets/\`.
- Put repeatable helper scripts in \`scripts/\`.
`;
}

export function renderEvalTemplate(name) {
  return JSON.stringify({
    skill_name: name,
    evals: [
      {
        id: 1,
        prompt: 'TODO: Add a realistic user request to evaluate this skill.',
        expected_output: 'Describe what a successful result should accomplish.',
        files: [],
        assertions: [],
      },
    ],
  }, null, 2);
}

export async function initSkill(options) {
  const baseDir = path.resolve(options.baseDir ?? getDefaultSkillsDir());
  const skillDir = path.join(baseDir, options.name);
  const description = options.description
    ?? `Describe what ${options.name} does and when it should be used.`;

  if (await pathExists(skillDir)) {
    if (!options.force) {
      throw new Error(`Skill directory already exists: ${skillDir}`);
    }
  }

  await ensureDirectory(skillDir);
  await ensureDirectory(path.join(skillDir, 'references'));
  await ensureDirectory(path.join(skillDir, 'assets'));
  await ensureDirectory(path.join(skillDir, 'scripts'));

  await writeFile(
    path.join(skillDir, 'SKILL.md'),
    renderSkillTemplate(options.name, description),
    'utf8'
  );

  if (options.includeEvals !== false) {
    await ensureDirectory(path.join(skillDir, 'evals'));
    await writeFile(
      path.join(skillDir, 'evals', 'evals.json'),
      `${renderEvalTemplate(options.name)}\n`,
      'utf8'
    );
  }

  return {
    skillDir,
    created: [
      'SKILL.md',
      ...(options.includeEvals !== false ? ['evals/evals.json'] : []),
      'references/',
      'assets/',
      'scripts/',
    ],
  };
}

function parseArgs(argv) {
  const args = {
    name: argv[2],
    baseDir: undefined,
    description: undefined,
    force: false,
    includeEvals: true,
  };

  for (let index = 3; index < argv.length; index += 1) {
    const token = argv[index];
    if ((token === '--path' || token === '--dest') && argv[index + 1]) {
      args.baseDir = argv[++index];
    } else if (token === '--description' && argv[index + 1]) {
      args.description = argv[++index];
    } else if (token === '--force') {
      args.force = true;
    } else if (token === '--no-evals') {
      args.includeEvals = false;
    }
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.name) {
    console.error('Usage: node scripts/init-skill.js <skill-name> [--path <skills-dir>] [--description <text>] [--force] [--no-evals]');
    process.exit(1);
  }

  const result = await initSkill(args);
  console.log(`Initialized ${result.skillDir}`);
}

const isDirectRun = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
