import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  killChildProcessTree,
  killPidTree,
  rememberChildProcessTree,
} from '@kodax-ai/agent';
import { createMcpTestServerFixture } from '../packages/agent/src/capabilities/mcp/test-helpers.js';

import {
  acquireKodaXInlineOwner,
  connectKodaXRuntime,
  createKodaXRuntime,
  enableKodaXDaemonOwner,
  getKodaXRuntimeOwnerState,
  type KodaXDaemonRuntime,
} from './sdk-runtime.js';

import {
  RUNTIME_DAEMON_BOOTSTRAP_LOG_MAX_BYTES,
  runtimeDaemonBootstrapLogPath,
} from './runtime-daemon/process.js';
import {
  readRuntimeDaemonLockOwner,
  readRuntimeDaemonShutdownOutcome,
  resolveRuntimeDaemonPaths,
  resolveRuntimeDaemonPathsFromConfigHome,
  tryAcquireRuntimeDaemonLock,
  writeRuntimeDaemonState,
} from './runtime-daemon/state.js';
import {
  isRuntimeDaemonPidAlive,
  observeRuntimeDaemonHealth,
} from './runtime-daemon/lifecycle.js';

const tempRoots: string[] = [];
const DEFAULT_NODE_PROCESS_TIMEOUT_MS = 90_000;

