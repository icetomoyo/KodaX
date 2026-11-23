#!/usr/bin/env node
import { createCliStartupProgress, isInteractiveCliStartup, type CliStartupProgress } from './cli-startup-progress.js';
// ── Runtime environment defaults ──
// NODE_ENV must be set BEFORE any ESM static import is evaluated, otherwise
// React loads its development reconciler (~100 MB/turn profiling leak).
// This is handled by the CJS shim/preload upstream of this file:
//   - bin entry:        scripts/kodax-bin.cjs requires production-env.cjs
//                       then imports the lightweight bootstrap (ESM)
//   - npm run dev/start: --require ./scripts/production-env.cjs flag
// The bootstrap dynamically imports this full module after optional resume
// selection, so production mode is still fixed before React is evaluated.
// The inline fallback below only covers `node dist/kodax_cli.js` invoked
// directly; in that path we cannot guarantee React is still in production
// mode, but setting NODE_ENV here keeps downstream NODE_ENV checks sane.
const nodeEnvKey = ['NODE', 'ENV'].join('_') as 'NODE_ENV';
if (!process.env[nodeEnvKey]) {
  process.env[nodeEnvKey] =
    process.env.KODAX_DEV === '1' ? 'development' : 'production';
}

// Propagate a sensible V8 heap limit to child processes (sub-agents, forks).
// The main process heap limit is set via --max-old-space-size in the
// package.json scripts or shell wrapper. NODE_OPTIONS set here at runtime
// only affects children. Default 4 GB; override via KODAX_HEAP_LIMIT.
if (
  !process.execArgv.some((a) => a.includes('max-old-space-size')) &&
  !process.env.NODE_OPTIONS?.includes('max-old-space-size')
) {
  const limit = process.env.KODAX_HEAP_LIMIT ?? '4096';
  process.env.NODE_OPTIONS =
    `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=${limit}`.trim();
}

/**
 * KodaX CLI — Command-line entry point.
 * UI module: Ink-based interactive REPL with managed task lifecycle.
 */
import { Command } from 'commander';
import chalk from 'chalk';
import { pathToFileURL } from 'url';
import {
  getDefaultCommandDir,
  KODAX_COMMANDS_DIR,
  loadCommands,
  parseCommandCall,
  processCommandCall,
  type KodaXCommand,
  type KodaXCommandContext,
} from './cli_commands.js';
import {
  ACP_PERMISSION_MODES,
  parseAgentModeOption,
  parsePermissionModeOption,
  parseReasoningModeOption,
  parseRepoIntelligenceModeOption,
  resolveCliAgentMode,
  ignoredKodaXHomeWarning,
} from './cli_option_helpers.js';
import { consumeInternalSkillDispatchFlag } from './skill_cli.js';
import {
  dispatchSkillCreatorTool,
  isSkillCreatorDispatchAction,
} from '@kodax-ai/agent/capabilities/skills';
import { bootstrapTracing, estimateTokens } from '@kodax-ai/coding';
import { KodaXClient, runKodaX, runManagedTask } from './trusted-coding-entry.js';
import { shutdownTracing, applyProcessHardening, installWindowsProcessHelper } from '@kodax-ai/agent';
import { resolveWindowsSandboxV2Executable } from './windows-sandbox-v2.js';
import { version } from './cli-version.js';
import { findKodaXCommand } from './cli/root.js';
import { loadSandboxRuntimeModule, INTERNAL_SANDBOX_STARTUP_RECOVERY_ARG, INTERNAL_SANDBOX_STARTUP_RECOVERY_ENV, INTERNAL_SANDBOX_STARTUP_REPORT_PREFIX, prepareSetupSandboxReport } from './cli/interactive-sandbox.js';
import { configureKodaXSetupCommand, showKodaXSetupHelpIfRequested } from './cli/setup.js';
import { runKodaXRootCommand } from './cli/run.js';
import { createKodaXProgram } from './cli/program.js';
export {
  ACP_PERMISSION_MODES,
  getDefaultCommandDir,
  KODAX_COMMANDS_DIR,
  loadCommands,
  parseCommandCall,
  parseAgentModeOption,
  parsePermissionModeOption,
  parseReasoningModeOption,
  parseRepoIntelligenceModeOption,
  processCommandCall,
  resolveCliAgentMode,
};
export type { KodaXCommand, KodaXCommandContext };
export { configureKodaXRootCommand } from './cli/root.js';
export { prepareInteractiveSandboxStartup } from './cli/interactive-sandbox.js';
export { configureKodaXHostCommand } from './cli/host.js';
export { configureKodaXSetupCommand, showKodaXSetupHelpIfRequested } from './cli/setup.js';
export { configureKodaXMemoryCommand } from './cli/memory.js';

async function main(entryOptions: { readonly startupProgress?: CliStartupProgress } = {}) {
  const startupProgress = entryOptions.startupProgress
    ?? (isInteractiveCliStartup(process.argv.slice(2)) ? createCliStartupProgress('Starting KodaX') : undefined);
  try {
    await runCliMain(startupProgress);
  } finally {
    startupProgress?.stop();
  }
}

