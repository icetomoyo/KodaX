import { createCliStartupProgress, type CliStartupProgress } from '../cli-startup-progress.js';
import chalk from 'chalk';
import { execFile } from 'node:child_process';
import { daemonServeExecArgv } from '../runtime-daemon/process.js';
import { prepareInternalNodeLaunch } from '@kodax-ai/agent';

type SandboxRuntimeModule = typeof import('../sandbox-runtime.js');
let sandboxRuntimeModulePromise: Promise<SandboxRuntimeModule> | undefined;

export function loadSandboxRuntimeModule(): Promise<SandboxRuntimeModule> {
  sandboxRuntimeModulePromise ??= import('../sandbox-runtime.js');
  return sandboxRuntimeModulePromise;
}

export const INTERNAL_SANDBOX_STARTUP_RECOVERY_ARG = '__sandbox-startup-recovery';
export const INTERNAL_SANDBOX_STARTUP_RECOVERY_ENV = 'KODAX_INTERNAL_SANDBOX_STARTUP_RECOVERY';
export const INTERNAL_SANDBOX_STARTUP_REPORT_PREFIX = 'KODAX_SANDBOX_STARTUP_REPORT:';

export async function prepareSetupSandboxReport(
  allowElevation = process.stdin.isTTY === true && process.stdout.isTTY === true,
): Promise<{
  readonly status: 'ready' | 'cancelled' | 'unavailable';
  readonly attempted: boolean;
  readonly lines: readonly string[];
}> {
  const { prepareSandboxRuntimeForSetup } = await loadSandboxRuntimeModule();
  const outcome = await prepareSandboxRuntimeForSetup({
    allowElevation,
  });
  const details = [
    ...outcome.guidance,
    ...outcome.doctor.diagnostics.map((diagnostic) => `Diagnostic: ${diagnostic}`),
    ...(outcome.error ? [`Setup result: ${outcome.error}`] : []),
    ...(outcome.status === 'unavailable'
      ? ['KodaX will use the normal permission policy; sandbox containment remains off until activated.']
      : []),
  ];
  return {
    status: outcome.status,
    attempted: outcome.attempted,
    lines: [...new Set(details)],
  };
}

interface InteractiveSandboxStartupInput {
  readonly platform: NodeJS.Platform;
  readonly stdinIsTTY: boolean;
  readonly stdoutIsTTY: boolean;
}

interface InteractiveSandboxStartupReport {
  readonly status: 'ready' | 'cancelled' | 'unavailable';
  readonly attempted: boolean;
  readonly lines: readonly string[];
}

function isInteractiveSandboxStartupReport(
  value: unknown,
): value is InteractiveSandboxStartupReport {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const report = value as Readonly<Record<string, unknown>>;
  return (
    (report.status === 'ready' || report.status === 'cancelled' || report.status === 'unavailable')
    && typeof report.attempted === 'boolean'
    && Array.isArray(report.lines)
    && report.lines.every((line: unknown) => typeof line === 'string')
  );
}

