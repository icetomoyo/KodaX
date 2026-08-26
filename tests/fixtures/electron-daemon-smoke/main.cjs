const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { app } = require('electron');

const homeDir = requireEnvironment('KODAX_SMOKE_HOME');
const profile = requireEnvironment('KODAX_SMOKE_PROFILE');
const resultFile = requireEnvironment('KODAX_SMOKE_RESULT');
const detachFile = requireEnvironment('KODAX_SMOKE_DETACH');
const guiCountFile = requireEnvironment('KODAX_SMOKE_GUI_COUNT');
const environmentProofFile = requireEnvironment('KODAX_SMOKE_ENV_PROOF');
const consoleProbeQueryFile = requireEnvironment('KODAX_CONSOLE_PROBE_QUERY');
const consoleProbeExecutable = requireEnvironment('KODAX_CONSOLE_PROBE_EXECUTABLE');
const nodeExecutable = requireEnvironment('KODAX_SMOKE_NODE_EXECUTABLE');
const profileToolchainRoot = requireEnvironment('KODAX_SMOKE_PROFILE_TOOLCHAIN');
const ordinaryQueryCount = Number(requireEnvironment('KODAX_SMOKE_QUERY_COUNT'));
const sessionId = requireEnvironment('KODAX_SMOKE_SESSION_ID');
const environmentProofDeadlineMs = Number(
  process.env.KODAX_SMOKE_ENV_PROOF_DEADLINE_MS ?? '240000',
);
if (!Number.isSafeInteger(environmentProofDeadlineMs) || environmentProofDeadlineMs <= 0) {
  throw new Error('KODAX_SMOKE_ENV_PROOF_DEADLINE_MS must be a positive safe integer.');
}
const workspaceDir = path.join(homeDir, 'workspace');
const standaloneProbeDir = path.join(homeDir, 'standalone-probe');
const profileToolchainVersion = path.join(profileToolchainRoot, 'versions', 'v1');
const profileToolchainActive = path.join(profileToolchainRoot, 'active');
const profileToolchainPowerShellSetup = `$env:PATH = '${profileToolchainActive.replaceAll("'", "''")};' + $env:PATH`;
const profileToolchainCmdSetup = `set "PATH=${profileToolchainActive};%PATH%"`;
const profileToolchainPath = [
  profileToolchainActive,
  process.env.PATH ?? process.env.Path ?? '',
].filter(Boolean).join(path.delimiter);
const parallelSessionCount = 4;

app.on('window-all-closed', () => {});

void run().catch((error) => {
  writeResult({ ok: false, error: error instanceof Error ? error.stack : String(error) });
  app.quit();
});

