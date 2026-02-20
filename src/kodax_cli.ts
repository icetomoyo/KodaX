#!/usr/bin/env node
/**
 * KodaX CLI - 命令行入口
 *
 * UI 层：参数解析、Spinner、颜色输出、用户交互
 */

import { Command } from 'commander';
import chalk from 'chalk';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath, pathToFileURL } from 'url';

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
  KodaXResult,
  KodaXMessage,
  KodaXSessionStorage,
  KODAX_DEFAULT_PROVIDER,
  KODAX_FEATURES_FILE,
  KODAX_PROGRESS_FILE,
  checkPromiseSignal,
  getProvider,
  KODAX_TOOLS,
  KodaXTerminalError,
} from './core/index.js';
import { getGitRoot, loadConfig, getFeatureProgress, checkAllFeaturesComplete, rateLimitedCall, KODAX_SESSIONS_DIR, buildInitPrompt } from './cli/utils.js';

import { runInkInteractiveMode } from './ui/index.js';

import os from 'os';

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
  thinking: boolean;
  auto: boolean;
  mode?: 'code' | 'ask';  // 交互模式
  session?: string;
  parallel: boolean;
  team?: string;
  init?: string;
  append: boolean;
  overwrite: boolean;
  maxIter: number;
  autoContinue: boolean;
  maxSessions: number;
  maxHours: number;
  prompt: string[];
  continue?: boolean;
  resume?: string;
  noSession: boolean;
  print?: boolean;
}

// ============== Spinner 动画 ==============

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_COLORS = ['\x1b[36m', '\x1b[35m', '\x1b[34m'];

let globalSpinner: {
  stop: () => void;
  isStopped: () => boolean;
  updateText: (text: string) => void;
} | null = null;

let spinnerNewlined = false;

function startWaitingDots(): { stop: () => void; updateText: (text: string) => void; isStopped: () => boolean } {
  let frame = 0;
  let colorIdx = 0;
  let stopped = false;
  let currentText = 'Thinking...';

  const renderFrame = () => {
    if (stopped) return;
    const color = SPINNER_COLORS[colorIdx % SPINNER_COLORS.length];
    const reset = '\x1b[0m';
    const spinner = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
    // 使用 \r 回到行首，末尾不加多余空格，光标停在文本末尾
    process.stdout.write(`\r${color}${spinner}${reset} ${currentText}`);
  };

  const interval = setInterval(() => {
    frame++;
    if (frame % 10 === 0) colorIdx++;
    renderFrame();
  }, 80);

  renderFrame();

  const controller = {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      // 清除整行并将光标移回行首
      process.stdout.write('\r\x1b[K');
    },
    isStopped: () => stopped,
    updateText: (text: string) => {
      currentText = text;
    }
  };

  globalSpinner = controller;
  return controller;
}

// ============== 文件会话存储 ==============

class FileSessionStorage implements KodaXSessionStorage {
  async save(id: string, data: { messages: KodaXMessage[]; title: string; gitRoot: string }): Promise<void> {
    await fs.mkdir(KODAX_SESSIONS_DIR, { recursive: true });
    const meta = { _type: 'meta', title: data.title, id, gitRoot: data.gitRoot, createdAt: new Date().toISOString() };
    const lines = [JSON.stringify(meta), ...data.messages.map(m => JSON.stringify(m))];
    await fs.writeFile(path.join(KODAX_SESSIONS_DIR, `${id}.jsonl`), lines.join('\n'), 'utf-8');
  }

  async load(id: string): Promise<{ messages: KodaXMessage[]; title: string; gitRoot: string } | null> {
    const filePath = path.join(KODAX_SESSIONS_DIR, `${id}.jsonl`);
    if (!fsSync.existsSync(filePath)) return null;
    const lines = (await fs.readFile(filePath, 'utf-8')).trim().split('\n');
    const messages: KodaXMessage[] = [];
    let title = '', gitRoot = '';
    for (let i = 0; i < lines.length; i++) {
      const data = JSON.parse(lines[i]!);
      if (i === 0 && data._type === 'meta') { title = data.title ?? ''; gitRoot = data.gitRoot ?? ''; }
      else messages.push(data);
    }

    const currentGitRoot = await getGitRoot();
    if (currentGitRoot && gitRoot && currentGitRoot !== gitRoot) {
      console.log(chalk.yellow(`\n[Warning] Session project mismatch:`));
      console.log(`  Current:  ${currentGitRoot}`);
      console.log(`  Session:  ${gitRoot}`);
      console.log(`  Continuing anyway...\n`);
    }

    return { messages, title, gitRoot };
  }