async function runCliMain(startupProgress?: CliStartupProgress) {
  const argv = process.argv.slice(2);
  if (
    argv[0] === 'setup' &&
    argv.slice(1).some((arg) => arg === '-h' || arg === '--help')
  ) {
    const helpProgram = new Command().name('kodax');
    const helpCommand = configureKodaXSetupCommand(helpProgram);
    showKodaXSetupHelpIfRequested(argv, helpCommand);
    return;
  }
  const isDaemonManagementCommand = (argv[0] === 'host' || argv[0] === 'daemon') && argv[1] !== 'serve';

  // FEATURE_208 (v0.7.45): strip dynamic-linker preload env vars
  // (LD_PRELOAD / DYLD_*) before anything spawns children or loads native
  // addons. Opt-out: KODAX_DISABLE_HARDENING=1. Debug-preserving (no
  // PR_SET_DUMPABLE). No-op on Windows.
  applyProcessHardening();
  // Daemon discovery checks process identities before the first frame; the
  // native helper answers in tens of milliseconds instead of PowerShell.
  if (process.platform === 'win32') {
    installWindowsProcessHelper(() => resolveWindowsSandboxV2Executable().path);
  }
  const kodaxHomeWarning = ignoredKodaXHomeWarning();
  if (kodaxHomeWarning !== undefined) process.stderr.write(`${kodaxHomeWarning}\n`);
  if (argv[0] === INTERNAL_SANDBOX_STARTUP_RECOVERY_ARG) {
    if (process.env[INTERNAL_SANDBOX_STARTUP_RECOVERY_ENV] !== '1') {
      throw new Error('Internal sandbox startup recovery is not available directly.');
    }
    delete process.env[INTERNAL_SANDBOX_STARTUP_RECOVERY_ENV];
    const report = await prepareSetupSandboxReport(true);
    process.stdout.write(
      `${INTERNAL_SANDBOX_STARTUP_REPORT_PREFIX}${JSON.stringify(report)}\n`,
    );
    return;
  }
  if (argv[0] === '__skill-tool') {
    if (!consumeInternalSkillDispatchFlag()) {
      throw new Error('Internal skill tool entry is not available directly.');
    }
    if (!isSkillCreatorDispatchAction(argv[1])) {
      throw new Error(`Unknown internal skill tool: ${argv[1] ?? '(missing)'}`);
    }
    await dispatchSkillCreatorTool(argv[1], argv.slice(2), {
      estimateTokens,
      runKodaX,
    });
    return;
  }
  if (argv[0] === '__asrt-broker') {
    if (process.platform === 'win32') {
      throw new Error('Windows legacy ASRT broker execution is retired; use the native v2 shell sandbox.');
    }
    process.exitCode = await (await loadSandboxRuntimeModule()).runAsrtBrokerProcess(argv[1]);
    return;
  }
  if (argv[0] === '__asrt-windows-network-broker') {
    if (!argv[1]) throw new Error('Missing Windows network broker request file.');
    process.exitCode = await (await loadSandboxRuntimeModule())
      .runAsrtWindowsNetworkBrokerProcess(argv[1]);
    return;
  }
  // FEATURE_209 (v0.7.45): activate tracing so Runner spans persist to
  // ~/.kodax/.traces/<traceId>.jsonl. FileTracingProcessor flushes per-trace
  // on completion, so completed traces are durable without the beforeExit
  // handler; that handler only flushes a trace still in flight when the event
  // loop drains naturally (it does NOT fire on process.exit()). Opt-out via
  // KODAX_TRACING=0.
  if (!isDaemonManagementCommand) {
    bootstrapTracing();
    process.once('beforeExit', () => {
      void shutdownTracing();
    });
  }

  const program = createKodaXProgram({ version });

  // ============== constructed-tool direct dispatch ==============
  // BEFORE commander parses, intercept `kodax <constructed-tool-name> ...`
  // and dispatch to the registered handler. The detection bootstraps the
  // ConstructionRuntime and consults TOOL_REGISTRY — only fires when the
  // name matches an activated constructed tool. On no match we fall
  // through to commander, which preserves existing behavior (skill/acp/
  // help topics/REPL).
  if (
    argv.length > 0 &&
    argv[0] &&
    !argv[0].startsWith('-') &&
    findKodaXCommand(program, argv[0]) === undefined
  ) {
    const { detectConstructedToolDispatch, runConstructedToolDispatch } =
      await import('./constructed_cli.js');
    const dispatchTarget = await detectConstructedToolDispatch(
      argv,
      process.cwd(),
    );
    if (dispatchTarget) {
      await runConstructedToolDispatch(
        dispatchTarget,
        argv.slice(1),
        process.cwd(),
      );
      return;
    }
  }

  await program.parseAsync(process.argv);
  await runKodaXRootCommand(program, version, startupProgress);
}

/**
 * Entry Point Detection
 *
 * Determines if this module is being run as the main entry point.
 * This is necessary because:
 * 1. When run directly (e.g., `node dist/kodax_cli.js`), we should execute main()
 * 2. When imported for testing, we should NOT execute main()
 * 3. When imported by the lightweight bootstrap, we should NOT execute main()
 * 4. In a Bun standalone bundle, only the bootstrap owns process startup
 *
 * Detection logic:
 * - Direct execution: import.meta.url === pathToFileURL(process.argv[1]).href
 * Global/npm-link execution is owned by scripts/kodax-bin.cjs, which imports
 * the bootstrap and calls main() explicitly after optional resume routing.
 */
const scriptPath = process.argv[1];
const metaUrl = import.meta.url;
const scriptUrl = scriptPath ? pathToFileURL(scriptPath).href : '';

// Only direct execution owns automatic startup. Importers call main() explicitly.
export function shouldAutoStartCli(
  moduleUrl: string,
  entryUrl: string,
  bundled: boolean,
): boolean {
  return !bundled && moduleUrl === entryUrl;
}

const isMainModule = scriptPath && shouldAutoStartCli(
  metaUrl,
  scriptUrl,
  process.env.KODAX_BUNDLED === 'true',
);

if (isMainModule) {
  main().catch((e) => {
    console.error(chalk.red(`[Error] ${e.message}`));
    process.exit(1);
  });
}

// Export for testing
export { main };
