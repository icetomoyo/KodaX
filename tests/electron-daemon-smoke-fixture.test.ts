import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';

import { afterEach, describe, expect, it, vi } from 'vitest';

interface ProbeDoctor {
  readonly ready: boolean;
  readonly diagnostics: readonly string[];
  readonly setupRequired: boolean;
}

interface ProbeRunResult {
  readonly status: 'completed';
  readonly sandboxed: true;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface ProbeHarness {
  doctor(): Promise<ProbeDoctor>;
  toolBash(context: { readonly abortSignal?: AbortSignal }): Promise<string>;
  runSandboxed(input: {
    readonly args?: readonly string[];
    readonly signal?: AbortSignal;
  }): Promise<ProbeRunResult>;
}

interface GeneratedExtension {
  default(api: {
    registerModelProvider(input: unknown): void;
    registerTool(input: unknown): void;
  }): void;
}

const fixtureSource = readFileSync(
  fileURLToPath(new URL('./fixtures/electron-daemon-smoke/main.cjs', import.meta.url)),
  'utf8',
);
const nodeRequire = createRequire(import.meta.url);
const probeGlobal = globalThis as typeof globalThis & {
  __kodaxElectronProbeHarness?: ProbeHarness;
};

function generateExtension(
  temporaryRoot: string,
  proofPath: string,
  deadlineMs = 1_000,
): string {
  const appDirectory = path.join(temporaryRoot, 'app');
  const stubDirectory = path.join(
    appDirectory,
    'node_modules',
    '@kodax-ai',
    'kodax',
    'dist',
  );
  mkdirSync(stubDirectory, { recursive: true });
  writeFileSync(path.join(appDirectory, 'package.json'), '{"type":"module"}', 'utf8');
  writeFileSync(
    path.join(stubDirectory, 'sdk-llm.js'),
    'export class KodaXBaseProvider {}\n',
    'utf8',
  );
  writeFileSync(
    path.join(stubDirectory, 'sdk-coding.js'),
    [
      'export function toolBash(_input, context) {',
      '  return globalThis.__kodaxElectronProbeHarness.toolBash(context);',
      '}',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    path.join(stubDirectory, 'sdk-sandbox.js'),
    [
      'export function doctorKodaXSandbox() {',
      '  return globalThis.__kodaxElectronProbeHarness.doctor();',
      '}',
      'export function runKodaXSandboxed(input) {',
      '  return globalThis.__kodaxElectronProbeHarness.runSandboxed(input);',
      '}',
    ].join('\n'),
    'utf8',
  );

  const invocationStart = fixtureSource.indexOf('void run().catch');
  const invocationEnd = fixtureSource.indexOf('\n\nasync function run()', invocationStart);
  if (invocationStart < 0 || invocationEnd <= invocationStart) {
    throw new Error('Packaged Electron fixture invocation boundary was not found.');
  }
  const sourceWithoutInvocation =
    fixtureSource.slice(0, invocationStart) + fixtureSource.slice(invocationEnd);
  const fixtureRequire = (specifier: string): unknown => (
    specifier === 'electron'
      ? { app: { on: () => undefined } }
      : nodeRequire(specifier)
  );
  runInNewContext(
    `${sourceWithoutInvocation}\nprepareEnvironmentProbeExtension();`,
    {
      __dirname: appDirectory,
      exports: {},
      module: { exports: {} },
      process: {
        env: {
          ...process.env,
          KODAX_SMOKE_HOME: temporaryRoot,
          KODAX_SMOKE_PROFILE: 'fixture',
          KODAX_SMOKE_RESULT: path.join(temporaryRoot, 'result.json'),
          KODAX_SMOKE_DETACH: path.join(temporaryRoot, 'detach'),
          KODAX_SMOKE_GUI_COUNT: path.join(temporaryRoot, 'gui-count'),
          KODAX_SMOKE_ENV_PROOF: proofPath,
          KODAX_SMOKE_ENV_PROOF_DEADLINE_MS: String(deadlineMs),
          KODAX_CONSOLE_PROBE_QUERY: path.join(temporaryRoot, 'query'),
          KODAX_CONSOLE_PROBE_EXECUTABLE: process.execPath,
          KODAX_SMOKE_NODE_EXECUTABLE: process.execPath,
          KODAX_SMOKE_PROFILE_TOOLCHAIN: path.join(temporaryRoot, 'toolchain'),
          KODAX_SMOKE_QUERY_COUNT: '1',
          KODAX_SMOKE_SESSION_ID: 'fixture-session',
        },
        pid: process.pid,
      },
      require: fixtureRequire,
    },
  );
  return path.join(temporaryRoot, 'daemon-environment-probe.mjs');
}

async function activateExtension(extensionPath: string): Promise<void> {
  const extension = await import(pathToFileURL(extensionPath).href) as GeneratedExtension;
  extension.default({
    registerModelProvider: () => undefined,
    registerTool: () => undefined,
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for the packaged Electron probe fixture.');
}

function completedProbe(stdout: string): ProbeRunResult {
  return { status: 'completed', sandboxed: true, exitCode: 0, stdout, stderr: '' };
}

afterEach(() => {
  delete probeGlobal.__kodaxElectronProbeHarness;
  vi.restoreAllMocks();
});

describe('packaged Electron daemon environment probe', () => {
  it('awaits event subscription readiness before launching parallel Runtime runs', () => {
    const subscriptionBarrier = fixtureSource.indexOf(
      'await Promise.all([...permissionSubscriptions, ...sandboxSubscriptions]',
    );
    const parallelRunStart = fixtureSource.indexOf('const runQuery = async (index) =>');

    expect(subscriptionBarrier).toBeGreaterThan(0);
    expect(parallelRunStart).toBeGreaterThan(subscriptionBarrier);
  });

  it('waits for the exact sandbox observation after each parallel Run result', () => {
    const resultSettlement = fixtureSource.indexOf('const completed = await handle.result;');
    const observationSettlement = fixtureSource.indexOf(
      'await waitForAppliedSandboxObservation(handle.runId);',
    );

    expect(resultSettlement).toBeGreaterThan(0);
    expect(observationSettlement).toBeGreaterThan(resultSettlement);
    expect(fixtureSource).toContain("observation.state !== 'applied'");
    expect(fixtureSource).toContain("observation.backend !== 'windows-restricted-user'");
  });

  it('includes the daemon Windows sandbox diagnostic when an observation is not applied', () => {
    const observationFailure = fixtureSource.indexOf(
      '`Run ${runId} reported a non-applied Windows sandbox:',
    );
    const diagnosticRead = fixtureSource.lastIndexOf(
      'readWindowsSandboxDiagnostics()',
      observationFailure,
    );

    expect(observationFailure).toBeGreaterThan(0);
    expect(diagnosticRead).toBeGreaterThan(0);
    expect(diagnosticRead).toBeLessThan(observationFailure);
    expect(fixtureSource).toContain("entry?.data?.source !== 'sandbox:windows-v2'");
  });

  it('requires preconfigured setup and carries cancellable signals', () => {
    expect(fixtureSource).not.toContain('setupKodaXSandbox');
    expect(fixtureSource).not.toContain('Promise.race');
    expect(fixtureSource).toContain('operation(controller.signal)');
    expect(fixtureSource).toContain('abortSignal: signal');
  });

  it('does not publish timeout failure before aborted cleanup settles', async () => {
    const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'kodax-electron-probe-timeout-'));
    const proofPath = path.join(temporaryRoot, 'environment-proof.json');
    let abortObserved = false;
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    try {
      const extensionPath = generateExtension(temporaryRoot, proofPath, 250);
      probeGlobal.__kodaxElectronProbeHarness = {
        doctor: async () => ({ ready: true, diagnostics: [], setupRequired: false }),
        toolBash: async ({ abortSignal }) => {
          if (abortSignal === undefined) throw new Error('Expected a shell probe abort signal.');
          await new Promise<void>((resolve) => {
            abortSignal.addEventListener('abort', () => {
              abortObserved = true;
              resolve();
            }, { once: true });
          });
          await cleanup;
          return 'Exit: 1\ncancelled';
        },
        runSandboxed: async () => completedProbe('unexpected'),
      };
      await activateExtension(extensionPath);
      await waitUntil(() => abortObserved);
      expect(existsSync(proofPath)).toBe(false);
      releaseCleanup();
      await waitUntil(() => existsSync(proofPath));
      const proof = JSON.parse(readFileSync(proofPath, 'utf8')) as {
        readonly probeError?: { readonly phase?: string };
      };
      expect(proof.probeError?.phase).toBe('shell-probe');
    } finally {
      releaseCleanup();
      rmSync(temporaryRoot, { force: true, recursive: true });
    }
  });

  it('fails closed on a not-ready doctor without starting a command', async () => {
    const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'kodax-electron-probe-doctor-'));
    const proofPath = path.join(temporaryRoot, 'environment-proof.json');
    let commandCalls = 0;
    try {
      const extensionPath = generateExtension(temporaryRoot, proofPath);
      probeGlobal.__kodaxElectronProbeHarness = {
        doctor: async () => ({
          ready: false,
          diagnostics: ['[acl_guards_missing] setup required'],
          setupRequired: true,
        }),
        toolBash: async () => {
          commandCalls += 1;
          return 'unexpected';
        },
        runSandboxed: async () => {
          commandCalls += 1;
          return completedProbe('unexpected');
        },
      };
      await activateExtension(extensionPath);
      await waitUntil(() => existsSync(proofPath));
      expect(commandCalls).toBe(0);
      expect(readFileSync(proofPath, 'utf8')).toContain('preconfigured Windows sandbox');
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true });
    }
  });

  it('atomically publishes complete success JSON', async () => {
    const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'kodax-electron-probe-success-'));
    const proofPath = path.join(temporaryRoot, 'environment-proof.json');
    const originalComSpec = process.env.ComSpec;
    try {
      const extensionPath = generateExtension(temporaryRoot, proofPath);
      let directCalls = 0;
      probeGlobal.__kodaxElectronProbeHarness = {
        doctor: async () => ({ ready: true, diagnostics: [], setupRequired: false }),
        toolBash: async () => (
          'Exit: 0\nshell-probe-ok\nnode-mode=absent\nprofile-toolchain-ok'
        ),
        runSandboxed: async () => {
          directCalls += 1;
          return completedProbe(directCalls === 1
            ? 'direct-sandbox-ok'
            : 'direct-powershell-ok');
        },
      };
      process.env.ComSpec = process.execPath;
      await activateExtension(extensionPath);
      await waitUntil(() => existsSync(proofPath));
      const proofJson = readFileSync(proofPath, 'utf8');
      const proof = JSON.parse(proofJson) as {
        readonly shellProbe?: string;
        readonly directSandboxProbe?: ProbeRunResult;
        readonly directPowerShellProbe?: ProbeRunResult;
      };
      expect(proof.shellProbe).toBe('shell-probe-ok');
      expect(proof.directSandboxProbe?.stdout).toBe('direct-sandbox-ok');
      expect(proof.directPowerShellProbe?.stdout).toBe('direct-powershell-ok');
      expect(proofJson.startsWith('{') && proofJson.endsWith('}')).toBe(true);
      expect(existsSync(`${proofPath}.${process.pid}.1.tmp`)).toBe(false);
    } finally {
      if (originalComSpec === undefined) delete process.env.ComSpec;
      else process.env.ComSpec = originalComSpec;
      rmSync(temporaryRoot, { force: true, recursive: true });
    }
  });

  it('observes final publication failure without an unhandled rejection', async () => {
    const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'kodax-electron-probe-publish-'));
    const proofPath = path.join(temporaryRoot, 'environment-proof.json');
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const extensionPath = generateExtension(temporaryRoot, proofPath);
      mkdirSync(proofPath);
      probeGlobal.__kodaxElectronProbeHarness = {
        doctor: async () => ({ ready: false, diagnostics: ['not ready'], setupRequired: true }),
        toolBash: async () => 'unexpected',
        runSandboxed: async () => completedProbe('unexpected'),
      };
      await activateExtension(extensionPath);
      await waitUntil(() => stderr.mock.calls.some((call) => (
        String(call[0]).includes('environment proof publication failed')
      )));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      rmSync(temporaryRoot, { force: true, recursive: true });
    }
  });

  it('generates a syntactically valid environment probe extension', () => {
    const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'kodax-electron-probe-syntax-'));
    try {
      const extensionPath = generateExtension(
        temporaryRoot,
        path.join(temporaryRoot, 'environment-proof.json'),
      );
      const syntax = spawnSync(process.execPath, ['--check', extensionPath], {
        encoding: 'utf8',
        windowsHide: true,
      });
      expect(syntax.status, syntax.stderr).toBe(0);
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true });
    }
  });
});