afterEach(async () => {
  for (const dir of tempRoots.splice(0)) {
    await stopDaemonBestEffort(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('daemon CLI smoke', () => {
  it('keeps child bootstrap output bounded before the daemon becomes ready', async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-daemon-bootstrap-bound-'));
    tempRoots.push(homeDir);
    const profile = `bootstrap-bound-${process.pid}-${Date.now()}`;
    const paths = resolveRuntimeDaemonPaths(homeDir, profile);
    const start = runDaemonCommand(
      [
        'start',
        '--home',
        homeDir,
        '--profile',
        profile,
        '--provider',
        'mock-provider',
        '--timeout-ms',
        '30000',
        '--json',
      ],
      {
        KODAX_INTERNAL_DAEMON_TEST_BOOTSTRAP_BYTES: String(
          RUNTIME_DAEMON_BOOTSTRAP_LOG_MAX_BYTES * 3,
        ),
        KODAX_INTERNAL_DAEMON_TEST_READY_DELAY_MS: '1000',
      },
    );

    await waitForHealthyDaemonStatus(paths, 'starting');
    expect(fs.statSync(runtimeDaemonBootstrapLogPath(paths)).size).toBeLessThanOrEqual(
      RUNTIME_DAEMON_BOOTSTRAP_LOG_MAX_BYTES,
    );
    await expect(start).resolves.toMatchObject({ started: true, health: 'healthy' });
    expect(fs.statSync(runtimeDaemonBootstrapLogPath(paths)).size).toBeLessThanOrEqual(
      RUNTIME_DAEMON_BOOTSTRAP_LOG_MAX_BYTES,
    );
  }, 90_000);

  it('kills a timed-out node process tree', async () => {
    const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-node-timeout-'));
    const markerFile = path.join(markerDir, 'nested-pid.txt');
    const script = [
      'const { spawn } = require("node:child_process");',
      'const fs = require("node:fs");',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"],',
      '{ stdio: "ignore", windowsHide: true });',
      `fs.writeFileSync(${JSON.stringify(markerFile)}, String(child.pid));`,
      'setInterval(() => {}, 1000);',
    ].join(' ');
    let nestedPid: number | undefined;

    try {
      await expect(runNodeProcess(['-e', script], {}, 250))
        .rejects.toThrow('timed out after 250ms');
      await waitForFile(markerFile);
      nestedPid = Number(fs.readFileSync(markerFile, 'utf8'));
      expect(Number.isInteger(nestedPid) && nestedPid > 0).toBe(true);
      await waitForDaemonPidExit(nestedPid, 10_000);
    } finally {
      if (nestedPid !== undefined && isRuntimeDaemonPidAlive(nestedPid)) {
        await killPidTree(nestedPid);
      }
      fs.rmSync(markerDir, { recursive: true, force: true });
    }
  }, 15_000);

  it('uses an arbitrary KODAX_HOME for default daemon ownership and A2A mutation', async () => {
    const configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-daemon-config-home-'));
    const profile = `custom-config-${process.pid}-${Date.now()}`;
    const env = { KODAX_HOME: configHome };
    const integrationDir = path.join(configHome, 'integrations');
    fs.mkdirSync(integrationDir, { recursive: true });
    fs.writeFileSync(
      path.join(integrationDir, 'a2a.json'),
      JSON.stringify({ version: 2, agents: {} }),
      'utf8',
    );
    try {
      await expect(runDaemonCommand([
        'start', '--profile', profile, '--provider', 'mock-provider',
        '--timeout-ms', '30000', '--json',
      ], env)).resolves.toMatchObject({ started: true, health: 'healthy' });

      const paths = resolveRuntimeDaemonPathsFromConfigHome(configHome, profile);
      expect(JSON.parse(fs.readFileSync(paths.stateFile, 'utf8'))).toMatchObject({
        profile,
        configHome: path.resolve(configHome),
        status: 'ready',
      });
      await runKodaXCommand([
        'a2a', 'add', 'configured', 'https://agents.example.com/card',
        '--disabled', '--no-test', '--effect', 'none',
      ], env);
      expect(JSON.parse(fs.readFileSync(path.join(integrationDir, 'a2a.json'), 'utf8')))
        .toMatchObject({ agents: { configured: { enabled: false } } });
      await expect(runDaemonCommand(['status', '--profile', profile, '--json'], env))
        .resolves.toMatchObject({ health: 'healthy', stateFile: paths.stateFile });
    } finally {
      await runDaemonCommand([
        'stop', '--profile', profile, '--timeout-ms', '30000', '--force', '--json',
      ], env).catch(() => undefined);
      fs.rmSync(configHome, { recursive: true, force: true });
    }
  }, 90_000);

  it('does not become ready before initial A2A reconciliation completes', async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-daemon-a2a-fence-'));
    tempRoots.push(homeDir);
    const profile = `a2a-fence-${process.pid}-${Date.now()}`;
    let releaseCard: (() => void) | undefined;
    let observeCardRequest: (() => void) | undefined;
    let cardPort: number | undefined;
    const cardRequest = new Promise<void>((resolve) => { observeCardRequest = resolve; });
    const cardRelease = new Promise<void>((resolve) => { releaseCard = resolve; });
    const cardServer = createServer(async (request, response) => {
      if (request.url !== '/.well-known/agent-card.json') {
        response.writeHead(404).end();
        return;
      }
      observeCardRequest?.();
      await cardRelease;
      if (cardPort === undefined) throw new Error('Card server port is unavailable.');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        name: 'Startup Fence Agent',
        description: 'Delayed Agent Card used to verify daemon readiness fencing.',
        version: '1.0.0',
        supportedInterfaces: [{
          url: `http://127.0.0.1:${cardPort}/a2a`,
          protocolBinding: 'JSONRPC',
          protocolVersion: '1.0',
        }],
        capabilities: {},
        defaultInputModes: ['text/plain'],
        defaultOutputModes: ['text/plain'],
        skills: [],
      }));
    });
    await new Promise<void>((resolve, reject) => {
      cardServer.once('error', reject);
      cardServer.listen(0, '127.0.0.1', resolve);
    });
    try {
      const address = cardServer.address();
      if (address === null || typeof address === 'string') throw new Error('Card server address is unavailable.');
      cardPort = address.port;
      const configDir = path.join(homeDir, '.kodax', 'integrations');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, 'a2a.json'), JSON.stringify({
        version: 2,
        agents: {
          delayed: {
            cardUrl: `http://127.0.0.1:${address.port}/.well-known/agent-card.json`,
            enabled: true,
            effect: 'read',
          },
        },
      }), 'utf8');

      const daemonEnv = { KODAX_INTERNAL_DAEMON_TEST_READY_DELAY_MS: '1000' };
      const start = runDaemonCommand([
        'start', '--home', homeDir, '--profile', profile,
        '--provider', 'mock-provider', '--timeout-ms', '30000', '--json',
      ], daemonEnv);
      await Promise.race([
        cardRequest,
        start.then(() => {
          throw new Error('Daemon start completed before initial A2A discovery began.');
        }),
      ]);
      releaseCard?.();
      const paths = resolveRuntimeDaemonPaths(homeDir, profile);
      await waitForHealthyDaemonStatus(paths, 'starting');

      const concurrentStart = runDaemonCommand([
        'start', '--home', homeDir, '--profile', profile,
        '--provider', 'mock-provider', '--timeout-ms', '30000', '--json',
      ]);
      const runtimePromise = connectKodaXRuntime({
        homeDir,
        profile,
        autoStart: true,
        daemonStartupTimeoutMs: 30_000,
        requirements: { externalAgentAdmin: 1, a2aConfigReconciler: 1 },
      });
      let concurrentStartSettled = false;
      let runtimeSettled = false;
      void concurrentStart.then(
        () => { concurrentStartSettled = true; },
        () => { concurrentStartSettled = true; },
      );
      void runtimePromise.then(
        () => { runtimeSettled = true; },
        () => { runtimeSettled = true; },
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(concurrentStartSettled).toBe(false);
      expect(runtimeSettled).toBe(false);

      releaseCard?.();
      await expect(start).resolves.toMatchObject({ started: true, health: 'healthy' });
      await expect(concurrentStart).resolves.toMatchObject({
        started: false,
        reason: 'already_running',
        state: { status: 'ready' },
      });
      expect(JSON.parse(fs.readFileSync(paths.stateFile, 'utf8'))).toMatchObject({
        configHome: path.resolve(homeDir, '.kodax'),
      });
      const runtime = await runtimePromise;
      try {
        expect(runtime.capabilities).toMatchObject({
          a2aConfigReconciler: { version: 1 },
        });
        await expect(runtime.admin.agentRegistrations.list()).resolves.toEqual([
          expect.objectContaining({ agentId: 'external:delayed', enabled: true }),
        ]);
      } finally {
        await runtime.close();
      }
      await expect(runDaemonCommand([
        'stop', '--home', homeDir, '--profile', profile,
        '--timeout-ms', '30000', '--json',
      ])).resolves.toMatchObject({ stopped: true, health: 'missing' });
      await waitForDaemonState(profile, homeDir, false);
    } finally {
      releaseCard?.();
      await new Promise<void>((resolve, reject) => {
        cardServer.close((error) => error ? reject(error) : resolve());
      });
    }
  }, 90_000);

  it('binds foreground daemon A2A config to --home and degrades an invalid domain safely', async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-daemon-a2a-home-'));
    const ambientHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-daemon-a2a-ambient-'));
    tempRoots.push(homeDir, ambientHome);
    const profile = `a2a-home-${process.pid}-${Date.now()}`;
    const homeConfigDir = path.join(homeDir, '.kodax', 'integrations');
    const ambientConfigHome = path.join(ambientHome, 'custom-config-home');
    fs.mkdirSync(homeConfigDir, { recursive: true });
    fs.mkdirSync(path.join(ambientConfigHome, 'integrations'), { recursive: true });
    fs.writeFileSync(path.join(homeConfigDir, 'a2a.json'), JSON.stringify({
      version: 2,
      agents: {
        invalid: {
          cardUrl: 'https://agents.example.com/.well-known/agent-card.json',
          enabled: true,
          effect: 'invalid',
        },
      },
    }), 'utf8');
    fs.writeFileSync(
      path.join(ambientConfigHome, 'integrations', 'a2a.json'),
      JSON.stringify({ version: 2, agents: {} }),
      'utf8',
    );

    let stderr = '';
    const child = spawn(process.execPath, [
      '--import', 'tsx', path.join(process.cwd(), 'src', 'kodax_cli.ts'),
      'daemon', 'serve', '--home', homeDir, '--profile', profile,
      '--provider', 'mock-provider',
    ], {
      cwd: process.cwd(),
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      env: { ...process.env, KODAX_HOME: ambientConfigHome, KODAX_TRACING: '0' },
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    const paths = resolveRuntimeDaemonPaths(homeDir, profile);
    try {
      await waitForHealthyDaemonStatus(paths, 'ready');
      const runtime = await connectKodaXRuntime({
        profile,
        homeDir,
        autoStart: false,
        requirements: { daemonManagement: 1 },
      });
      try {
        await expect(runtime.daemon.inspect()).resolves.toMatchObject({
          integrations: {
            state: 'degraded',
            domains: expect.arrayContaining([
              expect.objectContaining({
                domain: 'a2a',
                path: path.join(homeConfigDir, 'a2a.json'),
                source: 'user',
                diagnostic: expect.objectContaining({ code: 'invalid-config' }),
              }),
            ]),
          },
        });
      } finally {
        await runtime.close();
      }
      expect(stderr).toMatch(/Integration configuration is invalid/i);
      const stop = await runDaemonCommand([
        'stop', '--home', homeDir, '--profile', profile,
        '--timeout-ms', '30000', '--json',
      ]);
      if (process.platform === 'win32') {
        expect(stop).toMatchObject({
          stopped: false,
          reason: 'cleanup_unverified',
        });
        expect(String(stop.error)).toMatch(/containment metadata is unavailable/i);
        if (child.exitCode === null && child.signalCode === null) {
          await killChildProcessTree(child, { forceMs: 2_000, taskkillMs: 5_000 });
        }
      } else {
        expect(stop).toMatchObject({ stopped: true });
      }
      const exitCode = child.exitCode ?? await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', resolve);
      });
      expect(exitCode).toBe(0);
    } finally {
      if (isRuntimeDaemonPidAlive(child.pid ?? -1)) {
        await killChildProcessTree(child, { forceMs: 2_000, taskkillMs: 5_000 });
      }
    }
    expect(fs.existsSync(paths.stateFile)).toBe(false);
    expect(fs.existsSync(paths.lockFile)).toBe(false);
  }, 90_000);

  it('SDK auto-start owns a daemon process outside the embedding process', async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-daemon-sdk-smoke-'));
    tempRoots.push(homeDir);
    const profile = `sdk-${process.pid}-${Date.now()}`;
    const extensionPath = path.join(homeDir, 'daemon-owner-extension.mjs');
    fs.writeFileSync(extensionPath, `export default function(api) {
      api.registerTool({
        name: 'daemon_owner_echo',
        description: 'Daemon owner extension smoke',
        input_schema: { type: 'object', properties: {} },
        handler: async () => 'ok',
      });
    }`, 'utf8');
    fs.mkdirSync(path.join(homeDir, '.kodax'), { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, '.kodax', 'config.json'),
      JSON.stringify({ extensions: [extensionPath] }),
      'utf8',
    );
    const probeScript = `
      const { createKodaXRuntime } = await import('./src/sdk-runtime.ts');
      const runtime = await createKodaXRuntime({
        mode: 'daemon',
        profile: process.argv[2],
        homeDir: process.argv[1],
        autoStartDaemon: true,
        defaultProvider: 'mock-provider',
      });
      const extensions = await runtime.catalog.extensions();
      const identity = runtime.identity;
      await runtime.close();
      console.log(JSON.stringify({ callerPid: process.pid, identity, extensions }));
    `;
    const probe = JSON.parse(await runNodeProcess([
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      probeScript,
      homeDir,
      profile,
    ])) as {
      callerPid: number;
      identity: { runtimeId: string };
      extensions: { active: boolean; extensions: Array<{ path: string }> };
    };
    const paths = resolveRuntimeDaemonPaths(homeDir, profile);
    const state = JSON.parse(fs.readFileSync(paths.stateFile, 'utf8')) as { pid: number };

    expect(state.pid).not.toBe(probe.callerPid);
    expect(probe.extensions).toMatchObject({
      active: true,
      extensions: [expect.objectContaining({ path: extensionPath })],
    });

    const status = await runDaemonCommand([
      'status',
      '--home',
      homeDir,
      '--profile',
      profile,
      '--json',
    ]);
    expect(status).toMatchObject({ health: 'healthy' });
  }, 90_000);

  it('self-stops a Space-managed daemon after its final client disconnects', async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-daemon-orphan-smoke-'));
    tempRoots.push(homeDir);
    const profile = `orphan-${process.pid}-${Date.now()}`;
    const runtime = await createKodaXRuntime({
      mode: 'daemon',
      homeDir,
      profile,
      autoStartDaemon: true,
      daemonOrphanExitMs: 150,
      clientInfo: {
        name: 'kodax-space',
        instanceId: `space_${process.pid}`,
      },
    });
    const paths = resolveRuntimeDaemonPaths(homeDir, profile);
    const state = JSON.parse(fs.readFileSync(paths.stateFile, 'utf8')) as { pid: number };

    await runtime.close();
    await waitForDaemonState(profile, homeDir, false, 10_000);
    await waitForDaemonPidExit(state.pid, 10_000);

    expect(fs.existsSync(paths.stateFile)).toBe(false);
    expect(fs.existsSync(paths.lockFile)).toBe(false);
  }, 30_000);

  it('self-stops an opt-in daemon that becomes ready before any client initializes', async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-daemon-bootstrap-orphan-'));
    tempRoots.push(homeDir);
    const profile = `bootstrap-orphan-${process.pid}-${Date.now()}`;
    const paths = resolveRuntimeDaemonPaths(homeDir, profile);
    const serving = runNodeProcess(
      [
        '--import',
        'tsx',
        path.join(process.cwd(), 'src', 'kodax_cli.ts'),
        'daemon',
        'serve',
        '--home',
        homeDir,
        '--profile',
        profile,
        '--orphan-exit-ms',
        '1000',
      ],
      {},
      DEFAULT_NODE_PROCESS_TIMEOUT_MS,
    );

    await waitForHealthyDaemonStatus(paths, 'ready');
    const state = JSON.parse(fs.readFileSync(paths.stateFile, 'utf8')) as { pid: number };
    await serving;
    await waitForDaemonState(profile, homeDir, false, 10_000);
    await waitForDaemonPidExit(state.pid, 10_000);

    expect(fs.existsSync(paths.stateFile)).toBe(false);
    expect(fs.existsSync(paths.lockFile)).toBe(false);
  }, 120_000);

  it('lets process-distinct concurrent SDK starters elect exactly one owner', async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-daemon-race-smoke-'));
    tempRoots.push(homeDir);
    const profile = `race-${process.pid}-${Date.now()}`;
    const probeScript = `
      const { createKodaXRuntime } = await import('./src/sdk-runtime.ts');
      const runtime = await createKodaXRuntime({
        mode: 'daemon',
        profile: process.argv[2],
        homeDir: process.argv[1],
        autoStartDaemon: true,
        clientInfo: { name: 'race-probe', instanceId: 'probe-' + process.pid },
      });
      console.log(JSON.stringify({ runtimeId: runtime.identity.runtimeId }));
      await runtime.close();
    `;

    const [first, second] = await Promise.all([
      runSdkProbe(probeScript, homeDir, profile),
      runSdkProbe(probeScript, homeDir, profile),
    ]) as Array<{ readonly runtimeId: string }>;
    const paths = resolveRuntimeDaemonPaths(homeDir, profile);
    const state = JSON.parse(fs.readFileSync(paths.stateFile, 'utf8')) as {
      readonly runtimeId: string;
    };

    expect(first.runtimeId).toBe(second.runtimeId);
    expect(state.runtimeId).toBe(first.runtimeId);
    expect(JSON.parse(fs.readFileSync(paths.lockFile, 'utf8'))).toMatchObject({
      runtimeId: state.runtimeId,
      kind: 'daemon',
    });
  }, 120_000);

  it('counts process-distinct logical clients and atomically switches daemon ownership twice', async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-daemon-management-smoke-'));
    tempRoots.push(homeDir);
    const profile = `management-${process.pid}-${Date.now()}`;
    const first = await connectKodaXRuntime({
      homeDir,
      profile,
      autoStart: true,
      clientInfo: { name: 'management-parent', instanceId: 'management-parent' },
      requirements: { daemonManagement: 1 },
    });
    await expect(first.status.preflight()).resolves.toMatchObject({
      clientCount: 1,
      blockers: [],
      canStop: true,
    });
    const stale = await first.daemon.inspect();

    const readyFile = path.join(homeDir, 'child-ready');
    const releaseFile = path.join(homeDir, 'child-release');
    const childScript = `
      const fs = await import('node:fs');
      const { connectKodaXRuntime } = await import('./src/sdk-runtime.ts');
      const runtime = await connectKodaXRuntime({
        homeDir: process.argv[1], profile: process.argv[2], autoStart: false,
        clientInfo: { name: 'management-child', instanceId: 'management-child' },
        requirements: { daemonManagement: 1 },
      });
      fs.writeFileSync(process.argv[3], 'ready', 'utf8');
      while (!fs.existsSync(process.argv[4])) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await runtime.close();
      process.stdout.write(JSON.stringify({ runtimeId: runtime.identity.runtimeId }) + '\\n');
    `;
    const child = runSdkProbe(childScript, homeDir, profile, readyFile, releaseFile);
    try {
      await waitForFile(readyFile);
      await expect(first.status.preflight()).resolves.toMatchObject({
        clientCount: 2,
        blockers: ['connected_clients'],
        canStop: false,
      });
      await expect(first.daemon.stopForInline({
        expectedRuntimeId: stale.runtimeId,
        expectedRevision: stale.revision,
        expectedOwnerPolicyRevision: stale.ownerPolicy.revision,
      })).rejects.toMatchObject({ code: 'conflict' });
    } finally {
      fs.writeFileSync(releaseFile, 'release', 'utf8');
    }
    await child;
    await waitForDaemonClientCount(first, 1);
    const firstDaemonPid = readDaemonPid(homeDir, profile);
    const firstSupervisorPid = process.platform === 'win32'
      ? readDaemonSupervisorPid(homeDir, profile)
      : undefined;
    const firstCommit = await first.daemon.inspect();
    await expect(first.daemon.stopForInline({
      expectedRuntimeId: firstCommit.runtimeId,
      expectedRevision: firstCommit.revision,
      expectedOwnerPolicyRevision: firstCommit.ownerPolicy.revision,
    })).resolves.toMatchObject({ accepted: true, ownerPolicy: { mode: 'inline', revision: 1 } });
    await first.close();
    await waitForDaemonState(profile, homeDir, false);
    await waitForDaemonPidExit(firstDaemonPid, 10_000);
    if (firstSupervisorPid !== undefined) {
      await waitForDaemonPidExit(firstSupervisorPid, 10_000);
    }
    expect(getKodaXRuntimeOwnerState({ homeDir, profile })).toMatchObject({
      policy: { mode: 'inline', revision: 1 },
      ownerStatus: 'unowned',
      owner: null,
    });

    const firstInline = acquireKodaXInlineOwner({ homeDir, profile });
    expect(firstInline.ownerPolicy).toMatchObject({ mode: 'inline', revision: 1 });
    firstInline.close();
    expect(enableKodaXDaemonOwner({ homeDir, profile })).toMatchObject({ mode: 'daemon', revision: 2 });

    const second = await connectKodaXRuntime({
      homeDir,
      profile,
      autoStart: true,
      clientInfo: { name: 'management-second', instanceId: 'management-second' },
      requirements: { daemonManagement: 1 },
    }).catch((error: unknown) => {
      throw new AggregateError(
        [error],
        `Second ownership daemon bootstrap failed: ${readDaemonBootstrapLog(homeDir, profile)}`,
      );
    });
    const secondDaemonPid = readDaemonPid(homeDir, profile);
    const secondSupervisorPid = process.platform === 'win32'
      ? readDaemonSupervisorPid(homeDir, profile)
      : undefined;
    const secondCommit = await second.daemon.inspect();
    await second.daemon.stopForInline({
      expectedRuntimeId: secondCommit.runtimeId,
      expectedRevision: secondCommit.revision,
      expectedOwnerPolicyRevision: secondCommit.ownerPolicy.revision,
    });
    await second.close();
    await waitForDaemonState(profile, homeDir, false);
    await waitForDaemonPidExit(secondDaemonPid, 10_000);
    if (secondSupervisorPid !== undefined) {
      await waitForDaemonPidExit(secondSupervisorPid, 10_000);
    }

    const secondInline = acquireKodaXInlineOwner({ homeDir, profile });
    expect(secondInline.ownerPolicy).toMatchObject({ mode: 'inline', revision: 3 });
    secondInline.close();
    expect(enableKodaXDaemonOwner({ homeDir, profile })).toMatchObject({ mode: 'daemon', revision: 4 });

    const third = await connectKodaXRuntime({
      homeDir,
      profile,
      autoStart: true,
      clientInfo: { name: 'management-third', instanceId: 'management-third' },
      requirements: { daemonManagement: 1 },
    });
    expect(getKodaXRuntimeOwnerState({ homeDir, profile })).toMatchObject({
      policy: { mode: 'daemon', revision: 4 },
      ownerStatus: 'owned',
      owner: { runtimeId: third.identity.runtimeId, kind: 'daemon' },
    });
    await expect(third.status.preflight()).resolves.toMatchObject({ clientCount: 1 });
    await third.close();
    await expect(runDaemonCommand([
      'status', '--home', homeDir, '--profile', profile, '--json',
    ])).resolves.toMatchObject({ health: 'healthy' });
  }, 180_000);

  it('removes a killed client and reconnects the same instance without a ghost entry', async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-daemon-inventory-smoke-'));
    tempRoots.push(homeDir);
    const profile = `inventory-${process.pid}-${Date.now()}`;
    const parent = await connectKodaXRuntime({
      homeDir,
      profile,
      autoStart: true,
      clientInfo: {
        name: 'inventory-parent',
        instanceId: 'inventory-parent',
        clientType: 'diagnostic',
      },
      requirements: { daemonClientInventory: 1 },
    });
    const readyFile = path.join(homeDir, 'killed-client-ready');
    const killedClientScript = `
      const fs = await import('node:fs');
      const { connectKodaXRuntime } = await import('./src/sdk-runtime.ts');
      await connectKodaXRuntime({
        homeDir: process.argv[1], profile: process.argv[2], autoStart: false,
        clientInfo: {
          name: 'inventory-killed-client',
          instanceId: 'inventory-reconnect-instance',
          clientType: 'automation',
        },
        requirements: { daemonClientInventory: 1 },
      });
      fs.writeFileSync(process.argv[3], 'ready', 'utf8');
      setInterval(() => {}, 1000);
    `;
    const killedClient = spawn(process.execPath, [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      killedClientScript,
      homeDir,
      profile,
      readyFile,
    ], {
      cwd: process.cwd(),
      detached: process.platform !== 'win32',
      env: { ...process.env, KODAX_TRACING: '0' },
      stdio: 'ignore',
      windowsHide: true,
    });
    rememberChildProcessTree(killedClient);

    try {
      await waitForFile(readyFile);
      await waitForDaemonClientCount(parent, 2);
      const beforeKill = await parent.status.preflight();
      const killedEntry = beforeKill.clients?.find(
        (client) => client.name === 'inventory-killed-client',
      );
      expect(killedEntry).toMatchObject({
        principalId: 'inventory-reconnect-instance',
        clientType: 'automation',
      });
      if (killedEntry === undefined) throw new Error('Killed client inventory entry is missing.');

      await killChildProcessTree(killedClient, { forceMs: 2_000, taskkillMs: 5_000 });
      await waitForDaemonClientCount(parent, 1);
      expect((await parent.status.preflight()).clients).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ daemonConnectionId: killedEntry.daemonConnectionId }),
        ]),
      );

      const reconnected = await connectKodaXRuntime({
        homeDir,
        profile,
        autoStart: false,
        clientInfo: {
          name: 'inventory-reconnected-client',
          instanceId: 'inventory-reconnect-instance',
          clientType: 'automation',
        },
        requirements: { daemonClientInventory: 1 },
      });
      try {
        const afterReconnect = await parent.status.preflight();
        const reconnectEntries = afterReconnect.clients?.filter(
          (client) => client.principalId === 'inventory-reconnect-instance',
        );
        expect(reconnectEntries).toHaveLength(1);
        expect(reconnectEntries?.[0]).toMatchObject({
          name: 'inventory-reconnected-client',
          clientType: 'automation',
        });
        expect(reconnectEntries?.[0]?.daemonConnectionId)
          .not.toBe(killedEntry.daemonConnectionId);
      } finally {
        await reconnected.close();
      }
      await waitForDaemonClientCount(parent, 1);
    } finally {
      if (killedClient.exitCode === null && killedClient.signalCode === null) {
        await killChildProcessTree(killedClient, { forceMs: 2_000, taskkillMs: 5_000 });
      }
      await parent.close();
    }
  }, 120_000);

  it('converges process-distinct SDK clients and brokers a scoped credential without persistence', async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-daemon-shared-smoke-'));
    tempRoots.push(homeDir);
    const profile = `shared-${process.pid}-${Date.now()}`;
    const mcpFixture = await createMcpTestServerFixture(homeDir);
    const applicationDir = path.join(homeDir, 'space-application');
    fs.mkdirSync(applicationDir, { recursive: true });
    const mcpServer = mcpFixture.servers[mcpFixture.serverId];
    if (mcpServer === undefined) throw new Error('MCP test server is missing.');
    const integrationDir = path.join(homeDir, '.kodax', 'integrations');
    fs.mkdirSync(integrationDir, { recursive: true });
    fs.writeFileSync(path.join(integrationDir, 'mcp.json'), JSON.stringify({
      version: 1,
      servers: {
        ...mcpFixture.servers,
        [mcpFixture.serverId]: { ...mcpServer, cwd: applicationDir },
      },
    }), 'utf8');
    await runDaemonCommand([
      'start', '--home', homeDir, '--profile', profile,
      '--provider', 'mock-provider', '--timeout-ms', '30000', '--json',
    ]);
    const paths = resolveRuntimeDaemonPaths(homeDir, profile);
    const daemonPid = readDaemonPid(homeDir, profile);
    const mcpPid = await waitForManagedChildPid(
      path.join(homeDir, '.kodax'),
      mcpFixture.scriptPath,
    );

    const spaceScript = `
      const { createKodaXRuntime } = await import('./src/sdk-runtime.ts');
      const runtime = await createKodaXRuntime({
        mode: 'daemon', profile: process.argv[2], homeDir: process.argv[1],
        autoStartDaemon: false,
        clientInfo: { name: 'space-smoke', instanceId: 'space-smoke-1' },
      });
      const session = await runtime.sessions.create({ sessionId: 'shared-session', title: 'Shared' });
      const settings = await runtime.sessions.getSettingsVersioned(session.id);
      await runtime.sessions.updateSettingsVersioned(session.id, { model: 'space-model' }, {
        expectedRevision: settings.revision,
        operationId: 'space-settings-1',
      });
      let brokerCalls = 0;
      const credential = await runtime.credentials.register({ providers: ['mock-provider'] }, async (request) => {
        brokerCalls += 1;
        if (request.sessionId !== session.id || request.provider !== 'mock-provider') throw new Error('scope mismatch');
        return 'SPACE_SMOKE_SECRET_DO_NOT_PERSIST';
      });
      const hostTools = await runtime.hostTools.register([{
        name: 'space_artifact_create',
        description: 'Create a Space artifact',
        inputSchema: { type: 'object' },
        sideEffect: 'non_idempotent',
      }], { space_artifact_create: async () => ({ content: 'artifact-created' }) });
      let runError;
      try {
        const run = await runtime.runs.start({
          sessionId: session.id,
          prompt: 'credential smoke',
          options: { provider: 'mock-provider' },
          credential: { leaseId: credential.id, provider: 'mock-provider' },
          hostTools: { leaseId: hostTools.id },
          operation: { operationId: 'space-run-1' },
        });
        await run.result;
      } catch (error) {
        runError = error instanceof Error ? error.message : String(error);
      }
      console.log(JSON.stringify({ brokerCalls, runError, runtimeId: runtime.identity.runtimeId }));
      await runtime.close();
    `;
    const space = await runSdkProbe(spaceScript, homeDir, profile) as {
      brokerCalls: number;
      runtimeId: string;
      runError?: string;
    };
    expect(space.brokerCalls).toBe(1);

    const observerScript = `
      const { createKodaXRuntime } = await import('./src/sdk-runtime.ts');
      const runtime = await createKodaXRuntime({
        mode: 'daemon', profile: process.argv[2], homeDir: process.argv[1],
        autoStartDaemon: false,
        clientInfo: { name: 'observer-smoke', instanceId: 'observer-smoke-1' },
      });
      const observation = await runtime.sessions.observe('shared-session', () => {});
      console.log(JSON.stringify({
        runtimeId: runtime.identity.runtimeId,
        sessionId: observation.snapshot.session.id,
        settings: observation.snapshot.settings,
        terminalEvents: (await runtime.events.replay({
          sessionId: 'shared-session',
          type: ['run.completed', 'run.failed', 'run.cancelled', 'run.interrupted'],
        })).map((event) => event.id),
      }));
      observation.close();
      await runtime.close();
    `;
    const observer = await runSdkProbe(observerScript, homeDir, profile) as {
      runtimeId: string;
      sessionId: string;
      settings: { revision: number; value: { model: string } };
      terminalEvents: string[];
    };
    expect(observer).toMatchObject({
      runtimeId: space.runtimeId,
      sessionId: 'shared-session',
      settings: { revision: 1, value: { model: 'space-model' } },
    });
    expect(new Set(observer.terminalEvents).size).toBe(observer.terminalEvents.length);
    expect(readAllDaemonText(homeDir)).not.toContain('SPACE_SMOKE_SECRET_DO_NOT_PERSIST');

    const stop = await runDaemonCommand([
      'stop', '--home', homeDir, '--profile', profile,
      '--timeout-ms', '30000', '--json',
    ]);
    expect(stop).toMatchObject({ stopped: true, health: 'missing' });
    await waitForDaemonPidExit(daemonPid, 5_000);
    await waitForDaemonPidExit(mcpPid, 5_000);
    expect(fs.existsSync(paths.stateFile)).toBe(false);
    expect(fs.existsSync(paths.lockFile)).toBe(false);

    const releasedRoot = `${paths.rootDir}.released`;
    fs.renameSync(paths.rootDir, releasedRoot);
    fs.renameSync(releasedRoot, paths.rootDir);
    const releasedApplication = `${applicationDir}.released`;
    fs.renameSync(applicationDir, releasedApplication);
    fs.renameSync(releasedApplication, applicationDir);
  }, 120_000);

  it('resumes client-owned credential and Host Tool leases from a distinct process', async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-daemon-resume-smoke-'));
    tempRoots.push(homeDir);
    const profile = `resume-${process.pid}-${Date.now()}`;
    const instanceSecret = `space_${'s'.repeat(48)}`;
    await runDaemonCommand([
      'start', '--home', homeDir, '--profile', profile,
      '--provider', 'mock-provider', '--timeout-ms', '30000', '--json',
    ]);

    const registerScript = `
      const { createKodaXRuntime } = await import('./src/sdk-runtime.ts');
      const runtime = await createKodaXRuntime({
        mode: 'daemon', profile: process.argv[2], homeDir: process.argv[1],
        autoStartDaemon: false,
        clientInfo: {
          name: 'space-resume-smoke',
          instanceId: 'space-resume-installation',
          instanceSecret: process.argv[3],
        },
      });
      const credential = await runtime.credentials.register({ providers: ['mock-provider'] }, async () => 'secret');
      const hostTools = await runtime.hostTools.register([{
        name: 'space_control', description: 'Control Space',
        inputSchema: { type: 'object' }, sideEffect: 'non_idempotent',
      }], { space_control: async () => ({ content: 'done' }) });
      process.stdout.write(JSON.stringify({ credentialId: credential.id, hostToolId: hostTools.id }) + '\\n');
      await runtime.close();
    `;
    const registered = await runSdkProbe(
      registerScript,
      homeDir,
      profile,
      instanceSecret,
    ) as { readonly credentialId: string; readonly hostToolId: string };

    const resumeScript = `
      const { createKodaXRuntime } = await import('./src/sdk-runtime.ts');
      const runtime = await createKodaXRuntime({
        mode: 'daemon', profile: process.argv[2], homeDir: process.argv[1],
        autoStartDaemon: false,
        clientInfo: {
          name: 'space-resume-smoke',
          instanceId: 'space-resume-installation',
          instanceSecret: process.argv[3],
        },
      });
      const credential = await runtime.credentials.resume(process.argv[4], async () => 'secret');
      const hostTools = await runtime.hostTools.resume(process.argv[5], {
        space_control: async () => ({ content: 'done' }),
      });
      process.stdout.write(JSON.stringify({ credential, hostTools }) + '\\n');
      await runtime.close();
    `;
    await expect(runSdkProbe(
      resumeScript,
      homeDir,
      profile,
      instanceSecret,
      registered.credentialId,
      registered.hostToolId,
    )).resolves.toMatchObject({
      credential: { id: registered.credentialId, providers: ['mock-provider'] },
      hostTools: { id: registered.hostToolId },
    });
  }, 120_000);

  it('prints JSON for real start/stop commands and releases daemon state', async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-daemon-cli-smoke-'));
    tempRoots.push(homeDir);
    const profile = `smoke-${process.pid}-${Date.now()}`;

    const start = await runDaemonCommand([
      'start',
      '--home',
      homeDir,
      '--profile',
      profile,
      '--provider',
      'mock-provider',
      '--timeout-ms',
      '60000',
      '--json',
    ]);
    expect(
      start,
      `${JSON.stringify(start)}\n${readDaemonBootstrapLog(homeDir, profile)}`,
    ).toMatchObject({
      started: true,
      health: 'healthy',
    });
    expect(start.state).toMatchObject({
      profile,
      status: 'ready',
    });
    const daemonPaths = resolveRuntimeDaemonPaths(homeDir, profile);
    const firstOwner = JSON.parse(fs.readFileSync(daemonPaths.lockFile, 'utf8')) as {
      readonly processContainment?: unknown;
      readonly supervisorPid?: unknown;
    };
    if (process.platform === 'win32') {
      expect(firstOwner.processContainment).toBe('windows-job');
      expect(typeof firstOwner.supervisorPid).toBe('number');
      expect(isRuntimeDaemonPidAlive(firstOwner.supervisorPid as number)).toBe(true);
    }

    const status = await runDaemonCommand([
      'status',
      '--home',
      homeDir,
      '--profile',
      profile,
      '--json',
    ]);
    expect(status).toMatchObject({
      profile,
      health: 'healthy',
      runtime: {
        ok: true,
        summary: {
          sessions: 0,
          runs: 0,
          activeRuns: 0,
          queuedRuns: 0,
          pendingPermissions: 0,
          workflows: 0,
        },
      },
    });

    const logs = await runDaemonCommand([
      'logs',
      '--home',
      homeDir,
      '--profile',
      profile,
      '--json',
    ]);
    expect(logs).toMatchObject({
      profile,
      exists: true,
    });
    expect(Array.isArray(logs.lines) ? logs.lines.join('\n') : '').toContain('Runtime daemon ready.');
    expect(String(logs.logFile)).toContain(path.join('.kodax', 'runtime', 'daemon', profile, 'daemon.log'));

    const { createKodaXRuntime } = await import('@kodax-ai/kodax/runtime');
    const { defaultRuntimeDaemonEndpoint } = await import('./runtime-daemon/transport.js');
    const runtime = await createKodaXRuntime({
      mode: 'daemon',
      profile,
      homeDir,
      daemonEndpoint: defaultRuntimeDaemonEndpoint(profile, homeDir),
      autoStartDaemon: false,
    });
    try {
      await expect(runtime.config.patch({
        provider: 'mock-provider',
        model: 'daemon-home-model',
      })).resolves.toMatchObject({
        provider: 'mock-provider',
        model: 'daemon-home-model',
      });
    } finally {
      await runtime.close();
    }
    const configFile = path.join(homeDir, '.kodax', 'config.json');
    expect(JSON.parse(fs.readFileSync(configFile, 'utf8'))).toMatchObject({
      provider: 'mock-provider',
      model: 'daemon-home-model',
    });

    const restart = await runDaemonCommand([
      'restart',
      '--home',
      homeDir,
      '--profile',
      profile,
      '--provider',
      'mock-provider',
      '--timeout-ms',
      '60000',
      '--json',
    ], {}, 150_000);
    expect(restart).toMatchObject({
      restarted: true,
      stop: {
        stopped: true,
      },
      start: {
        started: true,
        health: 'healthy',
      },
    });
    if (process.platform === 'win32') {
      expect(isRuntimeDaemonPidAlive(firstOwner.supervisorPid as number)).toBe(false);
    }
    const restartedOwner = JSON.parse(fs.readFileSync(daemonPaths.lockFile, 'utf8')) as {
      readonly supervisorPid?: unknown;
    };

    const stop = await runDaemonCommand([
      'stop',
      '--home',
      homeDir,
      '--profile',
      profile,
      '--timeout-ms',
      '30000',
      '--json',
    ]);
    expect(stop).toEqual({
      stopped: true,
      health: 'missing',
      state: null,
    });
    if (process.platform === 'win32') {
      expect(isRuntimeDaemonPidAlive(restartedOwner.supervisorPid as number)).toBe(false);
    }

    const stateFile = path.join(homeDir, '.kodax', 'runtime', 'daemon', profile, 'daemon.json');
    const lockFile = path.join(homeDir, '.kodax', 'runtime', 'daemon', profile, 'daemon.lock');
    expect(fs.existsSync(stateFile)).toBe(false);
    expect(fs.existsSync(lockFile)).toBe(false);
    const shutdownOutcomes = fs.readdirSync(path.dirname(stateFile)).filter(
      (name) => name.startsWith('shutdown-outcome.'),
    );
    expect(shutdownOutcomes).toHaveLength(2);
    expect(new Set(shutdownOutcomes.map((name) => name.split('.')[1])).size).toBe(2);
  }, 240_000);

  it.skipIf(process.platform !== 'win32')(
    'reports cleanup failure rather than safe stop for a live uncontained daemon',
    async () => {
      const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-daemon-uncontained-stop-'));
      tempRoots.push(homeDir);
      const profile = `uncontained-stop-${process.pid}-${Date.now()}`;
      await runDaemonCommand([
        'start', '--home', homeDir, '--profile', profile,
        '--provider', 'mock-provider', '--timeout-ms', '30000', '--json',
      ]);
      const paths = resolveRuntimeDaemonPaths(homeDir, profile);
      const owner = JSON.parse(fs.readFileSync(paths.lockFile, 'utf8')) as {
        readonly runtimeId: string;
        readonly pid: number;
        readonly createdAt: string;
        readonly kind?: 'daemon';
      };
      fs.writeFileSync(paths.lockFile, `${JSON.stringify({
        runtimeId: owner.runtimeId,
        pid: owner.pid,
        createdAt: owner.createdAt,
        ...(owner.kind !== undefined ? { kind: owner.kind } : {}),
      }, null, 2)}\n`, 'utf8');

      const stop = await runDaemonCommand([
        'stop', '--home', homeDir, '--profile', profile,
        '--timeout-ms', '30000', '--json',
      ]);

      expect(stop).toMatchObject({
        stopped: false,
        reason: 'cleanup_failed',
      });
      expect(String(stop.error)).toMatch(/shutdown did not complete successfully/i);
    },
    90_000,
  );

  it('shuts down a test-owned daemon when its explicitly watched parent exits', async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-daemon-parent-watch-'));
    tempRoots.push(homeDir);
    const profile = `parent-watch-${process.pid}-${Date.now()}`;
    const parentScript = `
      const { createKodaXRuntime } = await import('./src/sdk-runtime.ts');
      const { readRuntimeDaemonState, resolveRuntimeDaemonPaths } = await import('./src/runtime-daemon/state.ts');
      process.env.KODAX_INTERNAL_DAEMON_TEST_PARENT_PID = String(process.pid);
      await createKodaXRuntime({
        mode: 'daemon', homeDir: process.argv[1], profile: process.argv[2],
        defaultProvider: 'mock-provider',
      });
      const state = readRuntimeDaemonState(resolveRuntimeDaemonPaths(process.argv[1], process.argv[2]));
      if (!state) throw new Error('daemon did not publish state');
      process.stdout.write(JSON.stringify({ pid: state.pid }), () => process.exit(0));
    `;

    const result = await runSdkProbe(parentScript, homeDir, profile) as { readonly pid: number };
    try {
      await waitForDaemonState(profile, homeDir, false, 5_000);
      await waitForDaemonPidExit(result.pid, 5_000);
    } finally {
      await stopDaemonBestEffort(homeDir);
    }
  }, 90_000);

  it('force-cleans stale daemon ownership without a live owner process', async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-daemon-cli-force-stale-'));
    tempRoots.push(homeDir);
    const profile = `force-stale-${process.pid}-${Date.now()}`;
    const paths = resolveRuntimeDaemonPaths(homeDir, profile);
    writeRuntimeDaemonState(paths, {
      runtimeId: 'runtime-stale',
      profile,
      pid: 999_999_999,
      startedAt: '2026-07-09T00:00:00.000Z',
      endpoint: process.platform === 'win32'
        ? '\\\\.\\pipe\\kodax-runtime-force-stale-missing'
        : path.join(os.tmpdir(), 'kodax-runtime-force-stale-missing.sock'),
      version: '0.7.66',
      status: 'ready',
    });
    expect(tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: 'runtime-stale',
      pid: 999_999_999,
      createdAt: '2026-07-09T00:00:00.000Z',
    })).toBeDefined();

    const stop = await runDaemonCommand([
      'stop',
      '--home',
      homeDir,
      '--profile',
      profile,
      '--timeout-ms',
      '3000',
      '--force',
      '--json',
    ]);

    expect(stop).toMatchObject({
      stopped: true,
      forced: true,
      health: 'missing',
      state: null,
    });
    expect(fs.existsSync(paths.stateFile)).toBe(false);
    expect(fs.existsSync(paths.lockFile)).toBe(false);
  }, 30_000);

  it('refuses force stop when a live pid cannot be verified as the daemon owner', async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-daemon-cli-force-live-'));
    tempRoots.push(homeDir);
    const profile = `force-live-${process.pid}-${Date.now()}`;
    const paths = resolveRuntimeDaemonPaths(homeDir, profile);
    writeRuntimeDaemonState(paths, {
      runtimeId: 'runtime-live',
      profile,
      pid: process.pid,
      startedAt: '2026-07-09T00:00:00.000Z',
      endpoint: process.platform === 'win32'
        ? '\\\\.\\pipe\\kodax-runtime-force-live-missing'
        : path.join(os.tmpdir(), 'kodax-runtime-force-live-missing.sock'),
      version: '0.7.66',
      status: 'ready',
    });
    expect(tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: 'runtime-live',
      pid: process.pid,
      createdAt: '2026-07-09T00:00:00.000Z',
    })).toBeDefined();

    const stop = await runDaemonCommand([
      'stop',
      '--home',
      homeDir,
      '--profile',
      profile,
      '--timeout-ms',
      '3000',
      '--force',
      '--json',
    ]);

    expect(stop).toMatchObject({
      stopped: false,
      forced: true,
      reason: 'unverified_owner',
      health: 'unhealthy',
      state: {
        runtimeId: 'runtime-live',
        pid: process.pid,
      },
    });
    expect(fs.existsSync(paths.stateFile)).toBe(true);
    expect(fs.existsSync(paths.lockFile)).toBe(true);
  }, 30_000);

  it('does not report stop success when detached serve final cleanup fails', async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-daemon-cleanup-failure-'));
    tempRoots.push(homeDir);
    const profile = `cleanup-failure-${process.pid}-${Date.now()}`;
    await runDaemonCommand([
      'start', '--home', homeDir, '--profile', profile,
      '--provider', 'mock-provider', '--timeout-ms', '30000', '--json',
    ], {
      KODAX_INTERNAL_DAEMON_TEST_FINAL_CLEANUP_ERROR: '1',
    });
    const daemonPid = readDaemonPid(homeDir, profile);

    const stop = await runDaemonCommand([
      'stop', '--home', homeDir, '--profile', profile,
      '--timeout-ms', '30000', '--json',
    ]);

    expect(stop).toMatchObject({
      stopped: false,
      reason: 'cleanup_failed',
      health: 'missing',
    });
    await waitForDaemonPidExit(daemonPid, 5_000);
  }, 60_000);

  it('persists a failed outcome when a scheduled Runtime host close fails', async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-daemon-host-close-error-'));
    tempRoots.push(homeDir);
    const profile = `host-close-error-${process.pid}-${Date.now()}`;
    await runDaemonCommand([
      'start', '--home', homeDir, '--profile', profile,
      '--provider', 'mock-provider', '--timeout-ms', '30000', '--json',
    ], {
      NODE_ENV: 'test',
      KODAX_INTERNAL_DAEMON_TEST_HOST_CLOSE_ERROR: '1',
    });
    const paths = resolveRuntimeDaemonPaths(homeDir, profile);
    const owner = readRuntimeDaemonLockOwner(paths.lockFile);
    expect(owner).toBeDefined();
    if (owner === undefined) throw new Error('Expected daemon owner for failed host close test.');

    const stop = await runDaemonCommand([
      'stop', '--home', homeDir, '--profile', profile,
      '--timeout-ms', '5000', '--json',
    ], {}, 15_000);

    expect(stop).toMatchObject({
      stopped: false,
      reason: 'cleanup_failed',
    });
    expect(readRuntimeDaemonShutdownOutcome(paths, owner)).toMatchObject({
      runtimeId: owner.runtimeId,
      pid: owner.pid,
      status: 'failed',
    });
    await waitForDaemonPidExit(owner.pid, 5_000);
  }, 60_000);

  it.skipIf(process.platform !== 'win32')('force-reclaims the exact daemon process when Runtime host close hangs', async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-daemon-host-close-hang-'));
    tempRoots.push(homeDir);
    const profile = `host-close-hang-${process.pid}-${Date.now()}`;
    await runDaemonCommand([
      'start', '--home', homeDir, '--profile', profile,
      '--provider', 'mock-provider', '--timeout-ms', '30000', '--json',
    ], {
      NODE_ENV: 'test',
      KODAX_INTERNAL_DAEMON_TEST_HOST_CLOSE_HANG: '1',
    });
    const daemonPid = readDaemonPid(homeDir, profile);

    const stop = await runDaemonCommand([
      'stop', '--home', homeDir, '--profile', profile,
      '--timeout-ms', '1000', '--json',
    ], {}, 30_000);

    expect(stop).toMatchObject({
      stopped: false,
      reason: 'cleanup_unverified',
      health: 'missing',
      state: null,
    });
    await waitForDaemonPidExit(daemonPid, 5_000);
    await waitForDaemonState(profile, homeDir, false, 5_000);
  }, 60_000);

  it.skipIf(process.platform !== 'win32')('force-reclaims the exact daemon process when final cleanup blocks synchronously', async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-daemon-cleanup-block-'));
    tempRoots.push(homeDir);
    const profile = `cleanup-block-${process.pid}-${Date.now()}`;
    const mcpFixture = await createMcpTestServerFixture(homeDir);
    const applicationDir = path.join(homeDir, 'blocked-application');
    fs.mkdirSync(applicationDir, { recursive: true });
    const mcpServer = mcpFixture.servers[mcpFixture.serverId];
    if (mcpServer === undefined) throw new Error('MCP test server is missing.');
    const integrationDir = path.join(homeDir, '.kodax', 'integrations');
    fs.mkdirSync(integrationDir, { recursive: true });
    fs.writeFileSync(path.join(integrationDir, 'mcp.json'), JSON.stringify({
      version: 1,
      servers: {
        ...mcpFixture.servers,
        [mcpFixture.serverId]: { ...mcpServer, cwd: applicationDir },
      },
    }), 'utf8');
    await runDaemonCommand([
      'start', '--home', homeDir, '--profile', profile,
      '--provider', 'mock-provider', '--timeout-ms', '30000', '--json',
    ], {
      KODAX_INTERNAL_DAEMON_TEST_FINAL_CLEANUP_BLOCK_MS: '30000',
    });
    const daemonPid = readDaemonPid(homeDir, profile);
    const paths = resolveRuntimeDaemonPaths(homeDir, profile);
    const mcpPid = await waitForManagedChildPid(
      path.join(homeDir, '.kodax'),
      mcpFixture.scriptPath,
    );

    const stop = await runDaemonCommand([
      'stop', '--home', homeDir, '--profile', profile,
      '--timeout-ms', '1000', '--json',
    ], {}, 30_000);

    expect(stop).toMatchObject({
      stopped: false,
      reason: 'cleanup_unverified',
      health: 'missing',
      state: null,
    });
    await waitForDaemonPidExit(daemonPid, 5_000);
    await waitForDaemonPidExit(mcpPid, 5_000);
    expect(fs.existsSync(paths.stateFile)).toBe(false);
    expect(fs.existsSync(paths.lockFile)).toBe(false);

    const releasedRoot = `${paths.rootDir}.released`;
    fs.renameSync(paths.rootDir, releasedRoot);
    fs.renameSync(releasedRoot, paths.rootDir);
    const releasedApplication = `${applicationDir}.released`;
    fs.renameSync(applicationDir, releasedApplication);
    fs.renameSync(releasedApplication, applicationDir);
  }, 60_000);

  it('reports a replacement daemon that takes ownership while the old process exits', async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-daemon-replacement-race-'));
    tempRoots.push(homeDir);
    const profile = `replacement-race-${process.pid}-${Date.now()}`;
    const initial = await runDaemonCommand([
      'start', '--home', homeDir, '--profile', profile,
      '--provider', 'mock-provider', '--timeout-ms', '60000', '--json',
    ], {
      KODAX_INTERNAL_DAEMON_TEST_FINAL_CLEANUP_DELAY_MS: '8000',
    });
    const oldPid = readDaemonResultPid(initial, profile);
    const stopPromise = runDaemonCommand([
      'stop', '--home', homeDir, '--profile', profile,
      '--timeout-ms', '30000', '--json',
    ], {}, 45_000);
    await waitForDaemonState(profile, homeDir, false, 10_000);

    const replacement = await runDaemonCommand([
      'start', '--home', homeDir, '--profile', profile,
      '--provider', 'mock-provider', '--timeout-ms', '60000', '--json',
    ]);
    expect(replacement, JSON.stringify(replacement)).toMatchObject({
      started: true,
      health: 'healthy',
    });
    const replacementPid = readDaemonResultPid(replacement, profile);
    const stop = await stopPromise;

    expect(replacementPid).not.toBe(oldPid);
    expect(stop).toMatchObject({
      stopped: false,
      reason: 'replacement_running',
      replacementRunning: true,
      health: 'healthy',
      state: { pid: replacementPid },
    });
    await waitForDaemonPidExit(oldPid, 5_000);
  }, 180_000);

  it('does not send a stale stop request to a replacement daemon on the same endpoint', async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-daemon-stale-stop-race-'));
    tempRoots.push(homeDir);
    const profile = `stale-stop-race-${process.pid}-${Date.now()}`;
    const observedFile = path.join(homeDir, 'stop-observed');
    const initial = await runDaemonCommand([
      'start', '--home', homeDir, '--profile', profile,
      '--provider', 'mock-provider', '--timeout-ms', '30000', '--json',
    ]);
    const oldPid = readDaemonResultPid(initial, profile);
    const staleStop = runDaemonCommand([
      'stop', '--home', homeDir, '--profile', profile,
      '--timeout-ms', '30000', '--json',
    ], {
      KODAX_INTERNAL_DAEMON_TEST_STOP_OBSERVED_FILE: observedFile,
      KODAX_INTERNAL_DAEMON_TEST_STOP_AFTER_OBSERVATION_DELAY_MS: '10000',
    }, 45_000);
    await waitForFile(observedFile);

    await expect(runDaemonCommand([
      'stop', '--home', homeDir, '--profile', profile,
      '--timeout-ms', '30000', '--json',
    ])).resolves.toMatchObject({ stopped: true, health: 'missing' });
    await waitForDaemonPidExit(oldPid, 5_000);
    const replacement = await runDaemonCommand([
      'start', '--home', homeDir, '--profile', profile,
      '--provider', 'mock-provider', '--timeout-ms', '30000', '--json',
    ]);
    expect(replacement).toMatchObject({ started: true, health: 'healthy' });
    const replacementPid = readDaemonResultPid(replacement, profile);

    await expect(staleStop).rejects.toThrow(
      'Runtime daemon owner changed before the stop request',
    );
    expect(isRuntimeDaemonPidAlive(replacementPid)).toBe(true);
    await expect(observeRuntimeDaemonHealth(resolveRuntimeDaemonPaths(homeDir, profile)))
      .resolves.toMatchObject({
        pidAlive: true,
        endpointReachable: true,
        identityMatches: true,
        state: { pid: replacementPid, status: 'ready' },
      });
  }, 90_000);
});

