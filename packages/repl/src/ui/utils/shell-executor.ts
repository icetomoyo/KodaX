/**
 * Shell Executor - Shell command executor - Shell 命令执行器
 *
 * Handles !command syntax, executes shell commands and returns results - 处理 !command 语法，执行 Shell 命令并返回结果
 * Extracted from InkREPL.tsx to improve code organization - 从 InkREPL.tsx 提取以改善代码组织
 */

import * as childProcess from "child_process";
import * as util from "util";
import chalk from "chalk";

const execAsync = util.promisify(childProcess.exec);

/**
 * Shell command execution configuration - Shell 命令执行配置
 */
export interface ShellExecutorConfig {
  maxBuffer?: number;
  timeout?: number;
  maxOutputLength?: number;
  maxErrorLength?: number;
}

const DEFAULT_CONFIG: Required<ShellExecutorConfig> = {
  maxBuffer: 1024 * 1024, // 1MB
  timeout: 30000, // 30 seconds
  maxOutputLength: 8000,
  maxErrorLength: 4000,
};

/**
 * Execute shell command - 执行 Shell 命令
 *
 * @param command - Command to execute (without ! prefix) - 要执行的命令（不含 ! 前缀）
 * @param config - Optional configuration - 可选配置
 * @returns Command output or error message, formatted for LLM processing - 命令输出或错误信息，格式化为适合 LLM 处理的字符串
 */
export async function executeShellCommand(
  command: string,
  config: ShellExecutorConfig = {}
): Promise<string> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  if (!command.trim()) {
    return "[Shell: No command provided]";
  }

  try {
    console.log(chalk.dim(`\n[Executing: ${command}]`));

    const { stdout, stderr } = await execAsync(command, {
      maxBuffer: cfg.maxBuffer,
      timeout: cfg.timeout,
    });

    let result = "";
    if (stdout) result += stdout;
    if (stderr) result += (result ? "\n" : "") + `[stderr] ${stderr}`;

    // Truncate excessively long output - 截断过长输出
    if (result.length > cfg.maxOutputLength) {
      result = result.slice(0, cfg.maxOutputLength) + "\n...[output truncated]";
    }

    console.log(chalk.dim(result || "[No output]"));
    console.log();

    return `[Shell command executed: ${command}]\n\nOutput:\n${result || "(no output)"}`;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    let errorMessage = err.message;

    // Truncate excessively long error messages - 截断过长错误信息
    if (errorMessage.length > cfg.maxErrorLength) {
      errorMessage = errorMessage.slice(0, cfg.maxErrorLength) + "\n...[error truncated]";
    }

    console.log(chalk.red(`\n[Shell Error: ${errorMessage}]`));
    console.log();

    return `[Shell command failed: ${command}]\n\nError: ${errorMessage}`;
  }
}

/**
 * Handle special syntax - 处理特殊语法
 *
 * Detects and handles !command syntax, executes shell commands - 检测并处理 !command 语法，执行 Shell 命令
 *
 * @param input - User input - 用户输入
 * @param config - Optional configuration - 可选配置
 * @returns Processed input (returns execution result for shell commands, otherwise returns original) - 处理后的输入（如果是 Shell 命令则返回执行结果，否则原样返回）
 */
export async function processSpecialSyntax(
  input: string,
  config: ShellExecutorConfig = {}
): Promise<string> {
  // !command syntax: execute shell command - !command 语法：执行 Shell 命令
  if (input.startsWith("!")) {
    const command = input.slice(1).trim();
    return executeShellCommand(command, config);
  }

  return input;
}

/**
 * Check if input is a shell command - 检查输入是否为 Shell 命令
 */
export function isShellCommand(input: string): boolean {
  return input.trim().startsWith("!");
}

/**
 * Check if shell command executed successfully - 检查 Shell 命令是否执行成功
 */
export function isShellCommandSuccess(result: string): boolean {
  return result.startsWith("[Shell command executed:") || result.startsWith("[Shell:");
}
