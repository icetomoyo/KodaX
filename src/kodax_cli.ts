#!/usr/bin/env node
/**
 * KodaX CLI - 命令行入口
 *
 * UI 层：参数解析、Spinner、颜色输出、用户交互
 */

import { Command, InvalidArgumentError } from 'commander';
import chalk from 'chalk';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { runAcpServer } from './acp_server.js';
import { runSkillCreatorTool } from './skill_cli.js';

// 从 package.json 读取版本号
const packageJsonPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../package.json');
const version = fsSync.existsSync(packageJsonPath)
  ? JSON.parse(fsSync.readFileSync(packageJsonPath, 'utf-8')).version
  : '0.0.0';

import {
  runKodaX,
  KodaXClient,
  KodaXEvents,
  KodaXOptions,
  createKodaXTaskRunner,
  KodaXReasoningMode,
  KodaXResult,
  runOrchestration,
  KODAX_REASONING_MODE_SEQUENCE,
  KODAX_DEFAULT_PROVIDER,
  KODAX_FEATURES_FILE,
  KODAX_PROGRESS_FILE,
  checkPromiseSignal,
  getProvider,
  getAvailableProviderNames,
  KODAX_TOOLS,
  KodaXTerminalError,
} from '@kodax/coding';
import type { KodaXAgentWorkerSpec } from '@kodax/coding';
import {
  getGitRoot,
  loadConfig,
  getFeatureProgress,
  checkAllFeaturesComplete,
  rateLimitedCall,
  buildInitPrompt,
  runInkInteractiveMode,
  FileSessionStorage,
  createCliEvents,
  type PermissionMode,
} from '@kodax/repl';

import os from 'os';

export const ACP_PERMISSION_MODES: PermissionMode[] = ['plan', 'accept-edits', 'auto-in-project'];

export function parsePermissionModeOption(value: string): PermissionMode {
  if (ACP_PERMISSION_MODES.includes(value as PermissionMode)) {
    return value as PermissionMode;
  }

  throw new InvalidArgumentError(
    `Expected one of: ${ACP_PERMISSION_MODES.join(', ')}.`,
  );
}

// ============== Commands 系统 (CLI 层) ==============
// Commands 是 /xxx 形式的 CLI 快捷命令，不是 Core 的 Skills (KODAX_TOOLS)

export const KODAX_COMMANDS_DIR = path.join(os.homedir(), '.kodax', 'commands');

export interface KodaXCommand {
  name: string;
  description: string;
  content: string;
  type: 'prompt' | 'programmable';
  execute?: (context: KodaXCommandContext) => Promise<string>;
}

export interface KodaXCommandContext {
  args?: string;
  runAgent: (prompt: string) => Promise<KodaXResult>;
}

export function getDefaultCommandDir(): string {
  return KODAX_COMMANDS_DIR;
}

