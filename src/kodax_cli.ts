#!/usr/bin/env node

// ── Runtime environment defaults ──
// NODE_ENV must be set BEFORE any ESM static import is evaluated, otherwise
// React loads its development reconciler (~100 MB/turn profiling leak).
// This is handled by the CJS shim/preload upstream of this file:
//   - bin entry:        scripts/kodax-bin.cjs requires production-env.cjs
//                       then dynamic-imports this module (ESM)
//   - npm run dev/start: --require ./scripts/production-env.cjs flag
// The inline fallback below only covers `node dist/kodax_cli.js` invoked
// directly; in that path we cannot guarantee React is still in production
// mode, but setting NODE_ENV here keeps downstream NODE_ENV checks sane.
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = process.env.KODAX_DEV === '1' ? 'development' : 'production';
}

// Propagate a sensible V8 heap limit to child processes (sub-agents, forks).
// The main process heap limit is set via --max-old-space-size in the
// package.json scripts or shell wrapper. NODE_OPTIONS set here at runtime
// only affects children. Default 4 GB; override via KODAX_HEAP_LIMIT.
if (
  !process.execArgv.some(a => a.includes('max-old-space-size'))
  && !process.env.NODE_OPTIONS?.includes('max-old-space-size')
) {
  const limit = process.env.KODAX_HEAP_LIMIT ?? '4096';
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=${limit}`.trim();
}

/**
 * KodaX CLI — Command-line entry point.
 * UI module: Ink-based interactive REPL with managed task lifecycle.
 */
import { Command } from 'commander';
import chalk from 'chalk';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { runAcpServer } from './acp_server.js';
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
  createKodaXOptions,
  mergeConfiguredExtensions,
  parseAgentModeOption,
  parseOptionalNonNegativeInt,
  parseNonNegativeIntWithFallback,
  parseOutputModeOption,
  parsePermissionModeOption,
  parsePositiveNumberWithFallback,
  resolveCliAgentMode,
  resolveCliModelSelection,
  resolveCliReasoningMode,
  type CliOutputMode,
  type CliOptions,
  validateCliModeSelection,
} from './cli_option_helpers.js';
import { runSkillCreatorTool } from './skill_cli.js';

// Read the CLI version from package.json.
const packageJsonPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../package.json');
const version = fsSync.existsSync(packageJsonPath)
  ? JSON.parse(fsSync.readFileSync(packageJsonPath, 'utf-8')).version
  : '0.0.0';

import {
  runKodaX,
  runManagedTask,
  KodaXClient,
  KodaXEvents,
  KodaXReasoningMode,
  createExtensionRuntime,
  registerConfiguredMcpCapabilityProvider,
  KODAX_DEFAULT_PROVIDER,
  KODAX_FEATURES_FILE,
  KODAX_PROGRESS_FILE,
  checkPromiseSignal,
  getProvider,
  getAvailableProviderNames,
  KODAX_TOOLS,
  KodaXTerminalError,
} from '@kodax/coding';
import {
  getGitRoot,
  prepareRuntimeConfig,
  getFeatureProgress,
  checkAllFeaturesComplete,
  buildInitPrompt,
  FileSessionStorage,
  KODAX_CONFIG_FILE,
  resolveInteractiveSurfacePreference,
  runInteractiveMode,
  runInkInteractiveMode,
  type PermissionMode,
} from '@kodax/repl';
export {
  ACP_PERMISSION_MODES,
  getDefaultCommandDir,
  KODAX_COMMANDS_DIR,
  loadCommands,
  parseCommandCall,
  parseAgentModeOption,
  parsePermissionModeOption,
  processCommandCall,
  resolveCliAgentMode,
};
export type { KodaXCommand, KodaXCommandContext };

function hasConfiguredMcpServers(config: { mcpServers?: Record<string, { connect?: string }> }): boolean {
  return Object.values(config.mcpServers ?? {}).some(
    (server) => (server.connect ?? 'lazy') !== 'disabled',
  );
}
// ============== CLI Help Topics ==============

const CLI_HELP_TOPICS: Record<string, () => void> = {
  acp: () => {
    console.log(chalk.cyan('\nACP Server\n'));
    console.log(chalk.bold('Overview:'));
    console.log(chalk.dim('  Run KodaX as a stdio ACP server so editors and IDEs can connect directly.'));
    console.log(chalk.dim('  Session creation, prompt streaming, cancellation, and permission prompts reuse KodaX runtime semantics.\n'));
    console.log(chalk.bold('Command:'));
    console.log(chalk.dim('  kodax acp serve [options]\n'));
    console.log(chalk.bold('Options:'));
    console.log(chalk.dim('  --cwd <dir>                  ') + 'Working directory exposed to ACP sessions');
    console.log(chalk.dim('  -m, --provider <name>        ') + 'Provider to use');
    console.log(chalk.dim('  --model <name>               ') + 'Model override');
    console.log(chalk.dim('  --reasoning <mode>           ') + 'Reasoning mode: off, auto, quick, balanced, deep');
    console.log(chalk.dim('  --agent-mode <mode>          ') + 'Agent mode: ama, sa');
    console.log(chalk.dim('  --repo-intelligence <mode>   ') + 'Repo intelligence mode: auto, off, oss, premium-shared, premium-native');
    console.log(chalk.dim('  --repo-intelligence-trace    ') + 'Emit repo intelligence trace metadata/logging');
    console.log(chalk.dim('  --repointel-endpoint <url>   ') + 'Premium daemon endpoint override');
    console.log(chalk.dim('  --repointel-bin <path>       ') + 'Premium CLI path used to warm/start daemon');
    console.log(chalk.dim('  -t, --thinking               ') + 'Compatibility alias for --reasoning auto');
    console.log(chalk.dim('  --permission-mode <mode>     ') + 'Initial mode: plan, accept-edits, auto-in-project');
    console.log(chalk.dim('  KODAX_ACP_LOG=<level>        ') + 'stderr log level: off, error, info, debug\n');
    console.log(chalk.bold('Examples:'));
    console.log(chalk.dim('  kodax acp serve'));
    console.log(chalk.dim('  kodax acp serve --cwd C:\\repo --permission-mode accept-edits'));
    console.log(chalk.dim('  kodax acp serve -m openai --model gpt-5.4 --reasoning balanced\n'));
  },
  skill: () => {
    console.log(chalk.cyan('\nSkill Utilities\n'));
    console.log(chalk.bold('Overview:'));
    console.log(chalk.dim('  Use built-in skill packaging commands without starting an agent session.'));
    console.log(chalk.dim('  These commands are thin wrappers around the builtin skill-creator tools.\n'));
    console.log(chalk.bold('Commands:'));
    console.log(chalk.dim('  kodax skill init <name> [options]   ') + 'Create a new skill scaffold');
    console.log(chalk.dim('  kodax skill validate <dir>          ') + 'Validate a skill directory');
    console.log(chalk.dim('  kodax skill eval --skill-path ...   ') + 'Run end-to-end eval workspace generation');
    console.log(chalk.dim('  kodax skill grade <workspace>       ') + 'Grade eval runs into grading.json files');
    console.log(chalk.dim('  kodax skill analyze <workspace>     ') + 'Analyze benchmark variance and failures');
    console.log(chalk.dim('  kodax skill compare <workspace>     ') + 'Blind-compare two configs across runs');
    console.log(chalk.dim('  kodax skill package <dir> [options] ') + 'Package a skill as .skill');
    console.log(chalk.dim('  kodax skill install <input> [opts]  ') + 'Install a skill from dir or .skill');
    console.log(chalk.bold('Examples:'));
    console.log(chalk.dim('  kodax skill init release-notes --dest ./.kodax/skills'));
    console.log(chalk.dim('  kodax skill validate ./.kodax/skills/my-skill'));
    console.log(chalk.dim('  kodax skill eval --skill-path ./.kodax/skills/my-skill --evals ./.kodax/skills/my-skill/evals/evals.json --workspace ./iteration-1'));
    console.log(chalk.dim('  kodax skill grade ./iteration-1'));
    console.log(chalk.dim('  kodax skill analyze ./iteration-1'));
    console.log(chalk.dim('  kodax skill compare ./iteration-1 --config-a with_skill --config-b without_skill'));
    console.log(chalk.dim('  kodax skill package ./.kodax/skills/my-skill --output ./my-skill.skill'));
    console.log(chalk.dim('  kodax skill install ./my-skill.skill --dest ~/.kodax/skills --force\n'));
  },
  sessions: () => {
    console.log(chalk.cyan('\nSession Management\n'));
    console.log(chalk.bold('Overview:'));
    console.log(chalk.dim('  KodaX automatically saves conversation sessions, allowing you to'));
    console.log(chalk.dim('  resume work later or switch between different conversations.\n'));
    console.log(chalk.bold('Options:'));
    console.log(chalk.dim('  -c, --continue       ') + 'Continue most recent conversation');
    console.log(chalk.dim('  -r, --resume [id]    ') + 'Resume session by ID (no ID = list recent sessions, then resume the latest)');
    console.log(chalk.dim('  -n, --new            ') + 'Legacy no-op; current CLI already starts a fresh session by default');
    console.log(chalk.dim('  -s, --session <op>   ') + 'Legacy session operations: list, resume, delete <id>, delete-all, or raw session ID');
    console.log(chalk.dim('  --no-session         ') + 'Disable session persistence (print mode only)\n');
    console.log(chalk.bold('Examples:'));
    console.log(chalk.dim('  kodax                      ') + '# Start new session (interactive)');
    console.log(chalk.dim('  kodax -c                   ') + '# Continue recent conversation');
    console.log(chalk.dim('  kodax -r                   ') + '# List recent sessions, then resume the latest');
    console.log(chalk.dim('  kodax -r 20260219_143052   ') + '# Resume specific session');
    console.log(chalk.dim('  kodax -s list              ') + '# List all sessions');
    console.log(chalk.dim('  kodax -s delete 20260219   ') + '# Delete a session');
    console.log(chalk.dim('  kodax -p "task" --no-session') + ' # Run without saving\n');
  },
  init: () => {
    console.log(chalk.cyan('\nProject Initialization\n'));
    console.log(chalk.bold('Overview:'));
    console.log(chalk.dim('  Initialize a long-running project with project truth files and managed runtime state.'));
    console.log(chalk.dim('  KodaX analyzes your task, creates manageable feature steps, and uses .agent/project/ for plans and harness artifacts.\n'));
  console.log(chalk.bold('Options:'));
  console.log(chalk.dim('  --init <task>    ') + 'Initialize new project');
  console.log(chalk.dim('  --append         ') + 'Deprecated compatibility alias for the old append flow');
  console.log(chalk.dim('  --overwrite      ') + 'Replace existing feature_list.json\n');
    console.log(chalk.bold('Workflow:'));
    console.log(chalk.dim('  1. kodax --init "Build REST API"     # Generate feature_list.json'));
    console.log(chalk.dim('  2. kodax                             # Enter REPL and use /project status, /project plan, /project next'));
    console.log(chalk.dim('  OR'));
    console.log(chalk.dim('  2. kodax --auto-continue             # Non-REPL session loop over pending features'));
    console.log();
    console.log(chalk.bold('Examples:'));
    console.log(chalk.dim('  kodax --init "Create auth system"   ') + '# New project');
    console.log(chalk.dim('  kodax --init "Add tests"            ') + '# Existing project -> change request flow');
    console.log(chalk.dim('  kodax --init "Redo" --overwrite     ') + '# Start fresh\n');
  },
  project: () => {
    console.log(chalk.cyan('\nProject Mode\n'));
    console.log(chalk.bold('Overview:'));
    console.log(chalk.dim('  Project mode spans two surfaces: non-REPL bootstrap commands and REPL /project commands.'));
    console.log(chalk.dim('  Current workflow includes planning, quality review, brainstorm sessions, harness-verified execution, and runtime artifacts under .agent/project/.\n'));
    console.log(chalk.bold('Non-REPL Entry Points:'));
    console.log(chalk.dim('  --init <task>          ') + 'Initialize project truth files');
    console.log(chalk.dim('  --overwrite            ') + 'Replace existing project management truth files');
    console.log(chalk.dim('  --auto-continue        ') + 'Run a non-REPL session loop across pending features');
    console.log(chalk.dim('  --max-sessions <n>     ') + 'Bound the auto-continue loop');
    console.log(chalk.dim('  --max-hours <h>        ') + 'Stop auto-continue after a time budget\n');
    console.log(chalk.bold('REPL /project Commands:'));
    console.log(chalk.dim('  /project status [prompt] [--features|--progress]') + '  Status + guided analysis');
    console.log(chalk.dim('  /project plan [#index|topic]                 ') + '  Generate project or feature planning truth');
    console.log(chalk.dim('  /project quality                             ') + '  Deterministic workflow health + release review');
    console.log(chalk.dim('  /project brainstorm                          ') + '  UI-driven discovery flow');
    console.log(chalk.dim('  /project next [prompt|#index] [--no-confirm] ') + '  Harness-verified feature execution');
    console.log(chalk.dim('  /project auto [prompt] [--max=N|--confirm]   ') + '  REPL-side auto-continue with pause support');
    console.log(chalk.dim('  /project pause                               ') + '  Stop /project auto');
    console.log(chalk.dim('  /project verify [#index|--last]              ') + '  Rerun deterministic harness verification');
    console.log(chalk.dim('  /project edit <prompt>                       ') + '  Edit current-stage truth');
    console.log(chalk.dim('  /project analyze [prompt]                    ') + '  AI project analysis');
    console.log(chalk.dim('  /project reset [--all]                       ') + '  Clear progress or remove project truth files\n');
    console.log(chalk.bold('Current Semantics:'));
    console.log(chalk.dim('  - /project next and /project auto are verifier-gated, not self-declared completion'));
    console.log(chalk.dim('  - /project plan writes the latest plan to .agent/project/session_plan.md'));
    console.log(chalk.dim('  - /project quality combines deterministic checks with optional model-generated guidance'));
    console.log(chalk.dim('  - /project brainstorm aligns requirements into .agent/project/alignment.md\n'));
    console.log(chalk.bold('Examples:'));
    console.log(chalk.dim('  kodax --init "Desktop app"'));
    console.log(chalk.dim('  kodax -h project'));
    console.log(chalk.dim('  kodax  # then: /project brainstorm -> /project plan -> /project next'));
    console.log(chalk.dim('  kodax  # then: /project quality | /project verify --last | /project auto --max=3\n'));
  },
  auto: () => {
    console.log(chalk.cyan('\nAuto Mode & Auto-Continue\n'));
    console.log(chalk.bold('Auto Mode (-y, --auto):'));
    console.log(chalk.dim('  Backward-compatibility alias kept for scripts.'));
    console.log(chalk.dim('  Non-REPL CLI already runs in auto mode by default, so this flag currently has no additional effect.\n'));
    console.log(chalk.bold('Auto-Continue (--auto-continue):'));
    console.log(chalk.dim('  Automatically run sessions until all features are complete.'));
    console.log(chalk.dim('  Works with --init for hands-off project execution.\n'));
    console.log(chalk.bold('Options:'));
    console.log(chalk.dim('  -y, --auto             ') + 'Backward-compat alias (no-op in non-REPL CLI)');
    console.log(chalk.dim('  --auto-continue        ') + 'Auto-execute until complete');
    console.log(chalk.dim('  --max-sessions <n>     ') + 'Max sessions (default: 50)');
    console.log(chalk.dim('  --max-hours <h>        ') + 'Max runtime hours (default: 2)\n');
    console.log(chalk.bold('Examples:'));
    console.log(chalk.dim('  kodax -y "refactor code"          ') + '# Legacy alias; same as plain non-REPL run');
    console.log(chalk.dim('  kodax --init "API" --auto-continue') + '# Full automation');
    console.log(chalk.dim('  kodax --auto-continue --max-hours 4') + '# Extended run\n');
  },
  provider: () => {
    const providerNames = getAvailableProviderNames();
    console.log(chalk.cyan('\nLLM Providers\n'));
    console.log(chalk.bold('Overview:'));
    console.log(chalk.dim('  KodaX supports multiple LLM providers. Configure via -m option'));
    console.log(chalk.dim('  or set default in ~/.kodax/config.json. Use --model to override the default model.\n'));
    console.log(chalk.bold('Available Providers:'));
    providerNames.forEach((name) => {
      const detail = name === 'gemini-cli' || name === 'codex-cli'
        ? 'CLI bridge provider (latest-user-message only, MCP unavailable)'
        : 'Native provider';
      console.log(chalk.dim(`  ${name.padEnd(15)} `) + detail);
    });
    console.log();
    console.log(chalk.bold('Key Options:'));
    console.log(chalk.dim('  -m, --provider <name> ') + 'Provider to use');
    console.log(chalk.dim('  --model <name>        ') + 'Model override for the selected provider\n');
    console.log(chalk.bold('Examples:'));
    console.log(chalk.dim('  kodax -m anthropic "task"     ') + '# Use Claude');
    console.log(chalk.dim('  kodax -m openai --model gpt-5.4 "task"') + '# Override model');
    console.log(chalk.dim('  /model                        ') + '# Switch in REPL (saves to config)\n');
  },
  thinking: () => {
    console.log(chalk.cyan('\nReasoning Modes\n'));
    console.log(chalk.bold('Overview:'));
    console.log(chalk.dim('  Reasoning controls how much deliberate analysis KodaX should apply.'));
    console.log(chalk.dim('  Use off, auto, quick, balanced, or deep depending on the task.\n'));
    console.log(chalk.bold('Options:'));
    console.log(chalk.dim('  --reasoning <mode>   ') + 'Set reasoning mode: off, auto, quick, balanced, deep');
    console.log(chalk.dim('  --agent-mode <mode>  ') + 'Set agent mode: ama, sa');
    console.log(chalk.dim('  -t, --thinking       ') + 'Compatibility alias for --reasoning auto\n');
    console.log(chalk.bold('Examples:'));
    console.log(chalk.dim('  kodax --reasoning deep "design the architecture"   ') + '# High-depth reasoning');
    console.log(chalk.dim('  kodax --reasoning balanced -p "analyze this bug"   ') + '# Medium-depth reasoning');
    console.log(chalk.dim('  kodax -t "review this PR"                           ') + '# Alias for auto');
    console.log(chalk.dim('  /reasoning balanced                                 ') + '# Set in REPL\n');
  },
  team: () => {
    console.log(chalk.cyan('\nTeam Mode (Deprecated)\n'));
    console.log(chalk.bold('Overview:'));
    console.log(chalk.dim('  Legacy orchestration-based parallel execution for loosely coupled tasks.'));
    console.log(chalk.dim('  Prefer --agent-mode ama|sa for the product path. --team is being sunset.\n'));
    console.log(chalk.bold('Options:'));
    console.log(chalk.dim('  --team <tasks>      ') + 'Deprecated legacy option\n');
    console.log(chalk.bold('Examples:'));
    console.log(chalk.dim('  kodax --team "fix auth tests,update docs,clean logs"'));
    console.log(chalk.dim('  kodax --team "task1,task2" -m anthropic --reasoning balanced\n'));
  },
  print: () => {
    console.log(chalk.cyan('\nPrint Mode\n'));
    console.log(chalk.bold('Overview:'));
    console.log(chalk.dim('  Run a single task and exit. Useful for scripting and CI/CD.\n'));
    console.log(chalk.dim('  `--mode json` is a scripting surface, not the ACP server protocol.\n'));
    console.log(chalk.bold('Options:'));
    console.log(chalk.dim('  -p, --print <text>  ') + 'Run task and exit');
    console.log(chalk.dim('  --mode json         ') + 'Emit newline-delimited JSON events to stdout for scripts/CI');
    console.log(chalk.dim('  --model <name>      ') + 'Override the selected provider model');
    console.log(chalk.dim('  --no-session        ') + 'Disable session saving\n');
    console.log(chalk.bold('Examples:'));
    console.log(chalk.dim('  kodax -p "fix the bug in auth.ts"   ') + '# Quick fix');
    console.log(chalk.dim('  kodax -p "generate tests" --reasoning balanced') + ' # With reasoning');
    console.log(chalk.dim('  kodax -p "task" -m openai --model gpt-5.4') + ' # Provider + model override');
    console.log(chalk.dim('  kodax -p "task" --no-session        ') + '# Stateless run');
    console.log(chalk.dim('  kodax --mode json "inspect auth flow"') + ' # Structured JSONL output');
    console.log(chalk.dim('  kodax -p "task" -m anthropic --reasoning deep') + ' # Explicit provider selection\n');
  },
};

function collectRepeatedOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function showCliHelpTopic(topic: string): boolean {
  const helpFn = CLI_HELP_TOPICS[topic.toLowerCase()];
  if (helpFn) {
    helpFn();
    return true;
  }
  return false;
}

function showCliHelpTopics(): void {
  console.log(chalk.cyan('\nDetailed Help Topics:\n'));
  console.log(chalk.dim('  kodax -h acp        ') + 'ACP server mode for editors and IDEs');
  console.log(chalk.dim('  kodax -h sessions   ') + 'Session management (-c, -r, -s options)');
  console.log(chalk.dim('  kodax -h skill      ') + 'Skill packaging and installation helpers');
  console.log(chalk.dim('  kodax -h init       ') + 'Project initialization (--init, --overwrite)');
  console.log(chalk.dim('  kodax -h project    ') + 'Project mode workflow across CLI and /project');
  console.log(chalk.dim('  kodax -h auto       ') + 'Auto mode and auto-continue');
  console.log(chalk.dim('  kodax -h provider   ') + 'LLM provider options');
  console.log(chalk.dim('  kodax -h thinking   ') + 'Reasoning modes and depth control');
  console.log(chalk.dim('  kodax -h team       ') + 'Parallel agent execution');
  console.log(chalk.dim('  kodax -h print      ') + 'Print mode for scripting\n');
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

function printAcpSubcommandHelp(name: string): boolean {
  if (name === 'serve') {
    console.log('Usage: kodax acp serve [options]');
    console.log();
    console.log('Run KodaX as a stdio ACP server for editors and IDEs.');
    console.log();
    console.log('Options:');
    console.log('  --cwd <dir>                  Working directory exposed to ACP sessions');
    console.log('  -m, --provider <name>        Provider to use');
    console.log('  --model <name>               Model override');
    console.log('  -t, --thinking               Compatibility alias for --reasoning auto');
    console.log('  --reasoning <mode>           Reasoning mode: off, auto, quick, balanced, deep');
    console.log('  --repo-intelligence <mode>   Repo intelligence mode: auto, off, oss, premium-shared, premium-native');
    console.log('  --repo-intelligence-trace    Emit repo intelligence trace metadata/logging');
    console.log('  --repointel-endpoint <url>   Premium daemon endpoint override');
    console.log('  --repointel-bin <path>       Premium CLI path used to warm/start daemon');
    console.log('  --permission-mode <mode>     Initial permission mode');
    console.log('  KODAX_ACP_LOG=<level>        stderr log level: off, error, info, debug');
    return true;
  }

  return false;
}

function printSkillSubcommandHelp(name: string): boolean {
  if (name === 'init') {
    console.log('Usage: kodax skill init [options] <name>');
    console.log();
    console.log('Initialize a new skill scaffold.');
    console.log();
    console.log('Options:');
    console.log('  -d, --dest <dir>         Base skills directory');
    console.log('  --description <text>     Initial skill description');
    console.log('  -f, --force              Allow writing into an existing target directory');
    console.log('  --no-evals               Skip creating evals/evals.json');
    return true;
  }

  if (name === 'validate') {
    console.log('Usage: kodax skill validate <skillDir>');
    console.log();
    console.log('Validate a skill directory using builtin skill-creator.');
    return true;
  }

  if (name === 'eval') {
    console.log('Usage: kodax skill eval [options]');
    console.log();
    console.log('Run end-to-end skill evals and write a benchmark/review workspace.');
    console.log();
    console.log('Required Options:');
    console.log('  --skill-path <dir>       Skill directory to evaluate');
    console.log('  --evals <file>           Evals JSON file');
    console.log('  --workspace <dir>        Workspace output directory');
    console.log();
    console.log('Options:');
    console.log('  --provider <name>        Provider to use');
    console.log('  --model <name>           Model override');
    console.log('  --runs <n>               Runs per config');
    console.log('  --max-iter <n>           Max iterations per run');
    console.log('  --reasoning <mode>       Reasoning mode');
    console.log('  --cwd <dir>              Working directory for the runs');
    console.log('  --configs <list>         Comma-separated configs, e.g. with_skill,without_skill');
    console.log('  -o, --output <file>      Optional JSON summary output');
    return true;
  }

  if (name === 'grade') {
    console.log('Usage: kodax skill grade [options] <workspace>');
    console.log();
    console.log('Grade eval runs into grading.json files.');
    console.log();
    console.log('Options:');
    console.log('  --provider <name>        Provider to use');
    console.log('  --model <name>           Model override');
    console.log('  --reasoning <mode>       Reasoning mode');
    console.log('  --max-iter <n>           Max iterations per grading run');
    console.log('  --configs <list>         Comma-separated configs, e.g. with_skill,without_skill');
    console.log('  --overwrite              Re-grade runs that already have grading.json');
    return true;
  }

  if (name === 'analyze') {
    console.log('Usage: kodax skill analyze [options] <workspace>');
    console.log();
    console.log('Analyze benchmark variance and write analysis.json + analysis.md.');
    console.log();
    console.log('Options:');
    console.log('  --benchmark <file>       Optional benchmark.json path');
    console.log('  --output <file>          JSON output path');
    console.log('  --markdown <file>        Markdown output path');
    console.log('  --skill-name <name>      Skill name if benchmark.json must be regenerated');
    console.log('  --provider <name>        Provider to use');
    console.log('  --model <name>           Model override');
    console.log('  --reasoning <mode>       Reasoning mode');
    return true;
  }

  if (name === 'compare') {
    console.log('Usage: kodax skill compare [options] <workspace>');
    console.log();
    console.log('Blind-compare two configs across eval run pairs.');
    console.log();
    console.log('Options:');
    console.log('  --config-a <name>        Primary config (default: with_skill)');
    console.log('  --config-b <name>        Baseline config (default: without_skill)');
    console.log('  --output <file>          JSON output path');
    console.log('  --markdown <file>        Markdown output path');
    console.log('  --max-pairs <n>          Limit pairs per eval');
    console.log('  --provider <name>        Provider to use');
    console.log('  --model <name>           Model override');
    console.log('  --reasoning <mode>       Reasoning mode');
    return true;
  }

  if (name === 'package') {
    console.log('Usage: kodax skill package [options] <skillDir>');
    console.log();
    console.log('Package a skill directory as a .skill archive.');
    console.log();
    console.log('Options:');
    console.log('  -o, --output <file>      Output .skill file path');
    return true;
  }

  if (name === 'install') {
    console.log('Usage: kodax skill install [options] <input>');
    console.log();
    console.log('Install a skill directory or .skill archive into a skills directory.');
    console.log();
    console.log('Options:');
    console.log('  -d, --dest <dir>         Destination skills directory');
    console.log('  -f, --force              Overwrite an existing target skill');
    return true;
  }

  return false;
}

function showBasicHelp(): void {
  const providerNames = getAvailableProviderNames().join(', ');
  console.log('KodaX - Intelligent Coding Agent\n');
  console.log('Usage: kodax [options] [prompt]');
  console.log('       kodax "your task"');
  console.log('       kodax /command_name\n');
  console.log('Options:');
  console.log('  -h, --help [TOPIC]      Show help, or detailed help for a topic');
  console.log('  -p, --print TEXT        Print mode: run single task and exit');
  console.log('  --mode json             Emit newline-delimited JSON events to stdout for scripts/CI');
  console.log('  -c, --continue          Continue most recent conversation');
  console.log('  -r, --resume [id]       Resume session by ID (no ID = list recent sessions, then resume the latest)');
  console.log('  -n, --new               Legacy no-op; current CLI already starts a fresh session by default');
  console.log(`  -m, --provider NAME     LLM provider (${providerNames})`);
  console.log('  --model NAME            Model override for the selected provider');
  console.log('  -t, --thinking          Compatibility alias for --reasoning auto');
  console.log('  --reasoning MODE        Reasoning mode: off, auto, quick, balanced, deep');
  console.log('  --agent-mode MODE       Agent mode: ama, sa');
  console.log('  -y, --auto              Backward-compat alias; no effect in non-REPL CLI');
  console.log('  -s, --session OP        Legacy session operations: list, resume, delete <id>, delete-all, or raw session ID');
  console.log('  --no-session            Disable session persistence (print mode only)');
  console.log('  --team TASKS            Deprecated legacy parallel team mode');
  console.log('  --init TASK             Initialize a long-running task');
  console.log('  --append                Deprecated compatibility alias for the old append flow');
  console.log('  --overwrite             With --init: overwrite existing feature_list.json');
  console.log('  --max-iter N            Max iterations per session (default: 200)');
  console.log('  --auto-continue         Auto-continue long-running task until all features pass');
  console.log('  --max-sessions N        Max sessions for --auto-continue (default: 50)');
  console.log('  --max-hours H           Max hours for --auto-continue (default: 2.0)\n');
  console.log('Help Topics (use -h <topic>):');
  console.log('  acp, skill, sessions, init, project, auto, provider, thinking, team, print\n');
  console.log('Interactive Commands (in REPL mode):');
  console.log('  /help, /h               Show all commands');
  console.log('  /exit, /quit            Exit interactive mode');
  console.log('  /clear                  Clear conversation history');
  console.log('  /status                 Show session status');
  console.log('  /mode [plan|accept-edits|auto-in-project]  Switch permission mode');
  console.log('  /project ...            Project workflow commands');
  console.log('  /sessions               List saved sessions\n');
  console.log('Examples:');
  console.log('  kodax                             # Enter interactive mode');
  console.log('  kodax "create a component"        # Run single task (with session)');
  console.log('  kodax acp serve                   # Start ACP stdio server');
  console.log('  kodax skill init my-skill         # Scaffold a new skill');
  console.log('  kodax skill package ./my-skill    # Package a skill without starting the agent');
  console.log('  kodax -h project                 # Project mode workflow across CLI and REPL');
  console.log('  kodax -p "quick fix" --reasoning balanced  # Quick task with reasoning');
  console.log('  kodax -c                          # Continue recent conversation');
  console.log('  kodax -c "finish this"            # Continue with new task');
  console.log('  kodax -r                          # List recent sessions, then resume the latest');
  console.log('  kodax -p "task" --model gpt-5.4   # Override model for a one-off run');
  console.log('  kodax -p "task" --no-session      # Run without saving session');
  console.log('  kodax -h sessions                 # Detailed help on sessions\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const program = new Command()
    .name('kodax')
    .description('KodaX - Intelligent Coding Agent')
    .version(version)
    // Disable commander default help so the custom topic help can take over.
    .helpOption(false)
    .option('-h, --help [topic]', 'Show help, or detailed help for a topic')
    // Short options.
    .option('-p, --print <text>', 'Print mode: run single task and exit')
    .option('--mode <mode>', 'Output mode: json', parseOutputModeOption)
    .option('-c, --continue', 'Continue most recent conversation in current directory')
    .option('-n, --new', 'Legacy no-op; current CLI already starts a fresh session by default')
    .option('-r, --resume [id]', 'Resume session by ID (no ID = list recent sessions, then resume the latest)')
    .option('-m, --provider <name>', 'LLM provider')
    .option('--model <name>', 'Model override')
    .option('-t, --thinking', 'Compatibility alias for --reasoning auto')
    .option('--reasoning <mode>', 'Reasoning mode: off, auto, quick, balanced, deep')
    .option('--agent-mode <mode>', 'Agent mode: ama, sa', parseAgentModeOption)
    .option('--repo-intelligence <mode>', 'Repo intelligence mode: auto, off, oss, premium-shared, premium-native')
    .option('--repo-intelligence-trace', 'Enable repo intelligence trace metadata/logging')
    .option('--repointel-endpoint <url>', 'Premium daemon endpoint override')
    .option('--repointel-bin <path>', 'Premium CLI path used to warm/start daemon')
    .option('-y, --auto', 'Backward-compat alias; no effect in non-REPL CLI')
    .option('-s, --session <op>', 'Legacy session operations: list, resume, delete <id>, delete-all, or raw session ID')
    .option('--extension <path>', 'Load local extension module (.js/.mjs/.cjs/.ts/.mts/.cts)', collectRepeatedOption, [])
    .option('--no-session', 'Disable session persistence (print mode only)')
    // Long options.
    .option('--team <tasks>', 'Deprecated: legacy parallel team mode')
    .option('--init <task>', 'Initialize a long-running task')
    .option('--append', 'Deprecated compatibility alias for the old append flow')
    .option('--overwrite', 'With --init: overwrite existing feature_list.json')
    .option('--max-iter <n>', 'Max iterations (default: 200 from coding package)')
    .option('--auto-continue', 'Auto-continue long-running task until all features pass')
    .option('--max-sessions <n>', 'Max sessions for --auto-continue', '50')
    .option('--max-hours <n>', 'Max hours for --auto-continue', '2')
    .allowUnknownOption(false)
    // Keep the root command executable even when subcommands like `skill` exist.
    .action(() => {});

  // ============== completion subcommand ==============
  program
    .command('completion')
    .description('Generate shell completion script')
    .argument('<shell>', 'Shell type: bash, zsh, or fish')
    .action((shell: string) => {
      const providerNames = getAvailableProviderNames().join(' ');
      const reasoningModes = 'off auto quick balanced deep';
      const agentModes = 'ama sa';

      if (shell === 'bash') {
        console.log(`# KodaX bash completion — add to ~/.bashrc:
#   eval "$(kodax completion bash)"
_kodax_complete() {
  local cur prev opts subcmds
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  subcmds="acp skill completion"
  opts="-p -c -r -n -m -t -s -y -h --print --continue --resume --new --provider --model --thinking --reasoning --agent-mode --repo-intelligence --repo-intelligence-trace --repointel-endpoint --repointel-bin --auto --session --extension --no-session --team --init --append --overwrite --max-iter --auto-continue --max-sessions --max-hours --version"

  case "\${prev}" in
    --provider|-m) COMPREPLY=( $(compgen -W "${providerNames}" -- "\${cur}") ); return 0 ;;
    --reasoning) COMPREPLY=( $(compgen -W "${reasoningModes}" -- "\${cur}") ); return 0 ;;
    --agent-mode) COMPREPLY=( $(compgen -W "${agentModes}" -- "\${cur}") ); return 0 ;;
    --repo-intelligence) COMPREPLY=( $(compgen -W "auto off oss premium-shared premium-native" -- "\${cur}") ); return 0 ;;
  esac

  if [[ "\${cur}" == -* ]]; then
    COMPREPLY=( $(compgen -W "\${opts}" -- "\${cur}") )
  elif [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "\${subcmds}" -- "\${cur}") )
  fi
}
complete -F _kodax_complete kodax`);
      } else if (shell === 'zsh') {
        console.log(`# KodaX zsh completion — add to ~/.zshrc:
