/**
 * KodaX 交互式 REPL 模式
 */

import * as readline from 'readline';
import * as childProcess from 'child_process';
import * as util from 'util';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import chalk from 'chalk';

const execAsync = util.promisify(childProcess.exec);

// 导出 Ink UI 版本的入口
export { runInkInteractiveMode } from '../ui/index.js';
export type { InkREPLOptions } from '../ui/index.js';
import {
  KodaXOptions,
  KodaXMessage,
  KodaXResult,
  runKodaX,
  estimateTokens,
  KodaXSessionStorage,
  KodaXError,
  KodaXRateLimitError,
  KodaXProviderError,
  KODAX_DEFAULT_PROVIDER,
  generateSessionId,
} from '../core/index.js';
import { getGitRoot, loadConfig, getProviderModel, KODAX_VERSION } from '../cli/utils.js';
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
import { runWithPlanMode } from '../cli/plan-mode.js';
import { detectAndShowProjectHint } from './project-commands.js';
import {
  confirmToolExecution,
  getTerminalWidth,
} from './prompts.js';
import {
  StatusBar,
  createStatusBarState,
  supportsStatusBar,
  formatTokenCount,
} from './status-bar.js';
import {
  createCompleter,
  getCompletionSuggestions,
  type Completion,
} from './autocomplete.js';
import { getCurrentTheme, setTheme, type Theme } from './themes.js';

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
  const initialAuto = options.auto ?? config.auto ?? false;

  // 应用主题 (使用默认 dark 主题)
  // TODO: 从配置文件读取主题设置
  const theme = getCurrentTheme();

  // 当前配置状态
  let currentConfig: CurrentConfig = {
    provider: initialProvider,
    thinking: initialThinking,
    auto: initialAuto,
    mode: 'code',
  };

  // Plan mode 状态
  let planMode = false;

  // Esc+Esc 编辑状态
  let lastEscTime = 0;
  let lastUserMessage = '';
  let pendingEdit = false;  // 标记是否需要在外部编辑器中编辑上一条消息
  const ESC_DOUBLE_PRESS_MS = 500;

  const context = await createInteractiveContext({
    sessionId: options.session?.id,
    gitRoot,
  });

  // 打印启动 Banner
  printStartupBanner(currentConfig, currentConfig.mode ?? 'code');

  // 检测并显示项目提示
  await detectAndShowProjectHint();

  // 创建自动补全器
  const completer = createCompleter(gitRoot ?? process.cwd());

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdout.isTTY ?? true,
    historySize: 100,
    completer: (line: string, callback: (err: null | Error, result: [string[], string]) => void) => {
      // 异步补全
      completer(line).then(result => {
        callback(null, result);
      }).catch(() => {
        callback(null, [[], line]);
      });
    },
  });

  // 初始化状态栏 (如果终端支持)
  const model = getProviderModel(currentConfig.provider) ?? currentConfig.provider;
  let statusBar: StatusBar | null = null;
  if (supportsStatusBar()) {
    statusBar = new StatusBar(createStatusBarState(
      context.sessionId,
      currentConfig.mode ?? 'code',
      currentConfig.provider,
      model
    ));
  }

  // 键盘快捷键状态 (Phase 2 将实际使用)
  // let showToolOutput = true;
  // let showTodoList = false;

  // 键盘快捷键映射
  const KEYBOARD_SHORTCUTS_HELP = `
Keyboard Shortcuts:
  Tab       Auto-complete (@files, /commands)
  Esc+Esc   Edit last message
  Ctrl+E    Open external editor
  Ctrl+R    Search command history (built-in)
  Ctrl+C    Cancel current input
  Ctrl+D    Exit REPL`;

  // 打印快捷键帮助 (可在 /help 命令中调用)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _printKeyboardShortcuts = (): void => {
    console.log(chalk.dim(KEYBOARD_SHORTCUTS_HELP));
  };

  // 监听键盘事件 (用于 Esc+Esc 和 Ctrl+E)
  if (process.stdin.isTTY) {
    process.stdin.on('keypress', (char: string | undefined, key: readline.Key | undefined) => {
      if (!key) return;

      // Esc+Esc 检测
      if (key.name === 'escape') {
        const now = Date.now();
        if (now - lastEscTime < ESC_DOUBLE_PRESS_MS && lastUserMessage) {
          // 双击 Esc - 标记需要在编辑器中编辑上一条消息
          pendingEdit = true;
          console.log(chalk.dim('\n[Opening editor with last message...]'));
          // 关闭当前 readline 问题以便主循环可以处理编辑
          rl.pause();
        }
        lastEscTime = now;
      }
    });
  }

  let isRunning = true;
  // 修复：确保 session.id 被设置以复用同一 session
  let currentOptions: RepLOptions = {
    ...options,
    mode: currentConfig.mode,
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
    setAuto: (enabled: boolean) => {
      currentConfig.auto = enabled;
      currentOptions.auto = enabled;
    },
    deleteSession: async (id: string) => {
      await storage.delete?.(id);
    },
    deleteAllSessions: async () => {
      await storage.deleteAll?.();
    },
    setPlanMode: (enabled: boolean) => {
      planMode = enabled;
    },
    createKodaXOptions: () => {
      return {
        ...currentOptions,
        provider: currentConfig.provider,
        thinking: currentConfig.thinking,
        auto: currentConfig.auto,
        mode: currentConfig.mode,
        events: {
          ...currentOptions.events,
          onConfirm: async (tool: string, input: Record<string, unknown>) => {
            // 使用增强的确认提示
            return confirmToolExecution(rl, tool, input, {
              isOutsideProject: input._outsideProject === true,
              reason: input._reason as string | undefined,
            });
          },
        },
      };
    },
    // 传递 readline 接口供需要用户交互的命令使用
    readline: rl,
  };

  // 处理 Ctrl+C
  rl.on('SIGINT', async () => {
    console.log(chalk.dim('\n\n[Press /exit to quit]'));
    rl.prompt();
  });

  // 处理退出时清理状态栏
  const cleanup = () => {
    statusBar?.hide();
    rl.close();
  };

  process.on('exit', cleanup);
  process.on('SIGTERM', cleanup);

  // 主循环
  while (isRunning) {
    // 检查是否需要编辑上一条消息 (Esc+Esc 触发)
    if (pendingEdit && lastUserMessage) {
      pendingEdit = false;
      rl.resume();  // 恢复 readline
      // 在外部编辑器中打开上一条消息
      const edited = await openExternalEditor(lastUserMessage);
      if (edited && edited.trim() && edited !== lastUserMessage) {
        // 如果有修改，作为新输入处理
        console.log(chalk.dim(`\n[Edited message ready to send]`));
        // 直接处理编辑后的内容，跳过 askInput
        const trimmed = edited.trim();
        touchContext(context);

        // 处理命令
        const parsed = parseCommand(trimmed);
        if (parsed) {
          await executeCommand(parsed, context, callbacks, currentConfig);
          continue;
        }

        // 处理特殊语法并更新 lastUserMessage
        const processed = await processSpecialSyntax(trimmed);
        context.messages.push({ role: 'user', content: processed });
        lastUserMessage = trimmed;
        statusBar?.update({ messageCount: context.messages.length });

        // 运行 agent (复制主循环逻辑)
        try {
          currentOptions.mode = currentConfig.mode;
          if (planMode) {
            await runWithPlanMode(processed, {
              ...currentOptions,
              provider: currentConfig.provider,
              thinking: currentConfig.thinking,
              auto: currentConfig.auto,
              mode: currentConfig.mode,
            });
          } else {
            const result = await runKodaX(
              {
                ...currentOptions,
                provider: currentConfig.provider,
                thinking: currentConfig.thinking,
                auto: currentConfig.auto,
                mode: currentConfig.mode,
                session: { ...currentOptions.session, initialMessages: context.messages },
              },
              processed
            );
            context.messages = result.messages;

            // 自动保存
            if (context.messages.length > 0) {
              const title = extractTitle(context.messages);
              context.title = title;
              await storage.save(context.sessionId, {
                messages: context.messages,
                title,
                gitRoot: context.gitRoot ?? '',
              });
            }
          }
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          context.messages.pop();
          console.log(chalk.red(`\n[Error] ${error.message}`));
        }
        continue;
      } else if (edited === lastUserMessage) {
        console.log(chalk.dim('\n[No changes made, continuing...]'));
      }
    }

    const prompt = getPrompt(currentConfig.mode ?? 'code', currentConfig, planMode);
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

    // 保存最后一条用户消息 (用于 Esc+Esc 编辑)
    lastUserMessage = trimmed;

    // 更新状态栏消息数量
    statusBar?.update({ messageCount: context.messages.length });

    // 同步当前模式到 options
    currentOptions.mode = currentConfig.mode;

    // 如果启用了 Plan Mode，使用计划模式执行
    if (planMode) {
      try {
        await runWithPlanMode(processed, {
          ...currentOptions,
          provider: currentConfig.provider,
          thinking: currentConfig.thinking,
          auto: currentConfig.auto,
          mode: currentConfig.mode,
        });
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        console.log(chalk.red(`\n[Plan Mode Error] ${error.message}`));
      }
      continue;
    }

    // 运行 Agent
    try {
      const result = await runAgentRound(currentOptions, context, processed);

      // 更新上下文中的消息（runKodaX 返回完整的消息列表）
      context.messages = result.messages;

      // 更新状态栏
      statusBar?.update({
        messageCount: context.messages.length,
      });

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

// 获取提示符 (响应式，使用主题颜色)
function getPrompt(mode: InteractiveMode, config: CurrentConfig, planMode: boolean): string {
  const theme = getCurrentTheme();
  const modeColor = mode === 'ask' ? chalk.hex(theme.colors.warning) : chalk.hex(theme.colors.success);
  const model = getProviderModel(config.provider) ?? config.provider;
  const width = getTerminalWidth();

  // 根据终端宽度决定提示符详细程度
  if (width < 60) {
    // 窄终端：最简提示符
    const modeIndicator = mode === 'ask' ? '?' : theme.symbols.prompt;
    return modeColor(`${modeIndicator} `);
  } else if (width < 100) {
    // 中等宽度：简短提示符
    const flagChar = planMode ? 'P' : (config.thinking ? 'T' : (config.auto ? 'A' : ''));
    const flagPart = flagChar ? chalk.hex(theme.colors.dim)(`[${flagChar}]`) : '';
    return modeColor(`kodax:${mode}${flagPart}> `);
  }

  // 宽终端：完整提示符
  const thinkingFlag = config.thinking ? chalk.hex(theme.colors.info)('[thinking]') : '';
  const autoFlag = config.auto ? chalk.hex(theme.colors.success)('[auto]') : '';
  const planFlag = planMode ? chalk.hex(theme.colors.accent)('[plan]') : '';
  const flags = [thinkingFlag, autoFlag, planFlag].filter(Boolean).join('');
  return modeColor(`kodax:${mode} (${config.provider}:${model})${flags}> `);
}

// 读取输入 (支持多行和外部编辑器)
async function askInput(rl: readline.Interface, prompt: string): Promise<string> {
  const theme = getCurrentTheme();
  const lines: string[] = [];

  // 读取第一行
  const firstLine = await new Promise<string>((resolve) => {
    rl.question(prompt, resolve);
  });

  // 检查是否要打开外部编辑器 (Ctrl+E 会被输入为特殊字符)
  if (firstLine === '\x05' || firstLine.toLowerCase() === '/e') {
    const edited = await openExternalEditor(lines.join('\n'));
    return edited;
  }

  lines.push(firstLine);

  // 检测是否需要多行输入
  // 1. 以 \ 结尾 (续行符)
  // 2. 括号/引号未闭合
  while (needsContinuation(lines.join('\n'))) {
    const continuationPrompt = chalk.hex(theme.colors.dim)('... ');
    const nextLine = await new Promise<string>((resolve) => {
      rl.question(continuationPrompt, resolve);
    });
    lines.push(nextLine);
  }

  // 处理续行符：移除行尾的 \
  const result = lines.join('\n').replace(/\\\n/g, '\n');
  return result;
}

// 打开外部编辑器
// 安全说明: 使用 spawnSync 代替 execSync 避免命令注入
async function openExternalEditor(initialContent: string): Promise<string> {
  // 使用 os.tmpdir() 获取系统安全的临时目录
  const tmpDir = path.join(os.tmpdir(), 'kodax');
  // 使用随机后缀避免文件名冲突
  const tmpFile = path.join(tmpDir, `input-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);

  try {
    // 确保临时目录存在
    await fs.promises.mkdir(tmpDir, { recursive: true });
    await fs.promises.writeFile(tmpFile, initialContent, 'utf-8');

    let editor = process.env.EDITOR ?? process.env.VISUAL ??
      (process.platform === 'win32' ? 'notepad.exe' : 'nano');

    // 基本的安全检查: 验证编辑器名称不包含路径分隔符或可疑字符
    // 这可以防止一些明显的注入尝试，但不会阻止所有攻击
    // spawnSync 本身不通过 shell 执行，所以大部分命令注入已被阻止
    if (editor.includes('/') || editor.includes('\\') || editor.includes('&&') || editor.includes('|')) {
      // 如果编辑器路径包含特殊字符，尝试提取基本名称
      const baseName = path.basename(editor);
      console.log(chalk.yellow(`\n[Security] Editor path sanitized: ${baseName}`));
      editor = baseName;
    }

    console.log(chalk.dim(`\n[Opening editor: ${editor}]`));

    // Windows notepad 特殊提示
    const isWindowsNotepad = process.platform === 'win32' &&
      (editor.toLowerCase() === 'notepad' || editor.toLowerCase() === 'notepad.exe');

    if (isWindowsNotepad) {
      console.log(chalk.dim('Note: Please close Notepad manually after editing to continue.\n'));
    } else {
      console.log(chalk.dim('Save and close the editor to continue...\n'));
    }

    // 使用 spawnSync 代替 execSync - 避免 shell 命令注入
    // spawnSync 直接执行程序，参数作为数组传递，不经过 shell 解析
    childProcess.spawnSync(editor, [tmpFile], {
      stdio: 'inherit',
      timeout: 300000, // 5 minutes timeout
      shell: false,    // 明确禁用 shell
    });

    // 读取编辑后的内容
    const content = await fs.promises.readFile(tmpFile, 'utf-8');
    return content.trim();
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.log(chalk.red(`\n[Editor Error] ${err.message}`));
    return initialContent;
  } finally {
    // 清理临时文件
    try {
      await fs.promises.unlink(tmpFile);
    } catch {
      // 忽略清理错误
    }
  }
}

// 检测是否需要续行
function needsContinuation(input: string): boolean {
  // 以 \ 结尾（续行符）
  if (input.endsWith('\\') && !input.endsWith('\\\\')) {
    return true;
  }

  // 检测未闭合的括号
  const openBrackets = { '(': 0, '[': 0, '{': 0 };
  const closeBrackets = { ')': '(', ']': '[', '}': '{' };
  let inString: string | null = null;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    // 处理字符串
    if ((char === '"' || char === "'" || char === '`') && input[i - 1] !== '\\') {
      if (inString === char) {
        inString = null;
      } else if (inString === null) {
        inString = char;
      }
      continue;
    }

    // 在字符串内不检测括号
    if (inString) continue;

    // 检测括号
    if (char in openBrackets) {
      openBrackets[char as keyof typeof openBrackets]++;
    } else if (char in closeBrackets) {
      const openChar = closeBrackets[char as keyof typeof closeBrackets];
      if (openChar) {
        openBrackets[openChar as keyof typeof openBrackets]--;
      }
    }
  }

  // 有未闭合的括号
  if (Object.values(openBrackets).some(count => count > 0)) {
    return true;
  }

  // 有未闭合的字符串
  if (inString) {
    return true;
  }

  return false;
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

// 打印启动 Banner (使用主题颜色)
function printStartupBanner(config: CurrentConfig, mode: string): void {
  const theme = getCurrentTheme();
  const model = getProviderModel(config.provider) ?? config.provider;

  // KODAX 方块字符 logo
  const logo = `
  ██╗  ██╗  ██████╗  ██████╗    █████╗   ██╗  ██╗
  ██║ ██╔╝ ██╔═══██╗ ██╔══██╗  ██╔══██╗  ╚██╗██╔╝
  █████╔╝  ██║   ██║ ██║  ██║  ███████║   ╚███╔╝
  ██╔═██╗  ██║   ██║ ██║  ██║  ██╔══██║   ██╔██╗
  ██║  ██╗ ╚██████╔╝ ██████╔╝  ██║  ██║  ██╔╝ ██╗
  ╚═╝  ╚═╝  ╚═════╝  ╚═════╝   ╚═╝  ╚═╝  ╚═╝  ╚═╝`;

  console.log(chalk.hex(theme.colors.primary)('\n' + logo));
  console.log(chalk.hex(theme.colors.text)(`\n  v${KODAX_VERSION}  |  AI Coding Agent  |  ${config.provider}:${model}`));
  console.log(chalk.hex(theme.colors.dim)('\n  ────────────────────────────────────────────────────────'));
  console.log(chalk.hex(theme.colors.dim)('  Mode: ') + chalk.hex(theme.colors.primary)(mode) + chalk.hex(theme.colors.dim)('  |  Thinking: ') + (config.thinking ? chalk.hex(theme.colors.success)('on') : chalk.hex(theme.colors.dim)('off')) + chalk.hex(theme.colors.dim)('  |  Auto: ') + (config.auto ? chalk.hex(theme.colors.success)('on') : chalk.hex(theme.colors.dim)('off')));
  console.log(chalk.hex(theme.colors.dim)('  ────────────────────────────────────────────────────────\n'));

  console.log(chalk.hex(theme.colors.dim)('  Quick tips:'));
  console.log(chalk.hex(theme.colors.primary)('    /help      ') + chalk.hex(theme.colors.dim)('Show all commands'));
  console.log(chalk.hex(theme.colors.primary)('    /mode      ') + chalk.hex(theme.colors.dim)('Switch code/ask mode'));
  console.log(chalk.hex(theme.colors.primary)('    /clear     ') + chalk.hex(theme.colors.dim)('Clear conversation'));
  console.log(chalk.hex(theme.colors.primary)('    @file      ') + chalk.hex(theme.colors.dim)('Add file to context'));
  console.log(chalk.hex(theme.colors.primary)('    !cmd       ') + chalk.hex(theme.colors.dim)('Run shell command'));
  console.log(chalk.hex(theme.colors.dim)('\n  Keyboard: Tab (complete) | Esc+Esc (edit last) | Ctrl+E (editor) | Ctrl+R (history)\n'));
}
