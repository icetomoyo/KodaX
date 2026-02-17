/**
 * KodaX 交互式 REPL 模式
 */

import * as readline from 'readline';
import * as childProcess from 'child_process';
import * as util from 'util';
import chalk from 'chalk';

const execAsync = util.promisify(childProcess.exec);
import {
  KodaXOptions,
  KodaXMessage,
  KodaXResult,
  runKodaX,
  estimateTokens,
  getGitRoot,
  KodaXSessionStorage,
  KodaXError,
  KodaXRateLimitError,
  KodaXProviderError,
  KODAX_DEFAULT_PROVIDER,
  KODAX_VERSION,
  loadConfig,
  getProviderModel,
} from '../kodax_core.js';
import {
  InteractiveContext,
  InteractiveMode,
  createInteractiveContext,
  touchContext,
} from './context.js';
import {
  parseCommand,
  executeCommand,
  CommandCallbacks,
  CurrentConfig,
} from './commands.js';

// 扩展的会话存储接口（增加 list 方法）
interface SessionStorage extends KodaXSessionStorage {
  list(gitRoot?: string): Promise<Array<{ id: string; title: string; msgCount: number }>>;
}

// 简单的内存会话存储（可替换为持久化存储）
class MemorySessionStorage implements SessionStorage {
  private sessions = new Map<string, { messages: KodaXMessage[]; title: string; gitRoot: string }>();

  async save(id: string, data: { messages: KodaXMessage[]; title: string; gitRoot: string }): Promise<void> {
    this.sessions.set(id, data);
  }

  async load(id: string): Promise<{ messages: KodaXMessage[]; title: string; gitRoot: string } | null> {
    return this.sessions.get(id) ?? null;
  }

  async list(_gitRoot?: string): Promise<Array<{ id: string; title: string; msgCount: number }>> {
    return Array.from(this.sessions.entries()).map(([id, data]) => ({
      id,
      title: data.title,
      msgCount: data.messages.length,
    }));
  }

  async delete(id: string): Promise<void> {
    this.sessions.delete(id);
  }

  async deleteAll(_gitRoot?: string): Promise<void> {
    this.sessions.clear();
  }
}

// REPL 选项
export interface RepLOptions extends KodaXOptions {
  storage?: SessionStorage;
}