#   eval "$(kodax completion zsh)"
_kodax() {
  local -a subcmds opts providers reasoning_modes agent_modes repo_modes
  subcmds=(acp skill completion)
  providers=(${providerNames.replace(/ /g, ' ')})
  reasoning_modes=(off auto quick balanced deep)
  agent_modes=(ama sa)
  repo_modes=(auto off oss premium-shared premium-native)

  _arguments -C \\
    '-p[Print mode]+:text:' \\
    '-c[Continue most recent conversation]' \\
    '-r[Resume session by ID]::id:' \\
    '-m[LLM provider]+:provider:($providers)' \\
    '--provider+[LLM provider]:provider:($providers)' \\
    '--model+[Model override]:model:' \\
    '-t[Enable thinking]' \\
    '--reasoning+[Reasoning mode]:mode:($reasoning_modes)' \\
    '--agent-mode+[Agent mode]:mode:($agent_modes)' \\
    '--repo-intelligence+[Repo intelligence mode]:mode:($repo_modes)' \\
    '--version[Show version]' \\
    '-h[Show help]' \\
    '1:subcommand:($subcmds)' \\
    '*::arg:->args'
}
compdef _kodax kodax`);
      } else if (shell === 'fish') {
        console.log(`# KodaX fish completion — add to ~/.config/fish/completions/kodax.fish:
