/**
 * KodaX 交互式 REPL 模式
 */

import * as readline from 'readline';
import chalk from 'chalk';
import {
  KodaXOptions,
  KodaXMessage,
  KodaXResult,
  runKodaX,
  estimateTokens,
  getGitRoot,
  KodaXSessionStorage,
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
}

// REPL 选项
export interface RepLOptions extends KodaXOptions {
  storage?: SessionStorage;
}

// 运行交互式模式
export async function runInteractiveMode(options: RepLOptions): Promise<void> {
  const gitRoot = await getGitRoot() ?? undefined;
  const storage = options.storage ?? new MemorySessionStorage();

  const context = await createInteractiveContext({
    sessionId: options.session?.id,
    gitRoot,
  });

  console.log(chalk.cyan('\n[KodaX Interactive Mode]'));
  console.log(chalk.dim('Type /help for commands, /exit to quit.\n'));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    historySize: 100,
  });

  let isRunning = true;
  let currentOptions = { ...options };

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
  };

  // 处理 Ctrl+C
  rl.on('SIGINT', async () => {
    console.log(chalk.dim('\n\n[Press /exit to quit]'));
    rl.prompt();
  });

  // 主循环
  while (isRunning) {
    const prompt = getPrompt(context.mode);
    const input = await askInput(rl, prompt);

    if (!isRunning) break;

    const trimmed = input.trim();
    if (!trimmed) continue;

    touchContext(context);

    // 处理命令
    const parsed = parseCommand(trimmed);
    if (parsed) {
      await executeCommand(parsed, context, callbacks);
      continue;
    }

    // 处理特殊语法
    const processed = await processSpecialSyntax(trimmed);

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
      const error = err instanceof Error ? err : new Error(String(err));
      console.log(chalk.red(`\n[Error] ${error.message}`));
    }
  }
}

// 获取提示符
function getPrompt(mode: InteractiveMode): string {
  const modeColor = mode === 'ask' ? chalk.yellow : chalk.green;
  return modeColor(`kodax:${mode}> `);
}

// 读取输入
function askInput(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

// 处理特殊语法
async function processSpecialSyntax(input: string): Promise<string> {
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
    // 暂时保留原样，后续实现
    return input;
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
