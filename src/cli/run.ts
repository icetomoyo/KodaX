import { cliStartupProgressMessage, type CliStartupProgress } from '../cli-startup-progress.js';
import type { KodaXClientHostAuthorization } from '../client-host-authorization.js';
import { Command } from 'commander';
import chalk from 'chalk';
import path from 'path';
import {
  loadCommands,
  parseCommandCall,
  processCommandCall,
} from '../cli_commands.js';
import {
  createKodaXOptions,
  parseWorkModeOption,
  parseOptionalNonNegativeInt,
  parseRepoIntelligenceModeOption,
  normalizeCliSessionFlags,
  resolveCliAgentMode,
  resolveCliEffort,
  resolveCliModelSelection,
  resolveCliProviderSelection,
  resolveCliReasoningMode,
  findSessionTitleMatches,
  type CliOutputMode,
  type CliOptions,
  validateCliModeSelection,
} from '../cli_option_helpers.js';
import {
  type KodaXOptions,
  dedupeExtensionPathsByEntrypoint,
  discoverDefaultExtensions,
  excludeExtensionPathsByEntrypoint,
  KODAX_DEFAULT_PROVIDER,
  KodaXTerminalError,
  shutdownDefaultLspService,
  awaitLatestCodingMemoryReviewDrain,
} from '@kodax-ai/coding';
import { connectReplHost, createReplHostBindings } from '../repl-host/connect.js';
import { runKodaX } from '../trusted-coding-entry.js';
import {
  cleanupRegisteredManagedChildren,
  emitKodaXDiagnostic,
  shutdownTracing,
} from '@kodax-ai/agent';
import {
  prepareRuntimeConfig,
  FileSessionStorage,
  KODAX_CONFIG_FILE,
  KODAX_DIR,
  ensureExampleConfigFiles,
  resolveInteractiveSurfacePreference,
  runInteractiveMode,
  runInkInteractiveMode,
  runSessionPicker,
  getProviderSetupCatalog,
  inspectProviderSetupReadiness,
} from '@kodax-ai/repl';
import { createIntegrationEventBridge } from '../integration-hot-reload.js';
import { parseA2AIntegrationDocument } from '../a2a/config.js';
import {
  renderMissingProviderCredentialGuide,
  shouldAutoLaunchProviderSetup,
} from '../provider-setup-cli.js';
import { loadProviderAuth } from '../cli-lazy-components.js';
import { CLI_SUBCOMMAND_NAMES } from './root.js';
import { showCliHelpTopic, showCliHelpTopics, showBasicHelp } from './help.js';
import { cleanupInteractiveProcessResources } from './process-cleanup.js';
import { getReplHostStatus } from './host.js';
import { CliHost, runCliTaskViaClient } from './cli-host.js';
import { loadResumableSessions, readResumeTarget, runLegacySessionOperation } from './sessions.js';
import { loadSandboxRuntimeModule, prepareSetupSandboxReport, prepareInteractiveSandboxStartupInChild, prepareInteractiveSandboxStartup, reportInteractiveSandboxStartup, inspectSandboxReport } from './interactive-sandbox.js';
import { executeProviderSetup } from './setup.js';

async function discoverCliDefaultExtensions(): Promise<string[]> {
  try {
    return await discoverDefaultExtensions();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      chalk.yellow(
        '[extensions] Failed to discover default extensions: ' + message,
      ),
    );
    return [];
  }
}

type CliRunResultEvent = {
  type: 'run.result';
  success: boolean;
  signal?: 'COMPLETE' | 'BLOCKED' | 'DECIDE';
  signalReason?: string;
  sessionId: string;
  interrupted?: boolean;
  limitReached?: boolean;
};

function writeJsonStdout(value: CliRunResultEvent): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function emitJsonRunResultIfNeeded(
  outputMode: CliOutputMode,
  result: Awaited<ReturnType<typeof runKodaX>>,
): void {
  if (outputMode !== 'json') {
    return;
  }

  writeJsonStdout({
    type: 'run.result',
    success: result.success,
    signal: result.signal,
    signalReason: result.signalReason,
    sessionId: result.sessionId,
    interrupted: result.interrupted,
    limitReached: result.limitReached,
  });
}

