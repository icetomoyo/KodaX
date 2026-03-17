#!/usr/bin/env node

import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { strFromU8, unzipSync } from 'fflate';
import { validateSkillDirectory } from './quick-validate.js';
import { getDefaultSkillsDir, parseSkillMarkdown, pathExists } from './utils.js';

const PACKAGE_MANIFEST_PATH = '.kodax-package.json';

function normalizeArchivePath(relativePath) {
  return relativePath.replace(/\\/g, '/').replace(/^\.?\//, '');
}

function assertSafeArchivePath(relativePath) {
  const normalized = normalizeArchivePath(relativePath);
  if (!normalized || normalized.startsWith('/') || normalized.includes('../')) {
    throw new Error(`Unsafe archive entry path: ${relativePath}`);
  }
  return normalized;
}

function isZipLike(filePath) {
  return /\.(skill|zip)$/i.test(filePath);
}

export function readSkillPackageBuffer(buffer) {
  const archive = unzipSync(buffer);
  const entries = Object.entries(archive).map(([relativePath, bytes]) => ({
    relativePath: assertSafeArchivePath(relativePath),
    bytes,
  }));

  const skillEntry = entries.find((entry) => entry.relativePath === 'SKILL.md');
  if (!skillEntry) {
    throw new Error('Archive is missing SKILL.md');
  }

  const parsedSkill = parseSkillMarkdown(strFromU8(skillEntry.bytes));
  const skillName = typeof parsedSkill.frontmatter.name === 'string'
    ? parsedSkill.frontmatter.name.trim()
    : '';
  const description = typeof parsedSkill.frontmatter.description === 'string'
    ? parsedSkill.frontmatter.description.trim()
    : '';
  if (!skillName || !description) {
    throw new Error('Archive SKILL.md is missing required frontmatter fields.');
  }

  const manifestEntry = entries.find((entry) => entry.relativePath === PACKAGE_MANIFEST_PATH);
  const manifest = manifestEntry
    ? JSON.parse(strFromU8(manifestEntry.bytes))
    : null;

  return {
    skillName,
    manifest,
    entries: entries.filter((entry) => entry.relativePath !== PACKAGE_MANIFEST_PATH),
  };
}

async function ensureInstallTarget(targetDir, force) {
  if (await pathExists(targetDir)) {
    if (!force) {
      throw new Error(`Target skill already exists: ${targetDir}`);
    }
    await rm(targetDir, { recursive: true, force: true });
  }
  await mkdir(targetDir, { recursive: true });
}

export async function installSkillArchive(archivePath, options = {}) {
  const skillsDir = path.resolve(options.skillsDir ?? getDefaultSkillsDir());
  const archive = readSkillPackageBuffer(await readFile(archivePath));
  const targetDir = path.join(skillsDir, archive.skillName);
  await ensureInstallTarget(targetDir, options.force === true);

  for (const entry of archive.entries) {
    const destination = path.join(targetDir, entry.relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, entry.bytes);
  }

  return {
    skillName: archive.skillName,
    installedTo: targetDir,
    source: path.resolve(archivePath),
    manifest: archive.manifest,
  };
}

export async function installSkillDirectory(skillDir, options = {}) {
  const validation = await validateSkillDirectory(skillDir);
  if (!validation.valid) {
    throw new Error(`Cannot install invalid skill:\n- ${validation.errors.join('\n- ')}`);
  }

  const skillFilePath = path.join(skillDir, 'SKILL.md');
  const skill = parseSkillMarkdown(await readFile(skillFilePath, 'utf8'));
  const skillsDir = path.resolve(options.skillsDir ?? getDefaultSkillsDir());
  const targetDir = path.join(skillsDir, skill.frontmatter.name);
  if (await pathExists(targetDir)) {
    if (!options.force) {
      throw new Error(`Target skill already exists: ${targetDir}`);
    }
    await rm(targetDir, { recursive: true, force: true });
  }
  await mkdir(skillsDir, { recursive: true });
  await cp(skillDir, targetDir, { recursive: true });

  return {
    skillName: skill.frontmatter.name,
    installedTo: targetDir,
    source: path.resolve(skillDir),
    manifest: null,
  };
}

export async function installSkill(inputPath, options = {}) {
  const resolvedInput = path.resolve(inputPath);
  const inputStat = await stat(resolvedInput).catch(() => null);
  if (!inputStat) {
    throw new Error(`Input not found: ${resolvedInput}`);
  }

  if (inputStat.isDirectory()) {
    return installSkillDirectory(resolvedInput, options);
  }

  if (inputStat.isFile() && isZipLike(resolvedInput)) {
    return installSkillArchive(resolvedInput, options);
  }

  throw new Error('Input must be a skill directory or a .skill/.zip archive.');
}

function parseArgs(argv) {
  const args = {
    input: argv[2],
    skillsDir: undefined,
    force: false,
  };

  for (let index = 3; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--dest' && argv[index + 1]) {
      args.skillsDir = argv[++index];
    } else if (token === '--force') {
      args.force = true;
    }
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.input) {
    console.error('Usage: node scripts/install-skill.js <skill-dir-or-archive> [--dest <skills-dir>] [--force]');
    process.exit(1);
  }

  const result = await installSkill(args.input, args);
  console.log(`Installed ${result.skillName} to ${result.installedTo}`);
}

const isDirectRun = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
