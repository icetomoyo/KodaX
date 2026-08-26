#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronDist = requirePath('KODAX_ELECTRON_DIST');
const electronBuilderCli = requirePath('KODAX_ELECTRON_BUILDER_CLI');
const electronPackage = JSON.parse(await readFile(path.join(electronDist, '..', 'package.json'), 'utf8'));
const temporaryBase = process.env.KODAX_NATIVE_TEST_TEMP
  ?? process.env.RUNNER_TEMP
  ?? os.tmpdir();
await mkdir(temporaryBase, { recursive: true });
const temporaryRoot = await mkdtemp(path.join(temporaryBase, 'kodax-electron-daemon-smoke-'));
const appDir = path.join(temporaryRoot, 'app');
const programDataDir = path.resolve(
  process.env.ProgramData ?? process.env.PROGRAMDATA ?? 'C:\\ProgramData',
);
const homeDir = process.env.KODAX_ELECTRON_SMOKE_HOME
  ?? path.join(temporaryRoot, 'home');
const externalHomeDir = process.env.KODAX_ELECTRON_SMOKE_HOME !== undefined;
const profile = `electron-smoke-${process.pid}-${Date.now()}`;
const ordinaryQueryCount = 20;
let electronProcess;
let electronSpawnError;
const electronOutput = [];
let smokePassed = false;