/** The root command after parsing: option resolution, -c/-r, /command dispatch, the REPL or a one-shot run. */
export async function runKodaXRootCommand(
  program: Command,
  version: string,
  startupProgress?: CliStartupProgress,
): Promise<void> {
  if (
    program.args[0] !== undefined &&
    CLI_SUBCOMMAND_NAMES.has(program.args[0])
  ) {
    return;
  }

  const opts = program.opts();
  // -h / --help [topic]: show basic help or a detailed help topic
  if (opts.help !== undefined) {
    if (typeof opts.help === 'string') {
      const topic = opts.help.toLowerCase();
      if (showCliHelpTopic(topic)) {
        return;
      }
      console.log(chalk.yellow(`\n[Unknown help topic: ${topic}]`));
      showCliHelpTopics();
      return;
    }
    // No topic specified: show basic help overview.
    showBasicHelp();
    return;
  }

  const outputMode = (opts.mode as CliOutputMode | undefined) ?? 'text';
  // Hydrate login-shell and config-backed environment before first-run
  // readiness inspects credentials. Reuse this same Runtime configuration for
  // startup so the gate and the session cannot observe different environments.
  const config = prepareRuntimeConfig();
  // Session retention: opt-in best-effort background prune of session files
  // older than KODAX_SESSION_RETENTION_DAYS. DEFAULT OFF (0) — auto-deleting a
  // user's accumulated history is destructive and surprising, so it must be
  // explicitly enabled (e.g. KODAX_SESSION_RETENTION_DAYS=30). The `list()`
  // head-read path already keeps `kodax -c` + the picker fast regardless of
  // file count, so retention is a housekeeping convenience, not a perf
  // requirement. Fire-and-forget never blocks startup, but cleanup failures
  // are reported because cached message bodies must remain attached to a
  // retryable Session lifecycle operation.
  // Execution-only: informational commands must not load or mutate user state.
  {
    const sessionRetentionDays = Number(
      process.env.KODAX_SESSION_RETENTION_DAYS ??
        config.sessionRetentionDays ??
        0,
    );
    void new FileSessionStorage().cleanupOldSessions(sessionRetentionDays).catch((error: unknown) => {
      emitKodaXDiagnostic({
        source: 'cli:session-retention',
        level: 'warn',
        message: 'Session retention cleanup was incomplete and will be retried later.',
        detail: error instanceof Error ? error.message : String(error),
      });
    });
  }

  if (
    shouldAutoLaunchProviderSetup({
      outputMode,
      prompt: opts.print ? [String(opts.print)] : program.args,
      print: opts.print !== undefined,
      continue: opts.continue === true,
      resumeRequested: opts.resume !== undefined,
      sessionRequested: opts.session !== undefined,
      helpRequested: opts.help !== undefined,
      extensionRequested:
        Array.isArray(opts.extension) && opts.extension.length > 0,
      isInputTty: process.stdin.isTTY,
      isOutputTty: process.stdout.isTTY,
    })
  ) {
    const readiness = inspectProviderSetupReadiness({
      configPath: KODAX_CONFIG_FILE,
      environment: process.env,
      explicitProvider: opts.provider,
    });
    const credentialEnvironmentNames = [
      ...getProviderSetupCatalog().map((provider) => provider.apiKeyEnv),
      ...(config.customProviders ?? []).map((provider) => provider.apiKeyEnv),
    ];
    if (readiness.status === 'needs-provider') {
      startupProgress?.stop();
      await executeProviderSetup();
      return;
    }
    if (readiness.status === 'needs-host-broker') {
      const connection = config.customProviders?.find(provider => provider.name === readiness.provider);
      if (!connection?.cloud && !connection?.oauthRegistration) {
        process.stderr.write(`Provider "${readiness.provider}" requires login. Run kodax auth login ${readiness.provider} with your registered client, or install the trusted SDK credential authorizer.\n`);
        process.exitCode = 1; return;
      }
    }
    if (readiness.status === 'needs-credential' && !(await (await loadProviderAuth()).createProviderCredentialManager({ configPath: KODAX_CONFIG_FILE }).describe(readiness.provider)).stored) {
      process.stdout.write(
        `\n${renderMissingProviderCredentialGuide(
          readiness.apiKeyEnv
            ? [readiness.apiKeyEnv]
            : credentialEnvironmentNames,
        )}\n\n`,
      );
      return;
    }
    if (readiness.status === 'invalid-config') {
      process.stderr.write(
        `${chalk.yellow(
          `KodaX cannot start first-run setup because ${readiness.configPath} is invalid: ${readiness.reason}`,
        )}\n`,
      );
      process.stderr.write(
        `${chalk.dim(
          'Repair or move that file, then run `kodax setup`. No configuration was changed.',
        )}\n`,
      );
      process.exitCode = 1;
      return;
    }
  }
  const configWithExtensions = config as typeof config & {
    extensions?: string[];
  };
  if (
    typeof opts.repoIntelligence === 'string' &&
    opts.repoIntelligence.trim()
  ) {
    process.env.KODAX_REPO_INTELLIGENCE = opts.repoIntelligence.trim();
  }
  if (opts.repoIntelligenceTrace === true) {
    process.env.KODAX_REPO_INTELLIGENCE_TRACE = '1';
  }
  const reasoningMode = resolveCliReasoningMode(program, opts, config);
  const effort = resolveCliEffort(program, opts, config);
  const agentMode = resolveCliAgentMode(program, opts, config);
  const configuredExtensions = Array.isArray(configWithExtensions.extensions)
    ? configWithExtensions.extensions
        .filter(
          (value): value is string =>
            typeof value === 'string' && value.trim().length > 0,
        )
        .map((value) =>
          path.isAbsolute(value)
            ? value
            : path.resolve(path.dirname(KODAX_CONFIG_FILE), value),
        )
    : [];
  const cliExtensions = Array.isArray(opts.extension)
    ? opts.extension
        .filter(
          (value): value is string =>
            typeof value === 'string' && value.trim().length > 0,
        )
        .map((value) => path.resolve(value))
    : [];
  const discoveredExtensions = await discoverCliDefaultExtensions();
  const dedupedDiscoveredExtensions =
    await dedupeExtensionPathsByEntrypoint(discoveredExtensions);
  const dedupedConfiguredExtensions =
    await dedupeExtensionPathsByEntrypoint(configuredExtensions);
  const dedupedCliExtensions =
    await dedupeExtensionPathsByEntrypoint(cliExtensions);
  const configuredOnlyExtensions = await excludeExtensionPathsByEntrypoint(
    dedupedConfiguredExtensions,
    dedupedCliExtensions,
  );
  const discoveredOnlyExtensions = await excludeExtensionPathsByEntrypoint(
    dedupedDiscoveredExtensions,
    [...dedupedConfiguredExtensions, ...dedupedCliExtensions],
  );
  const activeExtensions = [
    ...discoveredOnlyExtensions,
    ...configuredOnlyExtensions,
    ...dedupedCliExtensions,
  ];
  const providerOverride = opts.provider ?? process.env.KODAX_PROVIDER;
  const selectedProvider = resolveCliProviderSelection(
    opts.provider,
    process.env.KODAX_PROVIDER,
    config.provider,
    KODAX_DEFAULT_PROVIDER,
  );
  const selectedModel = resolveCliModelSelection(
    providerOverride,
    opts.model,
    config.provider,
    config.model,
  );
  const sessionFlags = normalizeCliSessionFlags(opts);
  // -y/--auto is kept for backward compatibility but has no effect in CLI.
  const options: CliOptions = {
    // Priority: CLI args > environment > config file > defaults.
    provider: selectedProvider,
    model: selectedModel,
    effort,
    thinking: reasoningMode !== 'off',
    reasoningMode,
    agentMode,
    ...(typeof opts.workMode === 'string' ? { workMode: parseWorkModeOption(opts.workMode) } : {}),
    outputMode,
    extensions: activeExtensions,
    session: sessionFlags.session,
    maxIter: parseOptionalNonNegativeInt(opts.maxIter),
    prompt: opts.print ? [opts.print] : program.args,
    continue: opts.continue ?? false,
    resume: opts.resume,
    noSession: sessionFlags.noSession,
    print: opts.print ? true : false,
  };
  // The CLI owns no extension runtime, integration hot reload or A2A
  // handle; the Host does. Every command reaches it over one v2 connection.
  let cliHost: CliHost | undefined;
  const cliCredentials = (await import('../cli-provider-credentials.js')).createCliProviderCredentialAccess(config);
  const authorizeCli: KodaXClientHostAuthorization = cliCredentials.authorizeExecution;
  let shouldHardExitAfterInteractiveCleanup = false;
  const integrationEvents = createIntegrationEventBridge((message) =>
    console.error(chalk.dim(message)),
  );

  // Interactive and print flows start the shared Host or attach to it. The
  // Host owns extensions, configured MCP and the A2A plane; the CLI never
  // builds a Runtime of its own.
  const getCliHost = async (): Promise<CliHost> => {
    cliHost ??= await connectReplHost({
      version,
      authorize: authorizeCli,
      ...(startupProgress !== undefined
        ? { onStartupProgress: (progress: Parameters<typeof cliStartupProgressMessage>[0]) => { startupProgress.update(cliStartupProgressMessage(progress)); } }
        : {}),
      onError: (error: unknown) => emitKodaXDiagnostic({
        source: 'repl:host',
        level: 'warn',
        message: 'The Host connection reported an error.',
        detail: error instanceof Error ? error.message : String(error),
      }),
    });
    return cliHost;
  };

  try {
    if (await runLegacySessionOperation(options, opts, getCliHost)) return;

    let userPrompt = options.prompt.join(' ');

    validateCliModeSelection(options, {
      resumeWithoutId: opts.resume === true,
    });

    let validatedResumeId: string | undefined;
    if (opts.resume === true) {
      const sessions = await loadResumableSessions(await getCliHost());
      if (sessions.length === 0) {
        console.log(
          chalk.yellow(
            'No resumable sessions found. Starting a new session...',
          ),
        );
        options.resume = undefined;
      } else {
        const selected = await runSessionPicker(sessions);
        if (!selected) {
          console.log(chalk.dim('Session resume cancelled.'));
          return;
        }
        options.resume = selected.id;
      }
    } else if (typeof opts.resume === 'string') {
      startupProgress?.update('Loading session');
      const host = await getCliHost();
      startupProgress?.update('Loading session');
      const target = await readResumeTarget(host, opts.resume);
      if (target?.archived === true) throw new Error('Session is archived; unarchive it before resuming.');
      validatedResumeId = target?.id;
      if (target === undefined) {
        const titleMatches = findSessionTitleMatches(
          await loadResumableSessions(host),
          opts.resume,
        );
        if (titleMatches.length === 1) {
          options.resume = titleMatches[0]!.id;
        } else if (titleMatches.length > 1) {
          if (options.outputMode === 'json') {
            throw new Error(
              `Multiple sessions have the title "${opts.resume}". Use an exact session ID with --mode json.`,
            );
          }
          console.log(
            chalk.yellow(
              `Multiple sessions have the title "${opts.resume}". Choose the intended session:`,
            ),
          );
          const selected = await runSessionPicker(titleMatches);
          if (!selected) {
            console.log(chalk.dim('Session resume cancelled.'));
            return;
          }
          options.resume = selected.id;
        }
      }
    }

    if (options.resume && options.resume !== validatedResumeId) {
      const target = await readResumeTarget(await getCliHost(), options.resume);
      if (target === undefined) throw new Error(`Session not found: ${options.resume}`);
      if (target.archived === true) throw new Error('Session is archived; unarchive it before resuming.');
    }

    // FEATURE_298 T27 — fixed to the independent Host: the client never
    // constructs an embedded Runtime, so CLI --extension paths have no
    // embedded fallback. The Host owns the extension runtime, configured
    // MCP servers (with elicitation), and integration hot reload.
    if (dedupedCliExtensions.length > 0) {
      throw new Error(
        'CLI --extension paths cannot cross the daemon process boundary. ' +
          'Add the extension to the daemon profile config for this profile.',
      );
    }

    // Command dispatch for /command-style invocations.
    if (userPrompt.startsWith('/')) {
      const parsed = parseCommandCall(userPrompt);
      if (parsed) {
        const [commandName, args] = parsed;
        const commands = await loadCommands();
        if (commands.has(commandName)) {
          const kodaXOptions = createKodaXOptions(options, false);
          const commandPrompt = await processCommandCall(
            commandName,
            args,
            commands,
            async (prompt: string) =>
              runCliTaskViaClient(
                await getCliHost(),
                {
                  ...kodaXOptions,
                  context: {
                    ...kodaXOptions.context,
                    taskSurface: 'cli',
                  },
                },
                prompt,
              ),
          );
          if (commandPrompt) {
            const result = await runCliTaskViaClient(
              await getCliHost(),
              {
                ...kodaXOptions,
                context: {
                  ...kodaXOptions.context,
                  taskSurface: 'cli',
                },
              },
              commandPrompt,
            );
            emitJsonRunResultIfNeeded(options.outputMode, result);
            return;
          }
        }
      }
    }
    // No prompt and not in print mode: enter interactive mode
    if (!userPrompt && !options.print) {
      const kodaXOptions = createKodaXOptions(options, false);
      const interactiveSurface = resolveInteractiveSurfacePreference();
      const useClassicInteractiveMode = interactiveSurface === 'classic';
      // Pass FileSessionStorage for persisted sessions.
      try {
        const sandboxRuntime = process.platform === 'win32'
          && process.stdin.isTTY === true
          && process.stdout.isTTY === true
          ? await loadSandboxRuntimeModule()
          : undefined;
        reportInteractiveSandboxStartup(await prepareInteractiveSandboxStartup({
          platform: process.platform,
          stdinIsTTY: process.stdin.isTTY === true,
          stdoutIsTTY: process.stdout.isTTY === true,
        }, prepareInteractiveSandboxStartupInChild, () => (
          sandboxRuntime?.isWindowsSandboxV2SetupCurrent() ?? true
        ), startupProgress));
        if (useClassicInteractiveMode) {
          console.error(
            chalk.dim(
              '\n[Terminal compatibility] Using classic REPL because this terminal host cannot safely run the fullscreen TUI.',
            ),
          );
          console.error(
            chalk.dim(
              'Set KODAX_FORCE_INK=1 or KODAX_TUI_RENDERER=owned to override, or KODAX_FORCE_CLASSIC_REPL=1 to keep this mode everywhere.\n',
            ),
          );
        }

        // The REPL runs on the Host over the connection the -r lookup above may already have opened.
        const { client: hostClient, leases } = await getCliHost();

        const initialClientSettings = {
          ...(program.getOptionValueSource('provider') === 'cli' ? { provider: options.provider, model: options.model ?? null } : {}),
          ...(program.getOptionValueSource('model') === 'cli' ? { model: options.model ?? null } : {}),
          ...(program.getOptionValueSource('effort') === 'cli' ? { effort: options.effort ?? null } : {}),
          ...(program.getOptionValueSource('reasoning') === 'cli' || program.getOptionValueSource('thinking') === 'cli'
            ? { reasoningMode: options.reasoningMode, thinking: options.thinking } : {}),
          agentMode: 'ama' as const,
          ...(options.workMode !== undefined ? { workMode: options.workMode } : {}),
          ...(program.getOptionValueSource('maxIter') === 'cli' ? { maxIter: options.maxIter } : {}),
          ...(program.getOptionValueSource('repoIntelligence') === 'cli'
            ? { repoIntelligenceMode: parseRepoIntelligenceModeOption(opts.repoIntelligence) } : {}),
          ...(program.getOptionValueSource('repoIntelligenceTrace') === 'cli' ? { repoIntelligenceTrace: opts.repoIntelligenceTrace === true } : {}),
        };
        // -c and autoResume are resolved by the REPL from the Host's Session
        // list. The Host owns the Sessions, so no local storage is passed.
        const interactiveOptions = {
          onBeforeRender: () => startupProgress?.stop(),
          initialClientSettings,
          provider: kodaXOptions.provider,
          model: kodaXOptions.model,
          effort: kodaXOptions.effort,
          thinking: kodaXOptions.thinking,
          reasoningMode: kodaXOptions.reasoningMode,
          agentMode: kodaXOptions.agentMode,
          workMode: kodaXOptions.workMode,
          maxIter: kodaXOptions.maxIter,
          sandbox: kodaXOptions.sandbox,
          extensionRuntime: kodaXOptions.extensionRuntime,
          session: kodaXOptions.session,
          getRuntimeStatus: () => getReplHostStatus(hostClient, KODAX_DIR),
          validateSetupA2AConfig: parseA2AIntegrationDocument,
          prepareSetupSandbox: prepareSetupSandboxReport,
          inspectSandbox: inspectSandboxReport,
          ...createReplHostBindings(hostClient, leases),
          subscribeTransientNotices: integrationEvents.subscribe,
          hardExitOnClose: false,
        };

        // F1 — first launch with no config.json: drop a commented config.example.jsonc
        // reference next to it and point the user at it (one time only).
        const exampleConfigPaths = ensureExampleConfigFiles();
        if (exampleConfigPaths.length > 0) {
          console.error(
            chalk.dim(
              `\n[Configuration] Wrote missing annotated examples:\n` +
                `${exampleConfigPaths.map((file) => `  ${file}`).join('\n')}\n` +
                `Core settings belong in config.json; integrations belong in integrations/*.json.\n`,
            ),
          );
        }

        startupProgress?.update('Preparing workspace');
        if (useClassicInteractiveMode) {
          await runInteractiveMode(interactiveOptions);
        } else {
          await runInkInteractiveMode(interactiveOptions);
        }
        shouldHardExitAfterInteractiveCleanup = true;
      } catch (error) {
        if (error instanceof KodaXTerminalError) {
          console.error(chalk.red(`\n[Error] ${error.message}`));
          console.error(
            chalk.dim(
              '\nYour terminal environment does not support interactive mode.',
            ),
          );
          console.error(chalk.dim('\nPlease use CLI mode instead:'));
          for (const suggestion of error.suggestions) {
            console.error(chalk.cyan(`  ${suggestion}`));
          }
          console.error();
          process.exitCode = 1;
        } else {
          throw error;
        }
      }
      return;
    }

    // No prompt + --print: show basic help and exit.
    if (!userPrompt && options.print) {
      showBasicHelp();
      return;
    }

    // Run a single managed task through the selected Runtime and exit.
    const kodaXOptions = createKodaXOptions(options, options.print ?? false);
    const cliOptions: KodaXOptions = {
      ...kodaXOptions,
      context: {
        ...kodaXOptions.context,
        taskSurface: 'cli',
      },
    };
    const result = await runCliTaskViaClient(await getCliHost(), cliOptions, userPrompt);
    emitJsonRunResultIfNeeded(options.outputMode, result);
  } finally {
    let credentialCloseError: unknown;
    const closeCredentials = async () => {
      try { await cliCredentials.close(); }
      catch (error) { credentialCloseError = error; }
    };
    if (shouldHardExitAfterInteractiveCleanup) {
      const host = cliHost;
      cliHost = undefined;
      await closeCredentials();
      await cleanupInteractiveProcessResources({
        closeRuntime: async () => { host?.client.close(); },
      });
    } else {
      // Non-interactive callers own their process and receive cleanup errors.
      await awaitLatestCodingMemoryReviewDrain(15_000);
      await closeCredentials();
      cliHost?.client.close();
      cliHost = undefined;
      await shutdownDefaultLspService();
      await cleanupRegisteredManagedChildren({ scope: 'current-owner', includeCurrentOwner: true });
      await shutdownTracing();
    }
    if (credentialCloseError !== undefined) throw credentialCloseError;
    if (
      shouldHardExitAfterInteractiveCleanup &&
      process.env.VITEST !== 'true'
    ) {
      process.exit(process.exitCode ?? 0);
    }
  }
}
