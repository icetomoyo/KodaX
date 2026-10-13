import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createCliStartupProgress, isInteractiveCliStartup, type CliStartupProgress } from './cli-startup-progress.js';

export type BootstrapResumeRoute =
  | { readonly kind: 'continue'; readonly argv: readonly string[] }
  | { readonly kind: 'exit' };

interface ResumeModule {
  readonly resolveBareResume: (options?: {
    readonly beforeSelect?: () => Promise<void>;
  }) => Promise<BootstrapResumeRoute>;
}

interface CliModule {
  readonly main: (options?: { readonly startupProgress?: CliStartupProgress }) => Promise<void>;
}

export interface KodaXBootstrapOptions {
  readonly argv?: string[];
  readonly loadResume?: () => Promise<ResumeModule>;
  readonly loadCli?: () => Promise<CliModule>;
  readonly stdin?: {
    readonly isTTY?: boolean;
    readonly pause?: () => void;
    readonly ref?: () => void;
    readonly unref?: () => void;
  };
}

export function isBareResumeRequest(args: readonly string[]): boolean {
  return args.length === 1 && (args[0] === '-r' || args[0] === '--resume');
}

export function isVersionRequest(args: readonly string[]): boolean {
  return args.length === 1 && (args[0] === '-V' || args[0] === '--version');
}

function readBootstrapVersion(): string {
  if (process.env.KODAX_VERSION) return process.env.KODAX_VERSION;
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    );
    if (
      typeof parsed === 'object'
      && parsed !== null
      && typeof (parsed as { readonly version?: unknown }).version === 'string'
    ) {
      return (parsed as { readonly version: string }).version;
    }
  } catch {
    // Standalone builds inject KODAX_VERSION and may not ship package.json.
  }
  return '0.0.0';
}

export async function runKodaXBootstrap(options: KodaXBootstrapOptions = {}): Promise<void> {
  const argv = options.argv ?? process.argv;
  const stdin = options.stdin ?? process.stdin;
  const loadResume = options.loadResume ?? (() => import('./kodax_resume.js'));
  const loadCli = options.loadCli ?? (() => import('./kodax_cli.js'));
  let cliModulePromise: Promise<CliModule> | undefined;
  const loadCliOnce = (): Promise<CliModule> => {
    cliModulePromise ??= loadCli();
    return cliModulePromise;
  };
  const args = argv.slice(2);
  let startupProgress: CliStartupProgress | undefined;
  try {
    if (isVersionRequest(args)) {
      process.stdout.write(`${readBootstrapVersion()}\n`);
      return;
    }
    if (isBareResumeRequest(args)) {
      const route = await (await loadResume()).resolveBareResume({
        beforeSelect: async () => {
          await loadCliOnce();
        },
      });
      if (route.kind === 'exit') {
        stdin.pause?.();
        stdin.unref?.();
        return;
      }
      argv.splice(2, argv.length - 2, ...route.argv);
      if (route.argv.length > 0 && stdin.isTTY === true) {
        stdin.pause?.();
        stdin.ref?.();
      }
    }
    if (isInteractiveCliStartup(argv.slice(2))) {
      startupProgress = createCliStartupProgress(args[0] === '-r' || args[0] === '--resume'
        ? 'Resuming session' : 'Starting KodaX');
    }
    const cli = await loadCliOnce();
    if (startupProgress) await cli.main({ startupProgress });
    else await cli.main();
  } finally {
    startupProgress?.stop();
  }
}

export async function runKodaXBootstrapAsEntry(): Promise<void> {
  try {
    await runKodaXBootstrap();
  } catch (error: unknown) {
    process.stdin.pause();
    process.stdin.unref?.();
    const message = error instanceof Error ? error.message : String(error);
    try {
      const { default: chalk } = await import('chalk');
      console.error(chalk.red(`[Error] ${message}`));
    } catch {
      console.error(`[Error] ${message}`);
    }
    process.exitCode = 1;
  }
}

const scriptPath = process.argv[1];
const isMainModule = scriptPath !== undefined
  && import.meta.url === pathToFileURL(scriptPath).href;

if (isMainModule) {
  void runKodaXBootstrapAsEntry();
}