function parseInteractiveSandboxStartupReport(
  output: string,
): InteractiveSandboxStartupReport | undefined {
  const lines = output.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line?.startsWith(INTERNAL_SANDBOX_STARTUP_REPORT_PREFIX)) continue;
    try {
      const parsed: unknown = JSON.parse(line.slice(INTERNAL_SANDBOX_STARTUP_REPORT_PREFIX.length));
      return isInteractiveSandboxStartupReport(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function interactiveSandboxStartupRecoveryLaunch(): {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
} {
  const bundled = process.env.KODAX_BUNDLED === 'true';
  const entry = bundled ? undefined : process.argv[1];
  if (!bundled && entry === undefined) {
    throw new Error('KodaX CLI entry path is unavailable for sandbox startup recovery.');
  }
  const args = [
    ...(entry === undefined
      ? []
      : daemonServeExecArgv(process.execArgv, entry.endsWith('.ts'))),
    ...(entry === undefined ? [] : [entry]),
    INTERNAL_SANDBOX_STARTUP_RECOVERY_ARG,
  ];
  const launch = prepareInternalNodeLaunch({
    args,
    env: {
      ...process.env,
      [INTERNAL_SANDBOX_STARTUP_RECOVERY_ENV]: '1',
    },
    isElectron: process.versions.electron !== undefined,
  });
  return { command: process.execPath, ...launch };
}

export async function prepareInteractiveSandboxStartupInChild(
): Promise<InteractiveSandboxStartupReport> {
  let launch: ReturnType<typeof interactiveSandboxStartupRecoveryLaunch>;
  try {
    launch = interactiveSandboxStartupRecoveryLaunch();
  } catch (error: unknown) {
    return {
      status: 'unavailable',
      attempted: false,
      lines: [error instanceof Error ? error.message : String(error)],
    };
  }
  return await new Promise<InteractiveSandboxStartupReport>((resolve) => {
    execFile(
      launch.command,
      [...launch.args],
      {
        cwd: process.cwd(),
        env: launch.env,
        encoding: 'utf8',
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const report = parseInteractiveSandboxStartupReport(stdout);
        if (report !== undefined) {
          resolve(report);
          return;
        }
        const detail = stderr.trim()
          || (error instanceof Error ? error.message : 'Sandbox startup recovery returned no report.');
        resolve({
          status: 'unavailable',
          attempted: true,
          lines: [
            `Sandbox startup recovery could not complete: ${detail}`,
            'KodaX will use the normal permission policy until the sandbox is activated.',
          ],
        });
      },
    );
  });
}

async function withInteractiveSandboxStartupProgress<T>(
  operation: () => Promise<T>,
  startupProgress?: CliStartupProgress,
): Promise<T> {
  const message = 'Preparing Windows sandbox; first repair may take a few minutes';
  const progress = startupProgress ?? createCliStartupProgress(message);
  if (startupProgress) progress.update(message);
  try {
    return await operation();
  } finally {
    if (!startupProgress) progress.stop();
  }
}

export async function prepareInteractiveSandboxStartup(
  input: InteractiveSandboxStartupInput,
  prepare: () => Promise<InteractiveSandboxStartupReport>,
  isSetupCurrent: () => boolean | Promise<boolean> = () => false,
  startupProgress?: CliStartupProgress,
): Promise<InteractiveSandboxStartupReport | undefined> {
  if (
    input.platform !== 'win32'
    || !input.stdinIsTTY
    || !input.stdoutIsTTY
  ) return undefined;
  if (await isSetupCurrent()) return undefined;
  return withInteractiveSandboxStartupProgress(prepare, startupProgress);
}

export function reportInteractiveSandboxStartup(
  report: InteractiveSandboxStartupReport | undefined,
): void {
  if (report === undefined || (!report.attempted && report.status === 'ready')) return;
  const label = report.status === 'ready'
    ? chalk.green('ready')
    : report.status === 'cancelled'
      ? chalk.yellow('cancelled')
      : chalk.yellow('unavailable');
  process.stderr.write(`\nWindows sandbox startup recovery: [${label}]\n`);
  for (const line of report.lines) process.stderr.write(`  ${line}\n`);
  process.stderr.write('\n');
}

export async function inspectSandboxReport(): Promise<{
  readonly ready: boolean;
  readonly platform: string;
  readonly version: string;
  readonly backend: string;
  readonly diagnostics: readonly string[];
  readonly guidance: readonly string[];
}> {
  const {
    doctorSandboxExecution,
    sandboxRuntimeCapability,
    sandboxSetupGuidance,
  } = await loadSandboxRuntimeModule();
  const doctor = await doctorSandboxExecution();
  return {
    ready: doctor.ready,
    platform: doctor.platform,
    version: doctor.version,
    backend: sandboxRuntimeCapability().backend,
    diagnostics: doctor.diagnostics,
    guidance: sandboxSetupGuidance(doctor),
  };
}