async function run() {
  await app.whenReady();
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(standaloneProbeDir, { recursive: true });
  fs.mkdirSync(profileToolchainVersion, { recursive: true });
  const quotedCommandDirectory = path.join(workspaceDir, 'quoted command directory');
  fs.mkdirSync(quotedCommandDirectory, { recursive: true });
  fs.writeFileSync(path.join(quotedCommandDirectory, 'quoted-command-ok.txt'), 'ok', 'utf8');
  fs.copyFileSync(consoleProbeExecutable, path.join(profileToolchainVersion, 'profile-tool.exe'));
  fs.copyFileSync(consoleProbeExecutable, path.join(profileToolchainVersion, 'git.exe'));
  fs.copyFileSync(nodeExecutable, path.join(profileToolchainVersion, 'node.exe'));
  if (!fs.existsSync(profileToolchainActive)) {
    fs.symlinkSync(profileToolchainVersion, profileToolchainActive, 'junction');
  }
  fs.appendFileSync(guiCountFile, `${process.pid}\n`, 'utf8');
  if (process.argv.includes('daemon') && process.argv.includes('serve')) {
    throw new Error('The daemon child re-entered the packaged Electron GUI application.');
  }

  prepareEnvironmentProbeExtension();
  const { connectKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
  const runtime = await connectKodaXRuntime({
    homeDir,
    profile,
    autoStart: true,
    clientInfo: { name: 'packaged-electron-smoke', instanceId: 'packaged-electron-smoke' },
    requirements: { daemonManagement: 1 },
  });
  await waitForFile(environmentProofFile, 270_000);
  const environmentProof = JSON.parse(fs.readFileSync(environmentProofFile, 'utf8'));
  if (environmentProof.probeError !== undefined) {
    throw new Error(
      'Packaged daemon environment probe failed: '
      + JSON.stringify(environmentProof.probeError),
    );
  }
  if (environmentProof.sandboxDoctor?.ready !== true) {
    throw new Error(
      'Packaged daemon OS sandbox is unavailable: '
      + JSON.stringify(environmentProof.sandboxDoctor),
    );
  }
  if (
    environmentProof.directSandboxProbe?.status !== 'completed'
    || environmentProof.directSandboxProbe.exitCode !== 0
    || environmentProof.directSandboxProbe.stdout !== 'direct-sandbox-ok'
  ) {
    throw new Error(
      'Packaged Electron sandbox target bootstrap failed: '
      + JSON.stringify(environmentProof.directSandboxProbe),
    );
  }
  if (
    environmentProof.directPowerShellProbe?.status !== 'completed'
    || environmentProof.directPowerShellProbe.exitCode !== 0
    || !environmentProof.directPowerShellProbe.stdout.includes('direct-powershell-ok')
  ) {
    throw new Error(
      'Direct restricted-user PowerShell probe failed: '
      + JSON.stringify(environmentProof.directPowerShellProbe),
    );
  }
  const sessions = await Promise.all(Array.from(
    { length: parallelSessionCount },
    (_, index) => runtime.sessions.create({
      sessionId: `${sessionId}-${index}`,
      title: `Windows GUI query smoke ${index}`,
      projectPath: workspaceDir,
      surface: 'space-desktop',
    }),
  ));
  const settings = {
    permissionMode: 'auto',
    autoModeEngine: 'rules',
    shellExecution: {
      version: 1,
      shell: {
        kind: 'cmd',
        executable: process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe',
        profile: 'none',
      },
      environment: {
        inherit: 'filtered',
        windowsPath: 'registry',
        set: { PATH: profileToolchainPath },
        setup: profileToolchainCmdSetup,
      },
      cache: { ttlMs: 0, refreshToken: 'packaged-electron-runtime-sandbox' },
      probeTimeoutMs: 60_000,
    },
  };
  await Promise.all(sessions.map((session) => (
    runtime.sessions.updateSettings(session.id, settings)
  )));
  const permissionSubscriptions = sessions.map((session) => runtime.events.subscribe({
      sessionId: session.id,
      type: 'permission.requested',
    }, (event) => {
      const request = event.payload;
      if (request?.toolName !== 'bash' || typeof request.id !== 'string') return;
      void runtime.permissions.respond(request.id, { type: 'allow_once' }, {
        runId: request.runId,
      });
    }));
  const sandboxObservations = new Map();
  const sandboxSubscriptions = sessions.map((session) => runtime.events.subscribe({
      sessionId: session.id,
      type: 'tool.sandbox',
    }, (event) => {
      const observation = event.payload?.update?.observation;
      if (typeof event.runId === 'string' && observation && typeof observation === 'object') {
        sandboxObservations.set(event.runId, observation);
      }
    }));
  await Promise.all([...permissionSubscriptions, ...sandboxSubscriptions]
    .map((subscription) => subscription.ready));
  const waitForAppliedSandboxObservation = async (runId) => {
    const deadline = Date.now() + 30_000;
    while (Date.now() <= deadline) {
      const observation = sandboxObservations.get(runId);
      if (observation !== undefined) {
        if (
          observation.state !== 'applied'
          || observation.backend !== 'windows-restricted-user'
        ) {
          const diagnostics = readWindowsSandboxDiagnostics();
          throw new Error(
            `Run ${runId} reported a non-applied Windows sandbox: ${JSON.stringify(observation)}; `
            + `daemon diagnostics: ${JSON.stringify(diagnostics)}`,
          );
        }
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Run ${runId} did not publish a sandbox observation within 30 seconds.`);
  };
  let appliedSandboxCount = 0;
  try {
    const runQuery = async (index) => {
      try {
        const session = sessions[index % sessions.length];
        const handle = await runtime.runs.start({
          sessionId: session.id,
          prompt: `ordinary query ${index}`,
          options: { provider: 'windows-hide-smoke' },
          operation: { operationId: `windows-hide-smoke-${sessionId}-${index}` },
        });
        const completed = await handle.result;
        if (completed.phase !== 'completed') {
          throw completed.error ?? new Error(`Runtime shell query ended in phase ${completed.phase}.`);
        }
        await waitForAppliedSandboxObservation(handle.runId);
        appliedSandboxCount += 1;
      } catch (error) {
        const detail = error instanceof Error ? error.stack : String(error);
        throw new Error(`Ordinary query ${index} failed: ${detail}`);
      }
    };
    for (let index = 0; index < ordinaryQueryCount; index += parallelSessionCount) {
      fs.writeFileSync(consoleProbeQueryFile, String(index), 'utf8');
      await Promise.all(Array.from(
        { length: Math.min(parallelSessionCount, ordinaryQueryCount - index) },
        (_, offset) => runQuery(index + offset),
      ));
    }
    fs.writeFileSync(consoleProbeQueryFile, 'idle', 'utf8');
  } finally {
    for (const subscription of sandboxSubscriptions) subscription.close();
    for (const subscription of permissionSubscriptions) subscription.close();
  }
  const preflight = await runtime.status.preflight();
  writeResult({
    ok: true,
    appPid: process.pid,
    runtimeId: runtime.identity.runtimeId,
    clientCount: preflight.clientCount,
    environmentProof,
    ordinaryQueryCount,
    parallelSessionCount,
    appliedSandboxCount,
  });

  await waitForFile(detachFile, 90_000);
  await runtime.close();
  app.quit();
}

function readWindowsSandboxDiagnostics() {
  const logFile = path.join(
    homeDir,
    '.kodax',
    'runtime',
    'daemon',
    profile,
    'daemon.log',
  );
  let text;
  try {
    const descriptor = fs.openSync(logFile, 'r');
    try {
      const size = fs.fstatSync(descriptor).size;
      const length = Math.min(size, 256 * 1024);
      const buffer = Buffer.alloc(length);
      fs.readSync(descriptor, buffer, 0, length, size - length);
      text = buffer.toString('utf8');
      if (length < size) text = text.slice(text.indexOf('\n') + 1);
    } finally {
      fs.closeSync(descriptor);
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    return [{
      message: 'Could not read the bounded daemon diagnostic tail.',
      detail: error instanceof Error ? error.message : String(error),
    }];
  }

  const diagnostics = [];
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (error) {
      diagnostics.push({
        message: 'Skipped a malformed daemon diagnostic entry.',
        detail: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (entry?.data?.source !== 'sandbox:windows-v2') continue;
    diagnostics.push({
      time: entry.time,
      message: entry.message,
      detail: entry.data.detail,
    });
  }
  return diagnostics.slice(-8);
}

function prepareEnvironmentProbeExtension() {
  const configDir = path.join(homeDir, '.kodax');
  const extensionPath = path.join(homeDir, 'daemon-environment-probe.mjs');
  const llmEntry = path.join(
    __dirname,
    'node_modules',
    '@kodax-ai',
    'kodax',
    'dist',
    'sdk-llm.js',
  );
  const codingEntry = path.join(
    __dirname,
    'node_modules',
    '@kodax-ai',
    'kodax',
    'dist',
    'sdk-coding.js',
  );
  const sandboxEntry = path.join(
    __dirname,
    'node_modules',
    '@kodax-ai',
    'kodax',
    'dist',
    'sdk-sandbox.js',
  );
  const llmUrl = pathToFileURL(llmEntry).href;
  const codingUrl = pathToFileURL(codingEntry).href;
  const sandboxUrl = pathToFileURL(sandboxEntry).href;
  const powerShellCommand = path.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const powerShellArgs = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    "if ($env:ELECTRON_RUN_AS_NODE) { Write-Error 'Electron Node mode leaked'; exit 97 }; Write-Output 'direct-powershell-ok'",
  ];
  const powerShellProbeScript = [
    "const { spawnSync } = require('node:child_process');",
    `const result = spawnSync(${JSON.stringify(powerShellCommand)}, ${JSON.stringify(powerShellArgs)}, { encoding: 'utf8' });`,
    "process.stdout.write(result.stdout ?? '');",
    "process.stderr.write(result.stderr ?? '');",
    "process.exit(result.status ?? 1);",
  ].join(' ');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(extensionPath, `
import { spawnSync } from 'node:child_process';
import { renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { KodaXBaseProvider } from ${JSON.stringify(llmUrl)};
import { toolBash } from ${JSON.stringify(codingUrl)};
import { doctorKodaXSandbox, runKodaXSandboxed } from ${JSON.stringify(sandboxUrl)};

class WindowsHideSmokeProvider extends KodaXBaseProvider {
  name = 'windows-hide-smoke';
  supportsThinking = false;
  config = {
    apiKeyEnv: 'KODAX_WINDOWS_HIDE_SMOKE_KEY',
    model: 'windows-hide-smoke',
    supportsThinking: false,
  };

  isConfigured() {
    return true;
  }

  toolSequence = 0;

  async stream(messages) {
    const last = messages.at(-1);
    const blocks = Array.isArray(last?.content) ? last.content : [];
    const toolResult = blocks.find((block) => block?.type === 'tool_result');
    if (toolResult) {
      const content = typeof toolResult.content === 'string'
        ? toolResult.content
        : JSON.stringify(toolResult.content);
      if (
        !content.includes('Exit: 0')
        || !content.includes('runtime-sandbox-ok')
        || !content.includes('profile-toolchain-ok')
        || !content.includes('parallel-barrier-ok')
        || !content.includes('abcdef0')
        || !content.includes('node-realpath-ok')
        || !content.toLowerCase().includes(${JSON.stringify(
          `node-realpath=${path.join(profileToolchainVersion, 'node.exe')}`.toLowerCase(),
        )})
        || !content.includes('quoted-command-ok.txt')
      ) {
        throw new Error('Runtime sandbox Bash result was not successful: ' + content);
      }
      return {
        textBlocks: [{ type: 'text', text: 'done' }],
        toolBlocks: [],
        thinkingBlocks: [],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        stopReason: 'end_turn',
      };
    }
    this.toolSequence += 1;
    const promptText = typeof last?.content === 'string'
      ? last.content
      : JSON.stringify(last?.content ?? '');
    const queryId = /ordinary query (\\d+)/.exec(promptText)?.[1]
      ?? String(this.toolSequence);
    const queryNumber = Number(queryId);
    const barrierGroup = Math.floor(queryNumber / ${parallelSessionCount});
    const barrierCount = Math.min(
      ${parallelSessionCount},
      ${ordinaryQueryCount} - barrierGroup * ${parallelSessionCount},
    );
    const barrierDirectory = ${JSON.stringify(path.join(workspaceDir, '.parallel-barriers'))}
      + '\\\\' + barrierGroup;
    return {
      textBlocks: [],
      toolBlocks: [{
        type: 'tool_use',
        id: 'runtime-sandbox-shell-' + this.toolSequence,
        name: 'bash',
        input: {
          timeout: 240,
          command: 'set "KODAX_CONSOLE_PROBE_QUERY_ID=' + queryId
            + '" && profile-tool.exe --profile-toolchain --barrier "' + barrierDirectory
            + '" ' + queryId + ' ' + barrierCount + ' && ' + ${JSON.stringify(
            `git rev-parse --short HEAD `
            + `&& node -e "const p=require('node:fs').realpathSync(process.execPath);`
            + `process.stdout.write('node-realpath='+p+'\\nnode-realpath-ok')" `
            + `&& if defined ELECTRON_RUN_AS_NODE `
            + `(exit /b 97) else (dir /b "${path.join(workspaceDir, 'quoted command directory')}" `
            + '&& echo runtime-sandbox-ok)',
          )},
        },
      }],
      thinkingBlocks: [],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      stopReason: 'tool_use',
    };
  }
}

async function publishEnvironmentProof() {
let phase = 'external-child';
const deadlineAt = Date.now() + ${environmentProofDeadlineMs};
const runPhase = async (nextPhase, operation) => {
  phase = nextPhase;
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) throw new Error('Environment probe deadline expired.');
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error('Environment probe deadline expired.'));
  }, remainingMs);
  try {
    const result = await operation(controller.signal);
    if (controller.signal.aborted) throw controller.signal.reason;
    return result;
  } finally {
    clearTimeout(timer);
  }
};
let proofSequence = 0;
const writeEnvironmentProof = (value) => {
  const proofPath = ${JSON.stringify(environmentProofFile)};
  proofSequence += 1;
  const temporary = proofPath + '.' + process.pid + '.' + proofSequence + '.tmp';
  writeFileSync(temporary, JSON.stringify(value), {
    encoding: 'utf8',
    flag: 'wx', flush: true,
  });
  renameSync(temporary, proofPath);
};
try {
const child = spawnSync(process.env.ComSpec ?? 'cmd.exe', [
  '/d', '/s', '/c',
  'if defined ELECTRON_RUN_AS_NODE (echo present) else (echo absent)',
], { encoding: 'utf8', windowsHide: true });
phase = 'sandbox-doctor';
const sandboxDoctor = await doctorKodaXSandbox({ refresh: true });
if (!sandboxDoctor.ready) {
  throw new Error(
    'Packaged Electron release gate requires a preconfigured Windows sandbox: '
      + JSON.stringify(sandboxDoctor),
  );
}
const shellProbe = await runPhase('shell-probe', (signal) => toolBash(
  {
    command:
      "Write-Output 'shell-probe-ok'; "
      + "Write-Output ('node-mode=' + $(if (Test-Path Env:ELECTRON_RUN_AS_NODE) "
      + "{ $env:ELECTRON_RUN_AS_NODE } else { 'absent' })); "
      + 'profile-tool.exe --profile-toolchain',
  },
  {
    backups: new Map(),
    abortSignal: signal,
    executionCwd: ${JSON.stringify(homeDir)},
    shellExecution: {
      version: 1,
      shell: {
        kind: 'powershell',
        executable: process.env.SystemRoot
          + '\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe',
        profile: 'none',
      },
      environment: {
        inherit: 'filtered',
        windowsPath: 'registry',
        set: { PATH: ${JSON.stringify(profileToolchainPath)} },
        setup: ${JSON.stringify(profileToolchainPowerShellSetup)},
      },
      cache: { ttlMs: 0, refreshToken: 'packaged-electron-smoke' },
      probeTimeoutMs: 10_000,
    },
  },
));
const shellProbeLines = shellProbe.trim().split(/\\r?\\n/);
const shellProbeExitIndex = shellProbeLines.findIndex((line) => /^Exit: -?\\d+$/.test(line));
const shellProbeExitCode =
  shellProbeExitIndex >= 0
    ? Number.parseInt(shellProbeLines[shellProbeExitIndex].slice('Exit: '.length), 10)
    : null;
const shellProbeOutput = shellProbeLines.slice(shellProbeExitIndex + 1);
const directSandboxProbe = await runPhase('direct-node-probe', (signal) => runKodaXSandboxed({
      command: process.execPath,
      args: [
        '-e',
        "if (process.env.ELECTRON_RUN_AS_NODE) process.exit(97); process.stdout.write('direct-sandbox-ok')",
      ],
      cwd: ${JSON.stringify(standaloneProbeDir)},
      filesystem: {
        allowRead: [dirname(process.execPath), ${JSON.stringify(standaloneProbeDir)}],
        allowWrite: [],
      },
      env: { ELECTRON_RUN_AS_NODE: '1' },
      timeoutMs: 60_000,
      signal,
    }));
const directPowerShellProbe = await runPhase('direct-powershell-probe', (signal) => runKodaXSandboxed({
      // Keep the external PowerShell child under the Electron Node target
      // already proven above. This avoids making Electron itself the outer
      // PowerShell target in the packaged smoke broker.
      command: process.execPath,
      args: [
        '-e',
        ${JSON.stringify(powerShellProbeScript)},
      ],
      cwd: ${JSON.stringify(standaloneProbeDir)},
      filesystem: {
        allowRead: [dirname(process.execPath), ${JSON.stringify(standaloneProbeDir)}],
        allowWrite: [],
      },
      env: { ELECTRON_RUN_AS_NODE: '1' },
      timeoutMs: 60_000,
      signal,
    }));
phase = 'publish';
writeEnvironmentProof({
  daemon: process.env.ELECTRON_RUN_AS_NODE ?? 'absent',
  externalChild: child.stdout.trim(),
  externalChildStatus: child.status,
  externalChildError: child.error?.message,
  shellProbe: shellProbeOutput[0],
  shellProbeExitCode,
  shellProbeNodeMode: shellProbeOutput[1]?.replace(/^node-mode=/, ''),
  shellProbeToolchain: shellProbeOutput[2],
  sandboxDoctor,
  directSandboxProbe,
  directPowerShellProbe,
});
} catch (error) {
  writeEnvironmentProof({
    probeError: {
      phase,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    },
  });
}
}

export default function(api) {
  api.registerModelProvider({
    name: 'windows-hide-smoke',
    factory: () => new WindowsHideSmokeProvider(),
  });
  api.registerTool({
    name: 'daemon_environment_probe',
    description: 'Packaged Electron daemon environment probe',
    input_schema: { type: 'object', properties: {} },
    handler: async () => 'ok',
  });
  // Extension activation must not block Runtime startup on shell/sandbox
  // probes that themselves require the fully activated daemon services.
  publishEnvironmentProof().catch((error) => {
    process.stderr.write(
      '[electron-daemon-smoke] environment proof publication failed: '
        + (error instanceof Error ? error.stack : String(error)) + '\\n',
    );
  });
}
`, 'utf8');
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({ provider: 'windows-hide-smoke', extensions: [extensionPath] }),
    'utf8',
  );
}

function requireEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
}

function writeResult(value) {
  const temporary = `${resultFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), 'utf8');
  fs.renameSync(temporary, resultFile);
}

async function waitForFile(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (fs.existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for detach marker ${file}.`);
}
