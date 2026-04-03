#!/usr/bin/env node
import { access, cp, mkdir } from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const skillSourceDir = path.join(scriptDir, 'skill');

function parseArgs(argv) {
  const parsed = {
    host: '',
    workspaceRoot: '',
    runDoctor: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--host') {
      parsed.host = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (arg === '--workspace-root') {
      parsed.workspaceRoot = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (arg === '--run-doctor') {
      parsed.runDoctor = true;
    }
  }

  return parsed;
}

function assertHost(host) {
  if (!['codex', 'claude', 'opencode', 'all'].includes(host)) {
    throw new Error('Usage: node clients/repointel/install.mjs --host <codex|claude|opencode|all> [--workspace-root <path>] [--run-doctor]');
  }
}

function ensureWorkspaceRoot(host, workspaceRoot) {
  if ((host === 'claude' || host === 'opencode' || host === 'all') && !workspaceRoot) {
    throw new Error('Workspace root is required for claude, opencode, or all.');
  }
}

function resolveCodexTarget() {
  const codexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
  return path.join(codexHome, 'skills', 'repointel');
}

function resolveHostTargets(host, workspaceRoot) {
  const resolvedWorkspaceRoot = workspaceRoot ? path.resolve(workspaceRoot) : '';
  switch (host) {
    case 'codex':
      return [{ label: 'Codex', target: resolveCodexTarget() }];
    case 'claude':
      return [{ label: 'Claude Code', target: path.join(resolvedWorkspaceRoot, '.claude', 'skills', 'repointel') }];
    case 'opencode':
      return [{ label: 'OpenCode', target: path.join(resolvedWorkspaceRoot, '.opencode', 'skills', 'repointel') }];
    case 'all':
      return [
        { label: 'Codex', target: resolveCodexTarget() },
        { label: 'Claude Code', target: path.join(resolvedWorkspaceRoot, '.claude', 'skills', 'repointel') },
        { label: 'OpenCode', target: path.join(resolvedWorkspaceRoot, '.opencode', 'skills', 'repointel') },
      ];
    default:
      return [];
  }
}

async function installSkill(target) {
  await mkdir(path.dirname(target), { recursive: true });
  await cp(skillSourceDir, target, { recursive: true, force: true });
}

function resolveOnPath(command) {
  const locator = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(locator, [command], { encoding: 'utf8' });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || null;
}

function resolveCliInvocation() {
  const explicitBin = process.env.KODAX_REPOINTEL_BIN?.trim();
  if (explicitBin) {
    const resolved = path.resolve(explicitBin);
    const extension = path.extname(resolved).toLowerCase();
    if (extension === '.ts' || extension === '.mts' || extension === '.cts') {
      return { command: process.platform === 'win32' ? 'npx.cmd' : 'npx', args: ['tsx', resolved] };
    }
    if (extension === '.js' || extension === '.mjs' || extension === '.cjs') {
      return { command: process.execPath, args: [resolved] };
    }
    return { command: resolved, args: [] };
  }

  const onPath = resolveOnPath('repointel');
  if (!onPath) {
    return null;
  }
  return { command: onPath, args: [] };
}

function runDoctor(installedTargets) {
  console.log('');
  console.log('Repointel install doctor');
  for (const { label, target } of installedTargets) {
    if (!target) {
      continue;
    }
    const skillEntry = path.join(target, 'SKILL.md');
    if (!existsSync(skillEntry)) {
      throw new Error(`${label} skill missing after install: ${skillEntry}`);
    }
    console.log(`OK   ${label} skill: ${skillEntry}`);
  }

  const cliInvocation = resolveCliInvocation();
  if (!cliInvocation) {
    console.warn('WARN Local repointel tool not found on PATH. Set KODAX_REPOINTEL_BIN or install the premium CLI before using the skill.');
    return;
  }

  const result = spawnSync(
    cliInvocation.command,
    [...cliInvocation.args, 'status', '{}'],
    {
      encoding: 'utf8',
      env: process.env,
      windowsHide: process.platform === 'win32',
    },
  );
  if (result.status !== 0) {
    console.warn(`WARN repointel status failed: ${result.stderr.trim() || result.stdout.trim() || 'unknown error'}`);
    return;
  }

  try {
    const parsed = JSON.parse(result.stdout);
    const transport = parsed?.result?.transport || 'unknown';
    const buildId = parsed?.buildId || parsed?.result?.buildId || 'unknown';
    console.log(`OK   repointel status: transport=${transport} buildId=${buildId}`);
  } catch {
    console.warn('WARN repointel status returned non-JSON output.');
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  assertHost(args.host);
  ensureWorkspaceRoot(args.host, args.workspaceRoot);

  await access(path.join(skillSourceDir, 'SKILL.md'), constants.R_OK);
  const targets = resolveHostTargets(args.host, args.workspaceRoot);
  for (const { label, target } of targets) {
    await installSkill(target);
    console.log(`Installed ${label} Repo Intelligence skill to ${target}`);
  }

  if (!args.runDoctor && !process.env.KODAX_REPOINTEL_BIN && !resolveOnPath('repointel')) {
    console.warn('WARN Local repointel tool not found on PATH. Set KODAX_REPOINTEL_BIN or install the premium CLI before using the skill.');
  }

  if (args.runDoctor) {
    runDoctor(targets);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