async function runDaemonCommand(
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
  timeoutMs = DEFAULT_NODE_PROCESS_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  const stdout = await runNodeProcess([
    '--import',
    'tsx',
    path.join(process.cwd(), 'src', 'kodax_cli.ts'),
    'daemon',
    ...args,
  ], env, timeoutMs);
  return JSON.parse(stdout) as Record<string, unknown>;
}

async function runKodaXCommand(
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): Promise<string> {
  return runNodeProcess([
    '--import',
    'tsx',
    path.join(process.cwd(), 'src', 'kodax_cli.ts'),
    ...args,
  ], env);
}

async function runSdkProbe(
  script: string,
  homeDir: string,
  profile: string,
  ...args: readonly string[]
): Promise<unknown> {
  const stdout = await runNodeProcess([
    '--import',
    'tsx',
    '--input-type=module',
    '--eval',
    script,
    homeDir,
    profile,
    ...args,
  ]);
  return JSON.parse(stdout) as unknown;
}

function runNodeProcess(
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
  timeoutMs = DEFAULT_NODE_PROCESS_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...args], {
      cwd: process.cwd(),
      detached: process.platform !== 'win32',
      env: { ...process.env, KODAX_TRACING: '0', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    rememberChildProcessTree(child);
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error !== undefined) reject(error);
      else resolve(stdout);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      const timeoutError = new Error(
        `Node process timed out after ${timeoutMs}ms${stderr.trim() ? `: ${stderr.trim()}` : ''}`,
      );
      void killChildProcessTree(child, { forceMs: 2_000, taskkillMs: 5_000 }).then(
        () => finish(timeoutError),
        (cleanupError: unknown) => finish(new Error(
          `${timeoutError.message}; process-tree cleanup failed: ${String(cleanupError)}`,
          { cause: cleanupError },
        )),
      );
    }, timeoutMs);

    child.once('error', finish);
    child.once('close', (code, signal) => {
      if (timedOut) return;
      if (code === 0) {
        finish();
        return;
      }
      const detail = stderr.trim() || `signal ${signal ?? 'unknown'}`;
      finish(new Error(`Node process exited with code ${code ?? 'null'}: ${detail}`));
    });
  });
}