#   kodax completion fish > ~/.config/fish/completions/kodax.fish
complete -c kodax -n '__fish_use_subcommand' -a 'acp skill completion' -d 'Subcommands'
complete -c kodax -s p -l print -d 'Print mode'
complete -c kodax -s c -l continue -d 'Continue most recent conversation'
complete -c kodax -s r -l resume -d 'Resume session by ID'
complete -c kodax -s m -l provider -d 'LLM provider' -xa '${providerNames}'
complete -c kodax -l model -d 'Model override'
complete -c kodax -s t -l thinking -d 'Enable thinking'
complete -c kodax -l reasoning -d 'Reasoning mode' -xa '${reasoningModes}'
complete -c kodax -l agent-mode -d 'Agent mode' -xa '${agentModes}'
complete -c kodax -l repo-intelligence -d 'Repo intelligence mode' -xa 'auto off oss premium-shared premium-native'
complete -c kodax -l version -d 'Show version'`);
      } else {
        console.error(`Unknown shell: ${shell}. Supported: bash, zsh, fish`);
        process.exit(1);
      }
    });

  const skillCommand = program
    .command('skill')
    .description('Built-in skill packaging and installation helpers')
    .helpOption('-h, --help', 'Show skill utility help');

  const acpCommand = program
    .command('acp')
    .description('Run KodaX as an ACP server for editors and IDEs')
    .helpOption('-h, --help', 'Show ACP server help');

  acpCommand
    .command('serve')
    .description('Run the ACP stdio server')
    .option('--cwd <dir>', 'Working directory exposed to ACP sessions')
    .option('-m, --provider <name>', 'Provider to use')
    .option('--model <name>', 'Model override')
    .option('-t, --thinking', 'Compatibility alias for --reasoning auto')
    .option('--reasoning <mode>', 'Reasoning mode: off, auto, quick, balanced, deep')
    .option('--repo-intelligence <mode>', 'Repo intelligence mode: auto, off, oss, premium-shared, premium-native')
    .option('--repo-intelligence-trace', 'Enable repo intelligence trace metadata/logging')
    .option('--repointel-endpoint <url>', 'Premium daemon endpoint override')
    .option('--repointel-bin <path>', 'Premium CLI path used to warm/start daemon')
    .option('--permission-mode <mode>', 'Initial permission mode', parsePermissionModeOption, 'accept-edits')
    .action(async (subcommandOptions: {
      cwd?: string;
      provider?: string;
      model?: string;
      thinking?: boolean;
      reasoning?: KodaXReasoningMode;
      repoIntelligence?: string;
      repoIntelligenceTrace?: boolean;
      repointelEndpoint?: string;
      repointelBin?: string;
      permissionMode?: PermissionMode;
    }) => {
      if (typeof subcommandOptions.repoIntelligence === 'string' && subcommandOptions.repoIntelligence.trim()) {
        process.env.KODAX_REPO_INTELLIGENCE_MODE = subcommandOptions.repoIntelligence.trim();
      }
      if (subcommandOptions.repoIntelligenceTrace === true) {
        process.env.KODAX_REPO_INTELLIGENCE_TRACE = '1';
      }
      if (typeof subcommandOptions.repointelEndpoint === 'string' && subcommandOptions.repointelEndpoint.trim()) {
        process.env.KODAX_REPOINTEL_ENDPOINT = subcommandOptions.repointelEndpoint.trim();
      }
      if (typeof subcommandOptions.repointelBin === 'string' && subcommandOptions.repointelBin.trim()) {
        process.env.KODAX_REPOINTEL_BIN = subcommandOptions.repointelBin.trim();
      }
      await runAcpServer({
        cwd: subcommandOptions.cwd,
        provider: subcommandOptions.provider,
        model: subcommandOptions.model,
        thinking: subcommandOptions.thinking,
        reasoningMode: subcommandOptions.reasoning,
        permissionMode: subcommandOptions.permissionMode,
        agentVersion: version,
      });
    });

  skillCommand
    .command('init <name>')
    .description('Initialize a new skill scaffold')
    .option('-d, --dest <dir>', 'Base skills directory')
    .option('--description <text>', 'Initial skill description')
    .option('-f, --force', 'Allow writing into an existing target directory')
    .option('--no-evals', 'Skip creating evals/evals.json')
    .action(async (
      name: string,
      subcommandOptions: {
        dest?: string;
        description?: string;
        force?: boolean;
        evals?: boolean;
      }
    ) => {
      const args = [name];
      if (subcommandOptions.dest) {
        args.push('--dest', subcommandOptions.dest);
      }
      if (subcommandOptions.description) {
        args.push('--description', subcommandOptions.description);
      }
      if (subcommandOptions.force) {
        args.push('--force');
      }
      if (subcommandOptions.evals === false) {
        args.push('--no-evals');
      }
      await runSkillCreatorTool('init', args);
    });

  skillCommand
    .command('validate <skillDir>')
    .description('Validate a skill directory using builtin skill-creator')
    .action(async (skillDir: string) => {
      await runSkillCreatorTool('validate', [skillDir]);
    });

  skillCommand
    .command('eval')
    .description('Run end-to-end skill evals and write a benchmark/review workspace')
    .requiredOption('--skill-path <dir>', 'Skill directory to evaluate')
    .requiredOption('--evals <file>', 'Evals JSON file')
    .requiredOption('--workspace <dir>', 'Workspace output directory')
    .option('--provider <name>', 'Provider to use')
    .option('--model <name>', 'Model override')
    .option('--runs <n>', 'Runs per config')
    .option('--max-iter <n>', 'Max iterations per run')
    .option('--reasoning <mode>', 'Reasoning mode')
    .option('--cwd <dir>', 'Working directory for the runs')
    .option('--configs <list>', 'Comma-separated configs, e.g. with_skill,without_skill')
    .option('-o, --output <file>', 'Optional JSON summary output')
    .action(async (subcommandOptions: {
      skillPath: string;
      evals: string;
      workspace: string;
      provider?: string;
      model?: string;
      runs?: string;
      maxIter?: string;
      reasoning?: string;
      cwd?: string;
      configs?: string;
      output?: string;
    }) => {
      const args = [
        '--skill-path', subcommandOptions.skillPath,
        '--evals', subcommandOptions.evals,
        '--workspace', subcommandOptions.workspace,
      ];
      if (subcommandOptions.provider) {
        args.push('--provider', subcommandOptions.provider);
      }
      if (subcommandOptions.model) {
        args.push('--model', subcommandOptions.model);
      }
      if (subcommandOptions.runs) {
        args.push('--runs', subcommandOptions.runs);
      }
      if (subcommandOptions.maxIter) {
        args.push('--max-iter', subcommandOptions.maxIter);
      }
      if (subcommandOptions.reasoning) {
        args.push('--reasoning', subcommandOptions.reasoning);
      }
      if (subcommandOptions.cwd) {
        args.push('--cwd', subcommandOptions.cwd);
      }
      if (subcommandOptions.configs) {
        args.push('--configs', subcommandOptions.configs);
      }
      if (subcommandOptions.output) {
        args.push('--output', subcommandOptions.output);
      }
      await runSkillCreatorTool('eval', args);
    });

  skillCommand
    .command('grade <workspace>')
    .description('Grade eval runs into grading.json files')
    .option('--provider <name>', 'Provider to use')
    .option('--model <name>', 'Model override')
    .option('--reasoning <mode>', 'Reasoning mode')
    .option('--max-iter <n>', 'Max iterations per grading run')
    .option('--configs <list>', 'Comma-separated configs, e.g. with_skill,without_skill')
    .option('--overwrite', 'Re-grade runs that already have grading.json')
    .action(async (workspace: string, subcommandOptions: {
      provider?: string;
      model?: string;
      reasoning?: string;
      maxIter?: string;
      configs?: string;
      overwrite?: boolean;
    }) => {
      const args = [workspace];
      if (subcommandOptions.provider) {
        args.push('--provider', subcommandOptions.provider);
      }
      if (subcommandOptions.model) {
        args.push('--model', subcommandOptions.model);
      }
      if (subcommandOptions.reasoning) {
        args.push('--reasoning', subcommandOptions.reasoning);
      }
      if (subcommandOptions.maxIter) {
        args.push('--max-iter', subcommandOptions.maxIter);
      }
      if (subcommandOptions.configs) {
        args.push('--configs', subcommandOptions.configs);
      }
      if (subcommandOptions.overwrite) {
        args.push('--overwrite');
      }
      await runSkillCreatorTool('grade', args);
    });

  skillCommand
    .command('analyze <workspace>')
    .description('Analyze benchmark variance and write analysis artifacts')
    .option('--benchmark <file>', 'Optional benchmark.json path')
    .option('--output <file>', 'JSON output path')
    .option('--markdown <file>', 'Markdown output path')
    .option('--skill-name <name>', 'Skill name if benchmark.json must be regenerated')
    .option('--provider <name>', 'Provider to use')
    .option('--model <name>', 'Model override')
    .option('--reasoning <mode>', 'Reasoning mode')
    .action(async (workspace: string, subcommandOptions: {
      benchmark?: string;
      output?: string;
      markdown?: string;
      skillName?: string;
      provider?: string;
      model?: string;
      reasoning?: string;
    }) => {
      const args = [workspace];
      if (subcommandOptions.benchmark) {
        args.push('--benchmark', subcommandOptions.benchmark);
      }
      if (subcommandOptions.output) {
        args.push('--output', subcommandOptions.output);
      }
      if (subcommandOptions.markdown) {
        args.push('--markdown', subcommandOptions.markdown);
      }
      if (subcommandOptions.skillName) {
        args.push('--skill-name', subcommandOptions.skillName);
      }
      if (subcommandOptions.provider) {
        args.push('--provider', subcommandOptions.provider);
      }
      if (subcommandOptions.model) {
        args.push('--model', subcommandOptions.model);
      }
      if (subcommandOptions.reasoning) {
        args.push('--reasoning', subcommandOptions.reasoning);
      }
      await runSkillCreatorTool('analyze', args);
    });

  skillCommand
    .command('compare <workspace>')
    .description('Blind-compare two configs across eval run pairs')
    .option('--config-a <name>', 'Primary config', 'with_skill')
    .option('--config-b <name>', 'Baseline config', 'without_skill')
    .option('--output <file>', 'JSON output path')
    .option('--markdown <file>', 'Markdown output path')
    .option('--max-pairs <n>', 'Limit pairs per eval')
    .option('--provider <name>', 'Provider to use')
    .option('--model <name>', 'Model override')
    .option('--reasoning <mode>', 'Reasoning mode')
    .action(async (workspace: string, subcommandOptions: {
      configA: string;
      configB: string;
      output?: string;
      markdown?: string;
      maxPairs?: string;
      provider?: string;
      model?: string;
      reasoning?: string;
    }) => {
      const args = [
        workspace,
        '--config-a', subcommandOptions.configA,
        '--config-b', subcommandOptions.configB,
      ];
      if (subcommandOptions.output) {
        args.push('--output', subcommandOptions.output);
      }
      if (subcommandOptions.markdown) {
        args.push('--markdown', subcommandOptions.markdown);
      }
      if (subcommandOptions.maxPairs) {
        args.push('--max-pairs', subcommandOptions.maxPairs);
      }
      if (subcommandOptions.provider) {
        args.push('--provider', subcommandOptions.provider);
      }
      if (subcommandOptions.model) {
        args.push('--model', subcommandOptions.model);
      }
      if (subcommandOptions.reasoning) {
        args.push('--reasoning', subcommandOptions.reasoning);
      }
      await runSkillCreatorTool('compare', args);
    });

  skillCommand
    .command('package <skillDir>')
    .description('Package a skill directory as a .skill archive')
    .option('-o, --output <file>', 'Output .skill file path')
    .action(async (skillDir: string, subcommandOptions: { output?: string }) => {
      const args = [skillDir];
      if (subcommandOptions.output) {
        args.push('--output', subcommandOptions.output);
      }
      await runSkillCreatorTool('package', args);
    });

  skillCommand
    .command('install <input>')
    .description('Install a skill directory or .skill archive into a skills directory')
    .option('-d, --dest <dir>', 'Destination skills directory')
    .option('-f, --force', 'Overwrite an existing target skill')
    .action(async (input: string, subcommandOptions: { dest?: string; force?: boolean }) => {
      const args = [input];
      if (subcommandOptions.dest) {
        args.push('--dest', subcommandOptions.dest);
      }
      if (subcommandOptions.force) {
        args.push('--force');
      }
      await runSkillCreatorTool('install', args);
    });

  if (argv[0] === 'skill') {
    if (argv.length === 1 || argv[1] === '-h' || argv[1] === '--help') {
      console.log(skillCommand.helpInformation());
      return;
    }

    const skillSubcommand = argv[1];
    if (skillSubcommand && (argv.includes('-h') || argv.includes('--help'))) {
      if (printSkillSubcommandHelp(skillSubcommand)) {
        return;
      }
    }
  }

  if (argv[0] === 'acp') {
    if (argv.length === 1 || argv[1] === '-h' || argv[1] === '--help') {
      console.log(acpCommand.helpInformation());
      return;
    }

    const acpSubcommand = argv[1];
    if (acpSubcommand && (argv.includes('-h') || argv.includes('--help'))) {
      if (printAcpSubcommandHelp(acpSubcommand)) {
        return;
      }
    }
  }

  await program.parseAsync(process.argv);
  if (argv[0] === 'skill' || argv[0] === 'acp') {
    return;
  }

  const opts = program.opts();
  // Parse CLI options and merge with config defaults.
  const config = prepareRuntimeConfig();
  const configWithExtensions = config as typeof config & { extensions?: string[] };
  if (typeof opts.repoIntelligence === 'string' && opts.repoIntelligence.trim()) {
    process.env.KODAX_REPO_INTELLIGENCE_MODE = opts.repoIntelligence.trim();
  }
  if (opts.repoIntelligenceTrace === true) {
    process.env.KODAX_REPO_INTELLIGENCE_TRACE = '1';
  }
  if (typeof opts.repointelEndpoint === 'string' && opts.repointelEndpoint.trim()) {
    process.env.KODAX_REPOINTEL_ENDPOINT = opts.repointelEndpoint.trim();
  }
  if (typeof opts.repointelBin === 'string' && opts.repointelBin.trim()) {
    process.env.KODAX_REPOINTEL_BIN = opts.repointelBin.trim();
  }
  const reasoningMode = resolveCliReasoningMode(program, opts, config);
  const agentMode = resolveCliAgentMode(program, opts, config);
  const configuredExtensions = Array.isArray(configWithExtensions.extensions)
    ? configWithExtensions.extensions
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map((value) => path.isAbsolute(value) ? value : path.resolve(path.dirname(KODAX_CONFIG_FILE), value))
    : [];
  const cliExtensions = Array.isArray(opts.extension)
    ? opts.extension
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map((value) => path.resolve(value))
    : [];
  const dedupedConfiguredExtensions = mergeConfiguredExtensions([], configuredExtensions);
  const dedupedCliExtensions = mergeConfiguredExtensions(cliExtensions, []);
  const configuredOnlyExtensions = dedupedConfiguredExtensions.filter(
    (value) => !dedupedCliExtensions.includes(value),
  );
  const activeExtensions = mergeConfiguredExtensions(dedupedCliExtensions, configuredOnlyExtensions);
  const hasActiveMcp = hasConfiguredMcpServers(configWithExtensions);
  const selectedProvider = opts.provider ?? config.provider ?? KODAX_DEFAULT_PROVIDER;
  const selectedModel = resolveCliModelSelection(
    opts.provider,
    opts.model,
    config.provider,
    config.model,
  );
  // -y/--auto is kept for backward compatibility but has no effect in CLI.
  const options: CliOptions = {
    // Priority: CLI args > config file > defaults.
    provider: selectedProvider,
    model: selectedModel,
    thinking: reasoningMode !== 'off',
    reasoningMode,
    agentMode,
    outputMode: (opts.mode as CliOutputMode | undefined) ?? 'text',
    extensions: activeExtensions,
    session: opts.session,
    team: opts.team,
    init: opts.init,
    append: opts.append ?? false,
    overwrite: opts.overwrite ?? false,
    maxIter: parseOptionalNonNegativeInt(opts.maxIter),
    autoContinue: opts.autoContinue ?? false,
    maxSessions: parseNonNegativeIntWithFallback(opts.maxSessions, 50),
    maxHours: parsePositiveNumberWithFallback(opts.maxHours, 2),
    prompt: opts.print ? [opts.print] : program.args,
    continue: opts.continue ?? false,
    resume: opts.resume,
    noSession: opts.noSession ?? false,
    print: opts.print ? true : false,
  };

  if (options.team) {
    console.error(chalk.red('\n[Deprecated] --team has been sunset.'));
    console.error(chalk.dim('Use --agent-mode ama for adaptive multi-agent execution, or --agent-mode sa for single-agent execution.\n'));
    process.exitCode = 1;
    return;
  }

  // Session list: show all saved sessions.
  if (options.session === 'list') {
    const storage = new FileSessionStorage();
    const sessions = await storage.list();
    console.log(sessions.length ? 'Sessions:\n' + sessions.map(s => `  ${s.id} [${s.msgCount}] ${s.title}`).join('\n') : 'No sessions.');
    return;
  }

  let userPrompt = options.prompt.join(' ');

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

  validateCliModeSelection(options, { resumeWithoutId: opts.resume === true });

  if ((options.extensions?.length ?? 0) > 0 || hasActiveMcp) {
    const extensionRuntime = createExtensionRuntime({ config });
    await registerConfiguredMcpCapabilityProvider(extensionRuntime, configWithExtensions.mcpServers);
    const extensionLoader = extensionRuntime as typeof extensionRuntime & {
      loadExtensions: (
        paths: string[],
        options?: { continueOnError?: boolean; loadSource?: 'config' | 'cli' | 'api' },
      ) => Promise<void>;
    };
    await extensionLoader.loadExtensions(configuredOnlyExtensions, {
      continueOnError: true,
      loadSource: 'config',
    });
    await extensionLoader.loadExtensions(dedupedCliExtensions, {
      continueOnError: true,
      loadSource: 'cli',
    });
    options.extensionRuntime = extensionRuntime;
    extensionRuntime.activate();
  }

  // -r / --resume without ID: list sessions, then resume the latest.
  if (opts.resume === true) {
    try {
      const storage = new FileSessionStorage();
      const sessions = await storage.list();
      if (sessions.length === 0) {
        console.log(chalk.yellow('No sessions found. Starting new session...'));
      } else {
        console.log(chalk.cyan('Recent sessions:'));
        sessions.forEach((s, i) => {
          console.log(`  ${i + 1}. ${s.id} [${s.msgCount} msgs] ${s.title}`);
        });
        // Auto-select the most recent session for resume.
        const selected = sessions[0]!;
        options.resume = selected.id;
        console.log(chalk.cyan(`\nResuming session: ${selected.id}`));
      }
    } catch (error) {
      console.log(chalk.yellow('Failed to list sessions. Starting new session...'));
    }
  }

  // --auto-continue: run non-REPL session loop across pending features.
  if (options.autoContinue) {
    if (!fsSync.existsSync(path.resolve(KODAX_FEATURES_FILE))) {
      console.log(chalk.red(`[Error] --auto-continue requires a long-running project.`));
      console.log(`Run 'kodax --init "your project"' first.`);
      process.exit(1);
    }

    let firstSessionId: string | undefined;
    const storage = new FileSessionStorage();

    if (options.session === 'resume') {
      const sessions = await storage.list();
      firstSessionId = sessions[0]?.id;
      if (firstSessionId) console.log(chalk.cyan(`[KodaX Auto-Continue] Resuming from session: ${firstSessionId}`));
    } else if (options.session) {
      firstSessionId = options.session;
    }

    const startTime = Date.now();
    let sessionCount = 0;

    console.log(chalk.cyan(`[KodaX Auto-Continue] Starting automatic session loop`));
    console.log(chalk.cyan(`[KodaX Auto-Continue] Max sessions: ${options.maxSessions}, Max hours: ${options.maxHours}`));
    const [completed0, total0] = getFeatureProgress();
    console.log(chalk.cyan(`[KodaX Auto-Continue] Current progress: ${completed0}/${total0} features complete\n`));

    while (sessionCount < options.maxSessions) {
      if (checkAllFeaturesComplete()) {
        console.log('\n' + '='.repeat(60));
        console.log(chalk.green(`[KodaX Auto-Continue] All features complete!`));
        console.log('='.repeat(60));
        break;
      }

      const elapsedHours = (Date.now() - startTime) / 3600000;
      if (elapsedHours >= options.maxHours) {
        console.log('\n' + '='.repeat(60));
        console.log(chalk.yellow(`[KodaX Auto-Continue] Max time reached (${options.maxHours}h)`));
        console.log('='.repeat(60));
        break;
      }

      sessionCount++;
      const [completed, total] = getFeatureProgress();
      console.log('\n' + '='.repeat(60));
      console.log(chalk.cyan(`[KodaX Auto-Continue] Session ${sessionCount}/${options.maxSessions}`));
      console.log(chalk.cyan(`[KodaX Auto-Continue] Progress: ${completed}/${total} features | Elapsed: ${elapsedHours.toFixed(1)}h/${options.maxHours}h`));
      console.log('='.repeat(60));

      const prompt = userPrompt || 'Continue implementing features from feature_list.json';
      const kodaXOptions = createKodaXOptions({
        ...options,
        session: sessionCount === 1 ? firstSessionId : undefined,
      }, false);

      const result = await runManagedTask({
        ...kodaXOptions,
        context: {
          ...kodaXOptions.context,
          taskSurface: 'cli',
        },
      }, prompt);
      emitJsonRunResultIfNeeded(options.outputMode, result);

      if (!result.success) {
        console.log(chalk.red(`\n[KodaX Auto-Continue] Session failed, stopping`));
        break;
      }

      if (result.signal === 'COMPLETE') {
        console.log('\n' + '='.repeat(60));
        console.log(chalk.green(`[KodaX Auto-Continue] Agent signaled COMPLETE`));
        console.log('='.repeat(60));
        break;
      } else if (result.signal === 'BLOCKED') {
        console.log('\n' + '='.repeat(60));
        console.log(chalk.yellow(`[KodaX Auto-Continue] Agent BLOCKED: ${result.signalReason}`));
        console.log('Waiting for human intervention...');
        console.log('='.repeat(60));
        break;
      } else if (result.signal === 'DECIDE') {
        console.log('\n' + '='.repeat(60));
        console.log(chalk.cyan(`[KodaX Auto-Continue] Agent needs decision: ${result.signalReason}`));
        console.log('='.repeat(60));
        break;
      }
    }

    const [completedF, totalF] = getFeatureProgress();
    console.log('\n' + '='.repeat(60));
    console.log(chalk.cyan(`[KodaX Auto-Continue] Final Status:`));
    console.log(`  Sessions completed: ${sessionCount}`);
    console.log(`  Features complete: ${completedF}/${totalF}`);
    console.log(`  Total time: ${((Date.now() - startTime) / 60000).toFixed(1)} minutes`);
    console.log('='.repeat(60));
    return;
  }

  // --init: generate feature_list.json and initialize project truth files.
  if (options.init) {
    const currentDate = new Date().toISOString().split('T')[0];
    const currentOS = process.platform === 'win32' ? 'Windows' : 'Unix/Linux';
    const featuresPath = path.resolve(KODAX_FEATURES_FILE);

    if (fsSync.existsSync(featuresPath)) {
      let existingFeatures: any[] = [];
      let total = 0, completed = 0;
      try {
        const data = JSON.parse(fsSync.readFileSync(featuresPath, 'utf-8'));
        existingFeatures = data.features ?? [];
        total = existingFeatures.length;
        completed = existingFeatures.filter((f: any) => f.passes).length;
      } catch { }

      if (options.append) {
        console.log(chalk.yellow('[Warning] --append is deprecated. Prefer /project init "<request>" inside the REPL change-request flow.'));
        console.log(chalk.cyan(`[KodaX] Appending to existing project (${total} features, ${completed} complete)`));
        userPrompt = `Add new features to an existing project: ${options.init}