export async function loadCommands(commandDir?: string): Promise<Map<string, KodaXCommand>> {
  const commands = new Map<string, KodaXCommand>();
  const dir = commandDir ?? KODAX_COMMANDS_DIR;

  try {
    await fs.mkdir(dir, { recursive: true });
    const files = await fs.readdir(dir);

    for (const f of files) {
      const ext = path.extname(f);
      const commandName = f.replace(ext, '');

      if (ext === '.md') {
        // Markdown prompt command
        try {
          const content = await fs.readFile(path.join(dir, f), 'utf-8');
          const firstLine = content.split('\n')[0]?.replace(/^#\s*/, '').trim() ?? '';
          const desc = firstLine.slice(0, 60) || '(prompt command)';
          commands.set(commandName, {
            name: commandName,
            description: desc,
            content,
            type: 'prompt',
          });
        } catch { }
      } else if (ext === '.js' || ext === '.ts') {
        // Programmable command
        try {
          const mod = await import(path.join(dir, f));
          for (const [key, value] of Object.entries(mod)) {
            if (key.startsWith('command_') && typeof value === 'function') {
              const fnName = key.replace('command_', '');
              const desc = (value as any).description ?? fnName;
              commands.set(fnName, {
                name: fnName,
                description: String(desc).slice(0, 60),
                content: `[Programmable command: ${fnName}]`,
                type: 'programmable',
                execute: value as (context: KodaXCommandContext) => Promise<string>,
              });
            }
          }
        } catch { }
      }
    }
  } catch { }

  return commands;
}

export async function processCommandCall(
  commandName: string,
  args: string | undefined,
  commands: Map<string, KodaXCommand>,
  runAgent: (prompt: string) => Promise<KodaXResult>
): Promise<string | null> {
  const command = commands.get(commandName);
  if (!command) return null;

  if (command.type === 'prompt') {
    // Prompt command: 将 content 中的 {args} 替换为实际参数
    let prompt = command.content;
    if (args) {
      prompt = prompt.replace(/{args}/g, args);
    }
    return prompt;
  } else if (command.type === 'programmable' && command.execute) {
    // Programmable command: 调用执行函数
    const result = await command.execute({
      args,
      runAgent,
    });
    return result;
  }

  return null;
}

export function parseCommandCall(input: string): [string, string?] | null {
  if (!input.startsWith('/')) return null;

  const parts = input.slice(1).split(/\s+/, 2);
  if (parts.length === 0) return null;

  const commandName = parts[0];
  const args = parts[1];

  return commandName ? [commandName, args] : null;
}

// ============== CLI 选项 ==============

interface CliOptions {
  provider: string;
  model?: string;
  thinking: boolean;
  reasoningMode: KodaXReasoningMode;
  session?: string;
  parallel: boolean;
  team?: string;
  init?: string;
  append: boolean;
  overwrite: boolean;
  maxIter?: number;
  autoContinue: boolean;
  maxSessions: number;
  maxHours: number;
  prompt: string[];
  continue?: boolean;
  resume?: string;
  noSession: boolean;
  print?: boolean;
}

function resolveCliReasoningMode(
  program: Command,
  opts: Record<string, unknown>,
  config: { reasoningMode?: KodaXReasoningMode; thinking?: boolean },
): KodaXReasoningMode {
  const reasoningSource = program.getOptionValueSource('reasoning');
  if (reasoningSource === 'cli' && typeof opts.reasoning === 'string') {
    if (!KODAX_REASONING_MODE_SEQUENCE.includes(opts.reasoning as KodaXReasoningMode)) {
      throw new Error(
        `Invalid reasoning mode "${opts.reasoning}". Expected one of: ${KODAX_REASONING_MODE_SEQUENCE.join(', ')}`,
      );
    }
    return opts.reasoning as KodaXReasoningMode;
  }

  const thinkingSource = program.getOptionValueSource('thinking');
  if (thinkingSource === 'cli' && opts.thinking === true) {
    return 'auto';
  }

  if (config.reasoningMode) {
    return config.reasoningMode;
  }

  if (config.thinking === true) {
    return 'auto';
  }

  return 'auto';
}

export function resolveCliParallel(
  program: Command,
  opts: Record<string, unknown>,
  config: { parallel?: boolean },
): boolean {
  const parallelSource = program.getOptionValueSource('parallel');
  if (parallelSource === 'cli') {
    return opts.parallel === true;
  }

  return config.parallel ?? false;
}

function parseOptionalNonNegativeInt(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }

  return parsed;
}

function parseNonNegativeIntWithFallback(value: string | undefined, fallback: number): number {
  return parseOptionalNonNegativeInt(value) ?? fallback;
}