// 运行交互式模式
export async function runInteractiveMode(options: RepLOptions): Promise<void> {
  const gitRoot = await getGitRoot() ?? undefined;
  const storage = options.storage ?? new MemorySessionStorage();

  // 加载配置（优先级：CLI参数 > 配置文件 > 默认值）
  const config = loadConfig();
  const initialProvider = options.provider ?? config.provider ?? KODAX_DEFAULT_PROVIDER;
  const initialThinking = options.thinking ?? config.thinking ?? false;
  const initialNoConfirm = options.noConfirm ?? config.noConfirm ?? false;

  // 当前配置状态
  let currentConfig: CurrentConfig = {
    provider: initialProvider,
    thinking: initialThinking,
    noConfirm: initialNoConfirm,
    mode: 'code',
  };

  const context = await createInteractiveContext({
    sessionId: options.session?.id,
    gitRoot,
  });

  // 打印启动 Banner
  printStartupBanner(currentConfig, context.mode);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    historySize: 100,
  });

  let isRunning = true;
  // 修复：确保 session.id 被设置以复用同一 session
  let currentOptions: RepLOptions = {
    ...options,
    session: {
      ...options.session,
      id: context.sessionId,
    },
  };

  // 命令回调
  const callbacks: CommandCallbacks = {
    exit: () => {
      isRunning = false;
      rl.close();
    },
    saveSession: async () => {
      if (context.messages.length > 0) {
        const title = extractTitle(context.messages);
        context.title = title;
        await storage.save(context.sessionId, {
          messages: context.messages,
          title,
          gitRoot: gitRoot ?? '',
        });
      }
    },
    loadSession: async (id: string) => {
      const loaded = await storage.load(id);
      if (loaded) {
        context.messages = loaded.messages;
        context.title = loaded.title;
        context.sessionId = id;
        console.log(chalk.green(`\n[Loaded session: ${id}]`));
        console.log(chalk.dim(`  Messages: ${loaded.messages.length}`));
        return true;
      }
      return false;
    },
    listSessions: async () => {
      const sessions = await storage.list();
      if (sessions.length === 0) {
        console.log(chalk.dim('\n[No saved sessions]'));
        return;
      }
      console.log(chalk.bold('\nRecent Sessions:\n'));
      for (const s of sessions.slice(0, 10)) {
        console.log(`  ${chalk.cyan(s.id)} ${chalk.dim(`(${s.msgCount} messages)`)} ${s.title.slice(0, 40)}`);
      }
      console.log();
    },
    clearHistory: () => {
      context.messages = [];
    },
    printHistory: () => {
      if (context.messages.length === 0) {
        console.log(chalk.dim('\n[No conversation history]'));
        return;
      }
      console.log(chalk.bold('\nConversation History:\n'));
      const recent = context.messages.slice(-20);
      for (let i = 0; i < recent.length; i++) {
        const m = recent[i]!;
        const role = chalk.cyan(m.role.padEnd(10));
        const content = typeof m.content === 'string' ? m.content : '[Complex content]';
        const preview = content.slice(0, 60).replace(/\n/g, ' ');
        const ellipsis = content.length > 60 ? '...' : '';
        console.log(`  ${(i + 1).toString().padStart(2)}. ${role} ${preview}${ellipsis}`);
      }
      console.log();
    },
    switchProvider: (provider: string) => {
      currentConfig.provider = provider;
      currentOptions.provider = provider;
    },
    setThinking: (enabled: boolean) => {
      currentConfig.thinking = enabled;
      currentOptions.thinking = enabled;
    },
    setNoConfirm: (enabled: boolean) => {
      currentConfig.noConfirm = enabled;
      currentOptions.noConfirm = enabled;
    },
    deleteSession: async (id: string) => {
      await storage.delete?.(id);
    },
    deleteAllSessions: async () => {
      await storage.deleteAll?.();
    },
  };

  // 处理 Ctrl+C
  rl.on('SIGINT', async () => {
    console.log(chalk.dim('\n\n[Press /exit to quit]'));
    rl.prompt();
  });

  // 主循环
  while (isRunning) {
    const prompt = getPrompt(context.mode, currentConfig);
    const input = await askInput(rl, prompt);

    if (!isRunning) break;

    const trimmed = input.trim();
    if (!trimmed) continue;

    touchContext(context);

    // 处理命令
    const parsed = parseCommand(trimmed);
    if (parsed) {
      await executeCommand(parsed, context, callbacks, currentConfig);
      continue;
    }

    // 处理特殊语法
    const processed = await processSpecialSyntax(trimmed);

    // Shell 命令处理：Warp 风格
    // - 成功执行 → 跳过（结果已显示）
    // - 空命令 → 跳过（用户知道）
    // - 失败/错误 → 发送给 LLM（需要智能帮助）
    if (trimmed.startsWith('!')) {
      if (processed.startsWith('[Shell command executed:') || processed.startsWith('[Shell:')) {
        continue;
      }
    }

    // 添加用户消息到上下文
    context.messages.push({ role: 'user', content: processed });

    // 运行 Agent
    try {
      const result = await runAgentRound(currentOptions, context, processed);

      // 更新上下文中的消息（runKodaX 返回完整的消息列表）
      context.messages = result.messages;

      // 自动保存
      if (context.messages.length > 0) {
        const title = extractTitle(context.messages);
        context.title = title;
        await storage.save(context.sessionId, {
          messages: context.messages,
          title,
          gitRoot: gitRoot ?? '',
        });
      }
    } catch (err) {
      // 处理不同类型的错误
      const error = err instanceof Error ? err : new Error(String(err));

      // 移除失败的用户消息（避免重复）
      context.messages.pop();

      // 根据错误类型提供不同的恢复建议
      if (error.message.includes('rate limit') || error.message.includes('Rate limit')) {
        console.log(chalk.yellow(`\n[Rate Limit] ${error.message}`));
        console.log(chalk.dim('Suggestion: Wait a moment and try again, or switch provider with /mode\n'));
      } else if (error.message.includes('API key') || error.message.includes('not configured')) {
        console.log(chalk.red(`\n[Configuration Error] ${error.message}`));
        console.log(chalk.dim('Suggestion: Set the required API key environment variable\n'));
      } else if (error.message.includes('network') || error.message.includes('ECONNREFUSED') || error.message.includes('ETIMEDOUT')) {
        console.log(chalk.red(`\n[Network Error] ${error.message}`));
        console.log(chalk.dim('Suggestion: Check your internet connection and try again\n'));
      } else if (error.message.includes('token') || error.message.includes('context too long')) {
        console.log(chalk.yellow(`\n[Context Error] ${error.message}`));
        console.log(chalk.dim('Suggestion: Use /clear to start a fresh conversation\n'));
      } else {
        console.log(chalk.red(`\n[Error] ${error.message}`));
        console.log(chalk.dim('Your message was not sent. Please try again.\n'));
      }
    }
  }
}

// 获取提示符
function getPrompt(mode: InteractiveMode, config: CurrentConfig): string {
  const modeColor = mode === 'ask' ? chalk.yellow : chalk.green;
  const model = getProviderModel(config.provider) ?? config.provider;
  const thinkingFlag = config.thinking ? chalk.cyan('[thinking]') : '';
  const autoFlag = config.noConfirm ? chalk.cyan('[auto]') : '';
  const flags = [thinkingFlag, autoFlag].filter(Boolean).join('');
  return modeColor(`kodax:${mode} (${config.provider}:${model})${flags}> `);
}

