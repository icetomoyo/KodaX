/**
 * KodaX CLI Event Handler - CLI 事件处理器
 *
 * Spinner animation and event handling for CLI mode - 用于 CLI 模式的 Spinner 动画和事件处理
 */

import chalk from 'chalk';
import readline from 'readline';
import { KodaXEvents } from '@kodax/core';
import { PREVIEW_MAX_LENGTH } from '../common/utils.js';

// ============== Spinner Animation - Spinner 动画 ==============

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
    // Use \r to return to line start, no extra trailing space, cursor at text end - 使用 \r 回到行首，末尾不加多余空格，光标停在文本末尾
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
      // Clear entire line and move cursor to line start - 清除整行并将光标移回行首
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

// ============== User Confirmation - 用户确认 ==============

async function confirmAction(name: string, input: Record<string, unknown>): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    let prompt: string;
    switch (name) {
      case 'bash': prompt = `[Confirm] Execute: ${(input.command as string)?.slice(0, PREVIEW_MAX_LENGTH)}...? (y/n) `; break;
      case 'write': prompt = `[Confirm] Write to ${input.path}? (y/n) `; break;
      case 'edit': prompt = `[Confirm] Edit ${input.path}? (y/n) `; break;
      default: prompt = `[Confirm] Execute ${name}? (y/n) `;
    }
    rl.question(prompt, ans => { rl.close(); resolve(['y', 'yes'].includes(ans.trim().toLowerCase())); });
  });
}

// ============== CLI 事件处理器 ==============

export function createCliEvents(showSessionId = true): KodaXEvents {
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
      needNewline = true;  // Has text output, need newline later - 有文本输出，后续需要换行
    },

    onThinkingDelta: (text: string) => {
      thinkingCharCount += text.length;
      if (!spinner) spinner = startWaitingDots();
      spinner.updateText(`Thinking... (${thinkingCharCount} chars)`);
    },

    onThinkingEnd: (thinking: string) => {
      // thinking block ended, stop spinner and show summary - thinking block 结束，停止 spinner 并显示摘要
      if (spinner) { spinner.stop(); spinner = null; }
      if (thinking) {
        // Remove newlines to ensure preview is single line - 移除换行符，确保 preview 是单行
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
        // If spinner stopped (after thinking ended), newline first then create spinner - 如果 spinner 已停止（因为 thinking 结束后），先换行再创建 spinner
        // Consistent with kodax.ts behavior - 与 kodax.ts 行为一致
        if (!spinnerNewlined) {
          process.stdout.write('\n');
          spinnerNewlined = true;
          needNewline = false;  // Already newlined, onStreamEnd doesn't need to newline - 已经换行，onStreamEnd 不需要再换行
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
      // Stop globalSpinner (may be created in input_json_delta) - 停止 globalSpinner（在 input_json_delta 中可能创建的）
      if (globalSpinner && !globalSpinner.isStopped()) {
        globalSpinner.stop();
      }
      globalSpinner = null;
      spinnerNewlined = false;

      // Only newline if has text output and didn't newline in onToolInputDelta - 只有在有文本输出且没有在 onToolInputDelta 中换行时，才换行
      if (needNewline) {
        console.log();
        needNewline = false;
      }

      // If spinner was stopped during streaming (text_delta handling), restart it - 如果 spinner 在流式输出期间被停止（text_delta 处理），重启它
      if (!spinner || spinner.isStopped()) {
        spinner = startWaitingDots();
        spinner.updateText('Processing...');
      }
    },

    onIterationStart: (_iter: number, _maxIter: number) => {
      // Stop existing spinner first (avoid multiple intervals running) - 先停止已有的 spinner（避免多个 interval 同时运行）
      if (spinner && !spinner.isStopped()) {
        spinner.stop();
      }
      spinnerNewlined = false;
      needNewline = false;  // Reset newline flag - 重置换行标志
      console.log(chalk.magenta('\n[Assistant]'));
      // Recreate spinner each iteration (consistent with kodax.ts behavior) - 每次迭代都重新创建 spinner（与 kodax.ts 行为一致）
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