  async list(gitRoot?: string): Promise<Array<{ id: string; title: string; msgCount: number }>> {
    await fs.mkdir(KODAX_SESSIONS_DIR, { recursive: true });
    const currentGitRoot = gitRoot ?? await getGitRoot();
    const files = (await fs.readdir(KODAX_SESSIONS_DIR)).filter(f => f.endsWith('.jsonl'));
    const sessions = [];
    for (const f of files) {
      try {
        const content = (await fs.readFile(path.join(KODAX_SESSIONS_DIR, f), 'utf-8')).trim();
        const firstLine = content.split('\n')[0];
        if (!firstLine) continue;
        const first = JSON.parse(firstLine);
        if (first._type === 'meta') {
          const sessionGitRoot = first.gitRoot ?? '';
          if (currentGitRoot && sessionGitRoot && currentGitRoot !== sessionGitRoot) continue;
          const lineCount = content.split('\n').length;
          sessions.push({ id: f.replace('.jsonl', ''), title: first.title ?? '', msgCount: lineCount - 1 });
        } else {
          const lineCount = content.split('\n').length;
          sessions.push({ id: f.replace('.jsonl', ''), title: '', msgCount: lineCount });
        }
      } catch { continue; }
    }
    return sessions.sort((a, b) => b.id.localeCompare(a.id)).slice(0, 10);
  }

  async delete(id: string): Promise<void> {
    const filePath = path.join(KODAX_SESSIONS_DIR, `${id}.jsonl`);
    if (fsSync.existsSync(filePath)) {
      await fs.unlink(filePath);
    }
  }

  async deleteAll(gitRoot?: string): Promise<void> {
    const currentGitRoot = gitRoot ?? await getGitRoot();
    const sessions = await this.list(currentGitRoot ?? undefined);
    for (const s of sessions) {
      await this.delete(s.id);
    }
  }
}

// ============== 用户确认 ==============

async function confirmAction(name: string, input: Record<string, unknown>): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    let prompt: string;
    switch (name) {
      case 'bash': prompt = `[Confirm] Execute: ${(input.command as string)?.slice(0, 60)}...? (y/n) `; break;
      case 'write': prompt = `[Confirm] Write to ${input.path}? (y/n) `; break;
      case 'edit': prompt = `[Confirm] Edit ${input.path}? (y/n) `; break;
      default: prompt = `[Confirm] Execute ${name}? (y/n) `;
    }
    rl.question(prompt, ans => { rl.close(); resolve(['y', 'yes'].includes(ans.trim().toLowerCase())); });
  });
}

// ============== CLI 事件处理器 ==============