function parsePositiveNumberWithFallback(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }

  const parsed = Number.parseFloat(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

// ============== CLI 选项转换 ==============

function createKodaXOptions(cliOptions: CliOptions, isPrintMode = false): KodaXOptions {
  return {
    provider: cliOptions.provider,
    model: cliOptions.model,
    thinking: cliOptions.thinking,
    reasoningMode: cliOptions.reasoningMode,
    maxIter: cliOptions.maxIter,
    parallel: cliOptions.parallel,
    session: buildSessionOptions(cliOptions),
    events: createCliEvents(!isPrintMode),
  };
}

// 构建 session 选项
function buildSessionOptions(cliOptions: CliOptions): { id?: string; resume?: boolean; storage: FileSessionStorage; autoResume?: boolean } | undefined {
  const storage = new FileSessionStorage();

  // -p --no-session: 不启用 session（纯无状态）
  if (cliOptions.print && cliOptions.noSession) {
    return undefined;
  }

  // -r <id>: 恢复指定会话
  if (cliOptions.resume) {
    return { id: cliOptions.resume, storage };
  }

  // -c: 继续最近会话
  if (cliOptions.continue) {
    return { resume: true, storage };
  }

  // -s resume: 向后兼容
  if (cliOptions.session === 'resume') {
    return { resume: true, storage };
  }

  // -s <id>: 向后兼容
  if (cliOptions.session && cliOptions.session !== 'list' && cliOptions.session !== 'delete-all' && !cliOptions.session.startsWith('delete ')) {
    return { id: cliOptions.session, storage };
  }

  // -p 模式（不带 --no-session）: 启用 session 以便后续 -c 继续
  if (cliOptions.print) {
    return { storage };
  }

  // 纯交互模式（无参数）: 创建新会话（不自动恢复）
  if (!cliOptions.prompt?.length) {
    return { storage };
  }

  // 默认启用 session
  return { storage };
}

// ============== 主函数 ==============

// ============== CLI 详细帮助 ==============

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
    console.log(chalk.dim('  -t, --thinking               ') + 'Compatibility alias for --reasoning auto');
    console.log(chalk.dim('  --permission-mode <mode>     ') + 'Initial mode: plan, accept-edits, auto-in-project\n');
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
    console.log(chalk.dim('  -t, --thinking       ') + 'Compatibility alias for --reasoning auto\n');
    console.log(chalk.bold('Examples:'));
    console.log(chalk.dim('  kodax --reasoning deep "design the architecture"   ') + '# High-depth reasoning');
    console.log(chalk.dim('  kodax --reasoning balanced -p "analyze this bug"   ') + '# Medium-depth reasoning');
    console.log(chalk.dim('  kodax -t "review this PR"                           ') + '# Alias for auto');
    console.log(chalk.dim('  /reasoning balanced                                 ') + '# Set in REPL\n');
  },
  team: () => {
    console.log(chalk.cyan('\nTeam Mode (Parallel Agents)\n'));
    console.log(chalk.bold('Overview:'));
    console.log(chalk.dim('  Experimental orchestration-based parallel execution for loosely coupled tasks.'));
    console.log(chalk.dim('  Best for independent subtasks; it is not yet a fully shared-context multi-agent runtime.\n'));
    console.log(chalk.bold('Options:'));
    console.log(chalk.dim('  --team <tasks>      ') + 'Comma-separated tasks');
    console.log(chalk.dim('  -j, --parallel      ') + 'Enable parallel tool execution\n');
    console.log(chalk.bold('Examples:'));
    console.log(chalk.dim('  kodax --team "fix auth tests,update docs,clean logs"'));
    console.log(chalk.dim('  kodax --team "task1,task2" -m anthropic --reasoning balanced\n'));
  },
  print: () => {
    console.log(chalk.cyan('\nPrint Mode\n'));
    console.log(chalk.bold('Overview:'));
    console.log(chalk.dim('  Run a single task and exit. Useful for scripting and CI/CD.\n'));
    console.log(chalk.bold('Options:'));
    console.log(chalk.dim('  -p, --print <text>  ') + 'Run task and exit');
    console.log(chalk.dim('  --model <name>      ') + 'Override the selected provider model');
    console.log(chalk.dim('  --no-session        ') + 'Disable session saving\n');
    console.log(chalk.bold('Examples:'));
    console.log(chalk.dim('  kodax -p "fix the bug in auth.ts"   ') + '# Quick fix');
    console.log(chalk.dim('  kodax -p "generate tests" --reasoning balanced') + ' # With reasoning');
    console.log(chalk.dim('  kodax -p "task" -m openai --model gpt-5.4') + ' # Provider + model override');
    console.log(chalk.dim('  kodax -p "task" --no-session        ') + '# Stateless run');
    console.log(chalk.dim('  kodax -p "task" -m anthropic --reasoning deep') + ' # Explicit provider selection\n');
  },
};

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
  console.log('KodaX - 极致轻量化 Coding Agent\n');
  console.log('Usage: kodax [options] [prompt]');
  console.log('       kodax "your task"');
  console.log('       kodax /command_name\n');
  console.log('Options:');
  console.log('  -h, --help [TOPIC]      Show help, or detailed help for a topic');
  console.log('  -p, --print TEXT        Print mode: run single task and exit');
  console.log('  -c, --continue          Continue most recent conversation');
  console.log('  -r, --resume [id]       Resume session by ID (no ID = list recent sessions, then resume the latest)');
  console.log('  -n, --new               Legacy no-op; current CLI already starts a fresh session by default');
  console.log(`  -m, --provider NAME     LLM provider (${providerNames})`);
  console.log('  --model NAME            Model override for the selected provider');
  console.log('  -t, --thinking          Compatibility alias for --reasoning auto');
  console.log('  --reasoning MODE        Reasoning mode: off, auto, quick, balanced, deep');
  console.log('  -y, --auto              Backward-compat alias; no effect in non-REPL CLI');
  console.log('  -s, --session OP        Legacy session operations: list, resume, delete <id>, delete-all, or raw session ID');
  console.log('  --no-session            Disable session persistence (print mode only)');
  console.log('  -j, --parallel          Parallel tool execution');
  console.log('  --team TASKS            Run multiple sub-agents in parallel');
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
    .description('KodaX - 极致轻量化 Coding Agent')
    .version(version)
    // 禁用默认 help，使用自定义的
    .helpOption(false)
    .argument('[prompt...]', 'Your task (optional, enters interactive mode if not provided)')
    // 自定义 help 选项（支持可选参数）
    .option('-h, --help [topic]', 'Show help, or detailed help for a topic')
    // 短参数支持
    .option('-p, --print <text>', 'Print mode: run single task and exit')
    .option('-c, --continue', 'Continue most recent conversation in current directory')
    .option('-n, --new', 'Legacy no-op; current CLI already starts a fresh session by default')
    .option('-r, --resume [id]', 'Resume session by ID (no ID = list recent sessions, then resume the latest)')
    .option('-m, --provider <name>', 'LLM provider')
    .option('--model <name>', 'Model override')
    .option('-t, --thinking', 'Compatibility alias for --reasoning auto')
    .option('--reasoning <mode>', 'Reasoning mode: off, auto, quick, balanced, deep')
    .option('-y, --auto', 'Backward-compat alias; no effect in non-REPL CLI')
    .option('-s, --session <op>', 'Legacy session operations: list, resume, delete <id>, delete-all, or raw session ID')
    .option('-j, --parallel', 'Parallel tool execution')
    .option('--no-session', 'Disable session persistence (print mode only)')
    // 长参数
    .option('--team <tasks>', 'Run multiple sub-agents in parallel (comma-separated)')
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
  // 加载配置文件（用于确定默认值）
  const config = loadConfig();
  const reasoningMode = resolveCliReasoningMode(program, opts, config);
  const parallel = resolveCliParallel(program, opts, config);
  // CLI 参数优先，否则用配置文件的值，最后用默认值
  // Note: -y/--auto is kept for backward compatibility but has no effect in CLI (YOLO mode is default)
  const options: CliOptions = {
    // 优先级：CLI 参数 > 配置文件 > 默认值
    provider: opts.provider ?? config.provider ?? KODAX_DEFAULT_PROVIDER,
    model: opts.model ?? config.model,
    thinking: reasoningMode !== 'off',
    reasoningMode,
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

  // 会话列表
  if (options.session === 'list') {
    const storage = new FileSessionStorage();
    const sessions = await storage.list();
    console.log(sessions.length ? 'Sessions:\n' + sessions.map(s => `  ${s.id} [${s.msgCount}] ${s.title}`).join('\n') : 'No sessions.');
    return;
  }

  let userPrompt = options.prompt.join(' ');

  // -h / --help [topic]: 帮助（无参数显示基本帮助，有参数显示详细主题）
  if (opts.help !== undefined) {
    // opts.help === true 表示没有参数，字符串表示有参数
    if (typeof opts.help === 'string') {
      const topic = opts.help.toLowerCase();
      if (showCliHelpTopic(topic)) {
        return;
      }
      console.log(chalk.yellow(`\n[Unknown help topic: ${topic}]`));
      showCliHelpTopics();
      return;
    }
    // 无参数：显示基本帮助
    showBasicHelp();
    return;
  }

  // -r / --resume 不带 id: 交互式选择会话
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
        // 默认选择第一个（最近）
        const selected = sessions[0]!;
        options.resume = selected.id;
        console.log(chalk.cyan(`\nResuming session: ${selected.id}`));
      }
    } catch (error) {
      console.log(chalk.yellow('Failed to list sessions. Starting new session...'));
    }
  }

  // --auto-continue: 自动循环
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

      const result = await runKodaX(kodaXOptions, prompt);

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

  // --init: 初始化长时间运行任务
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

  // --team: 并行子 Agent
  if (options.team) {
    const tasks = options.team.split(',').map(t => t.trim()).filter(Boolean);
    if (tasks.length === 0) { console.log('Error: No tasks specified for --team'); process.exit(1); }

    console.log(chalk.cyan(`[KodaX Team] Running ${tasks.length} tasks with ${options.provider}`));
    if (options.reasoningMode !== 'off') {
      console.log(chalk.cyan(`[KodaX Team] Reasoning mode: ${options.reasoningMode}`));
    }
    const runId = `team-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const workspaceDir = path.resolve('.kodax', 'orchestration', runId);
    console.log(chalk.dim(`[KodaX Team] Workspace: ${workspaceDir}`));

    // 流式输出锁
    const streamLock = { locked: false, queue: [] as (() => void)[] };
    const printedHeaders = new Set<string>();
    async function acquireStreamLock(): Promise<void> {
      while (streamLock.locked) {
        await new Promise<void>(resolve => streamLock.queue.push(resolve));
      }
      streamLock.locked = true;
    }
    function releaseStreamLock(): void {
      streamLock.locked = false;
      const next = streamLock.queue.shift();
      if (next) next();
    }

    const MAX_SUB_ROUNDS = 10;
    const orchestrationTasks: KodaXAgentWorkerSpec[] = tasks.map((task, index) => ({
      id: `task-${index + 1}`,
      title: `Team Task ${index + 1}`,
      prompt: task,
      execution: 'parallel',
      budget: {
        reasoningMode: options.reasoningMode,
        thinking: options.thinking,
        maxIter: MAX_SUB_ROUNDS,
      },
      metadata: {
        taskIndex: index + 1,
      },
    }));
    const runner = createKodaXTaskRunner({
      baseOptions: {
        provider: options.provider,
        thinking: options.thinking,
        reasoningMode: options.reasoningMode,
        maxIter: MAX_SUB_ROUNDS,
      },
      rateLimit: (operation) => rateLimitedCall(operation),
      createEvents: (task) => ({
        onTextDelta: async (text: string) => {
          await acquireStreamLock();
          const taskPreview = task.prompt.slice(0, 50) + (task.prompt.length > 50 ? '...' : '');
          if (!printedHeaders.has(task.id)) {
            console.log(chalk.cyan(`\n[Agent ${task.metadata?.taskIndex ?? task.id}] ${chalk.dim(taskPreview)}`));
            printedHeaders.add(task.id);
          }
          process.stdout.write(text);
          releaseStreamLock();
        },
        onToolResult: (result: { id: string; name: string; content: string }) => {
          console.log(
            chalk.green(
              `[Agent ${task.metadata?.taskIndex ?? task.id} Result] ${result.content.slice(0, 100)}...`
            )
          );
        },
      }),
    });
    const orchestration = await runOrchestration({
      runId,
      workspaceDir,
      maxParallel: tasks.length,
      tasks: orchestrationTasks,
      runner,
    });

    console.log('\n' + '='.repeat(60));
    console.log(chalk.green(`[KodaX Team] Results Summary:`));
    console.log('='.repeat(60));
    for (let i = 0; i < tasks.length; i++) {
      const taskResult = orchestration.taskResults[`task-${i + 1}`];
      console.log(chalk.yellow(`\n[Task ${i + 1}] ${tasks[i]!.slice(0, 50)}${tasks[i]!.length > 50 ? '...' : ''}`));
      if (!taskResult) {
        console.log(chalk.red('[Result] Missing task result'));
        continue;
      }

      if (taskResult.status === 'completed') {
        const resultText = typeof taskResult.result.output === 'string'
          ? taskResult.result.output
          : taskResult.result.summary ?? '';
        if (resultText) {
          const preview = resultText.length > 300 ? resultText.slice(-300) : resultText;
          console.log(chalk.green(`[Result] ...${preview}`));
        } else {
          console.log(chalk.green('[Result] Completed with no textual output'));
        }
      } else {
        console.log(chalk.red(`[${taskResult.status.toUpperCase()}] ${taskResult.result.error ?? taskResult.result.summary ?? 'Task did not complete successfully'}`));
      }
    }
    console.log('\n' + '='.repeat(60));
    console.log(chalk.green(`[KodaX Team] Summary: ${orchestration.summary.completed} completed, ${orchestration.summary.failed} failed, ${orchestration.summary.blocked} blocked`));
    console.log(chalk.dim(`[KodaX Team] Artifacts saved to ${workspaceDir}`));
    return;
  }

  // Command 检查
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
          (prompt: string) => runKodaX(kodaXOptions, prompt)
        );
        if (commandPrompt) {
          await runKodaX(kodaXOptions, commandPrompt);
          return;
        }
      }
    }
  }

  // 无 prompt 且非 print 模式 → 进入交互式
  if (!userPrompt && !options.init && !options.print) {
    const kodaXOptions = createKodaXOptions(options, false);
    // 传递 FileSessionStorage 以支持会话持久化
    // 注意：不传递 CLI events，Ink 模式有自己的状态显示组件
    // 注意：不传递 permissionMode/confirmTools，InkREPL 从配置文件加载
    try {
      await runInkInteractiveMode({
        provider: kodaXOptions.provider,
        thinking: kodaXOptions.thinking,
        reasoningMode: kodaXOptions.reasoningMode,
        maxIter: kodaXOptions.maxIter,
        parallel: kodaXOptions.parallel,
        session: kodaXOptions.session,
        storage: new FileSessionStorage(),
        // 不传递 events，避免与 Ink UI 冲突
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

  // 显示帮助（print 模式且无任务时）
  if (!userPrompt && !options.init && options.print) {
    showBasicHelp();
    return;
  }

  // 正常运行
  const kodaXOptions = createKodaXOptions(options, options.print ?? false);
  await runKodaX(kodaXOptions, userPrompt);
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
