#!/usr/bin/env node
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const defaultPublicRepoRoot = repoRoot;
const defaultPrivateRepoRoot = path.resolve(repoRoot, '..', 'KodaX-private');

function parseArgs(argv) {
  const args = {
    publicRepoRoot: defaultPublicRepoRoot,
    privateRepoRoot: defaultPrivateRepoRoot,
    endpoint: '',
    skipBuild: false,
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
    if (arg === '--skip-build') {
      args.skipBuild = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!args.endpoint.trim()) {
    const demoPort = 47000 + Math.floor(Math.random() * 2000);
    args.endpoint = `http://127.0.0.1:${demoPort}`;
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

function main() {
  const args = parseArgs(process.argv.slice(2));
  const privateCliDist = path.join(args.privateRepoRoot, 'packages', 'repointel-cli', 'dist', 'index.js');
  const vitestEntrypoint = path.join(args.publicRepoRoot, 'node_modules', 'vitest', 'vitest.mjs');
  const repoEnv = {
    ...process.env,
    KODAX_REPO_INTELLIGENCE_MODE: 'premium-native',
    KODAX_REPO_INTELLIGENCE_TRACE: '1',
    KODAX_REPOINTEL_ENDPOINT: args.endpoint,
    KODAX_REPOINTEL_BIN: privateCliDist,
  };

  if (!args.skipBuild) {
    console.log('Building public repo...');
    runCommand('npm', ['run', 'build'], { cwd: args.publicRepoRoot, env: repoEnv });

    console.log('Building private repo...');
    runCommand('npm', ['run', 'build'], { cwd: args.privateRepoRoot, env: repoEnv });
  }

  console.log('Checking premium status...');
  const initialStatusRaw = runCommand('node', [privateCliDist, 'status', '{}'], {
    cwd: args.privateRepoRoot,
    env: repoEnv,
    capture: true,
  });
  const initialStatus = JSON.parse(initialStatusRaw);
  console.log(`Initial transport: ${initialStatus.result.transport}`);

  console.log('Warming premium daemon...');
  runCommand('node', [privateCliDist, 'warm', '{}'], {
    cwd: args.publicRepoRoot,
    env: repoEnv,
  });

  const daemonStatusRaw = runCommand('node', [privateCliDist, 'status', '{}'], {
    cwd: args.publicRepoRoot,
    env: repoEnv,
    capture: true,
  });
  const daemonStatus = JSON.parse(daemonStatusRaw);
  console.log(`Post-warm transport: ${daemonStatus.result.transport}`);
  if (daemonStatus.result.transport !== 'daemon') {
    throw new Error(`Premium daemon did not become reachable at ${args.endpoint}.`);
  }

  console.log('Running public runtime smoke...');
  runCommand('node', [vitestEntrypoint, 'run', 'packages/coding/src/repo-intelligence/runtime.test.ts'], {
    cwd: args.publicRepoRoot,
    env: repoEnv,
  });

  console.log('');
  console.log('Demo environment is ready.');
  console.log(`Mode      : ${repoEnv.KODAX_REPO_INTELLIGENCE_MODE}`);
  console.log(`Endpoint  : ${repoEnv.KODAX_REPOINTEL_ENDPOINT}`);
  console.log(`CLI path  : ${repoEnv.KODAX_REPOINTEL_BIN}`);
  console.log('');
  console.log('Next commands you can run manually:');
  console.log(`  cd ${args.publicRepoRoot}`);
  console.log('  kodax --repo-intelligence premium-native --repo-intelligence-trace');
  console.log(`  node ${path.join(args.publicRepoRoot, 'clients', 'repointel', 'install.mjs')} --host codex`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