function createCliEvents(showSessionId = true): KodaXEvents {
  let spinner: ReturnType<typeof startWaitingDots> | null = null;
  let thinkingCharCount = 0;
  let needNewline = false;  // 是否需要在 onStreamEnd 中换行

  const events: KodaXEvents = {
    onSessionStart: (info: { provider: string; sessionId: string }) => {
      if (showSessionId) {
        console.log(chalk.cyan(`[KodaX] Provider: ${info.provider} | Session: ${info.sessionId}`));
      } else {
        console.log(chalk.cyan(`[KodaX] Provider: ${info.provider}`));
      }
    },

    onTextDelta: (text: string) => {
      if (spinner) { spinner.stop(); spinner = null; }
      thinkingCharCount = 0;
      process.stdout.write(text);
      needNewline = true;  // 有文本输出，后续需要换行
    },

    onThinkingDelta: (text: string) => {
      thinkingCharCount += text.length;
      if (!spinner) spinner = startWaitingDots();
      spinner.updateText(`Thinking... (${thinkingCharCount} chars)`);
    },

    onThinkingEnd: (thinking: string) => {
      // thinking block 结束，停止 spinner 并显示摘要
      if (spinner) { spinner.stop(); spinner = null; }
      if (thinking) {
        // 移除换行符，确保 preview 是单行
        const singleLine = thinking.replace(/\n/g, ' ');
        const preview = singleLine.length > 100
          ? singleLine.slice(0, 100) + '...'
          : singleLine;
        console.log(chalk.dim(`[Thinking] ${preview}`));
      }
    },

    onToolUseStart: (tool: { name: string; id: string }) => {
      if (!spinner) {
        if (!spinnerNewlined) {
          process.stdout.write('\n');
          spinnerNewlined = true;
        }
        spinner = startWaitingDots();
      }
      spinner.updateText(`Executing ${tool.name}...`);
    },

    onToolInputDelta: (toolName: string, json: string) => {
      const charCount = json.length;
      if (spinner && !spinner.isStopped()) {
        spinner.updateText(`Receiving ${toolName}... (${charCount} chars)`);
      } else if (!spinner || spinner.isStopped()) {
        // 如果 spinner 已停止（因为 thinking 结束后），先换行再创建 spinner
        // 与 kodax.ts 行为一致
        if (!spinnerNewlined) {
          process.stdout.write('\n');
          spinnerNewlined = true;
          needNewline = false;  // 已经换行，onStreamEnd 不需要再换行
        }
        spinner = startWaitingDots();
        spinner.updateText(`Receiving ${toolName}... (${charCount} chars)`);
      }
    },

    onToolResult: (result: { id: string; name: string; content: string }) => {
      if (spinner) { spinner.stop(); spinner = null; }
      console.log(chalk.green(`[Result] ${result.content.slice(0, 300)}${result.content.length > 300 ? '...' : ''}`));
    },

    onStreamEnd: () => {
      // 停止 globalSpinner（在 input_json_delta 中可能创建的）
      if (globalSpinner && !globalSpinner.isStopped()) {
        globalSpinner.stop();
      }
      globalSpinner = null;
      spinnerNewlined = false;

      // 只有在有文本输出且没有在 onToolInputDelta 中换行时，才换行
      if (needNewline) {
        console.log();
        needNewline = false;
      }

      // 如果 spinner 在流式输出期间被停止（text_delta 处理），重启它
      if (!spinner || spinner.isStopped()) {
        spinner = startWaitingDots();
        spinner.updateText('Processing...');
      }
    },

    onIterationStart: (_iter: number, _maxIter: number) => {
      // 先停止已有的 spinner（避免多个 interval 同时运行）
      if (spinner && !spinner.isStopped()) {
        spinner.stop();
      }
      spinnerNewlined = false;
      needNewline = false;  // 重置换行标志
      console.log(chalk.magenta('\n[Assistant]'));
      // 每次迭代都重新创建 spinner（与 kodax.ts 行为一致）
      spinner = startWaitingDots();
    },

    onCompact: (tokens: number) => {
      console.log(chalk.dim(`[KodaX] Compacting context (${tokens} tokens)...`));
    },

    onRetry: (reason: string, attempt: number, maxAttempts: number) => {
      console.log(chalk.yellow(`[KodaX] Retry ${attempt}/${maxAttempts}: ${reason}`));
    },

    onComplete: () => {
      if (spinner) { spinner.stop(); spinner = null; }
      console.log(chalk.green('\n[KodaX] Done!'));
    },

    onError: (error: Error) => {
      if (spinner) { spinner.stop(); spinner = null; }
      console.log(chalk.red(`\n[Error] ${error.message}`));
    },

    onConfirm: async (tool: string, input: Record<string, unknown>) => {
      return confirmAction(tool, input);
    },
  };

  return events;
}

// ============== CLI 选项转换 ==============

