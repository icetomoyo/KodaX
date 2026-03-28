#!/usr/bin/env node
/**
 * KodaX CLI - 闂傚倸鍊搁崐椋庣矆娓氣偓楠炲鏁嶉崟顓犵厯闂佸湱鍎ら〃鍛村垂閸屾稓绡€闂傚牊渚楅崕蹇曠磼閻欌偓閸ｏ綁寮婚弴銏犻唶婵犻潧娲らˇ鈺呮⒑缁嬫鍎愰柨鏇樺灲楠炲啫顫滈埀顒勫箖濞嗘挻鍤嬫繛鍫熷椤ュ鏌ｆ惔銏╁晱闁哥姵顨嗙换娑欑節閸パ嗘憰? *
 * UI 闂傚倸鍊峰ù鍥敋瑜忛幑銏ゅ箳濡も偓绾剧粯绻涢幋娆忕仼缁炬崘顕ч埞鎴︽偐閹绘帩浠惧銈庡亝濞叉牠婀侀梺绋跨箰閸氬绱為幋锔界厽妞ゆ挾鍣ュ▓婊堟煛鐏炲墽銆掑ù鐙呯畵瀹曟粏顦┑顔兼搐閳规垿鎮欓懠顒€顣洪梺缁樼墪閵堟悂鐛崘銊ф殝闁逛絻娅曢悗璇测攽閻愬弶顥為柛銊ь攰閹筋偊姊婚崒娆愮グ妞ゆ泦鍛板С闁兼祴鏅涢崹婵囩箾閸℃ê濮冪紒璇叉閹鈽夊▎妯煎姺闂佸磭绮鑽ゆ閹烘鐭楁俊顖濇瑜颁苟ner闂傚倸鍊搁崐椋庢濮橆剦鐒界憸宥堢亱闂佸搫鍟崐褰掝敃閼恒儲鍙忔俊顖濇婢瑰嫰姊洪崹顕呭剳闁荤喎缍婇弻宥堫檨闁告挾鍠栭悰顔界節閸屾鏂€闁诲函缍嗛崑鍕枔閵堝鈷戦柛娑橈攻鐏忣偊鏌ら崘鑼煟闁诡喗鐟╁鎾閳锯偓閹锋椽姊洪崨濠勨槈闁挎洏鍊濋幃姗€鏁冮埀顒勬箒濠电姴艌閸嬫挾绱掗鐣屾噰鐎规洘妞介崺鈧い鎺嶉檷娴滄粓鏌熸潏鍓у埌闁告梻鏁婚弻娑滅疀閹惧墎鍔梺鍝勫閸撴繈骞忛崨瀛橆棃婵炴垶甯掓禍鐐節闂堟侗鍎戠€规挷绶氶幃妤呮晲鎼粹剝鐏嶉梺鐟扮湴閸庣敻寮诲☉姘勃闁告挆鈧Σ鍫ユ⒑鐞涒€充壕濡炪倖鎸鹃崰鎾剁不? */

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
  resolveCliParallel,
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
  loadConfig,
  getFeatureProgress,
  checkAllFeaturesComplete,
  buildInitPrompt,
  FileSessionStorage,
  KODAX_CONFIG_FILE,
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
  resolveCliParallel,
};
export type { KodaXCommand, KodaXCommandContext };
// ============== CLI 闂傚倸鍊峰ù鍥х暦閸偅鍙忛柡澶嬪殮瑜版帒绀嬫い鎴ｆ硶缁犳岸姊洪幖鐐插姉闁哄懏鐩畷鐟扳攽鐎ｎ剙褰勯梺鎼炲劘閸斿秶绮堥崘顔界厸闁糕剝顭囬惌瀣煏閸パ冾伃鐎殿噮鍣ｅ畷鎺戭潩椤戣法甯涢梺?==============

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
    console.log(chalk.dim('  --team <tasks>      ') + 'Deprecated legacy option');
    console.log(chalk.dim('  -j, --parallel      ') + 'Enable parallel tool execution\n');
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
  console.log('KodaX - 闂傚倸鍊搁崐椋庣矆娓氣偓楠炴牠顢曢敂缁樻櫈闂佸憡娲﹂崐瀣亹閹烘垹鍊炲銈嗗坊閸嬫捇鏌涘顒佽础闁规彃鎲￠幆鏃堝煡閸℃瑥濮烘俊鐐€曠换鎰板箠閹邦喖濮柍褜鍓欓埞鎴︻敊閺傘倓绶甸梺鍛婃尰瀹€鎼併€侀弮鍫熸櫢闁绘ɑ鏋奸幏?Coding Agent\n');
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
  console.log('  -j, --parallel          Parallel tool execution');
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
    .description('KodaX - 闂傚倸鍊搁崐椋庣矆娓氣偓楠炴牠顢曢敂缁樻櫈闂佸憡娲﹂崐瀣亹閹烘垹鍊炲銈嗗坊閸嬫捇鏌涘顒佽础闁规彃鎲￠幆鏃堝煡閸℃瑥濮烘俊鐐€曠换鎰板箠閹邦喖濮柍褜鍓欓埞鎴︻敊閺傘倓绶甸梺鍛婃尰瀹€鎼併€侀弮鍫熸櫢闁绘ɑ鏋奸幏?Coding Agent')
    .version(version)
    // Disable commander default help so the custom topic help can take over.
    .helpOption(false)
    // 闂傚倸鍊搁崐鐑芥嚄閸洖鍌ㄧ憸鏃堝Υ閸愨晜鍎熼柕蹇嬪焺濞茬鈹戦悩璇у伐闁绘锕畷鎴﹀煛閸涱喚鍘介梺閫涘嵆濞佳勬櫠娴煎瓨鐓?help 闂傚倸鍊搁崐鎼佸磹妞嬪孩顐介柨鐔哄Т绾惧鏌涢弴銊ョ€柛銉墯閸嬨劎绱掔€ｎ収鍤﹂柕澹偓閸嬫捇鐛崹顔煎濡炪倧缂氶崡鍐差嚕閺屻儺鏁嗛柛鏇ㄥ墰閸樺崬顪冮妶鍡楀闁稿﹥娲熷鎼佸箣閿旂晫鍘搁梺绯曞墲椤洭鎯岄幒妤佺厸鐎光偓閳ь剟宕伴弽褜娼栫憸鐗堝笒缁犳稒銇勯弴鐐村櫤鐞氾箓姊洪懡銈呮瀾缂侇喖瀛╅弲璺何旈崨顔间簵闂佽法鍠撴慨鎾嫅閻斿吋鐓曟繛鎴濆船閺嬫稓绱掗崜浣镐粶闁宠鍨块幃鈺呭箵閹哄棗浜剧憸鐗堝吹婢跺ň鏀介悗锝庡亐閹锋椽鏌℃径灞戒沪濠㈢懓妫濊棟闁挎洖鍊哥粻褰掓倵濞戞瑯鐒介柣顓炴湰娣?
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
    .option('-y, --auto', 'Backward-compat alias; no effect in non-REPL CLI')
    .option('-s, --session <op>', 'Legacy session operations: list, resume, delete <id>, delete-all, or raw session ID')
    .option('-j, --parallel', 'Parallel tool execution')
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
    .option('--permission-mode <mode>', 'Initial permission mode', parsePermissionModeOption, 'accept-edits')
    .action(async (subcommandOptions: {
      cwd?: string;
      provider?: string;
      model?: string;
      thinking?: boolean;
      reasoning?: KodaXReasoningMode;
      permissionMode?: PermissionMode;
    }) => {
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
  // 闂傚倸鍊搁崐椋庣矆娓氣偓楠炲鍨鹃幇浣圭稁缂傚倷鐒﹁摫闁告瑥绻橀弻鐔碱敍閿濆洣姹楅悷婊呭鐢帡鎮欐繝鍐︿簻闁瑰搫绉烽崗宀勬煕濡濮嶉柟顔筋殜閻涱噣宕归鐓庮潛婵犵數鍋涢惇浼村礉閹存繍鍤曢柟闂寸绾惧ジ鏌ｉ幇顒夊殶闁告ɑ鎮傚铏圭矙閹稿孩鎷辩紒鐐緲缁夊綊骞嗙仦杞挎梹鎷呴搹璇″晭闂備胶纭堕崜婵嬪礉閺囥垺鍊堕柡灞诲劜閻撴稑霉閿濆懏鎲搁弫鍫ユ倵鐟欏嫭绀€闁靛牆鎲￠幈銊╁焵椤掑嫭鐓冮柍杞扮閺嗙偞銇勯幘鑸靛殌闁宠鍨块幃娆撴嚑椤掍焦鍠栫紓鍌欑贰閸犳牠鎳熼鐐寸畳闂備胶绮崹鐓幬涢崟顖涘€堕柧蹇ｅ亗缁诲棙銇勯弽銊︾殤婵絿鍋ら弻娑氣偓锝庡亝鐏忕敻鏌熼崣澶嬪唉鐎规洜鍠栭、鏇㈠閳╁啫娈樼紓鍌氬€搁崐椋庢閿熺姴闂い鏇楀亾鐎规洖缍婇獮搴ㄦ寠婢跺矈鍞甸梺璇插嚱缂嶅棝宕伴弽褎绾梻鍌欑閹测剝绗熷Δ浣侯洸婵犲﹤瀚々鏌ユ煕閹炬鎳忛敍蹇擃渻閵堝棙灏柛鈺佸铻為柟瀵稿Х绾惧ジ鏌?
  const config = loadConfig();
  const configWithExtensions = config as typeof config & { extensions?: string[] };
  const reasoningMode = resolveCliReasoningMode(program, opts, config);
  const agentMode = resolveCliAgentMode(program, opts, config);
  const parallel = resolveCliParallel(program, opts, config);
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
  // -y/--auto is kept for backward compatibility but has no effect in CLI.
  const options: CliOptions = {
    // Priority: CLI args > config file > defaults.
    provider: opts.provider ?? config.provider ?? KODAX_DEFAULT_PROVIDER,
    model: opts.model ?? config.model,
    thinking: reasoningMode !== 'off',
    reasoningMode,
    agentMode,
    outputMode: (opts.mode as CliOutputMode | undefined) ?? 'text',
    extensions: activeExtensions,
    session: opts.session,
    parallel,
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

  // 婵犵數濮烽弫鎼佸磻閻愬樊鐒芥繛鍡樻尭鐟欙箓鎮楅敐搴′簽闁崇懓绉电换娑橆啅椤旇崵鍑归梺绋块閿曘倝婀侀梺缁樏Ο濠囧磿韫囨洜纾奸柍褜鍓熷畷鍗炍熼崷顓犵暰闂備線娼ч悧鍡涘箠鎼搭煈鏁傞柕澶嗘櫆閻?
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
    // 闂傚倸鍊搁崐椋庣矆娓氣偓楠炴牠顢曢敃鈧悿顕€鏌ｅΔ鈧悧濠囧矗韫囨稒鐓涘璺侯儏閻掗箖鏌涢妶鍡樼闁靛洤瀚伴獮鎺楀箣濠垫劒鎮ｉ梻浣告惈椤戝嫮娆㈠璺虹畺濞寸姴顑愰弫宥夋煥濠靛棙鍣洪柣蹇旀尵缁辨挻鎷呴悷鏉款潔濡炪們鍔岄敃顏勵嚕婵犳碍鏅搁柣妯垮皺椤︽澘顪冮妶鍡楀闁瑰啿娲獮鎰板礃椤旇В鎷洪梻鍌氱墛缁嬫帗寰勯崟顓涘亾閸忓浜剧紓浣割儓濞夋洟寮抽敂鐣岀鐎瑰壊鍠曠花濂告煕婵犲嫮甯涘ǎ鍥э躬椤㈡稑顭ㄩ崨顓狀偧闂佽瀛╃喊宥嗙箾婵犲洤钃熼柨婵嗩槸椤懘鏌嶆潪鎷屽厡濞寸厧娲娲传閵夈儛锝夋煟濡や緡娈滄?
    showBasicHelp();
    return;
  }

  validateCliModeSelection(options, { resumeWithoutId: opts.resume === true });

  if ((options.extensions?.length ?? 0) > 0) {
    const extensionRuntime = createExtensionRuntime({ config });
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

  // -r / --resume 婵犵數濮烽弫鎼佸磻閻愬搫鍨傞柛顐ｆ礀缁犱即鏌涘┑鍕姢闁活厽鎹囬弻鐔虹磼閵忕姵鐏嶉梺?id: 婵犵數濮烽弫鎼佸磻濞戙垺鍋ら柕濞炬櫅閸氬綊骞栧ǎ顒€濡肩痪鎯х秺閺岀喖鎮欓鈧崝璺衡攽椤旇棄鈻曢柡灞稿墲瀵板嫮鈧綁娼ч崝宀勬⒑閹肩偛鈧牕煤閻斿吋鍋傛い鎰剁畱閻愬﹪鏌曟繛褉鍋撻柡瀣濮婅櫣绮欏▎鎯у壉闂佽鐡曢褔顢氶妷鈺佺妞ゆ挻绋戞禍楣冩煥濠靛棛鍑归柟鍙夊劤闇夐柣妯垮皺閹界姷绱掔紒妯兼创鐎殿喖鐖奸獮瀣攽閸パ€鍋撻娑氱闁挎繂鎳忔径鍕繆閻愭壆鐭欐?
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
        // 婵犵數濮甸鏍窗濡ゅ啯鏆滄俊銈呭暟閻瑩鏌熼悜妯镐粶闁逞屽墾缁犳挸鐣锋總绋课ㄦい鏃囧Г濞呭秴鈹戦悩鍨毄濠殿喚鏁搁崰濠傤吋婢跺鈧潡鎮归崶褎鈻曢柣鏂挎閹娼幏宀婂妳闂佺楠哥换鎴﹀Φ閸曨喚鐤€閻庯綆浜滄慨銏㈢磽娴ｄ粙鍝洪悽顖涘笩閻忓啯绻濋悽闈浶㈤柛濠冩倐閻涱噣骞囬鍓э紳婵炶揪缍€椤鎮￠妷鈺傜厽閹烘娊宕濇惔锝呭灊婵炲棙鍔曠欢鐐烘煙閺夎法浠涢柡鍛矒閺岀喖鎳濋悧鍫濇锭缂備焦褰冨陇妫熼梺鍐叉惈閹冲繘鍩涢幋锔界厱婵犻潧妫楅顐㈩熆瑜庨崝娆撳蓟濞戞埃鍋撻敐搴′簼鐎规洖鐬奸埀顒侇問閸犳牠鎮ユ總绋挎槬闁跨喓濮寸壕鍏兼叏濡搫鑸归悽顖氭捣缁?
        const selected = sessions[0]!;
        options.resume = selected.id;
        console.log(chalk.cyan(`\nResuming session: ${selected.id}`));
      }
    } catch (error) {
      console.log(chalk.yellow('Failed to list sessions. Starting new session...'));
    }
  }

  // --auto-continue: 闂傚倸鍊搁崐鐑芥嚄閸洖鍌ㄧ憸鏃堝Υ閸愨晜鍎熼柕蹇嬪焺濞茬鈹戦悩璇у伐閻庢凹鍙冨畷锝堢疀濞戞瑧鍘撻柡澶屽仦婢瑰棛鎷规导瀛樼厱闁靛牆妫▓鏇㈡煏閸パ冾伂缂佺姵鐩獮姗€骞栭鐕佹＇缂?
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

  // --init: 闂傚倸鍊搁崐椋庣矆娓氣偓楠炲鏁嶉崟顒佹濠德板€曢崯顖氱暦閺屻儲鐓曠€光偓閳ь剟宕曢幋鐘电闁哄稁鍘介悡娆撴煟濡も偓閻楀﹦娆㈤懠顒傜＜闁逞屽墮閻ｆ繈宕熼鍌氬箰闁诲骸绠嶉崕杈殽閹间胶宓佹俊銈勭劍閸欏繘鏌ㄥ┑鍡橆棞濠殿喖绉归弻鈥崇暆鐎ｎ剛鐦堥悗瑙勬礃閿曘垺淇婂宀婃Щ闂佺粯鎸鹃崰搴ㄥ煘閹达箑鐓￠柛鈩冦仦缁ㄥジ鏌ｆ惔锝囨嚄闁告劕澧介崝閿嬬節閻㈤潧校闁肩懓澧界划璇测槈濞嗗秳绨婚梺鍝勭Ф閺佸摜绮欐繝姘厸闁稿本顨呮禍鎯р攽閻樺灚鏆╅柛瀣洴椤㈡岸顢橀悢绋垮伎婵°倧绲介崰姘跺极鐎ｎ剚鍠愰幖娣妼缁?
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
    // Pass FileSessionStorage for persisted sessions.
    // Avoid forwarding CLI events or permission settings because Ink manages its own UI state.
    try {
      await runInkInteractiveMode({
        provider: kodaXOptions.provider,
        model: kodaXOptions.model,
        thinking: kodaXOptions.thinking,
        reasoningMode: kodaXOptions.reasoningMode,
        agentMode: kodaXOptions.agentMode,
        maxIter: kodaXOptions.maxIter,
        parallel: kodaXOptions.parallel,
        extensionRuntime: kodaXOptions.extensionRuntime,
        session: kodaXOptions.session,
        storage: new FileSessionStorage(),
        // 婵犵數濮烽弫鎼佸磻閻愬搫鍨傞柛顐ｆ礀缁犱即鏌涘┑鍕姢闁活厽鎸鹃埀顒冾潐濞叉牕煤閿曞偊缍栭柡鍥ュ灪閻撴洘銇勯幇鍓佺ɑ缂佲偓閸愵喗鐓?events闂傚倸鍊搁崐鐑芥倿閿旈敮鍋撶粭娑樻噽閻瑩鏌熸潏楣冩闁稿孩顨婇弻娑氫沪閸撗€妲堝銈嗘礋娴滃爼寮诲澶婁紶闁告洦鍓欏▍锝囩磽娴ｆ彃浜鹃梺绋挎湰婢规洟宕戦幘鑽ゅ祦闁割煈鍠栨慨搴ㄦ煟鎼淬垹鍤柛锝忕秮楠?Ink UI 闂傚倸鍊搁崐椋庣矆娓氣偓楠炲鏁撻悩鑼槷濠碘槅鍨跺Λ鍧楁倿婵犲啰绠鹃柛鈩兩戠亸浼存煕?
      });
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

  // 闂傚倸鍊搁崐椋庣矆娓氣偓楠炴牠顢曢妶鍌氫壕婵鍘ф晶顖炴煛閸涙澘鐓愮紒鍌涘笧閳ь剨缍嗛埀顒夊弿闂勫嫰骞堥妸銉庣喖宕稿Δ鈧幗鐢告⒑閸濆嫭顥炵紒顔肩Ч婵＄敻宕熼姘辩潉闂佺鏈懝鐐濮椻偓閹泛顫濋崡鐐╂瀰濠殿喖锕ュ浠嬬嵁閹邦厽鍎熼柨婵嗗€归～宥嗙節閻㈤潧浠╅柛瀣姍閳ワ妇绮甸惃鈧瑃 濠电姷鏁告慨鐑姐€傞挊澹╋綁宕ㄩ弶鎴濈€銈呯箰閻楀棝鎮為崹顐犱簻闁瑰搫妫楁禍鍓х磼閸撗嗘闁告ɑ鍎抽埥澶愭偨缁嬭法鍔﹀銈嗗笂閼冲墎绮绘ィ鍐╃厵閻庣數顭堟禒锕傛倶韫囨洖顣奸柟渚垮妽缁绘繈宕熼鈧▓宀勬煣閼姐倕浠遍柡灞炬礋瀹曠厧鈹戦崶鑸碉骏婵＄偑鍊愰弲婵嬪礂濮椻偓楠炲啳銇愰幒鎴犲€為梺闈涱焾閸庡磭绮婂畡閭︽富闁靛牆楠告禍鏍煕婵犲啰绠炵€殿喖顭烽弫鎾绘偐閼碱剦妲版俊鐐€栭幐鍡涘礃閳哄倻褰庣紓?
  if (!userPrompt && !options.init && options.print) {
    showBasicHelp();
    return;
  }

  // 濠电姷鏁告慨鐢割敊閺嶎厼绐楁俊銈呭暞瀹曟煡鏌熼柇锕€鏋涚紒韬插€曢湁闁绘ê妯婇崕鎰版煕鐎ｎ亶妯€闁哄被鍊楃划娆戞崉閵娿倗椹冲┑鐐茬摠閸ゅ酣宕愬┑瀣摕闁绘柨鍚嬮悞浠嬫煥閺囨浜鹃梺璇茬箻娴滃爼寮婚敓鐘茬劦?
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
