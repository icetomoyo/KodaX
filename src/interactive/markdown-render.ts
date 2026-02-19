/**
 * KodaX Markdown 渲染工具
 *
 * 为终端输出提供简单的 Markdown 渲染支持
 */

import chalk from 'chalk';
import { getSymbols, supportsUnicode } from './prompts.js';

/**
 * 代码块信息
 */
interface CodeBlock {
  language: string;
  code: string;
  startLine: number;
  endLine: number;
}

/**
 * 解析代码块
 */
function parseCodeBlocks(text: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const regex = /```(\w*)\n([\s\S]*?)```/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    blocks.push({
      language: match[1] ?? '',
      code: match[2] ?? '',
      startLine: match.index,
      endLine: match.index + match[0].length,
    });
  }

  return blocks;
}

/**
 * 简单的语法高亮
 */
function highlightCode(code: string, _language: string): string {
  // 简单的关键词高亮（不依赖外部库）
  const keywords = /\b(const|let|var|function|return|if|else|for|while|class|import|export|from|async|await|try|catch|throw|new|this|typeof|instanceof)\b/g;
  const strings = /(["'`])(?:(?!\1)[^\\]|\\.)*\1/g;
  const comments = /(\/\/.*$|\/\*[\s\S]*?\*\/)/gm;
  const numbers = /\b(\d+\.?\d*)\b/g;

  let result = code;

  // 注释
  result = result.replace(comments, chalk.dim('$1'));

  // 字符串
  result = result.replace(strings, chalk.green('$&'));

  // 关键词
  result = result.replace(keywords, chalk.cyan('$1'));

  // 数字
  result = result.replace(numbers, chalk.yellow('$1'));

  return result;
}

/**
 * 渲染 Markdown 文本到终端
 */
export function renderMarkdown(text: string): string {
  const symbols = getSymbols();
  let result = text;

  // 处理代码块
  const codeBlocks = parseCodeBlocks(text);
  for (let i = codeBlocks.length - 1; i >= 0; i--) {
    const block = codeBlocks[i];
    if (!block) continue;

    const highlighted = highlightCode(block.code, block.language);
    const header = block.language ? chalk.dim(`[${block.language}]`) : '';
    const replacement = `\n${chalk.dim('─'.repeat(40))}\n${header}\n${highlighted}${chalk.dim('─'.repeat(40))}\n`;

    result = result.slice(0, block.startLine) + replacement + result.slice(block.endLine);
  }

  // 处理行内代码
  result = result.replace(/`([^`]+)`/g, (_, code: string) => chalk.bgGray.black(` ${code} `));

  // 处理粗体
  result = result.replace(/\*\*([^*]+)\*\*/g, (_, text: string) => chalk.bold(text));

  // 处理斜体
  result = result.replace(/\*([^*]+)\*/g, (_, text: string) => chalk.italic(text));

  // 处理标题
  result = result.replace(/^### (.+)$/gm, (_, title: string) => chalk.bold.cyan(`### ${title}`));
  result = result.replace(/^## (.+)$/gm, (_, title: string) => chalk.bold.blue(`## ${title}`));
  result = result.replace(/^# (.+)$/gm, (_, title: string) => chalk.bold.white(`# ${title}`));

  // 处理列表项
  result = result.replace(/^- (.+)$/gm, (_, item: string) => `  ${symbols.bullet} ${item}`);
  result = result.replace(/^\* (.+)$/gm, (_, item: string) => `  ${symbols.bullet} ${item}`);
  result = result.replace(/^(\d+)\. (.+)$/gm, (_, num: string, item: string) => `  ${chalk.dim(num)}. ${item}`);

  // 处理链接
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text: string, url: string) =>
    `${chalk.cyan(text)} ${chalk.dim(`(${url})`)}`
  );

  return result;
}

/**
 * 流式 Markdown 渲染器
 *
 * 用于逐步渲染流式输出的 Markdown 内容
 */
export class StreamingMarkdownRenderer {
  private buffer = '';
  private inCodeBlock = false;
  private codeBlockLanguage = '';
  private lastRenderedLength = 0;

  /**
   * 添加文本到缓冲区
   */
  append(text: string): void {
    this.buffer += text;
  }

  /**
   * 获取新内容并渲染
   *
   * @returns 自上次渲染以来的新渲染内容
   */
  renderNew(): string {
    const newContent = this.buffer.slice(this.lastRenderedLength);
    this.lastRenderedLength = this.buffer.length;

    // 检测代码块状态
    const codeBlockStart = newContent.indexOf('```');
    if (codeBlockStart !== -1) {
      this.inCodeBlock = !this.inCodeBlock;
      if (this.inCodeBlock) {
        // 提取语言
        const afterStart = newContent.slice(codeBlockStart + 3);
        const newlineIndex = afterStart.indexOf('\n');
        if (newlineIndex !== -1) {
          this.codeBlockLanguage = afterStart.slice(0, newlineIndex).trim();
        }
      }
    }

    // 代码块内不渲染 Markdown
    if (this.inCodeBlock) {
      return newContent;
    }

    // 渲染行内 Markdown
    return this.renderInline(newContent);
  }

  /**
   * 渲染行内 Markdown（不包含代码块）
   */
  private renderInline(text: string): string {
    let result = text;

    // 行内代码
    result = result.replace(/`([^`\n]+)`/g, (_, code: string) => chalk.bgGray.black(` ${code} `));

    // 粗体
    result = result.replace(/\*\*([^*\n]+)\*\*/g, (_, t: string) => chalk.bold(t));

    // 斜体
    result = result.replace(/\*([^*\n]+)\*/g, (_, t: string) => chalk.italic(t));

    return result;
  }

  /**
   * 重置渲染器
   */
  reset(): void {
    this.buffer = '';
    this.lastRenderedLength = 0;
    this.inCodeBlock = false;
    this.codeBlockLanguage = '';
  }

  /**
   * 获取完整缓冲区
   */
  getBuffer(): string {
    return this.buffer;
  }

  /**
   * 是否在代码块内
   */
  isInCodeBlock(): boolean {
    return this.inCodeBlock;
  }
}

/**
 * 格式化工具输出
 */
export function formatToolOutput(toolName: string, result: string): string {
  const symbols = getSymbols();

  // 截断过长的输出
  const maxLength = 2000;
  const truncated = result.length > maxLength
    ? result.slice(0, maxLength) + '\n...[output truncated]'
    : result;

  const header = chalk.dim(`${symbols.arrow} ${toolName}`);
  const content = chalk.dim(truncated);

  return `${header}\n${content}`;
}

/**
 * 格式化工具执行状态
 */
export function formatToolStatus(
  toolName: string,
  status: 'running' | 'success' | 'error',
  duration?: number
): string {
  const symbols = getSymbols();

  switch (status) {
    case 'running':
      return chalk.cyan(`${symbols.arrow} ${toolName}...`);
    case 'success':
      const durationStr = duration !== undefined ? ` (${duration}ms)` : '';
      return chalk.green(`${symbols.success} ${toolName}${durationStr}`);
    case 'error':
      return chalk.red(`${symbols.error} ${toolName}`);
  }
}

/**
 * 创建进度指示器
 */
export function createProgressIndicator(
  current: number,
  total: number,
  label: string = ''
): string {
  const symbols = getSymbols();
  const percent = total > 0 ? Math.round((current / total) * 100) : 0;
  const barWidth = 20;
  const filled = Math.round((percent / 100) * barWidth);
  const empty = barWidth - filled;

  const bar = chalk.green('█'.repeat(filled)) + chalk.dim('░'.repeat(empty));
  const percentStr = chalk.dim(`${percent.toString().padStart(3)}%`);

  if (label) {
    return `${bar} ${percentStr} ${chalk.dim(label)}`;
  }
  return `${bar} ${percentStr}`;
}