function createKodaXOptions(cliOptions: CliOptions, isPrintMode = false): KodaXOptions {
  return {
    provider: cliOptions.provider,
    thinking: cliOptions.thinking,
    maxIter: cliOptions.maxIter,
    parallel: cliOptions.parallel,
    auto: cliOptions.auto,
    mode: cliOptions.mode,
    confirmTools: cliOptions.auto
      ? new Set()
      : new Set(['bash', 'write', 'edit']),
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
  sessions: () => {
    console.log(chalk.cyan('\nSession Management\n'));
    console.log(chalk.bold('Overview:'));
    console.log(chalk.dim('  KodaX automatically saves conversation sessions, allowing you to'));
    console.log(chalk.dim('  resume work later or switch between different conversations.\n'));
    console.log(chalk.bold('Options:'));
    console.log(chalk.dim('  -c, --continue       ') + 'Continue most recent conversation');
    console.log(chalk.dim('  -r, --resume [id]    ') + 'Resume session by ID (interactive picker if no ID)');
    console.log(chalk.dim('  -s, --session <op>   ') + 'Session operations: list, delete <id>, delete-all');
    console.log(chalk.dim('  --no-session         ') + 'Disable session persistence\n');
    console.log(chalk.bold('Examples:'));
    console.log(chalk.dim('  kodax                      ') + '# Start new session (interactive)');
    console.log(chalk.dim('  kodax -c                   ') + '# Continue recent conversation');
    console.log(chalk.dim('  kodax -r                   ') + '# Pick session to resume');
    console.log(chalk.dim('  kodax -r 20260219_143052   ') + '# Resume specific session');
    console.log(chalk.dim('  kodax -s list              ') + '# List all sessions');
    console.log(chalk.dim('  kodax -s delete 20260219   ') + '# Delete a session');
    console.log(chalk.dim('  kodax -p "task" --no-session') + ' # Run without saving\n');
  },
  init: () => {
    console.log(chalk.cyan('\nProject Initialization\n'));
    console.log(chalk.bold('Overview:'));
    console.log(chalk.dim('  Initialize a long-running project with auto-generated feature list.'));
    console.log(chalk.dim('  KodaX analyzes your task and creates manageable feature steps.\n'));
    console.log(chalk.bold('Options:'));
    console.log(chalk.dim('  --init <task>    ') + 'Initialize new project');
    console.log(chalk.dim('  --append         ') + 'Add features to existing project');
    console.log(chalk.dim('  --overwrite      ') + 'Replace existing feature_list.json\n');
    console.log(chalk.bold('Workflow:'));
    console.log(chalk.dim('  1. kodax --init "Build REST API"     # Generate feature_list.json'));
    console.log(chalk.dim('  2. kodax --auto-continue             # Auto-execute all features'));
    console.log(chalk.dim('  OR'));
    console.log(chalk.dim('  2. kodax                            # Interactive, use /project next'));
    console.log();
    console.log(chalk.bold('Examples:'));
    console.log(chalk.dim('  kodax --init "Create auth system"   ') + '# New project');
    console.log(chalk.dim('  kodax --init "Add tests" --append   ') + '# Add to existing');
    console.log(chalk.dim('  kodax --init "Redo" --overwrite     ') + '# Start fresh\n');
  },
  auto: () => {
    console.log(chalk.cyan('\nAuto Mode & Auto-Continue\n'));
    console.log(chalk.bold('Auto Mode (-y, --auto):'));
    console.log(chalk.dim('  Skip all confirmation prompts for file operations.'));
    console.log(chalk.dim('  Useful for trusted environments or automated workflows.\n'));
    console.log(chalk.bold('Auto-Continue (--auto-continue):'));
    console.log(chalk.dim('  Automatically run sessions until all features are complete.'));
    console.log(chalk.dim('  Works with --init for hands-off project execution.\n'));
    console.log(chalk.bold('Options:'));
    console.log(chalk.dim('  -y, --auto             ') + 'Skip confirmations');
    console.log(chalk.dim('  --auto-continue        ') + 'Auto-execute until complete');
    console.log(chalk.dim('  --max-sessions <n>     ') + 'Max sessions (default: 50)');
    console.log(chalk.dim('  --max-hours <h>        ') + 'Max runtime hours (default: 2)\n');
    console.log(chalk.bold('Examples:'));
    console.log(chalk.dim('  kodax -y "refactor code"          ') + '# No confirmations');
    console.log(chalk.dim('  kodax --init "API" --auto-continue') + '# Full automation');
    console.log(chalk.dim('  kodax --auto-continue --max-hours 4') + '# Extended run\n');
  },
  provider: () => {
    console.log(chalk.cyan('\nLLM Providers\n'));
    console.log(chalk.bold('Overview:'));
    console.log(chalk.dim('  KodaX supports multiple LLM providers. Configure via -m option'));
    console.log(chalk.dim('  or set default in ~/.kodax/config.json\n'));
    console.log(chalk.bold('Available Providers:'));
    console.log(chalk.dim('  anthropic      ') + 'Claude (Opus, Sonnet, Haiku)');
    console.log(chalk.dim('  openai         ') + 'GPT-4, GPT-3.5');
    console.log(chalk.dim('  kimi           ') + 'Moonshot Kimi');
    console.log(chalk.dim('  kimi-code      ') + 'Moonshot Kimi (code-optimized)');
    console.log(chalk.dim('  qwen           ') + 'Alibaba Qwen');
    console.log(chalk.dim('  zhipu          ') + 'Zhipu AI GLM');
    console.log(chalk.dim('  zhipu-coding   ') + 'Zhipu AI (code-optimized)\n');
    console.log(chalk.bold('Examples:'));
    console.log(chalk.dim('  kodax -m anthropic "task"     ') + '# Use Claude');
    console.log(chalk.dim('  kodax -m openai "task"        ') + '# Use GPT-4');
    console.log(chalk.dim('  /model                        ') + '# Switch in REPL (saves to config)\n');
  },
  thinking: () => {
    console.log(chalk.cyan('\nThinking Mode\n'));
    console.log(chalk.bold('Overview:'));
    console.log(chalk.dim('  Extended thinking allows the model to reason through complex'));
    console.log(chalk.dim('  problems before responding. Useful for architectural decisions,'));
    console.log(chalk.dim('  multi-step reasoning, and deep code analysis.\n'));
    console.log(chalk.bold('Options:'));
    console.log(chalk.dim('  -t, --thinking       ') + 'Enable extended thinking\n');
    console.log(chalk.bold('Examples:'));
    console.log(chalk.dim('  kodax -t "design the architecture"  ') + '# Deep reasoning');
    console.log(chalk.dim('  kodax -t -p "analyze this bug"      ') + '# Quick analysis');
    console.log(chalk.dim('  /thinking on                        ') + '# Enable in REPL\n');
  },
  team: () => {
    console.log(chalk.cyan('\nTeam Mode (Parallel Agents)\n'));
    console.log(chalk.bold('Overview:'));
    console.log(chalk.dim('  Run multiple independent tasks in parallel using separate agents.'));
    console.log(chalk.dim('  Each agent works on its task simultaneously.\n'));
    console.log(chalk.bold('Options:'));
    console.log(chalk.dim('  --team <tasks>      ') + 'Comma-separated tasks');
    console.log(chalk.dim('  -j, --parallel      ') + 'Enable parallel tool execution\n');
    console.log(chalk.bold('Examples:'));
    console.log(chalk.dim('  kodax --team "fix auth tests,update docs,clean logs"'));
    console.log(chalk.dim('  kodax --team "task1,task2" -m anthropic -t\n'));
  },
  print: () => {
    console.log(chalk.cyan('\nPrint Mode\n'));
    console.log(chalk.bold('Overview:'));
    console.log(chalk.dim('  Run a single task and exit. Useful for scripting and CI/CD.\n'));
    console.log(chalk.bold('Options:'));
    console.log(chalk.dim('  -p, --print <text>  ') + 'Run task and exit');
    console.log(chalk.dim('  --no-session        ') + 'Disable session saving\n');
    console.log(chalk.bold('Examples:'));
    console.log(chalk.dim('  kodax -p "fix the bug in auth.ts"   ') + '# Quick fix');
    console.log(chalk.dim('  kodax -p "generate tests" -t        ') + '# With thinking');
    console.log(chalk.dim('  kodax -p "task" --no-session        ') + '# Stateless run');
    console.log(chalk.dim('  echo "task" | kodax -p -            ') + '# Pipe input\n');
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
  console.log(chalk.dim('  kodax -h sessions   ') + 'Session management (-c, -r, -s options)');
  console.log(chalk.dim('  kodax -h init       ') + 'Project initialization (--init, --append)');
  console.log(chalk.dim('  kodax -h auto       ') + 'Auto mode and auto-continue');
  console.log(chalk.dim('  kodax -h provider   ') + 'LLM provider options');
  console.log(chalk.dim('  kodax -h thinking   ') + 'Extended thinking mode');
  console.log(chalk.dim('  kodax -h team       ') + 'Parallel agent execution');
  console.log(chalk.dim('  kodax -h print      ') + 'Print mode for scripting\n');
}

function showBasicHelp(): void {
  console.log('KodaX - 极致轻量化 Coding Agent\n');
  console.log('Usage: kodax [options] [prompt]');
  console.log('       kodax "your task"');
  console.log('       kodax /command_name\n');
  console.log('Options:');
  console.log('  -h, --help [TOPIC]      Show help, or detailed help for a topic');
  console.log('  -p, --print TEXT        Print mode: run single task and exit');
  console.log('  -c, --continue          Continue most recent conversation');
  console.log('  -r, --resume [id]       Resume session by ID (no id = interactive picker)');
  console.log('  -m, --provider NAME     LLM provider (anthropic, kimi, kimi-code, qwen, zhipu, openai, zhipu-coding)');
  console.log('  -t, --thinking          Enable thinking mode');
  console.log('  -y, --auto              Auto mode: skip all confirmations');
  console.log('  -s, --session ID        Session management (list, delete <id>, delete-all)');
  console.log('  --no-session            Disable session persistence (print mode only)');
  console.log('  -j, --parallel          Parallel tool execution');
  console.log('  --team TASKS            Run multiple sub-agents in parallel');
  console.log('  --init TASK             Initialize a long-running task');
  console.log('  --append                With --init: append to existing feature_list.json');
  console.log('  --overwrite             With --init: overwrite existing feature_list.json');
  console.log('  --max-iter N            Max iterations per session (default: 50)');
  console.log('  --auto-continue         Auto-continue long-running task until all features pass');
  console.log('  --max-sessions N        Max sessions for --auto-continue (default: 50)');
  console.log('  --max-hours H           Max hours for --auto-continue (default: 2.0)\n');
  console.log('Help Topics (use -h <topic>):');
  console.log('  sessions, init, auto, provider, thinking, team, print\n');
  console.log('Interactive Commands (in REPL mode):');
  console.log('  /help, /h               Show all commands');
  console.log('  /exit, /quit            Exit interactive mode');
  console.log('  /clear                  Clear conversation history');
  console.log('  /status                 Show session status');
  console.log('  /mode [code|ask]        Switch mode');
  console.log('  /sessions               List saved sessions\n');
  console.log('Examples:');
  console.log('  kodax                             # Enter interactive mode (auto-resume)');
  console.log('  kodax "create a component"        # Run single task (with session)');
  console.log('  kodax -p "quick fix" -t           # Quick task with thinking');
  console.log('  kodax -c                          # Continue recent conversation');
  console.log('  kodax -c "finish this"            # Continue with new task');
  console.log('  kodax -r                          # Pick session to resume');
  console.log('  kodax -p "task" --no-session      # Run without saving session');
  console.log('  kodax -h sessions                 # Detailed help on sessions\n');
}

async function main() {
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
    .option('-n, --new', 'Start a new session (do not auto-resume)')
    .option('-r, --resume <id>', 'Resume session by ID (no id = interactive picker)')
    .option('-m, --provider <name>', 'LLM provider')
    .option('-t, --thinking', 'Enable thinking mode')
    .option('-y, --auto', 'Auto mode: skip all confirmations')
    .option('-s, --session <id>', 'Session management: list, delete <id>, delete-all')
    .option('-j, --parallel', 'Parallel tool execution')
    .option('--no-session', 'Disable session persistence (print mode only)')
    // 长参数
    .option('--team <tasks>', 'Run multiple sub-agents in parallel (comma-separated)')
    .option('--init <task>', 'Initialize a long-running task')
    .option('--append', 'With --init: append to existing feature_list.json')
    .option('--overwrite', 'With --init: overwrite existing feature_list.json')
    .option('--max-iter <n>', 'Max iterations', '50')
    .option('--auto-continue', 'Auto-continue long-running task until all features pass')
    .option('--max-sessions <n>', 'Max sessions for --auto-continue', '50')
    .option('--max-hours <n>', 'Max hours for --auto-continue', '2')
    .allowUnknownOption(false)
    .parse();

  const opts = program.opts();
  // 加载配置文件（用于确定默认值）
  const config = loadConfig();
  // CLI 参数优先，否则用配置文件的值，最后用默认值
  const cliAuto = opts.auto === true;
  const options: CliOptions = {
    // 优先级：CLI 参数 > 配置文件 > 默认值
    provider: opts.provider ?? config.provider ?? KODAX_DEFAULT_PROVIDER,
    thinking: opts.thinking ?? config.thinking ?? false,
    auto: cliAuto ? true : (config.auto ?? false),
    session: opts.session,
    parallel: opts.parallel ?? false,
    team: opts.team,
    init: opts.init,
    append: opts.append ?? false,
    overwrite: opts.overwrite ?? false,
    maxIter: parseInt(opts.maxIter ?? '50', 10),
    autoContinue: opts.autoContinue ?? false,
    maxSessions: parseInt(opts.maxSessions ?? '50', 10),
    maxHours: parseFloat(opts.maxHours ?? '2'),
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
        console.log('  --append      Add new features to existing list (recommended)');
        console.log('  --overwrite   Start fresh (existing features will be lost)\n');
        console.log(`Example:\n  kodax --init "${options.init}" --append`);
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
    if (options.thinking) console.log(chalk.cyan(`[KodaX Team] Thinking mode enabled`));

    // 流式输出锁
    const streamLock = { locked: false, queue: [] as (() => void)[] };
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

    // SubAgent 运行
    const MAX_SUB_ROUNDS = 10;
    async function runSubAgent(taskIndex: number, task: string): Promise<{ result: string }> {
      const subEvents: KodaXEvents = {
        onTextDelta: async (text: string) => {
          await acquireStreamLock();
          const taskPreview = task.slice(0, 50) + (task.length > 50 ? '...' : '');
          console.log(chalk.cyan(`\n[Agent ${taskIndex + 1}] ${chalk.dim(taskPreview)}`));
          process.stdout.write(text);
          releaseStreamLock();
        },
        onToolResult: (result: { id: string; name: string; content: string }) => {
          console.log(chalk.green(`[Agent ${taskIndex + 1} Result] ${result.content.slice(0, 100)}...`));
        },
      };

      const kodaXOptions: KodaXOptions = {
        provider: options.provider,
        thinking: options.thinking,
        maxIter: MAX_SUB_ROUNDS,
        events: subEvents,
      };

      const result = await rateLimitedCall(() => runKodaX(kodaXOptions, task));
      return { result: result.lastText };
    }

    // 使用 stagger delay 启动所有 SubAgent
    const STAGGER_DELAY = 1.0;
    const promises = tasks.map((task, i) =>
      new Promise<{ result: string }>(resolve => {
        setTimeout(() => resolve(runSubAgent(i, task)), i * STAGGER_DELAY * 1000);
      })
    );

    const results = await Promise.all(promises);

    console.log('\n' + '='.repeat(60));
    console.log(chalk.green(`[KodaX Team] Results Summary:`));
    console.log('='.repeat(60));
    for (let i = 0; i < tasks.length; i++) {
      const result = results[i]!.result;
      console.log(chalk.yellow(`\n[Task ${i + 1}] ${tasks[i]!.slice(0, 50)}${tasks[i]!.length > 50 ? '...' : ''}`));
      if (result) {
        const preview = result.length > 300 ? result.slice(-300) : result;
        console.log(chalk.green(`[Result] ...${preview}`));
      }
    }
    console.log('\n' + '='.repeat(60));
    console.log(chalk.green(`[KodaX Team] All ${tasks.length} tasks completed!`));
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
    try {
      await runInkInteractiveMode({
        provider: kodaXOptions.provider,
        thinking: kodaXOptions.thinking,
        auto: kodaXOptions.auto,
        maxIter: kodaXOptions.maxIter,
        parallel: kodaXOptions.parallel,
        mode: kodaXOptions.mode,
        confirmTools: kodaXOptions.confirmTools,
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
