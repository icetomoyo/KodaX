#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';
import { validateSkillDirectory } from './quick-validate.js';
import { collectFiles, loadSkill } from './utils.js';

const PACKAGE_MANIFEST_PATH = '.kodax-package.json';

function toUint8Array(value) {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function createPackageManifest(skill, files, options = {}) {
  return {
    format: 'kodax-skill-package',
    version: 1,
    created_at: options.createdAt ?? new Date().toISOString(),
    entrypoint: 'SKILL.md',
    skill: {
      name: skill.frontmatter.name,
      description: skill.frontmatter.description,
      compatibility: skill.frontmatter.compatibility ?? null,
      user_invocable: skill.frontmatter['user-invocable'] ?? true,
      disable_model_invocation: skill.frontmatter['disable-model-invocation'] ?? false,
    },
    files: files.map((file) => ({
      path: file.relativePath,
      size: file.bytes.length,
      sha256: file.sha256,
    })),
    note: 'This archive is a zip file with a .skill extension. Compatible agents can extract and install the included skill directory.',
  };
}

export async function buildSkillPackage(skillDir, options = {}) {
  const validation = await validateSkillDirectory(skillDir);
  if (!validation.valid) {
    throw new Error(`Cannot package invalid skill:\n- ${validation.errors.join('\n- ')}`);
  }

  const skill = await loadSkill(skillDir);
  const discoveredFiles = await collectFiles(skillDir);
  const files = [];
  for (const file of discoveredFiles) {
    if (file.relativePath.endsWith('.skill')) {
      continue;
    }
    const bytes = toUint8Array(await readFile(file.absolutePath));
    files.push({
      ...file,
      bytes,
      sha256: sha256(bytes),
    });
  }

  const manifest = createPackageManifest(skill, files, options);
  const archiveEntries = {
    [PACKAGE_MANIFEST_PATH]: strToU8(JSON.stringify(manifest, null, 2)),
  };
  for (const file of files) {
    archiveEntries[file.relativePath] = file.bytes;
  }

  return {
    manifest,
    bytes: zipSync(archiveEntries, { level: 6 }),
  };
}

export async function writeSkillPackage(skillDir, outputPath, options = {}) {
  const result = await buildSkillPackage(skillDir, options);
  await writeFile(outputPath, result.bytes);
  return {
    ...result,
    outputPath: path.resolve(outputPath),
  };
}

function parseArgs(argv) {
  const args = {
    skillDir: argv[2],
    output: undefined,
  };

  for (let index = 3; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--output' && argv[index + 1]) {
      args.output = argv[++index];
    }
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.skillDir) {
    console.error('Usage: node scripts/package-skill.js <skill-dir> [--output <file.skill>]');
    process.exit(1);
  }

  const skill = await loadSkill(args.skillDir);
  const outputPath = args.output ?? path.join(path.dirname(args.skillDir), `${skill.frontmatter.name}.skill`);
  const result = await writeSkillPackage(args.skillDir, outputPath);
  console.log(`Wrote ${result.outputPath}`);
}

const isDirectRun = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