**Current Context:**
- Date: ${currentDate}
- OS: ${currentOS}

**Existing Features** (DO NOT modify these, keep them as-is):
${JSON.stringify(existingFeatures, null, 2)}

**Your Task**:
1. Read the existing feature_list.json to understand what's already done
2. Create NEW features for: ${options.init}
3. Use the EDIT tool to APPEND the new features to the existing feature_list.json
   - Do NOT delete or modify existing features
   - Just add new features to the "features" array
4. Add a new section to PROGRESS.md for this phase (don't overwrite)

**New Feature Guidelines:**
- Aim for 5-10 NEW features (not 40+)
- Keep each feature SMALL (completable in 1 session)
- Each new feature should have "passes": false

After updating files, commit:
   git add .
   git commit -m "Add new features: ${options.init.slice(0, 50)}"

**Example of appending to feature_list.json:**
Old: {"features": [{"description": "Old feature", "passes": true}]}
New: {"features": [
  {"description": "Old feature", "passes": true},
  {"description": "New feature 1", "steps": [...], "passes": false},
  {"description": "New feature 2", "steps": [...], "passes": false}
]}
`;
      } else if (options.overwrite) {
        console.log(chalk.yellow(`[Warning] Overwriting existing feature_list.json (${total} features will be lost)`));
        userPrompt = buildInitPrompt(options.init, currentDate, currentOS);
      } else {
        console.log(chalk.yellow(`\n[Warning] feature_list.json already exists!`));
        console.log(`  Current: ${total} features (${completed} complete, ${total - completed} pending)\n`);
        console.log('  Options:');
        console.log('  Open the REPL and run /project init "<request>" to create a change request');
        console.log('  --overwrite   Start fresh (existing features will be lost)\n');
        console.log(`Example:\n  kodax\n  /project init "${options.init}"`);
        process.exit(1);
      }
    } else {
      console.log(chalk.cyan(`[KodaX] Initializing long-running task: ${options.init}`));
      userPrompt = buildInitPrompt(options.init, currentDate, currentOS);
    }
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
          (prompt: string) => runManagedTask({
            ...kodaXOptions,
            context: {
              ...kodaXOptions.context,
              taskSurface: 'cli',
            },
          }, prompt)
        );
        if (commandPrompt) {
          const result = await runManagedTask({
            ...kodaXOptions,
            context: {
              ...kodaXOptions.context,
              taskSurface: 'cli',
            },
          }, commandPrompt);
          emitJsonRunResultIfNeeded(options.outputMode, result);
          return;
        }
      }
    }
  }
  // No prompt and not in print/init mode: enter interactive mode
  if (!userPrompt && !options.init && !options.print) {
    const kodaXOptions = createKodaXOptions(options, false);
    const interactiveSurface = resolveInteractiveSurfacePreference();
    const useClassicInteractiveMode = interactiveSurface === 'classic';
    // Pass FileSessionStorage for persisted sessions.
    try {
      if (useClassicInteractiveMode) {
        console.error(chalk.dim(
          '\n[Terminal compatibility] Using classic REPL because this terminal host cannot safely run the fullscreen TUI.',
        ));
        console.error(chalk.dim(
          'Set KODAX_FORCE_INK=1 or KODAX_TUI_RENDERER=owned to override, or KODAX_FORCE_CLASSIC_REPL=1 to keep this mode everywhere.\n',
        ));
      }

      const interactiveOptions = {
        provider: kodaXOptions.provider,
        model: kodaXOptions.model,
        thinking: kodaXOptions.thinking,
        reasoningMode: kodaXOptions.reasoningMode,
        agentMode: kodaXOptions.agentMode,
        maxIter: kodaXOptions.maxIter,
        extensionRuntime: kodaXOptions.extensionRuntime,
        session: kodaXOptions.session,
        storage: new FileSessionStorage(),
      };

      if (useClassicInteractiveMode) {
        await runInteractiveMode(interactiveOptions);
      } else {
        await runInkInteractiveMode(interactiveOptions);
      }
    } catch (error) {
      if (error instanceof KodaXTerminalError) {
        console.error(chalk.red(`\n[Error] ${error.message}`));
        console.error(chalk.dim("\nYour terminal environment does not support interactive mode."));
        console.error(chalk.dim("\nPlease use CLI mode instead:"));
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
  if (!userPrompt && !options.init && options.print) {
    showBasicHelp();
    return;
  }

  // Run a single managed task in print mode and exit.
  const kodaXOptions = createKodaXOptions(options, options.print ?? false);
  const result = await runManagedTask({
    ...kodaXOptions,
    context: {
      ...kodaXOptions.context,
      taskSurface: 'cli',
    },
  }, userPrompt);
  emitJsonRunResultIfNeeded(options.outputMode, result);
}

/**
 * Entry Point Detection
 *
 * Determines if this module is being run as the main entry point.
 * This is necessary because:
 * 1. When run directly (e.g., `node dist/kodax_cli.js`), we should execute main()
 * 2. When imported for testing, we should NOT execute main()
 * 3. When run via npm link, the paths may differ due to symlinks
 *
 * Detection logic:
 * - Direct execution: import.meta.url === pathToFileURL(process.argv[1]).href
 * - npm link: import.meta.url ends with '/dist/kodax_cli.js' while process.argv[1]
 *   points to the symlinked global bin
 */
const scriptPath = process.argv[1];
const metaUrl = import.meta.url;
const scriptUrl = scriptPath ? pathToFileURL(scriptPath).href : '';

// Check if this is the main module
// Primary: exact URL match (direct execution)
// Fallback: check if module path ends with the expected dist file (npm link scenario)
const isMainModule = scriptPath && (
  metaUrl === scriptUrl ||
  metaUrl.endsWith('/dist/kodax_cli.js')
);

if (isMainModule) {
  main().catch(e => { console.error(chalk.red(`[Error] ${e.message}`)); process.exit(1); });
}

// Export for testing
export { main };
