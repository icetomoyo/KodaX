/**
 * FEATURE_200 Phase E (v0.7.45) — readline/input helpers extracted from repl.ts.
 * Self-contained (verified: no calls to repl.ts-local fns, zero closure state).
 * getPrompt / askInput / openExternalEditor / needsContinuation.
 */
import * as readline from 'readline';
import * as childProcess from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import chalk from 'chalk';
import {
  formatReasoningEffortStatusLabel,
  getProviderModel,
  resolvePermissionModeEffort,
} from '../common/utils.js';
import { getTerminalWidth } from './prompts.js';
import { getCurrentTheme } from './themes.js';
import { executeShellCommand } from '../ui/utils/shell-executor.js';
import type { CurrentConfig } from './commands.js';

export function getPrompt(mode: string, config: CurrentConfig): string {
  if (config.hostSettings) mode = config.hostSettings.permissionMode ?? 'Host default';
  const theme = getCurrentTheme();
  const modeColor = mode === 'plan' ? chalk.hex(theme.colors.warning) : chalk.hex(theme.colors.success);
  const model = config.model ?? getProviderModel(config.provider) ?? config.provider;
  const reasoningEffortLabel = config.hostSettings
    ? config.hostSettings.effort ?? config.hostSettings.reasoningMode
      ?? (config.hostSettings.thinking === undefined ? 'Host default' : config.hostSettings.thinking ? 'on' : 'off')
    : formatReasoningEffortStatusLabel({
    provider: config.provider,
    model: config.model,
    effort: resolvePermissionModeEffort(config),
    effortOverride: config.effortOverride,
    thinking: config.thinking,
    reasoningMode: config.reasoningMode,
  });
  const width = getTerminalWidth();

  if (width < 60) {
    const modeIndicator = mode === 'plan' ? '?' : theme.symbols.prompt;
    return modeColor(`${modeIndicator} `);
  }

  if (width < 100) {
    const flagPart = chalk.hex(theme.colors.dim)(`[${reasoningEffortLabel}]`);
    return modeColor(`kodax:${mode}${flagPart}> `);
  }

  const reasoningFlag = chalk.hex(theme.colors.info)(`[effort:${reasoningEffortLabel}]`);
  return modeColor(`kodax:${mode} (${config.provider}:${model})${reasoningFlag}> `);
}

// Read input; supports multiline continuations and external editor.
export async function askInput(rl: readline.Interface, prompt: string, signal?: AbortSignal): Promise<string> {
  const theme = getCurrentTheme();
  const lines: string[] = [];

  const firstLine = await askLine(rl, prompt, signal);
  if (signal?.aborted) return '';

  if (firstLine === '\x05' || firstLine.toLowerCase() === '/e') {
    return openExternalEditor(lines.join('\n'));
  }

  lines.push(firstLine);
  while (needsContinuation(lines.join('\n'))) {
    const continuationPrompt = chalk.hex(theme.colors.dim)('... ');
    const nextLine = await askLine(rl, continuationPrompt, signal);
    if (signal?.aborted) return '';
    lines.push(nextLine);
  }

  return lines.join('\n').replace(/\\\n/g, '\n');
}

function askLine(rl: readline.Interface, prompt: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) return Promise.resolve('');
  return new Promise<string>(resolve => {
    const finish = (answer: string): void => {
      signal?.removeEventListener('abort', onAbort);
      resolve(answer);
    };
    const onAbort = (): void => finish('');
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal) rl.question(prompt, { signal }, finish);
    else rl.question(prompt, finish);
  });
}

export async function openExternalEditor(initialContent: string): Promise<string> {
  const tmpDir = path.join(os.tmpdir(), 'kodax');
  const tmpFile = path.join(tmpDir, `input-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);

  try {
    await fs.promises.mkdir(tmpDir, { recursive: true });
    await fs.promises.writeFile(tmpFile, initialContent, 'utf-8');

    let editor = process.env.EDITOR ?? process.env.VISUAL ??
      (process.platform === 'win32' ? 'notepad.exe' : 'nano');

    if (editor.includes('/') || editor.includes('\\') || editor.includes('&&') || editor.includes('|')) {
      const baseName = path.basename(editor);
      console.log(chalk.yellow(`\n[Security] Editor path sanitized: ${baseName}`));
      editor = baseName;
    }

    console.log(chalk.dim(`\n[Opening editor: ${editor}]`));
    const isWindowsNotepad = process.platform === 'win32' &&
      (editor.toLowerCase() === 'notepad' || editor.toLowerCase() === 'notepad.exe');

    if (isWindowsNotepad) {
      console.log(chalk.dim('Note: Please close Notepad manually after editing to continue.\n'));
    } else {
      console.log(chalk.dim('Save and close the editor to continue...\n'));
    }

    childProcess.spawnSync(editor, [tmpFile], {
      stdio: 'inherit',
      timeout: 300000,
      shell: false,
    });

    const content = await fs.promises.readFile(tmpFile, 'utf-8');
    return content.trim();
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.log(chalk.red(`\n[Editor Error] ${err.message}`));
    return initialContent;
  } finally {
    try {
      await fs.promises.unlink(tmpFile);
    } catch {
      // Ignore cleanup errors.
    }
  }
}

export function needsContinuation(input: string): boolean {
  if (input.endsWith('\\') && !input.endsWith('\\\\')) {
    return true;
  }

  const openBrackets = { '(': 0, '[': 0, '{': 0 };
  const closeBrackets: Record<string, keyof typeof openBrackets> = { ')': '(', ']': '[', '}': '{' };
  let inString: string | null = null;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === undefined) {
      continue;
    }

    if ((char === '"' || char === "'" || char === '`') && input[i - 1] !== '\\') {
      if (inString === char) {
        inString = null;
      } else if (inString === null) {
        inString = char;
      }
      continue;
    }

    if (inString) {
      continue;
    }

    if (char in openBrackets) {
      openBrackets[char as keyof typeof openBrackets] += 1;
    } else if (char in closeBrackets) {
      const openChar = closeBrackets[char];
      if (openChar) {
        openBrackets[openChar] -= 1;
      }
    }
  }

  if (Object.values(openBrackets).some((count) => count > 0)) {
    return true;
  }

  return inString !== null;
}