function readAllDaemonText(homeDir: string): string {
  const root = path.join(homeDir, '.kodax', 'runtime');
  if (!fs.existsSync(root)) return '';
  const content: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else content.push(fs.readFileSync(target, 'utf8'));
    }
  };
  visit(root);
  return content.join('\n');
}

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() <= deadline) {
    if (fs.existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for process marker: ${file}`);
}

async function waitForDaemonClientCount(
  runtime: Pick<KodaXDaemonRuntime, 'status'>,
  expected: number,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() <= deadline) {
    const preflight = await runtime.status.preflight();
    if (preflight.clientCount === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for daemon client count ${expected}.`);
}

async function waitForDaemonState(
  profile: string,
  homeDir: string,
  present: boolean,
  timeoutMs = 30_000,
): Promise<void> {
  const paths = resolveRuntimeDaemonPaths(homeDir, profile);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const exists = fs.existsSync(paths.stateFile) || fs.existsSync(paths.lockFile);
    if (exists === present) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for daemon state present=${present}.`);
}

async function waitForHealthyDaemonStatus(
  paths: ReturnType<typeof resolveRuntimeDaemonPaths>,
  expected: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const observation = await observeRuntimeDaemonHealth(paths);
    if (
      observation.endpointReachable
      && observation.identityMatches
      && observation.state?.status === expected
    ) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for healthy daemon status=${expected}.`);
}