// 读取输入
function askInput(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

// 处理特殊语法
export async function processSpecialSyntax(input: string): Promise<string> {
  // @file 语法：添加文件内容到上下文
  const fileRefs = input.match(/@[\w./-]+/g);
  if (fileRefs) {
    for (const ref of fileRefs) {
      const filePath = ref.slice(1); // 移除 @
      // 这里可以读取文件并添加到上下文
      // 暂时保留原样，后续实现
    }
  }

  // !command 语法：执行 shell 命令
  if (input.startsWith('!')) {
    const command = input.slice(1).trim();
    if (!command) {
      return '[Shell: No command provided]';
    }

    try {
      console.log(chalk.dim(`\n[Executing: ${command}]`));
      const { stdout, stderr } = await execAsync(command, {
        maxBuffer: 1024 * 1024, // 1MB buffer
        timeout: 30000, // 30 second timeout
      });

      let result = '';
      if (stdout) {
        result += stdout;
      }
      if (stderr) {
        result += (result ? '\n' : '') + `[stderr] ${stderr}`;
      }

      // Truncate if too long
      const maxLength = 8000;
      if (result.length > maxLength) {
        result = result.slice(0, maxLength) + '\n...[output truncated]';
      }

      console.log(chalk.dim(result || '[No output]'));
      console.log(); // Add blank line

      return `[Shell command executed: ${command}]\n\nOutput:\n${result || '(no output)'}`;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      let errorMessage = err.message;

      // Truncate error if too long
      const maxLength = 4000;
      if (errorMessage.length > maxLength) {
        errorMessage = errorMessage.slice(0, maxLength) + '\n...[error truncated]';
      }

      console.log(chalk.red(`\n[Shell Error: ${errorMessage}]`));
      console.log(); // Add blank line

      return `[Shell command failed: ${command}]\n\nError: ${errorMessage}`;
    }
  }

  return input;
}

// 运行一轮 Agent
async function runAgentRound(
  options: KodaXOptions,
  context: InteractiveContext,
  prompt: string
): Promise<KodaXResult> {
  // 创建事件回调
  const events = options.events ?? {};

  // 传递已有的对话历史，实现多轮对话
  return runKodaX(
    {
      ...options,
      events,
      session: {
        ...options.session,
        initialMessages: context.messages,  // 传递已有消息
      },
    },
    prompt
  );
}

// 从消息中提取标题
function extractTitle(messages: KodaXMessage[]): string {
  const firstUser = messages.find(m => m.role === 'user');
  if (firstUser) {
    const content = typeof firstUser.content === 'string'
      ? firstUser.content
      : '';
    return content.slice(0, 50) + (content.length > 50 ? '...' : '');
  }
  return 'Untitled Session';
}

// 打印启动 Banner
function printStartupBanner(config: CurrentConfig, mode: string): void {
  const model = getProviderModel(config.provider) ?? config.provider;

  const logo = chalk.cyan(`
   █████╗ ██╗     ██████╗  ██████╗ ███████╗ ██████╗ ██████╗
  ██╔══██╗██║     ██╔══██╗██╔════╝ ██╔════╝██╔═══██╗██╔══██╗
  ███████║██║     ██████╔╝██║  ███╗█████╗  ██║   ██║██████╔╝
  ██╔══██║██║     ██╔══██╗██║   ██║██╔══╝  ██║   ██║██╔══██╗
  ██║  ██║███████╗██║  ██║╚██████╔╝███████╗╚██████╔╝██║  ██║
  ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝ ╚═════╝ ╚═╝  ╚═╝`);

  console.log(chalk.cyan('\n') + logo);
  console.log(chalk.white(`\n  KodaX v${KODAX_VERSION}  |  AI Coding Agent  |  ${config.provider}:${model}`));
  console.log(chalk.dim('\n  ────────────────────────────────────────────────────────'));
  console.log(chalk.dim('  Mode: ') + chalk.cyan(mode) + chalk.dim('  |  Thinking: ') + (config.thinking ? chalk.green('on') : chalk.dim('off')) + chalk.dim('  |  Auto: ') + (config.noConfirm ? chalk.green('on') : chalk.dim('off')));
  console.log(chalk.dim('  ────────────────────────────────────────────────────────\n'));

  console.log(chalk.dim('  Quick tips:'));
  console.log(chalk.cyan('    /help      ') + chalk.dim('Show all commands'));
  console.log(chalk.cyan('    /mode      ') + chalk.dim('Switch code/ask mode'));
  console.log(chalk.cyan('    /clear     ') + chalk.dim('Clear conversation'));
  console.log(chalk.cyan('    @file      ') + chalk.dim('Add file to context'));
  console.log(chalk.cyan('    !cmd       ') + chalk.dim('Run shell command\n'));
}
