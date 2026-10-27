#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import YAML from 'yaml';

// FEATURE_150 (v0.7.37, finalized v0.7.39) — KodaX SDK loader for builtin helper scripts.
//
// These helper scripts (run-eval.js / grade-evals.js / etc.) need access to
// the runKodaX / estimateTokens API. The SDK lives in different places
// depending on install mode:
//
//   1. Bundle-installed (npm install -g @kodax-ai/kodax):
//      this file → <prefix>/lib/node_modules/@kodax-ai/kodax/dist/builtin/skill-creator/scripts/utils.js
//      SDK       → <prefix>/lib/node_modules/@kodax-ai/kodax/dist/index.js
//      Resolution: relative path '../../../index.js' (3 levels up from scripts/ to dist/)
//      → Strategy 1 covers 99%+ of bundle-installed users.
//
//   2. Dev monorepo / unusual bundle layouts:
//      this file → <repo>/packages/skills/dist/builtin/skill-creator/scripts/utils.js
//      SDK       → resolved via npm workspace symlink or installed package
//      Resolution: bare-name `@kodax-ai/kodax` (canonical SDK package)
//
// Workspace-internal package names and legacy package aliases are intentionally
// NOT in this chain. Published helper scripts must not rely on workspace-only
// package names.
//
// See docs/ADR.md ADR-022 / ADR-024 + docs/HLD.md §12 for the SDK distribution
// contract.

let _cachedSdk = null;

/** Published single-package entry, or the standalone Agent's public Skill API. */
export async function loadKodaXSkills() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const bundled = path.resolve(here, '../../../sdk-skills.js');
  if (existsSync(bundled)) return import(pathToFileURL(bundled).href);
  return import('@kodax-ai/agent/capabilities/skills');
}

export function setKodaXSDKForSkillCreator(sdk) {
  _cachedSdk = sdk;
}

export async function loadKodaXSDK() {
  if (_cachedSdk) return _cachedSdk;

  const here = path.dirname(fileURLToPath(import.meta.url));
  const errors = [];

  // Strategy 1: bundled install — relative path to dist/index.js
  // Layout: dist/builtin/<skill>/scripts/utils.js → ../../../index.js
  const relSdkPath = path.resolve(here, '../../../index.js');
  if (existsSync(relSdkPath)) {
    _cachedSdk = await import(pathToFileURL(relSdkPath).href);
    return _cachedSdk;
  }
  errors.push(`relative SDK path not found: ${relSdkPath}`);

  // Strategy 2: bare-name canonical (dev monorepo / rare edge-case fallback).
  // Keep the specifier computed so Vite does not resolve the root package
  // during test collection before the root dist entry exists.
  try {
    const packageName = ['@kodax-ai', 'kodax'].join('/');
    _cachedSdk = await import(packageName);
    return _cachedSdk;
  } catch (err) {
    errors.push(`bare-name @kodax-ai/kodax failed: ${err?.code ?? err?.message}`);
  }

  throw new Error(
    `Cannot locate KodaX SDK from helper script ${import.meta.url}.\nAttempted:\n  - ${errors.join('\n  - ')}`,
  );
}

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