async function waitForDaemonPidExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isRuntimeDaemonPidAlive(pid)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for daemon PID ${pid} to exit.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function readDaemonPid(homeDir: string, profile: string): number {
  const paths = resolveRuntimeDaemonPaths(homeDir, profile);
  const state: unknown = JSON.parse(fs.readFileSync(paths.stateFile, 'utf8'));
  if (
    state === null
    || typeof state !== 'object'
    || !('pid' in state)
    || typeof state.pid !== 'number'
  ) {
    throw new Error(`Daemon profile ${profile} did not publish a numeric PID.`);
  }
  return state.pid;
}

function readDaemonSupervisorPid(homeDir: string, profile: string): number {
  const paths = resolveRuntimeDaemonPaths(homeDir, profile);
  const owner = JSON.parse(fs.readFileSync(paths.lockFile, 'utf8')) as {
    readonly supervisorPid?: unknown;
  };
  if (typeof owner.supervisorPid !== 'number') {
    throw new Error(`Runtime daemon ${profile} has no Windows Job supervisor PID.`);
  }
  return owner.supervisorPid;
}

function readDaemonBootstrapLog(homeDir: string, profile: string): string {
  const logFile = runtimeDaemonBootstrapLogPath(resolveRuntimeDaemonPaths(homeDir, profile));
  return fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '<missing>';
}

