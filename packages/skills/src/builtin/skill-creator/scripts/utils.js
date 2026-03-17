#!/usr/bin/env node

import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

export function toPosixPath(filePath) {
  return filePath.replace(/\\/g, '/');
}

export function extractFrontmatter(rawContent) {
  const normalized = rawContent
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trimStart();

  if (!normalized.startsWith('---\n')) {
    throw new Error('SKILL.md missing YAML frontmatter');
  }

  const closeIndex = normalized.indexOf('\n---\n', 4);
  if (closeIndex === -1) {
    throw new Error('SKILL.md has unclosed YAML frontmatter');
  }

  return {
    yamlText: normalized.slice(4, closeIndex),
    body: normalized.slice(closeIndex + 5).trim(),
  };
}

export function parseSkillMarkdown(rawContent) {
  const { yamlText, body } = extractFrontmatter(rawContent);
  const frontmatter = YAML.parse(yamlText);

  if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    throw new Error('Frontmatter must be a YAML object');
  }

  return {
    frontmatter,
    body,
  };
}

export async function loadSkill(skillDir) {
  const skillMdPath = path.join(skillDir, 'SKILL.md');
  const info = await stat(skillMdPath).catch(() => null);
  if (!info?.isFile()) {
    throw new Error(`SKILL.md not found in ${skillDir}`);
  }

  const rawContent = await readFile(skillMdPath, 'utf8');
  const { frontmatter, body } = parseSkillMarkdown(rawContent);

  return {
    skillDir: path.resolve(skillDir),
    skillMdPath,
    rawContent,
    body,
    frontmatter,
  };
}

export async function writeSkill(skillDir, frontmatter, body) {
  const skillMdPath = path.join(skillDir, 'SKILL.md');
  const yamlText = YAML.stringify(frontmatter).trimEnd();
  const content = `---\n${yamlText}\n---\n\n${body.trim()}\n`;
  await writeFile(skillMdPath, content, 'utf8');
}

export async function pathExists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

export function calculateStats(values) {
  if (!values.length) {
    return { mean: 0, stddev: 0, min: 0, max: 0 };
  }

  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.length > 1
    ? values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (values.length - 1)
    : 0;

  return {
    mean: roundNumber(mean),
    stddev: roundNumber(Math.sqrt(variance)),
    min: roundNumber(Math.min(...values)),
    max: roundNumber(Math.max(...values)),
  };
}

export function roundNumber(value, digits = 4) {
  return Number(value.toFixed(digits));
}

export function formatDelta(value) {
  return value >= 0 ? `+${value.toFixed(4)}` : value.toFixed(4);
}

export function extractTaggedText(text, tagName) {
  const pattern = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const match = text.match(pattern);
  return match?.[1]?.trim() ?? null;
}

export function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function extractJsonObject(text) {
  const direct = safeJsonParse(text.trim());
  if (direct && typeof direct === 'object') {
    return direct;
  }

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }

  return safeJsonParse(text.slice(firstBrace, lastBrace + 1));
}

export async function readJsonFile(filePath, fallback = null) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

export async function loadRelativeText(moduleUrl, relativePath) {
  const moduleDir = path.dirname(fileURLToPath(moduleUrl));
  return readFile(path.resolve(moduleDir, relativePath), 'utf8');
}

export function truncateText(text, maxChars = 12000) {
  const value = typeof text === 'string' ? text : String(text ?? '');
  if (value.length <= maxChars) {
    return value;
  }

  const hiddenChars = value.length - maxChars;
  return `${value.slice(0, maxChars)}\n\n[truncated ${hiddenChars} chars]`;
}

export function computePassSummary(expectations) {
  const total = Array.isArray(expectations) ? expectations.length : 0;
  const passed = Array.isArray(expectations)
    ? expectations.filter((item) => item?.passed === true).length
    : 0;
  const failed = Math.max(total - passed, 0);

  return {
    passed,
    failed,
    total,
    pass_rate: total > 0 ? roundNumber(passed / total) : 0,
  };
}

export async function collectFiles(rootDir, currentDir = rootDir, files = []) {
  const entries = await readdir(currentDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolutePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(rootDir, absolutePath, files);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    files.push({
      absolutePath,
      relativePath: path.relative(rootDir, absolutePath).replace(/\\/g, '/'),
    });
  }
  return files;
}

export function getDefaultSkillsDir() {
  return path.join(os.homedir(), '.kodax', 'skills');
}

export async function ensureDirectory(targetPath) {
  await mkdir(targetPath, { recursive: true });
  return targetPath;
}
