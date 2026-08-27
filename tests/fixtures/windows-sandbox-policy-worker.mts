import { stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { setKodaXDiagnosticSink } from '@kodax-ai/agent';
import { toolBash } from '../../packages/coding/src/tools/bash.ts';
import {
  createAsrtShellSandbox,
  doctorSandboxRuntime,
  setupSandboxRuntime,
} from '../../src/sandbox-runtime.ts';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function errorDiagnostic(value: unknown, depth = 0): string {
  if (!(value instanceof Error)) return String(value);
  const base = value.stack ?? `${value.name}: ${value.message}`;
  if (depth >= 4) return base;
  const nested = value instanceof AggregateError
    ? value.errors
    : value.cause === undefined
      ? []
      : [value.cause];
  return nested.length === 0
    ? base
    : `${base}\n${nested.map((item, index) => (
        `[nested ${index + 1}] ${errorDiagnostic(item, depth + 1)}`
      )).join('\n')}`;
}

function hasOnlyRepairableAclGuardDiagnostics(diagnostics: readonly string[]): boolean {
  const blocking = diagnostics.filter(
    (diagnostic) => !diagnostic.startsWith('[legacy_acl_state_ignored]'),
  );
  return blocking.length > 0
    && blocking.every((diagnostic) => diagnostic.startsWith('[acl_guards_missing]'));
}

const workspace = path.resolve(requiredEnvironment('KODAX_CROSS_PROCESS_WORKSPACE'));
const barrierScript = path.resolve(requiredEnvironment('KODAX_CROSS_PROCESS_BARRIER'));
const barrierDirectory = path.resolve(requiredEnvironment('KODAX_CROSS_PROCESS_BARRIER_DIR'));
const participant = requiredEnvironment('KODAX_CROSS_PROCESS_PARTICIPANT');
const expectedParticipants = Number(requiredEnvironment('KODAX_CROSS_PROCESS_EXPECTED'));
const resultFile = path.resolve(requiredEnvironment('KODAX_CROSS_PROCESS_RESULT'));

const observations: unknown[] = [];
const diagnostics: unknown[] = [];
const restoreDiagnostics = setKodaXDiagnosticSink((diagnostic) => diagnostics.push({
  ...diagnostic,
  detail: diagnostic.detail instanceof Error
    ? diagnostic.detail.stack
    : diagnostic.detail,
}));
let result = '';
let error: string | undefined;
try {
  let doctor = await doctorSandboxRuntime({ refresh: true });
  if (
    !doctor.ready
    && hasOnlyRepairableAclGuardDiagnostics(doctor.diagnostics)
  ) {
    doctor = await setupSandboxRuntime();
  }
  if (!doctor.ready) {
    throw new Error(`Windows sandbox is unavailable: ${JSON.stringify(doctor)}`);
  }
  const preflightDirectory = process.env.KODAX_CROSS_PROCESS_PREFLIGHT_DIR;
  if (preflightDirectory !== undefined) {
    await writeFile(path.join(preflightDirectory, `${participant}.ready`), 'ready', 'utf8');
    const start = path.join(preflightDirectory, 'start');
    const deadline = Date.now() + 30_000;
    while (true) {
      try {
        await stat(start);
        break;
      } catch (caught: unknown) {
        if ((caught as NodeJS.ErrnoException).code !== 'ENOENT') throw caught;
      }
      if (Date.now() >= deadline) throw new Error('Cross-process preflight timed out.');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  const shellSandbox = createAsrtShellSandbox({
    workspaceRoot: workspace,
    shouldSandbox: () => true,
  });
  const command = [
    'node',
    JSON.stringify(barrierScript),
    JSON.stringify(barrierDirectory),
    JSON.stringify(participant),
    String(expectedParticipants),
  ].join(' ');
  result = await toolBash({ command, timeout: 240 }, {
    backups: new Map(),
    executionCwd: workspace,
    toolCallId: `cross-process-${participant}`,
    shellSandbox,
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
        set: {
          PATH: process.env.PATH ?? process.env.Path ?? '',
        },
      },
      cache: { ttlMs: 0, refreshToken: 'cross-process-policy-sharing' },
      probeTimeoutMs: 10_000,
    },
    reportToolSandboxObservation: (observation) => observations.push(observation),
  });
} catch (caught) {
  error = errorDiagnostic(caught);
} finally {
  restoreDiagnostics();
}

await writeFile(resultFile, JSON.stringify({ diagnostics, error, observations, result }), 'utf8');
if (error !== undefined) process.exitCode = 1;