function readDaemonResultPid(result: Readonly<Record<string, unknown>>, profile: string): number {
  const state = result.state;
  if (
    state === null
    || typeof state !== 'object'
    || !('pid' in state)
    || typeof state.pid !== 'number'
  ) {
    throw new Error(`Daemon profile ${profile} did not return a numeric PID.`);
  }
  return state.pid;
}

async function waitForManagedChildPid(
  configHome: string,
  expectedArg: string,
): Promise<number> {
  const registryDir = path.join(configHome, 'runtime', 'processes', 'children');
  const deadline = Date.now() + 30_000;
  while (Date.now() <= deadline) {
    if (fs.existsSync(registryDir)) {
      for (const entry of fs.readdirSync(registryDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(
            fs.readFileSync(path.join(registryDir, entry.name), 'utf8'),
          );
        } catch {
          continue;
        }
        if (
          parsed !== null
          && typeof parsed === 'object'
          && 'pid' in parsed
          && typeof parsed.pid === 'number'
          && 'args' in parsed
          && Array.isArray(parsed.args)
          && (parsed.args as readonly unknown[]).includes(expectedArg)
        ) return parsed.pid;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for managed child registered with ${expectedArg}.`);
}

async function stopDaemonBestEffort(homeDir: string): Promise<void> {
  const daemonRoot = path.join(homeDir, '.kodax', 'runtime', 'daemon');
  if (!fs.existsSync(daemonRoot)) return;
  for (const entry of fs.readdirSync(daemonRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const profile = entry.name;
    try {
      await runDaemonCommand([
        'stop',
        '--home',
        homeDir,
        '--profile',
        profile,
        '--timeout-ms',
        '3000',
        '--json',
      ], {}, 10_000);
    } catch {
      const stateFile = path.join(daemonRoot, profile, 'daemon.json');
      try {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as { pid?: unknown };
        if (typeof state.pid === 'number') {
          process.kill(state.pid, 'SIGTERM');
        }
      } catch {
        // Best-effort cleanup only.
      }
    }
  }
}
