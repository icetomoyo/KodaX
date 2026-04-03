#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..', '..');
const defaultPublicRepoRoot = repoRoot;
const defaultPrivateRepoRoot = path.resolve(repoRoot, '..', 'KodaX-private');

function parseArgs(argv) {
  const args = {
    publicRepoRoot: defaultPublicRepoRoot,
    privateRepoRoot: defaultPrivateRepoRoot,
    endpoint: '',
    host: 'none',
    workspaceRoot: '',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--public-repo-root') {
      args.publicRepoRoot = path.resolve(argv[index + 1] || args.publicRepoRoot);
      index += 1;
      continue;
    }
    if (arg === '--private-repo-root') {
      args.privateRepoRoot = path.resolve(argv[index + 1] || args.privateRepoRoot);
      index += 1;
      continue;
    }
    if (arg === '--endpoint') {
      args.endpoint = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (arg === '--host') {
      args.host = argv[index + 1] || 'none';
      index += 1;
      continue;
    }
    if (arg === '--workspace-root') {
      args.workspaceRoot = path.resolve(argv[index + 1] || '');
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!['none', 'codex', 'claude', 'opencode'].includes(args.host)) {
    throw new Error(`Unsupported host: ${args.host}`);
  }

  if (!args.endpoint.trim()) {
    const doctorPort = 47000 + Math.floor(Math.random() * 2000);
    args.endpoint = `http://127.0.0.1:${doctorPort}`;
  }

  return args;
}

function runCommand(command, commandArgs, options = {}) {
  const executable = process.platform === 'win32' && (command === 'npm' || command === 'npx')
    ? `${command}.cmd`
    : command;
  const result = spawnSync(executable, commandArgs, {
    stdio: options.capture ? 'pipe' : 'inherit',
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    const stdout = result.stdout?.trim();
    const details = stderr || stdout;
    throw new Error(details ? `${executable} ${commandArgs.join(' ')} failed: ${details}` : `${executable} ${commandArgs.join(' ')} failed.`);
  }
  return result.stdout || '';
}

function writeCheck(label, value) {
  const padded = `${label}:`.padEnd(28, ' ');
  console.log(`${padded}${value}`);
}

function assertPath(label, filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} missing: ${filePath}`);
  }
  writeCheck(label, filePath);
}

function resolveHostSkillPath(host, workspaceRoot) {
  if (host === 'codex') {
    const codexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
    return path.join(codexHome, 'skills', 'repointel', 'SKILL.md');
  }
  if (host === 'claude') {
    return path.join(workspaceRoot, '.claude', 'skills', 'repointel', 'SKILL.md');
  }
  if (host === 'opencode') {
    return path.join(workspaceRoot, '.opencode', 'skills', 'repointel', 'SKILL.md');
  }
  return '';
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const privateCliDist = path.join(args.privateRepoRoot, 'packages', 'repointel-cli', 'dist', 'index.js');
  const publicBridgeDist = path.join(args.publicRepoRoot, 'packages', 'coding', 'dist', 'repo-intelligence', 'public-bridge.js');
  const repoEnv = {
    ...process.env,
    KODAX_REPOINTEL_ENDPOINT: args.endpoint,
  };

  console.log('Repointel doctor');
  console.log('');

  assertPath('Public repo', args.publicRepoRoot);
  assertPath('Private repo', args.privateRepoRoot);
  assertPath('Private CLI dist', privateCliDist);
  assertPath('Public bridge dist', publicBridgeDist);

  const initialStatusRaw = runCommand('node', [privateCliDist, 'status', '{}'], {
    cwd: args.privateRepoRoot,
    env: repoEnv,
    capture: true,
  });
  const initialStatus = JSON.parse(initialStatusRaw);
  writeCheck('Initial transport', initialStatus.result.transport);

  runCommand('node', [privateCliDist, 'warm', '{}'], {
    cwd: args.publicRepoRoot,
    env: repoEnv,
  });

  const warmStatusRaw = runCommand('node', [privateCliDist, 'status', '{}'], {
    cwd: args.publicRepoRoot,
    env: repoEnv,
    capture: true,
  });
  const warmStatus = JSON.parse(warmStatusRaw);
  writeCheck('Post-warm transport', warmStatus.result.transport);
  writeCheck('Endpoint', args.endpoint);
  if (warmStatus.result.transport !== 'daemon') {
    throw new Error(`Expected daemon transport after warm, got ${warmStatus.result.transport}`);
  }

  if (args.host !== 'none') {
    if ((args.host === 'claude' || args.host === 'opencode') && !args.workspaceRoot) {
      throw new Error(`--workspace-root is required for host ${args.host}`);
    }
    assertPath(`${args.host} skill`, resolveHostSkillPath(args.host, args.workspaceRoot));
  }

  console.log('');
  console.log('Doctor checks passed.');
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
