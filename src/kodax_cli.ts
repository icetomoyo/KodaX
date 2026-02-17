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
import { fileURLToPath } from 'url';

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
  KODAX_DIR,
  KODAX_SESSIONS_DIR,
  KODAX_DEFAULT_PROVIDER,
  KODAX_FEATURES_FILE,
  KODAX_PROGRESS_FILE,
  getGitRoot,
  getFeatureProgress,
  checkAllFeaturesComplete,
  checkPromiseSignal,
  rateLimitedCall,
  getProvider,
  KODAX_TOOLS,
  loadConfig,
} from './kodax_core.js';

import { runInteractiveMode } from './interactive/index.js';

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
  confirm?: string;
  auto: boolean;
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
  noInteractive: boolean;
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

function createCliEvents(): KodaXEvents {
  let spinner: ReturnType<typeof startWaitingDots> | null = null;
  let thinkingCharCount = 0;
  let needNewline = false;  // 是否需要在 onStreamEnd 中换行

  const events: KodaXEvents = {
    onSessionStart: (info: { provider: string; sessionId: string }) => {
      console.log(chalk.cyan(`[KodaX] Provider: ${info.provider} | Session: ${info.sessionId}`));
    },

    onTextDelta: (text: string) => {
      if (spinner) { spinner.stop(); spinner = null; }
      thinkingCharCount = 0;
      process.stdout.write(text);
      needNewline = true;  // 有文本输出，后续需要换行
    },

    onThinkingDelta: (text: string, _charCount: number) => {
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

function createKodaXOptions(cliOptions: CliOptions): KodaXOptions {
  return {
    provider: cliOptions.provider,
    thinking: cliOptions.thinking,
    maxIter: cliOptions.maxIter,
    parallel: cliOptions.parallel,
    auto: cliOptions.auto,
    confirmTools: cliOptions.auto
      ? new Set()
      : cliOptions.confirm
        ? new Set(cliOptions.confirm.split(','))
        : new Set(['bash', 'write', 'edit']),
    session: cliOptions.session ? {
      id: cliOptions.session === 'resume' ? undefined : cliOptions.session,
      resume: cliOptions.session === 'resume',
      storage: new FileSessionStorage(),
    } : undefined,
    events: createCliEvents(),
  };
}

// ============== --init 提示词构建 ==============

function buildInitPrompt(task: string, currentDate: string, currentOS: string): string {
  return `Initialize a long-running project: ${task}

**Current Context:**
- Date: ${currentDate}
- OS: ${currentOS}

Create these files in the current directory:

1. **feature_list.json** - A list of features for this project.

**What is a Feature?**
A feature is a COMPLETE, TESTABLE functionality that can be finished in 1-2 sessions.
- Code size: ~50-300 lines per feature
- Time: ~10-60 minutes of actual development work
- Testable: Has clear "done" criteria

**Feature Count Guidelines (use your judgment, not hard limits):**
- **Simple task** (single file, display page, config): 1-3 features
- **Medium task** (multi-page site, CLI tool, small API): 3-8 features
- **Complex task** (full app with frontend + backend + database): 8-15 features

**DO:**
- Split by user-facing features (page A, page B, API group C)
- Each feature = something a user can actually USE

**DO NOT:**
- Split by technical layers (HTML → CSS → JS → content)
- Create features smaller than ~50 lines of code
- Create features larger than ~300 lines of code

**Examples of GOOD features:**
- "User authentication (register, login, logout)" - complete system
- "Todo list page with add/delete/mark-done" - complete page functionality
- "REST API for todos (GET, POST, PUT, DELETE)" - complete API resource

**Examples of BAD features:**
- "Add HTML structure" - too small, technical layer
- "Create the entire application" - too large
- "Add button styling" - trivial, not a feature

Format:
{
  "features": [
    {
      "description": "Feature description (clear and testable)",
      "steps": ["step 1", "step 2", "step 3"],
      "passes": false
    }
  ]
}

2. **PROGRESS.md** - A progress log file:
   # Progress Log

   ## ${currentDate} - Project Initialization

   ### Completed
   - [x] Project initialized

   ### Next Steps
   - [ ] First feature to implement

After creating files, make an initial git commit:
   git add .
   git commit -m "Initial commit: project setup for ${task.slice(0, 50)}"
`;
}

// ============== 主函数 ==============

async function main() {
  const program = new Command()
    .name('kodax')
    .description('KodaX - 极致轻量化 Coding Agent')
    .version(version)
    .argument('[prompt...]', 'Your task (optional, enters interactive mode if not provided)')
    // 短参数支持
    .option('-p, --prompt <text>', 'Task prompt (alternative to positional argument)')
    .option('-m, --provider <name>', 'LLM provider')
    .option('-t, --thinking', 'Enable thinking mode')
    .option('-c, --confirm <tools>', 'Tools requiring confirmation')
    .option('-y, --no-confirm', 'Disable confirmations (YOLO mode)')
    .option('-s, --session <id>', 'Session: resume, list, or ID')
    .option('-j, --parallel', 'Parallel tool execution')
    // 长参数
    .option('--team <tasks>', 'Run multiple sub-agents in parallel (comma-separated)')
    .option('--init <task>', 'Initialize a long-running task')
    .option('--append', 'With --init: append to existing feature_list.json')
    .option('--overwrite', 'With --init: overwrite existing feature_list.json')
    .option('--max-iter <n>', 'Max iterations', '50')
    .option('--auto-continue', 'Auto-continue long-running task until all features pass')
    .option('--max-sessions <n>', 'Max sessions for --auto-continue', '50')
    .option('--max-hours <n>', 'Max hours for --auto-continue', '2')
    .option('--single-shot', 'Single-shot mode (no interactive, show help if no task)')
    .allowUnknownOption(false)
    .parse();

  const opts = program.opts();
  // 加载配置文件（用于确定默认值）
  const config = loadConfig();
  // CLI 参数优先，否则用配置文件的值，最后用默认值
  const cliAuto = opts.noConfirm === true || opts.confirm === false;
  const options: CliOptions = {
    // 优先级：CLI 参数 > 配置文件 > 默认值
    provider: opts.provider ?? config.provider ?? KODAX_DEFAULT_PROVIDER,
    thinking: opts.thinking ?? config.thinking ?? false,
    auto: cliAuto ? true : (config.auto ?? false),
    session: opts.session,
    parallel: opts.parallel ?? false,
    confirm: opts.confirm,
    team: opts.team,
    init: opts.init,
    append: opts.append ?? false,
    overwrite: opts.overwrite ?? false,
    maxIter: parseInt(opts.maxIter ?? '50', 10),
    autoContinue: opts.autoContinue ?? false,
    maxSessions: parseInt(opts.maxSessions ?? '50', 10),
    maxHours: parseFloat(opts.maxHours ?? '2'),
    prompt: opts.prompt ? [opts.prompt] : program.args,
    noInteractive: opts.singleShot ?? false,
  };

  // 会话列表
  if (options.session === 'list') {
    const storage = new FileSessionStorage();
    const sessions = await storage.list();
    console.log(sessions.length ? 'Sessions:\n' + sessions.map(s => `  ${s.id} [${s.msgCount}] ${s.title}`).join('\n') : 'No sessions.');
    return;
  }

  let userPrompt = options.prompt.join(' ');

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
      });

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
        const kodaXOptions = createKodaXOptions(options);
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

  // 无 prompt 且未禁用交互式模式 → 进入交互式
  if (!userPrompt && !options.init && !options.noInteractive) {
    const kodaXOptions = createKodaXOptions(options);
    // 传递 FileSessionStorage 以支持会话持久化
    await runInteractiveMode({
      ...kodaXOptions,
      storage: new FileSessionStorage(),
    });
    return;
  }

  // 显示帮助（仅在 --no-interactive 且无任务时）
  if (!userPrompt && !options.init && options.noInteractive) {
    console.log('KodaX - 极致轻量化 Coding Agent\n');
    console.log('Usage: kodax [options] [prompt]');
    console.log('       kodax -p "your task"');
    console.log('       kodax /command_name\n');
    console.log('Options:');
    console.log('  -p, --prompt TEXT      Task prompt');
    console.log('  -m, --provider NAME    LLM provider (anthropic, kimi, kimi-code, qwen, zhipu, openai, zhipu-coding)');
    console.log('  -t, --thinking         Enable thinking mode');
    console.log('  -c, --confirm TOOLS    Tools requiring confirmation');
    console.log('  -y, --no-confirm       Enable auto mode (skip all confirmations)');
    console.log('  -s, --session ID       Session management (resume, list, or ID)');
    console.log('  -j, --parallel         Parallel tool execution');
    console.log('  --team TASKS           Run multiple sub-agents in parallel');
    console.log('  --init TASK            Initialize a long-running task');
    console.log('  --append               With --init: append to existing feature_list.json');
    console.log('  --overwrite            With --init: overwrite existing feature_list.json');
    console.log('  --max-iter N           Max iterations per session (default: 50)');
    console.log('  --auto-continue        Auto-continue long-running task until all features pass');
    console.log('  --max-sessions N       Max sessions for --auto-continue (default: 50)');
    console.log('  --max-hours H          Max hours for --auto-continue (default: 2.0)');
    console.log('  --single-shot          Single-shot mode (show help if no task)\n');
    console.log('Interactive Commands (in REPL mode):');
    console.log('  /help, /h              Show all commands');
    console.log('  /exit, /quit           Exit interactive mode');
    console.log('  /clear                 Clear conversation history');
    console.log('  /status                Show session status');
    console.log('  /mode [code|ask]       Switch mode');
    console.log('  /sessions              List saved sessions\n');
    console.log('Examples:');
    console.log('  kodax                            # Enter interactive mode (default)');
    console.log('  kodax "create a component"       # Run single task');
    console.log('  kodax -p "quick fix" -t          # Quick task with thinking');
    console.log('  kodax -m kimi-code -t "task"     # Use Kimi Code with thinking\n');
    return;
  }

  // 正常运行
  const kodaXOptions = createKodaXOptions(options);
  await runKodaX(kodaXOptions, userPrompt);
}

main().catch(e => { console.error(chalk.red(`[Error] ${e.message}`)); process.exit(1); });