try {
  const consoleProbe = await prepareConsoleProbe();
  await preparePackagedApplication(electronPackage.version);
  await verifyIndependentWindowsSandboxPolicySharing();
  const executable = path.join(appDir, 'release', 'win-unpacked', 'kodax-daemon-smoke.exe');
  assert.ok(existsSync(executable), `Packaged Electron executable is missing: ${executable}`);
  const resultFile = path.join(temporaryRoot, 'result.json');
  const detachFile = path.join(temporaryRoot, 'detach');
  const guiCountFile = path.join(temporaryRoot, 'gui-count.txt');
  const environmentProofFile = path.join(temporaryRoot, 'environment-proof.json');
  electronProcess = startElectron(executable, {
    resultFile,
    detachFile,
    guiCountFile,
    environmentProofFile,
    consoleProbe,
    queryCount: ordinaryQueryCount,
    sessionId: 'windows-gui-query-smoke',
  });

  // Cover cold start plus 20 end-to-end sandboxed Shell commands even on
  // slower CI/antivirus hosts.
  const result = await waitForJson(resultFile, 600_000);
  assert.deepEqual(result.ok, true, result.error ?? 'Packaged Electron startup failed.');
  assert.equal(result.clientCount, 1, 'The packaged facade must be the only logical client after cold start.');
  assert.equal(result.ordinaryQueryCount, ordinaryQueryCount);
  assert.equal(result.parallelSessionCount, 4, 'The packaged smoke must exercise four concurrent Runtime sessions.');
  assert.equal(
    result.appliedSandboxCount,
    ordinaryQueryCount,
    'Every packaged Runtime query must execute Bash through the Windows restricted-user sandbox.',
  );
  const {
    sandboxDoctor,
    directSandboxProbe,
    directPowerShellProbe,
    ...environmentProof
  } = result.environmentProof;
  assert.deepEqual(environmentProof, {
    daemon: 'absent',
    externalChild: 'absent',
    externalChildStatus: 0,
    shellProbe: 'shell-probe-ok',
    shellProbeExitCode: 0,
    shellProbeNodeMode: 'absent',
    shellProbeToolchain: 'profile-toolchain-ok',
  }, 'The Electron Node bootstrap switch must not reach daemon or user child code.');
  assert.equal(
    sandboxDoctor?.ready,
    true,
    `The packaged daemon OS sandbox must be ready: ${JSON.stringify(sandboxDoctor)}`,
  );
  assert.deepEqual(directSandboxProbe, {
    status: 'completed',
    sandboxed: true,
    exitCode: 0,
    stdout: 'direct-sandbox-ok',
    stderr: '',
  }, 'The packaged Electron executable must start directly under the restricted-user sandbox.');
  assert.equal(directPowerShellProbe?.status, 'completed');
  assert.equal(directPowerShellProbe?.sandboxed, true);
  assert.equal(directPowerShellProbe?.exitCode, 0);
  assert.match(directPowerShellProbe?.stdout ?? '', /direct-powershell-ok/);
  assert.equal(directPowerShellProbe?.stderr, '');
  await verifyConsoleProbe(consoleProbe);
  await assertNoAclPoisonMarkers(
    'Completed Shell commands must release every ACL owner while the packaged daemon remains active.',
  );
  const sdk = await importInstalledRuntimeSdk();
  await verifyAttachDetachAndOwnerFence(
    sdk,
    executable,
    result.runtimeId,
    detachFile,
    guiCountFile,
    consoleProbe,
  );
  await waitForExit(electronProcess, 15_000);
  smokePassed = true;
  process.stdout.write(`Packaged Electron daemon smoke passed for Electron ${electronPackage.version}.\n`);
} finally {
  if (electronProcess?.exitCode === null) electronProcess.kill();
  await stopDaemonBestEffort();
  if (!smokePassed && process.env.KODAX_KEEP_ELECTRON_SMOKE === '1') {
    process.stderr.write(`[electron-daemon-smoke] retained failure artifacts: ${temporaryRoot}\n`);
  } else {
    try {
      await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      if (externalHomeDir) {
        await rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    } catch (error) {
      if (smokePassed) throw error;
      process.stderr.write(
        `[electron-daemon-smoke] cleanup warning; retained failure artifacts at ${temporaryRoot}: ${String(error)}\n`,
      );
    }
  }
}

async function prepareConsoleProbe() {
  const binaryDir = path.join(temporaryRoot, 'console-probe-bin');
  // Runtime Git probes execute inside the workspace sandbox, so their read
  // query and write observations must remain inside the admitted workspace.
  const observationDir = path.join(homeDir, 'workspace', '.console-probe-observations');
  const queryFile = path.join(homeDir, 'workspace', '.console-probe-query.txt');
  const sourceFile = path.join(temporaryRoot, 'console-probe.cs');
  const executable = path.join(binaryDir, 'git.exe');
  await mkdir(binaryDir, { recursive: true });
  await mkdir(observationDir, { recursive: true });
  await writeFile(queryFile, 'idle', 'utf8');
  await writeFile(sourceFile, consoleProbeSource(), 'utf8');

  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  assert.ok(systemRoot, 'SystemRoot is required for the Windows console probe.');
  const powershell = path.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  assert.ok(existsSync(powershell), `Windows PowerShell is missing: ${powershell}`);
  const compile = [
    'Add-Type',
    '-Path', quotePowerShell(sourceFile),
    '-OutputAssembly', quotePowerShell(executable),
    '-OutputType', 'ConsoleApplication',
  ].join(' ');
  await run(
    powershell,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', compile],
    repoRoot,
    60_000,
  );
  assert.ok(existsSync(executable), `Console probe was not compiled: ${executable}`);
  return { binaryDir, executable, observationDir, queryFile };
}

function consoleProbeSource() {
  return String.raw`
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public static class Program {
  [DllImport("kernel32.dll")]
  private static extern IntPtr GetConsoleWindow();

  [DllImport("user32.dll")]
  private static extern bool IsWindowVisible(IntPtr window);

  public static int Main(string[] args) {
    string observationDirectory = Environment.GetEnvironmentVariable("KODAX_CONSOLE_PROBE_DIR");
    string queryFile = Environment.GetEnvironmentVariable("KODAX_CONSOLE_PROBE_QUERY");
    string query = Environment.GetEnvironmentVariable("KODAX_CONSOLE_PROBE_QUERY_ID");
    if (String.IsNullOrWhiteSpace(query)) {
      query = File.Exists(queryFile) ? File.ReadAllText(queryFile).Trim() : "unattributed";
    }
    Thread.Sleep(25);
    IntPtr window = GetConsoleWindow();
    string state = window == IntPtr.Zero ? "none" : (IsWindowVisible(window) ? "visible" : "hidden");
    Directory.CreateDirectory(observationDirectory);
    string file = Path.Combine(
      observationDirectory,
      query + "-" + Process.GetCurrentProcess().Id + "-" + DateTime.UtcNow.Ticks + ".txt"
    );
    File.WriteAllText(file, state + "\t" + string.Join("\u001f", args));

    string command = string.Join(" ", args);
    if (command == "config --get remote.origin.url") {
      Console.WriteLine("https://example.test/kodax/repo.git");
    } else if (command == "rev-parse --is-inside-work-tree") {
      Console.WriteLine("true");
    } else if (command == "rev-parse --show-toplevel") {
      Console.WriteLine(Environment.CurrentDirectory);
    } else if (command == "branch --show-current") {
      Console.WriteLine("main");
    } else if (command == "rev-parse --short HEAD") {
      Console.WriteLine("abcdef0");
    } else if (command == "--profile-toolchain") {
      Console.WriteLine("profile-toolchain-ok");
    } else if (args.Length == 5 && args[0] == "--profile-toolchain" && args[1] == "--barrier") {
      string barrierDirectory = args[2];
      int expected = Int32.Parse(args[4]);
      Directory.CreateDirectory(barrierDirectory);
      File.WriteAllText(Path.Combine(barrierDirectory, args[3] + ".ready"), "ready");
      DateTime deadline = DateTime.UtcNow.AddSeconds(120);
      while (Directory.GetFiles(barrierDirectory, "*.ready").Length < expected) {
        if (DateTime.UtcNow >= deadline) return 98;
        Thread.Sleep(25);
      }
      Console.WriteLine("profile-toolchain-ok");
      Console.WriteLine("parallel-barrier-ok");
    }
    return 0;
  }
}
`;
}

async function verifyConsoleProbe(probe) {
  const records = [];
  for (const file of await readdir(probe.observationDir)) {
    const match = /^(\d+)-/.exec(file);
    if (!match) continue;
    const [state, args = ''] = (await readFile(path.join(probe.observationDir, file), 'utf8'))
      .split('\t', 2);
    records.push({ query: Number(match[1]), state, args: args.split('\u001f') });
  }

  for (let query = 0; query < ordinaryQueryCount; query += 1) {
    const queryRecords = records.filter((record) => record.query === query);
    assert.ok(
      queryRecords.some((record) => record.args[0] === '--profile-toolchain'),
      `Ordinary query ${query} must execute the profile-tool probe.`,
    );
    assert.ok(
      queryRecords.some((record) => record.args.join(' ') === 'rev-parse --short HEAD'),
      `Ordinary query ${query} must execute the Git probe.`,
    );
    for (const record of queryRecords) {
      assert.notEqual(
        record.state,
        'visible',
        `Ordinary query ${query} created a visible console for git ${record.args.join(' ')}.`,
      );
    }
  }
}

function quotePowerShell(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

async function preparePackagedApplication(electronVersion) {
  const fixture = path.join(repoRoot, 'tests', 'fixtures', 'electron-daemon-smoke');
  await cp(fixture, appDir, { recursive: true });
  const packOutput = await runNpm(['pack', '--pack-destination', temporaryRoot, '--json'], repoRoot);
  const [{ filename }] = JSON.parse(packOutput);
  await runNpm([
    'install', '--save-exact', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund',
    path.join(temporaryRoot, filename),
  ], appDir, 600_000);
  await writeFile(
    path.join(appDir, 'electron-builder.json'),
    JSON.stringify(createBuilderConfig(electronVersion), null, 2),
    'utf8',
  );
  await run(process.execPath, [electronBuilderCli, '--dir', '--win', '--x64', '--config', 'electron-builder.json'], appDir, 300_000);
}

async function verifyIndependentWindowsSandboxPolicySharing() {
  const crossProcessHome = path.join(homeDir, 'cross-process-home');
  const workspace = path.join(crossProcessHome, 'workspace');
  const barrierScript = path.join(workspace, 'policy-barrier.cjs');
  const worker = path.join(repoRoot, 'tests', 'fixtures', 'windows-sandbox-policy-worker.mts');
  const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  await mkdir(workspace, { recursive: true });
  await writeFile(barrierScript, String.raw`
const fs = require('node:fs');
const path = require('node:path');
const [directory, participant, expectedText] = process.argv.slice(2);
const expected = Number(expectedText);
fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(path.join(directory, participant + '.ready'), 'ready', 'utf8');
const deadline = Date.now() + 120_000;
const wait = () => {
  if (fs.readdirSync(directory).filter((name) => name.endsWith('.ready')).length >= expected) {
    process.stdout.write('cross-process-sandbox-ok:' + participant);
    return;
  }
  if (Date.now() >= deadline) {
    process.stderr.write('cross-process barrier timed out');
    process.exitCode = 98;
    return;
  }
  setTimeout(wait, 25);
};
wait();
`, 'utf8');
  const {
    KODAX_HOME: _ignoredHome,
    ProgramData: _ignoredProgramData,
    PROGRAMDATA: _ignoredUpperProgramData,
    VITEST: _ignoredVitest,
    ...baseEnvironment
  } = process.env;
  const workerEnvironment = {
    ...baseEnvironment,
    ProgramData: programDataDir,
    KODAX_HOME: path.join(crossProcessHome, '.kodax'),
    KODAX_CROSS_PROCESS_WORKSPACE: workspace,
    KODAX_CROSS_PROCESS_BARRIER: barrierScript,
    PATH: [
      path.dirname(process.execPath),
      process.env.PATH ?? process.env.Path ?? '',
    ].filter(Boolean).join(path.delimiter),
  };
  const runWorker = async (participant, expected, barrierName, preflightDirectory) => {
    const barrierDirectory = path.join(workspace, '.policy-barriers', barrierName);
    const resultFile = path.join(temporaryRoot, `cross-process-${participant}.json`);
    await mkdir(barrierDirectory, { recursive: true });
    let launchError;
    try {
      await run(process.execPath, [tsxCli, worker], repoRoot, 300_000, {
        ...workerEnvironment,
        KODAX_CROSS_PROCESS_PARTICIPANT: participant,
        KODAX_CROSS_PROCESS_EXPECTED: String(expected),
        KODAX_CROSS_PROCESS_BARRIER_DIR: barrierDirectory,
        KODAX_CROSS_PROCESS_RESULT: resultFile,
        ...(preflightDirectory === undefined
          ? {}
          : { KODAX_CROSS_PROCESS_PREFLIGHT_DIR: preflightDirectory }),
      });
    } catch (error) {
      launchError = error;
    }
    const result = existsSync(resultFile)
      ? JSON.parse(await readFile(resultFile, 'utf8'))
      : undefined;
    assert.ok(result, `Cross-process sandbox worker ${participant} did not publish a result: ${String(launchError)}`);
    assert.equal(result.error, undefined, result.error ?? String(launchError ?? 'worker failed'));
    assert.match(result.result, new RegExp(`cross-process-sandbox-ok:${participant}`));
    assert.match(result.result, /(?:^|\n)Exit: 0(?:\n|$)/);
    assert.doesNotMatch(result.result, /\[Error\]/);
    assert.ok(
      result.observations.some((observation) => (
        observation?.state === 'applied'
        && observation.backend === 'windows-restricted-user'
      )),
      `Independent worker ${participant} did not use the Windows sandbox: ${JSON.stringify({
        observations: result.observations,
        diagnostics: result.diagnostics,
      })}`,
    );
    return result;
  };

  await runWorker('warmup', 1, 'warmup');
  const preflightDirectory = path.join(workspace, '.policy-preflight');
  await mkdir(preflightDirectory, { recursive: true });
  const workers = [
    runWorker('process-a', 2, 'parallel', preflightDirectory),
    runWorker('process-b', 2, 'parallel', preflightDirectory),
  ];
  const preflightDeadline = Date.now() + 30_000;
  while (!['process-a', 'process-b'].every((participant) => (
    existsSync(path.join(preflightDirectory, `${participant}.ready`))
  ))) {
    if (Date.now() >= preflightDeadline) {
      throw new Error('Independent sandbox workers did not finish readiness preflight.');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await writeFile(path.join(preflightDirectory, 'start'), 'start', 'utf8');
  await Promise.all(workers);
  await assertNoAclPoisonMarkers(
    'Independent same-policy KodaX processes must release all ACL owners after both commands finish.',
    crossProcessHome,
  );
}

function createBuilderConfig(electronVersion) {
  return {
    appId: 'ai.kodax.daemon.smoke',
    productName: 'KodaXDaemonSmoke',
    electronVersion,
    electronDist,
    asar: true,
    npmRebuild: false,
    directories: { output: 'release' },
    files: ['main.cjs', 'package.json', 'node_modules/**/*'],
    win: { target: 'dir', executableName: 'kodax-daemon-smoke', signAndEditExecutable: false },
  };
}

function startElectron(executable, files) {
  const {
    ELECTRON_RUN_AS_NODE: _ignored,
    PATH: parentUpperPath,
    Path: parentMixedPath,
    ...parentEnvironment
  } = process.env;
  const child = spawn(executable, [], {
    cwd: path.dirname(executable),
    windowsHide: true,
    env: {
      ...parentEnvironment,
      ProgramData: programDataDir,
      KODAX_HOME: path.join(homeDir, '.kodax'),
      KODAX_SMOKE_HOME: homeDir,
      KODAX_SMOKE_PROFILE: profile,
      KODAX_SMOKE_RESULT: files.resultFile,
      KODAX_SMOKE_DETACH: files.detachFile,
      KODAX_SMOKE_GUI_COUNT: files.guiCountFile,
      KODAX_SMOKE_ENV_PROOF: files.environmentProofFile,
      KODAX_SMOKE_QUERY_COUNT: String(files.queryCount),
      KODAX_SMOKE_SESSION_ID: files.sessionId,
      KODAX_CONSOLE_PROBE_DIR: files.consoleProbe.observationDir,
      KODAX_CONSOLE_PROBE_QUERY: files.consoleProbe.queryFile,
      KODAX_CONSOLE_PROBE_EXECUTABLE: files.consoleProbe.executable,
      KODAX_SMOKE_NODE_EXECUTABLE: process.execPath,
      KODAX_SMOKE_PROFILE_TOOLCHAIN: path.join(homeDir, 'profile-toolchain'),
      KODAX_TRACING: '0',
      PATH: [
        files.consoleProbe.binaryDir,
        parentUpperPath ?? parentMixedPath ?? '',
      ].filter(Boolean).join(path.delimiter),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => electronOutput.push(chunk));
  child.stderr.on('data', (chunk) => electronOutput.push(chunk));
  child.once('error', (error) => { electronSpawnError = error; });
  return child;
}

async function importInstalledRuntimeSdk() {
  const entry = path.join(appDir, 'node_modules', '@kodax-ai', 'kodax', 'dist', 'sdk-runtime.js');
  return import(pathToFileURL(entry).href);
}

async function verifyAttachDetachAndOwnerFence(
  sdk,
  executable,
  runtimeId,
  detachFile,
  guiCountFile,
  consoleProbe,
) {
  const attached = await sdk.connectKodaXRuntime({
    homeDir,
    profile,
    autoStart: false,
    clientInfo: { name: 'node-smoke', instanceId: 'node-smoke' },
    requirements: { daemonManagement: 1 },
  });
  assert.equal(attached.identity.runtimeId, runtimeId);
  await waitForClientCount(attached, 2);
  await attached.close();
  await writeFile(detachFile, 'detach', 'utf8');
  await waitForExit(electronProcess, 15_000);
  assert.equal((await readFile(guiCountFile, 'utf8')).trim().split(/\r?\n/).length, 1);

  const management = await sdk.connectKodaXRuntime({ homeDir, profile, autoStart: false, requirements: { daemonManagement: 1 } });
  assert.equal(management.identity.runtimeId, runtimeId, 'Electron close must detach without stopping the daemon.');
  await waitForClientCount(management, 1);
  await stopForInline(management);
  await management.close();
  await waitForUnowned(sdk);
  await assertNoAclPoisonMarkers('A clean packaged-daemon stop must remove every ACL owner marker.');
  assert.equal((await enableDaemonOwnerWhenReady(sdk)).mode, 'daemon');

  const restartResultFile = path.join(temporaryRoot, 'restart-result.json');
  const restartDetachFile = path.join(temporaryRoot, 'restart-detach');
  const restartEnvironmentProofFile = path.join(temporaryRoot, 'restart-environment-proof.json');
  electronSpawnError = undefined;
  electronOutput.length = 0;
  electronProcess = startElectron(executable, {
    resultFile: restartResultFile,
    detachFile: restartDetachFile,
    guiCountFile,
    environmentProofFile: restartEnvironmentProofFile,
    consoleProbe,
    queryCount: 1,
    sessionId: 'windows-gui-query-smoke-restart',
  });
  const restartResult = await waitForJson(restartResultFile, 600_000);
  assert.equal(restartResult.ok, true, restartResult.error ?? 'Packaged Electron restart failed.');
  assert.notEqual(restartResult.runtimeId, runtimeId);
  assert.equal(restartResult.ordinaryQueryCount, 1);
  assert.equal(
    restartResult.appliedSandboxCount,
    1,
    'The post-restart Shell must report an applied Windows restricted-user sandbox.',
  );
  assert.equal(restartResult.environmentProof?.shellProbeExitCode, 0);
  assert.equal(restartResult.environmentProof?.shellProbe, 'shell-probe-ok');

  const restarted = await sdk.connectKodaXRuntime({ homeDir, profile, autoStart: false, requirements: { daemonManagement: 1 } });
  assert.equal(restarted.identity.runtimeId, restartResult.runtimeId);
  await waitForClientCount(restarted, 2);
  await restarted.close();
  await writeFile(restartDetachFile, 'detach', 'utf8');
  await waitForExit(electronProcess, 15_000);
  assert.equal((await readFile(guiCountFile, 'utf8')).trim().split(/\r?\n/).length, 2);

  const restartManagement = await sdk.connectKodaXRuntime({ homeDir, profile, autoStart: false, requirements: { daemonManagement: 1 } });
  await waitForClientCount(restartManagement, 1);
  await stopForInline(restartManagement);
  await restartManagement.close();
  await waitForUnowned(sdk);
  await assertNoAclPoisonMarkers('The restarted daemon must also confirm clean ACL teardown.');
  assert.equal((await enableDaemonOwnerWhenReady(sdk)).mode, 'daemon');
}

async function assertNoAclPoisonMarkers(message, legacyHomeDir = homeDir) {
  const directories = [
    path.join(programDataDir, 'KodaX', 'sandbox-runtime', 'acl-poison'),
    path.join(legacyHomeDir, '.kodax', 'sandbox-runtime', 'acl-poison'),
  ];
  for (const directory of directories) {
    const entries = existsSync(directory) ? await readdir(directory) : [];
    assert.deepEqual(entries, [], `${message} Marker directory: ${directory}`);
  }
}

async function stopForInline(runtime) {
  const state = await runtime.daemon.inspect();
  await runtime.daemon.stopForInline({
    expectedRuntimeId: state.runtimeId,
    expectedRevision: state.revision,
    expectedOwnerPolicyRevision: state.ownerPolicy.revision,
  });
}

async function waitForClientCount(runtime, expected) {
  await waitUntil(async () => (await runtime.status.preflight()).clientCount === expected, 30_000, `clientCount=${expected}`);
}

async function waitForUnowned(sdk) {
  await waitUntil(
    () => sdk.getKodaXRuntimeOwnerState({ homeDir, profile }).ownerStatus === 'unowned',
    300_000,
    'an unowned Runtime fence',
  );
}

async function enableDaemonOwnerWhenReady(sdk) {
  let ownerPolicy;
  await waitUntil(() => {
    try {
      ownerPolicy = sdk.enableKodaXDaemonOwner({ homeDir, profile });
      return true;
    } catch (error) {
      if (!String(error).includes('owner transition is already in progress')) throw error;
      return false;
    }
  }, 10_000, 'the Runtime owner transition fence to drain');
  return ownerPolicy;
}

async function waitForJson(file, timeoutMs) {
  let value;
  await waitUntil(async () => {
    if (!existsSync(file)) return false;
    value = JSON.parse(await readFile(file, 'utf8'));
    return true;
  }, timeoutMs, `result file ${file}`, electronFailure);
  return value;
}

function electronFailure() {
  if (electronSpawnError) return electronSpawnError;
  if (electronProcess?.exitCode === null || electronProcess === undefined) return undefined;
  const output = Buffer.concat(electronOutput).toString('utf8').trim();
  return new Error(
    `Packaged Electron exited with code ${electronProcess.exitCode} before reporting ready.`
    + (output ? `\n${output}` : ''),
  );
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for process ${child.pid} to exit.`)), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function waitUntil(predicate, timeoutMs, description, earlyFailure = () => undefined) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await predicate()) return;
    const failure = earlyFailure();
    if (failure) throw failure;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

function run(command, args, cwd, timeoutMs = 120_000, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let settled = false;
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(
        `${JSON.stringify({ command, args })} timed out after ${timeoutMs}ms.`,
      ));
    }, timeoutMs);
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const output = Buffer.concat(stdout).toString('utf8');
      if (code === 0) resolve(output);
      else reject(new Error(`${command} exited ${code}: ${Buffer.concat(stderr).toString('utf8')}`));
    });
  });
}

function runNpm(args, cwd, timeoutMs) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli || !existsSync(npmCli)) {
    throw new Error('npm_execpath must identify the npm CLI entry for the packaged Electron smoke.');
  }
  return run(process.execPath, [npmCli, ...args], cwd, timeoutMs);
}

async function stopDaemonBestEffort() {
  const cli = path.join(repoRoot, 'dist', 'kodax_cli.js');
  if (!existsSync(cli)) return;
  try {
    await run(process.execPath, [cli, 'daemon', 'stop', '--home', homeDir, '--profile', profile, '--timeout-ms', '3000', '--json'], repoRoot, 10_000);
  } catch (error) {
    process.stderr.write(`[electron-daemon-smoke] cleanup warning: ${String(error)}\n`);
  }
}

function requirePath(name) {
  const value = process.env[name];
  if (!value || !existsSync(value)) throw new Error(`${name} must point to an existing path.`);
  return path.resolve(value);
}
