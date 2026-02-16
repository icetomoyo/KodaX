#!/usr/bin/env node
/**
 * KodaX - 极致轻量化 Coding Agent (TypeScript 版本)
 * 对应 Python 版本 KodaXP (kodaxp.py)
 *
 * 单文件实现，约 2000 LOC
 */

import { Command } from 'commander';
import chalk from 'chalk';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import { spawn, exec } from 'child_process';
import { glob as globAsync } from 'glob';
import iconv from 'iconv-lite';
import { promisify } from 'util';
import readline from 'readline';

const execAsync = promisify(exec);

// ============== 配置常量 ==============

const MAX_TOKENS = 32768;
const DEFAULT_TIMEOUT = 60;
const HARD_TIMEOUT = 300;
const DEFAULT_CONFIRM_TOOLS = new Set(['bash', 'write', 'edit']);
const COMPACT_THRESHOLD = 100000;
const COMPACT_KEEP_RECENT = 10;
const KODAX_DIR = path.join(os.homedir(), '.kodax');
const SESSIONS_DIR = path.join(KODAX_DIR, 'sessions');
const SKILLS_DIR = path.join(KODAX_DIR, 'skills');
const DEFAULT_PROVIDER = process.env.KODAX_PROVIDER ?? 'zhipu-coding';

// 长时间运行状态文件
const FEATURES_FILE = 'feature_list.json';
const PROGRESS_FILE = 'PROGRESS.md';
const SESSION_PLAN_DIR = '.kodax';
const SESSION_PLAN_FILE = '.kodax/session_plan.md';

// 并行 Agent 配置
const STAGGER_DELAY = 1.0;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 2;
const MAX_INCOMPLETE_RETRIES = 2;

// 全局文件备份（用于 undo）
const FILE_BACKUPS = new Map<string, string>();

// 全局 API 速率控制
const API_MIN_INTERVAL = 0.5; // 秒
let lastApiCallTime = 0;
const apiLock = { locked: false, queue: [] as (() => void)[] };

async function rateLimitedCall<T>(fn: () => Promise<T>): Promise<T> {
  // 简单的互斥锁
  while (apiLock.locked) {
    await new Promise<void>(resolve => apiLock.queue.push(resolve));
  }
  apiLock.locked = true;
  try {
    const elapsed = (Date.now() - lastApiCallTime) / 1000;
    if (elapsed < API_MIN_INTERVAL) {
      await new Promise(r => setTimeout(r, (API_MIN_INTERVAL - elapsed) * 1000));
    }
    const result = await fn();
    lastApiCallTime = Date.now();
    return result;
  } finally {
    apiLock.locked = false;
    const next = apiLock.queue.shift();
    if (next) next();
  }
}

// 等待动画 (Claude Code 风格的旋转 spinner)
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_COLORS = ['\x1b[36m', '\x1b[35m', '\x1b[34m']; // cyan, magenta, blue

// 全局 spinner 控制器（供 stream 方法访问）
let globalSpinner: {
  stop: () => void;
  isStopped: () => boolean;
  updateText: (text: string) => void;
} | null = null;

// 标志位：是否已经为 spinner 换过行（避免多次换行）
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
    process.stdout.write(`\r${color}${spinner}${reset} ${currentText}    `);
  };

  const interval = setInterval(() => {
    frame++;
    if (frame % 10 === 0) colorIdx++;
    renderFrame();
  }, 80);

  // 立即渲染第一帧（不等待 80ms）
  renderFrame();

  const controller = {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      process.stdout.write('\r                                        \r');
    },
    isStopped: () => stopped,
    updateText: (text: string) => {
      currentText = text;
    }
  };

  globalSpinner = controller;
  return controller;
}

// Session 计划模板
const SESSION_PLAN_TEMPLATE = `# Session Plan

**Date**: {date}
**Feature**: {feature}

## Understanding
[Describe what this feature does and why it's needed]

## Approach
[Describe how you plan to implement this feature]

## Steps
1. [First step]
2. [Second step]
3. [Third step]
...

## Considerations
- [Edge cases to handle]
- [Dependencies to check]
- [Security implications]

## Risks
- [What could go wrong]
- [How to mitigate]
`;

// Promise 信号模式
const PROMISE_PATTERN = /<promise>(COMPLETE|BLOCKED|DECIDE)(?::(.*?))?<\/promise>/is;

function checkPromiseSignal(text: string): [string, string] {
  const match = PROMISE_PATTERN.exec(text);
  if (match) return [match[1]!.toUpperCase(), match[2] ?? ''];
  return ['', ''];
}

// ============== 类型定义 ==============

interface TextBlock { type: 'text'; text: string; }
interface ToolUseBlock { type: 'tool_use'; id: string; name: string; input: Record<string, unknown>; }
interface ToolResultBlock { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean; }
interface ThinkingBlock { type: 'thinking'; thinking: string; signature?: string; }
interface RedactedThinkingBlock { type: 'redacted_thinking'; data: string; }
type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock | RedactedThinkingBlock;

interface StreamResult {
  textBlocks: TextBlock[];
  toolBlocks: ToolUseBlock[];
  thinkingBlocks: (ThinkingBlock | RedactedThinkingBlock)[];
}

interface Message {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

interface SessionMeta {
  _type: 'meta';
  title: string;
  id: string;
  gitRoot: string;
  createdAt: string;
}

interface ToolDefinition {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

interface ProviderConfig {
  apiKeyEnv: string;
  baseUrl?: string;
  model: string;
  supportsThinking: boolean;
}

interface CliOptions {
  provider: string;
  thinking: boolean;
  confirm?: string;
  noConfirm: boolean;
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
}

interface ToolExecutionContext {
  confirmTools: Set<string>;
  backups: Map<string, string>;
  noConfirm: boolean;
}

// ============== 工具定义 ==============

const TOOLS: ToolDefinition[] = [
  {
    name: 'read',
    description: 'Read the contents of a file.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The absolute path to the file' },
        offset: { type: 'number', description: 'Line number to start from' },
        limit: { type: 'number', description: 'Number of lines to read' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write',
    description: 'Write content to a file.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The absolute path to the file' },
        content: { type: 'string', description: 'The content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit',
    description: 'Perform exact string replacement in a file.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The file to edit' },
        old_string: { type: 'string', description: 'The text to replace' },
        new_string: { type: 'string', description: 'The replacement text' },
        replace_all: { type: 'boolean', description: 'Replace all occurrences' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'bash',
    description: 'Execute a shell command.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to execute' },
        timeout: { type: 'number', description: 'Timeout in seconds' },
      },
      required: ['command'],
    },
  },
  {
    name: 'glob',
    description: 'Find files matching a pattern.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'The glob pattern' },
        path: { type: 'string', description: 'Directory to search' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'grep',
    description: 'Search for a pattern in files.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'The regex pattern' },
        path: { type: 'string', description: 'File or directory to search' },
        ignore_case: { type: 'boolean', description: 'Case insensitive search' },
        output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'] },
      },
      required: ['pattern', 'path'],
    },
  },
  {
    name: 'undo',
    description: 'Revert the last file modification.',
    input_schema: { type: 'object', properties: {} },
  },
];

const TOOL_REQUIRED_PARAMS: Record<string, string[]> = {
  read: ['path'],
  write: ['path', 'content'],
  edit: ['path', 'old_string', 'new_string'],
  bash: ['command'],
  glob: ['pattern'],
  grep: ['pattern', 'path'],
  undo: [],
};

// ============== Provider 实现 ==============

abstract class BaseProvider {
  abstract readonly name: string;
  abstract readonly supportsThinking: boolean;
  protected abstract readonly config: ProviderConfig;

  abstract stream(messages: Message[], tools: ToolDefinition[], system: string, thinking?: boolean): Promise<StreamResult>;

  isConfigured(): boolean {
    return !!process.env[this.config.apiKeyEnv];
  }

  protected getApiKey(): string {
    const key = process.env[this.config.apiKeyEnv];
    if (!key) throw new Error(`${this.config.apiKeyEnv} not set`);
    return key;
  }

  protected isRateLimitError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const s = error.message.toLowerCase();
    return ['rate', 'limit', '速率', '频率', '1302', '429', 'too many'].some(k => s.includes(k));
  }

  protected async withRateLimit<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
    let lastErr: Error | undefined;
    for (let i = 0; i < retries; i++) {
      try { return await fn(); }
      catch (e) {
        if (this.isRateLimitError(e)) {
          lastErr = e instanceof Error ? e : new Error(String(e));
          console.log(chalk.dim(`[${this.name}] Rate limit, retry ${i + 1}/${retries}...`));
          await new Promise(r => setTimeout(r, (i + 1) * 2000));
          continue;
        }
        throw e;
      }
    }
    throw lastErr;
  }
}

// ============== Anthropic 兼容 Provider 基类 ==============

abstract class AnthropicCompatProvider extends BaseProvider {
  abstract override readonly name: string;
  readonly supportsThinking = true;
  protected abstract readonly config: ProviderConfig;
  protected client!: Anthropic;

  protected initClient(): void {
    this.client = new Anthropic({ apiKey: this.getApiKey(), baseURL: this.config.baseUrl });
  }

  async stream(messages: Message[], tools: ToolDefinition[], system: string, thinking = false): Promise<StreamResult> {
    return this.withRateLimit(async () => {
      const kwargs: Anthropic.Messages.MessageCreateParams = {
        model: this.config.model,
        max_tokens: MAX_TOKENS,
        system,
        messages: this.convertMessages(messages),
        tools: tools as Anthropic.Messages.Tool[],
        stream: true,
      };
      if (thinking) kwargs.thinking = { type: 'enabled', budget_tokens: 10000 };

      const textBlocks: TextBlock[] = [];
      const toolBlocks: ToolUseBlock[] = [];
      const thinkingBlocks: (ThinkingBlock | RedactedThinkingBlock)[] = [];

      // 手工处理流事件（细粒度控制）
      let currentBlockType: string | null = null;
      let currentText = '';
      let currentThinking = '';
      let currentThinkingSignature = '';
      let currentToolId = '';
      let currentToolName = '';
      let currentToolInput = '';

      const response = await this.client.messages.create(kwargs);

      // 处理流式事件
      for await (const event of response as AsyncIterable<Anthropic.Messages.RawMessageStreamEvent>) {
        if (event.type === 'content_block_start') {
          const block = event.content_block;
          currentBlockType = block.type;
          if (block.type === 'thinking') {
            currentThinking = '';
            currentThinkingSignature = (block as any).signature ?? '';
            // spinner 继续运行，由 thinking_delta 更新显示
          } else if (block.type === 'redacted_thinking') {
            currentBlockType = 'redacted_thinking';
          } else if (block.type === 'text') {
            currentText = '';
          } else if (block.type === 'tool_use') {
            currentToolId = block.id;
            currentToolName = block.name;
            currentToolInput = '';
          }
        } else if (event.type === 'content_block_delta') {
          const delta = event.delta as any;
          if (delta.type === 'thinking_delta') {
            currentThinking += delta.thinking ?? '';
            // 更新 spinner 显示当前 thinking 字数
            if (globalSpinner && !globalSpinner.isStopped()) {
              globalSpinner.updateText(`Thinking... (${currentThinking.length} chars)`);
            }
          } else if (delta.type === 'text_delta') {
            // 第一次输出 text 时停止 spinner
            if (globalSpinner) {
              globalSpinner.stop();
              globalSpinner = null;
            }
            currentText += delta.text ?? '';
            process.stdout.write(delta.text ?? '');
          } else if (delta.type === 'input_json_delta') {
            currentToolInput += delta.partial_json ?? '';
            // tool_use JSON 流式传输期间显示进度
            if (globalSpinner && !globalSpinner.isStopped()) {
              globalSpinner.updateText(`Receiving ${currentToolName}...`);
            } else if (!globalSpinner) {
              // 如果 spinner 已停止（因为 thinking 结束后），先换行再创建 spinner
              // 但只在第一次换行，避免多次换行导致显示空旷
              if (!spinnerNewlined) {
                process.stdout.write('\n');
                spinnerNewlined = true;
              }
              globalSpinner = startWaitingDots();
              globalSpinner.updateText(`Receiving ${currentToolName}...`);
            }
          }
        } else if (event.type === 'content_block_stop') {
          if (currentBlockType === 'thinking') {
            if (currentThinking) {
              thinkingBlocks.push({ type: 'thinking', thinking: currentThinking, signature: currentThinkingSignature });
            }
            // thinking block 结束，先停止 spinner 清除当前行，再显示摘要
            if (globalSpinner && !globalSpinner.isStopped()) {
              globalSpinner.stop();
              globalSpinner = null;
            }
            if (currentThinking) {
              // 移除换行符，确保 preview 是单行
              const singleLine = currentThinking.replace(/\n/g, ' ');
              const preview = singleLine.length > 100
                ? singleLine.slice(0, 100) + '...'
                : singleLine;
              console.log(chalk.dim(`[thinking] ${preview}`));
            }
          } else if (currentBlockType === 'redacted_thinking') {
            // redacted_thinking block 处理（数据在 block 中）
            const block = (event as any).content_block;
            if (block?.data) {
              thinkingBlocks.push({ type: 'redacted_thinking', data: block.data });
            }
          } else if (currentBlockType === 'text') {
            if (currentText) textBlocks.push({ type: 'text', text: currentText });
          } else if (currentBlockType === 'tool_use') {
            // tool_use block 结束时停止 spinner
            if (globalSpinner && !globalSpinner.isStopped()) {
              globalSpinner.stop();
            }
            globalSpinner = null;
            try {
              const input = currentToolInput ? JSON.parse(currentToolInput) : {};
              toolBlocks.push({ type: 'tool_use', id: currentToolId, name: currentToolName, input });
            } catch {
              toolBlocks.push({ type: 'tool_use', id: currentToolId, name: currentToolName, input: {} });
            }
          }
          currentBlockType = null;
        }
      }

      return { textBlocks, toolBlocks, thinkingBlocks };
    });
  }

  private convertMessages(messages: Message[]): Anthropic.Messages.MessageParam[] {
    return messages.map(m => {
      if (typeof m.content === 'string') return { role: m.role, content: m.content };
      const content: Anthropic.Messages.ContentBlockParam[] = [];
      // 关键：thinking blocks 必须放在最前面（Kimi Code API 要求）
      for (const b of m.content) {
        if (b.type === 'thinking') {
          content.push({ type: 'thinking', thinking: b.thinking, signature: b.signature ?? '' } as any);
        } else if (b.type === 'redacted_thinking') {
          content.push({ type: 'redacted_thinking', data: b.data } as any);
        }
      }
      // 然后是 text blocks
      for (const b of m.content) {
        if (b.type === 'text') content.push({ type: 'text', text: b.text });
      }
      // 最后是 tool blocks
      for (const b of m.content) {
        if (b.type === 'tool_use' && m.role === 'assistant') content.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input });
        else if (b.type === 'tool_result' && m.role === 'user') content.push({ type: 'tool_result', tool_use_id: b.tool_use_id, content: b.content });
      }
      return { role: m.role, content } as Anthropic.Messages.MessageParam;
    });
  }
}

class AnthropicProvider extends AnthropicCompatProvider {
  readonly name = 'anthropic';
  protected readonly config: ProviderConfig = {
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    model: 'claude-sonnet-4-20250514',
    supportsThinking: true,
  };
  constructor() { super(); this.client = new Anthropic({ apiKey: this.getApiKey() }); }
}

class ZhipuCodingProvider extends AnthropicCompatProvider {
  readonly name = 'zhipu-coding';
  protected readonly config: ProviderConfig = {
    apiKeyEnv: 'ZHIPU_API_KEY',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    model: 'glm-5',
    supportsThinking: true,
  };
  constructor() { super(); this.initClient(); }
}

class KimiCodeProvider extends AnthropicCompatProvider {
  readonly name = 'kimi-code';
  protected readonly config: ProviderConfig = {
    apiKeyEnv: 'KIMI_API_KEY',
    baseUrl: 'https://api.kimi.com/coding/',
    model: 'k2p5',
    supportsThinking: true,
  };
  constructor() { super(); this.initClient(); }
}

// ============== OpenAI 兼容 Provider 基类 ==============

abstract class OpenAICompatProvider extends BaseProvider {
  abstract override readonly name: string;
  readonly supportsThinking = false;
  protected abstract readonly config: ProviderConfig;
  protected client!: OpenAI;

  protected initClient(): void {
    this.client = new OpenAI({ apiKey: this.getApiKey(), baseURL: this.config.baseUrl });
  }

  async stream(messages: Message[], tools: ToolDefinition[], system: string, _thinking = false): Promise<StreamResult> {
    return this.withRateLimit(async () => {
      const fullMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        { role: 'system', content: system },
        ...this.convertMessages(messages),
      ];
      const openaiTools = tools.map(t => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.input_schema } }));

      const toolCallsMap = new Map<number, { id: string; name: string; arguments: string }>();
      let textContent = '';

      const stream = await this.client.chat.completions.create({
        model: this.config.model,
        messages: fullMessages,
        tools: openaiTools,
        max_tokens: MAX_TOKENS,
        stream: true,
      });

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (delta?.content) { process.stdout.write(delta.content); textContent += delta.content; }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const existing = toolCallsMap.get(tc.index) ?? { id: '', name: '', arguments: '' };
            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) existing.name = tc.function.name;
            if (tc.function?.arguments) existing.arguments += tc.function.arguments;
            toolCallsMap.set(tc.index, existing);
          }
        }
      }

      const textBlocks: TextBlock[] = textContent ? [{ type: 'text', text: textContent }] : [];
      const toolBlocks: ToolUseBlock[] = [];
      for (const [, tc] of toolCallsMap) {
        if (tc.id && tc.name) {
          try { toolBlocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: JSON.parse(tc.arguments) }); }
          catch { toolBlocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: {} }); }
        }
      }
      return { textBlocks, toolBlocks, thinkingBlocks: [] };
    });
  }

  private convertMessages(messages: Message[]): OpenAI.Chat.ChatCompletionMessageParam[] {
    return messages.map(m => {
      if (typeof m.content === 'string') return { role: m.role, content: m.content };
      const text = (m.content as ContentBlock[]).filter((b): b is TextBlock => b.type === 'text').map(b => b.text).join('\n');
      return { role: m.role, content: text };
    });
  }
}

class OpenAIProvider extends OpenAICompatProvider {
  readonly name = 'openai';
  protected readonly config: ProviderConfig = { apiKeyEnv: 'OPENAI_API_KEY', model: 'gpt-4o', supportsThinking: false };
  constructor() { super(); this.initClient(); }
}

class KimiProvider extends OpenAICompatProvider {
  readonly name = 'kimi';
  protected readonly config: ProviderConfig = {
    apiKeyEnv: 'KIMI_API_KEY', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-128k', supportsThinking: false,
  };
  constructor() { super(); this.initClient(); }
}

class QwenProvider extends OpenAICompatProvider {
  readonly name = 'qwen';
  protected readonly config: ProviderConfig = {
    apiKeyEnv: 'QWEN_API_KEY', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-max', supportsThinking: false,
  };
  constructor() { super(); this.initClient(); }
}

class ZhipuProvider extends OpenAICompatProvider {
  readonly name = 'zhipu';
  protected readonly config: ProviderConfig = {
    apiKeyEnv: 'ZHIPU_API_KEY', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus', supportsThinking: false,
  };
  constructor() { super(); this.initClient(); }
}

const PROVIDERS: Record<string, () => BaseProvider> = {
  anthropic: () => new AnthropicProvider(),
  openai: () => new OpenAIProvider(),
  kimi: () => new KimiProvider(),
  'kimi-code': () => new KimiCodeProvider(),
  qwen: () => new QwenProvider(),
  zhipu: () => new ZhipuProvider(),
  'zhipu-coding': () => new ZhipuCodingProvider(),
};

function getProvider(name?: string): BaseProvider {
  const n = name ?? DEFAULT_PROVIDER;
  const factory = PROVIDERS[n];
  if (!factory) throw new Error(`Unknown provider: ${n}. Available: ${Object.keys(PROVIDERS).join(', ')}`);
  return factory();
}

// ============== 工具执行 ==============

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

async function executeTool(name: string, input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  const required = TOOL_REQUIRED_PARAMS[name] ?? [];
  for (const p of required) {
    if (input[p] === undefined) return `[Tool Error] ${name}: Missing required parameter '${p}'`;
  }

  if (ctx.confirmTools.has(name) && !ctx.noConfirm) {
    if (!(await confirmAction(name, input))) return 'Operation cancelled by user';
  }

  try {
    switch (name) {
      case 'read': return await toolRead(input);
      case 'write': return await toolWrite(input, ctx);
      case 'edit': return await toolEdit(input, ctx);
      case 'bash': return await toolBash(input);
      case 'glob': return await toolGlob(input);
      case 'grep': return await toolGrep(input);
      case 'undo': return await toolUndo(ctx);
      default: return `[Tool Error] Unknown tool: ${name}`;
    }
  } catch (e) {
    return `[Tool Error] ${name}: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function toolRead(input: Record<string, unknown>): Promise<string> {
  const filePath = path.resolve(input.path as string);
  if (!fsSync.existsSync(filePath)) return `[Tool Error] File not found: ${filePath}`;
  const content = await fs.readFile(filePath, 'utf-8');
  const lines = content.split('\n');
  const offset = (input.offset as number) ?? 0;
  const limit = (input.limit as number) ?? lines.length;
  const selected = lines.slice(Math.max(0, offset - 1), offset - 1 + limit);
  const numbered = selected.map((l, i) => `${(offset + i + 1).toString().padStart(6)}\t${l}`);
  if (lines.length > 2000) return numbered.slice(0, 2000).join('\n') + `\n\n[Truncated] ${lines.length} lines total`;
  return numbered.join('\n');
}

async function toolWrite(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  const filePath = path.resolve(input.path as string);
  const content = input.content as string;
  if (fsSync.existsSync(filePath)) {
    const existing = await fs.readFile(filePath, 'utf-8');
    ctx.backups.set(filePath, existing);
    FILE_BACKUPS.set(filePath, existing);
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
  return `File written: ${filePath}`;
}

async function toolEdit(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  const filePath = path.resolve(input.path as string);
  if (!fsSync.existsSync(filePath)) return `[Tool Error] File not found: ${filePath}`;
  const oldStr = input.old_string as string;
  const newStr = input.new_string as string;
  const replaceAll = input.replace_all as boolean;
  const content = await fs.readFile(filePath, 'utf-8');
  ctx.backups.set(filePath, content);
  FILE_BACKUPS.set(filePath, content);
  if (!content.includes(oldStr)) return `[Tool Error] old_string not found`;
  const count = content.split(oldStr).length - 1;
  if (count > 1 && !replaceAll) return `[Tool Error] old_string appears ${count} times. Use replace_all=true`;
  const newContent = replaceAll ? content.split(oldStr).join(newStr) : content.replace(oldStr, newStr);
  await fs.writeFile(filePath, newContent, 'utf-8');
  return `File edited: ${filePath}`;
}

async function toolBash(input: Record<string, unknown>): Promise<string> {
  const command = input.command as string;
  const userTimeout = input.timeout as number | undefined;
  const timeout = userTimeout ? Math.min(HARD_TIMEOUT, userTimeout) : DEFAULT_TIMEOUT;
  const capped = userTimeout && userTimeout > HARD_TIMEOUT;

  return new Promise(resolve => {
    const proc = spawn(command, [], { shell: true, windowsHide: true, cwd: process.cwd() });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    const timer = setTimeout(() => {
      proc.kill();
      const partial = stdout.length ? stdout.toString('utf-8').slice(0, 2000) : '';
      resolve(`[Timeout] Command interrupted after ${timeout}s\n\nPartial output:\n${partial}\n\n[Suggestion] The command took too long. Consider:\n- Is this a watch/dev server? Run in a separate terminal.\n- Can the task be broken into smaller steps?\n- Is there an error causing it to hang?`);
    }, timeout * 1000);

    proc.stdout?.on('data', (d: Buffer) => { stdout = Buffer.concat([stdout, d]); });
    proc.stderr?.on('data', (d: Buffer) => { stderr = Buffer.concat([stderr, d]); });
    proc.on('close', code => {
      clearTimeout(timer);
      const decode = (b: Buffer) => {
        if (process.platform === 'win32') {
          try { const s = b.toString('utf-8'); if (!/[\uFFFD]/.test(s)) return s; } catch { }
          return iconv.decode(b, 'gbk');
        }
        return b.toString('utf-8');
      };
      let out = `Exit: ${code}\n${decode(stdout)}`;
      if (stderr.length) out += `\n[stderr]\n${decode(stderr)}`;
      if (capped) out += `\n[Note] Timeout capped at ${HARD_TIMEOUT}s`;
      resolve(out);
    });
    proc.on('error', e => { clearTimeout(timer); resolve(`[Error] ${e.message}`); });
  });
}

async function toolGlob(input: Record<string, unknown>): Promise<string> {
  const pattern = input.pattern as string;
  const cwd = (input.path as string) ?? process.cwd();
  const files = await globAsync(pattern, { cwd: path.resolve(cwd), nodir: true, absolute: true, ignore: ['**/node_modules/**', '**/dist/**', '**/.*/**'] });
  if (files.length === 0) return 'No files found';
  return files.slice(0, 100).join('\n') + (files.length > 100 ? '\n... (more files)' : '');
}

async function toolGrep(input: Record<string, unknown>): Promise<string> {
  const pattern = input.pattern as string;
  const searchPath = (input.path as string) ?? process.cwd();
  const ignoreCase = (input.ignore_case as boolean) ?? false;
  const outputMode = (input.output_mode as string) ?? 'content';
  const flags = ignoreCase ? 'gi' : 'g';
  const regex = new RegExp(pattern, flags);
  const resolvedPath = path.resolve(searchPath);
  const results: string[] = [];

  // 单文件 vs 目录
  const stat = fsSync.existsSync(resolvedPath) ? fsSync.statSync(resolvedPath) : null;
  if (stat?.isFile()) {
    // 单文件搜索
    try {
      const content = await fs.readFile(resolvedPath, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length && results.length < 200; i++) {
        if (regex.test(lines[i]!)) {
          if (outputMode === 'files_with_matches') { results.push(resolvedPath); break; }
          else results.push(`${resolvedPath}:${i + 1}: ${lines[i]!.trim()}`);
        }
        regex.lastIndex = 0;
      }
    } catch { }
  } else {
    // 目录搜索
    const files = (await globAsync('**/*', { cwd: resolvedPath, nodir: true, absolute: true, ignore: ['**/node_modules/**', '**/.*/**'] })).slice(0, 100);
    for (const file of files) {
      try {
        const content = await fs.readFile(file, 'utf-8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length && results.length < 200; i++) {
          if (regex.test(lines[i]!)) {
            if (outputMode === 'files_with_matches') { results.push(file); break; }
            else results.push(`${file}:${i + 1}: ${lines[i]!.trim()}`);
          }
          regex.lastIndex = 0;
        }
      } catch { }
    }
  }
  if (outputMode === 'count') return `${results.length} matches`;
  return results.length ? results.join('\n') : `No matches for "${pattern}"`;
}

async function toolUndo(ctx: ToolExecutionContext): Promise<string> {
  // 优先使用全局备份
  if (FILE_BACKUPS.size > 0) {
    const entries = [...FILE_BACKUPS.entries()];
    const [filePath, content] = entries[entries.length - 1]!;
    FILE_BACKUPS.delete(filePath);
    ctx.backups.delete(filePath);
    await fs.writeFile(filePath, content, 'utf-8');
    return `Restored: ${filePath}`;
  }
  return 'No backups available. Nothing to undo.';
}

// ============== 会话管理 ==============

async function generateSessionId(): Promise<string> {
  const now = new Date();
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
}

async function saveSession(id: string, messages: Message[], title: string, gitRoot: string): Promise<void> {
  await fs.mkdir(SESSIONS_DIR, { recursive: true });
  const meta: SessionMeta = { _type: 'meta', title, id, gitRoot, createdAt: new Date().toISOString() };
  const lines = [JSON.stringify(meta), ...messages.map(m => JSON.stringify(m))];
  await fs.writeFile(path.join(SESSIONS_DIR, `${id}.jsonl`), lines.join('\n'), 'utf-8');
}

async function loadSession(id: string): Promise<{ messages: Message[]; title: string; gitRoot: string } | null> {
  const filePath = path.join(SESSIONS_DIR, `${id}.jsonl`);
  if (!fsSync.existsSync(filePath)) return null;
  const lines = (await fs.readFile(filePath, 'utf-8')).trim().split('\n');
  const messages: Message[] = [];
  let title = '', gitRoot = '';
  for (let i = 0; i < lines.length; i++) {
    const data = JSON.parse(lines[i]!);
    if (i === 0 && data._type === 'meta') { title = data.title ?? ''; gitRoot = data.gitRoot ?? ''; }
    else messages.push(data);
  }

  // 验证项目匹配
  const currentGitRoot = await getGitRoot();
  if (currentGitRoot && gitRoot && currentGitRoot !== gitRoot) {
    console.log(chalk.yellow(`\n[Warning] Session project mismatch:`));
    console.log(`  Current:  ${currentGitRoot}`);
    console.log(`  Session:  ${gitRoot}`);
    console.log(`  Continuing anyway...\n`);
  }

  return { messages, title, gitRoot };
}

async function listSessions(): Promise<Array<{ id: string; title: string; msgCount: number }>> {
  await fs.mkdir(SESSIONS_DIR, { recursive: true });
  const currentGitRoot = await getGitRoot();
  const files = (await fs.readdir(SESSIONS_DIR)).filter(f => f.endsWith('.jsonl'));
  const sessions = [];
  for (const f of files) {
    try {
      const content = (await fs.readFile(path.join(SESSIONS_DIR, f), 'utf-8')).trim();
      const firstLine = content.split('\n')[0];
      if (!firstLine) continue;
      const first = JSON.parse(firstLine);
      if (first._type === 'meta') {
        const sessionGitRoot = first.gitRoot ?? '';
        // 过滤：只显示当前项目的 sessions
        if (currentGitRoot && sessionGitRoot && currentGitRoot !== sessionGitRoot) continue;
        const lineCount = content.split('\n').length;
        sessions.push({ id: f.replace('.jsonl', ''), title: first.title ?? '', msgCount: lineCount - 1 });
      } else {
        // 旧格式，无元数据
        const lineCount = content.split('\n').length;
        sessions.push({ id: f.replace('.jsonl', ''), title: '', msgCount: lineCount });
      }
    } catch { continue; }
  }
  return sessions.sort((a, b) => b.id.localeCompare(a.id)).slice(0, 10);
}

// ============== 上下文 ==============

async function getGitRoot(): Promise<string | null> {
  try { const { stdout } = await execAsync('git rev-parse --show-toplevel'); return stdout.trim(); } catch { return null; }
}

async function getGitContext(): Promise<string> {
  try {
    // 检查是否在 Git 仓库中
    const { stdout: check } = await execAsync('git rev-parse --is-inside-work-tree');
    if (!check.trim()) return '';

    const lines: string[] = [];

    // 获取分支名
    try {
      const { stdout: branch } = await execAsync('git branch --show-current');
      if (branch.trim()) lines.push(`Git Branch: ${branch.trim()}`);
    } catch { }

    // 获取状态摘要
    try {
      const { stdout: status } = await execAsync('git status --short');
      if (status.trim()) {
        const statusLines = status.trim().split('\n').slice(0, 10);
        lines.push(`Git Status:\n` + statusLines.map((s: string) => `  ${s}`).join('\n'));
        const totalLines = status.trim().split('\n').length;
        if (totalLines > 10) lines.push('  ... (more changes)');
      }
    } catch { }

    return lines.join('\n');
  } catch { return ''; }
}

function getEnvContext(): string {
  const p = process.platform;
  const isWin = p === 'win32';
  const cmdHint = isWin
    ? 'Use: dir, move, copy, del'
    : 'Use: ls, mv, cp, rm';
  return `Platform: ${isWin ? 'Windows' : p === 'darwin' ? 'macOS' : 'Linux'}\n${cmdHint}\nNode: ${process.version}`;
}

// ============== Token 估算 ==============

function estimateTokens(messages: Message[]): number {
  let total = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') total += Math.ceil(m.content.length / 4);
    else for (const b of m.content) {
      if (b.type === 'text') total += Math.ceil(b.text.length / 4);
      else if (b.type === 'tool_result') total += Math.ceil(b.content.length / 4);
    }
  }
  return total;
}

function compactMessages(messages: Message[]): Message[] {
  if (estimateTokens(messages) <= COMPACT_THRESHOLD) return messages;
  console.log(chalk.dim(`[KodaX] Compacting context...`));
  const recent = messages.slice(-COMPACT_KEEP_RECENT);
  const old = messages.slice(0, -COMPACT_KEEP_RECENT);
  const summary = old.map(m => {
    const content = typeof m.content === 'string' ? m.content : (m.content as ContentBlock[]).filter((b): b is TextBlock => b.type === 'text').map(b => b.text).join(' ');
    return `- ${m.role}: ${content.slice(0, 100)}...`;
  }).join('\n');
  return [{ role: 'user', content: `[对话历史摘要]\n${summary}` }, ...recent];
}

// ============== 上下文增强 ==============

async function getProjectSnapshot(maxDepth = 2, maxFiles = 50): Promise<string> {
  const ignoreDirs = new Set(['.git', '__pycache__', 'node_modules', '.venv', 'venv', 'dist', 'build', '.idea', '.vscode']);
  const ignoreExts = new Set(['.pyc', '.pyo', '.so', '.dll', '.exe', '.bin']);
  const cwd = process.cwd();
  const lines = [`Project: ${path.basename(cwd)}`];
  let fileCount = 0;

  async function walk(dir: string, depth: number) {
    if (depth > maxDepth || fileCount >= maxFiles) return;
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const dirs: string[] = [];
      const files: string[] = [];
      for (const e of entries) {
        if (e.isDirectory() && !ignoreDirs.has(e.name) && !e.name.startsWith('.')) dirs.push(e.name);
        else if (e.isFile() && !ignoreExts.has(path.extname(e.name))) files.push(e.name);
      }
      const indent = '  '.repeat(depth);
      const rel = path.relative(cwd, dir);
      if (rel && rel !== '.') lines.push(`${indent}${rel}/`);
      for (const f of files.sort().slice(0, 20)) {
        lines.push(`${indent}  ${f}`);
        fileCount++;
        if (fileCount >= maxFiles) { lines.push('  ... (more files)'); return; }
      }
      for (const d of dirs.sort()) await walk(path.join(dir, d), depth + 1);
    } catch { }
  }

  await walk(cwd, 0);
  return lines.join('\n');
}

async function getLongRunningContext(): Promise<string> {
  const parts: string[] = [];
  const featuresPath = path.resolve(FEATURES_FILE);
  if (fsSync.existsSync(featuresPath)) {
    try {
      const features = JSON.parse(await fs.readFile(featuresPath, 'utf-8'));
      parts.push('## Feature List (from feature_list.json)\n');
      for (const f of features.features ?? []) {
        const status = f.passes ? '[x]' : '[ ]';
        const desc = f.description ?? f.name ?? 'Unknown';
        parts.push(`- ${status} ${desc}`);
      }
    } catch { }
  }
  const progressPath = path.resolve(PROGRESS_FILE);
  if (fsSync.existsSync(progressPath)) {
    try {
      const progress = await fs.readFile(progressPath, 'utf-8');
      if (progress.trim()) parts.push(`\n## Last Session Progress (from PROGRESS.md)\n\n${progress.slice(0, 1500)}`);
    } catch { }
  }
  return parts.join('\n');
}

function checkAllFeaturesComplete(): boolean {
  const featuresPath = path.resolve(FEATURES_FILE);
  if (!fsSync.existsSync(featuresPath)) return false;
  try {
    const features = JSON.parse(fsSync.readFileSync(featuresPath, 'utf-8'));
    for (const f of features.features ?? []) {
      if (!f.passes) return false;
    }
    return true;
  } catch { return false; }
}

function getFeatureProgress(): [number, number] {
  const featuresPath = path.resolve(FEATURES_FILE);
  if (!fsSync.existsSync(featuresPath)) return [0, 0];
  try {
    const features = JSON.parse(fsSync.readFileSync(featuresPath, 'utf-8'));
    const total = (features.features ?? []).length;
    const completed = (features.features ?? []).filter((f: any) => f.passes).length;
    return [completed, total];
  } catch { return [0, 0]; }
}

function checkIncompleteToolCalls(toolBlocks: ToolUseBlock[]): string[] {
  const incomplete: string[] = [];
  for (const tc of toolBlocks) {
    const required = TOOL_REQUIRED_PARAMS[tc.name] ?? [];
    const input = (tc.input ?? {}) as Record<string, unknown>;
    for (const param of required) {
      if (input[param] === undefined || input[param] === null || input[param] === '') {
        incomplete.push(`${tc.name}: missing '${param}'`);
      }
    }
  }
  return incomplete;
}

// ============== 系统提示词 ==============

const SYSTEM_PROMPT = `You are a helpful coding assistant. You can read, write, and edit files, and execute shell commands.

## Large File Handling (IMPORTANT)

**RECOMMENDED LIMIT: 300 lines per write call**

When writing files, plan ahead to avoid truncation:
- Files under 300 lines: safe to write in one call
- Files over 300 lines: write skeleton first, then edit to add sections
- This prevents response truncation and reduces retry overhead

Example approach for large files:
1. write file with basic structure/skeleton (under 300 lines)
2. edit to add first major section
3. edit to add second major section
4. continue until complete

## Error Handling

When a tool call returns an error:
1. STOP and READ the error message carefully
2. DO NOT repeat the same tool call with the same parameters
3. Identify what's wrong (missing parameter? wrong type? wrong path?)
4. Fix the issue BEFORE making another tool call
5. Common errors:
   - "Missing required parameter 'X'" → Add the missing parameter to your JSON
   - "File not found" → Check the path with read or glob first
   - "String not found" → Read the file again to see exact content

## Editing Files

- Always read the file first to understand its current content
- Make precise, targeted edits rather than rewriting entire files
- Preserve the existing code style and formatting

## Shell Commands

- Be careful with destructive operations
- Prefer read-only operations when possible

### Cross-Platform Notes

Different platforms have different commands:
- Move: \`move\` (Windows) vs \`mv\` (Unix/Mac)
- List: \`dir\` (Windows) vs \`ls\` (Unix/Mac)
- Delete: \`del\` (Windows) vs \`rm\` (Unix/Mac)

**IMPORTANT: Directories are created automatically by the \`write\` tool.**
- NEVER use \`mkdir\` before writing files - the write tool handles directory creation
- If you truly need an empty directory: \`mkdir dir\` (Windows) or \`mkdir -p dir\` (Unix)

If you see "不是内部或外部命令" or "not recognized", the command doesn't exist on this platform. Try the equivalent command.

## Multi-step Tasks

- Track your progress by listing what you've done and what's next
- Break complex tasks into smaller steps
- Summarize progress periodically

## Plan Before Action

For any non-trivial task (creating files, editing code, running complex commands):
1. First explain your understanding of the task
2. Outline your approach (what files, what changes, what order)
3. Consider potential issues (edge cases, dependencies, conflicts)
4. Then execute step by step

For simple read-only tasks (reading a file, listing directory), just do it directly.

Always explain what you're doing before taking action.

{context}`;

const LONG_RUNNING_PROMPT = `

## Long-Running Task Mode

You are in a long-running task mode. At the start of EACH session, follow these steps:

1. Note the Working Directory from context. Use relative paths for file operations.
2. Read git logs (\`git log --oneline -10\`) and PROGRESS.md to understand recent work
3. Read feature_list.json and pick ONE incomplete feature (passes: false)
4. **Write a session plan** to .kodax/session_plan.md (see Session Planning section below)
5. Execute the plan step by step, testing as you go
6. End session with: git commit + update PROGRESS.md with plan summary

IMPORTANT Rules:
- Only change \`passes\` field in feature_list.json. NEVER remove or modify features.
- Leave codebase in clean state after each session (no half-implemented features).
- Work on ONE feature at a time. Do not start new features until current one is complete.
- Always verify features work end-to-end before marking as passing.

## Session Planning (CRITICAL for Quality)

Before writing ANY code in this session, you MUST create a plan file:

1. **Write plan** to \`.kodax/session_plan.md\` with this structure (directory will be created automatically):

\`\`\`markdown
# Session Plan

**Date**: [current date]
**Feature**: [feature description from feature_list.json]

## Understanding
[Your understanding of what this feature does and why it's needed]

## Approach
[How you plan to implement this feature - be specific about technical choices]

## Steps
1. [First step - e.g., "Check existing code structure"]
2. [Second step - e.g., "Create user model"]
3. [Third step - e.g., "Add API routes"]
...

## Considerations
- [Edge cases to handle]
- [Dependencies to check first]
- [Security implications]
- [Performance considerations]

## Risks
- [What could go wrong]
- [How to mitigate each risk]
\`\`\`

3. **Execute** the plan step by step
4. **After execution**, update PROGRESS.md with a summary:

\`\`\`markdown
## Session N - [date]

### Plan
[Brief summary of what you planned to do]

### Completed
- [What was actually done]

### Notes
- [Key learnings]
- [Issues encountered and how you solved them]
\`\`\`

This planning step ensures you think through the implementation before coding, leading to higher quality output.

## Efficiency Rules (CRITICAL)

1. Each session MUST complete at least ONE full feature (not just start it)
2. Minimum meaningful code change per session: 50+ lines
3. A single-page display task should be completed in ONE session
4. Avoid re-reading the same files - remember what you've read
5. Write code efficiently - don't over-engineer simple tasks
6. If a feature is taking too long, it might be too large - but don't give up, complete it

## Promise Signals (Ralph-Loop Style)

When you need to communicate status to the orchestrator, use these special signals:

<promise>COMPLETE</promise>
  - Use when ALL features in feature_list.json have passes: true
  - This will stop the auto-continue loop

<promise>BLOCKED:reason</promise>
  - Use when you are stuck and need human intervention
  - Example: <promise>BLOCKED:Need API key for external service</promise>

<promise>DECIDE:question</promise>
  - Use when you need a decision from the user
  - Example: <promise>DECIDE:Should I use PostgreSQL or MongoDB?</promise>

Only use these signals when necessary. Normal operation does not require them.
`;

async function buildSystemPrompt(options: CliOptions, isNewSession: boolean): Promise<string> {
  const contextParts: string[] = [];

  // 环境上下文（始终注入）
  contextParts.push(getEnvContext());

  // 工作目录（始终注入，避免 --auto-continue 后续会话丢失）
  contextParts.push(`Working Directory: ${process.cwd()}`);

  // Git 上下文（仅新会话）
  if (isNewSession) {
    const gitCtx = await getGitContext();
    if (gitCtx) contextParts.push(gitCtx);

    // 项目快照（仅新会话）
    const snapshot = await getProjectSnapshot();
    if (snapshot) contextParts.push(snapshot);
  }

  // 长运行模式检测
  const isLongRunning = fsSync.existsSync(path.resolve(FEATURES_FILE)) && !options.init;
  if (isLongRunning) {
    const longCtx = await getLongRunningContext();
    if (longCtx) contextParts.push(longCtx);
  }

  // 组装系统提示词
  let prompt = SYSTEM_PROMPT.replace('{context}', contextParts.join('\n\n'));

  // 长运行模式增强提示词
  if (isLongRunning) {
    prompt += LONG_RUNNING_PROMPT;
  }

  return prompt;
}

// ============== 主循环 ==============

async function runAgent(options: CliOptions, userPrompt: string): Promise<[boolean, string]> {
  const provider = getProvider(options.provider);
  if (!provider.isConfigured()) {
    console.log(chalk.red(`[Error] Provider "${options.provider}" not configured. Set ${options.provider.toUpperCase().replace('-', '_')}_API_KEY`));
    process.exit(1);
  }

  let sessionId = options.session;
  let messages: Message[] = [];
  let title = '';
  const isNewSession = !sessionId || sessionId === 'resume';

  if (options.session === 'resume') {
    const latest = (await listSessions())[0];
    if (latest) sessionId = latest.id;
  }
  if (sessionId && sessionId !== 'list') {
    const loaded = await loadSession(sessionId);
    if (loaded) { messages = loaded.messages; title = loaded.title; }
  }
  if (!sessionId) sessionId = await generateSessionId();

  messages.push({ role: 'user', content: userPrompt });
  if (!title) title = userPrompt.slice(0, 50) + (userPrompt.length > 50 ? '...' : '');

  const ctx: ToolExecutionContext = {
    confirmTools: options.noConfirm ? new Set() : options.confirm ? new Set(options.confirm.split(',')) : DEFAULT_CONFIRM_TOOLS,
    backups: new Map(),
    noConfirm: options.noConfirm,
  };

  const systemPrompt = await buildSystemPrompt(options, isNewSession);

  const isLongRunning = fsSync.existsSync(path.resolve(FEATURES_FILE)) && !options.init;
  console.log(chalk.cyan(`[KodaX] Provider: ${provider.name} | Session: ${sessionId}`));
  if (isLongRunning) console.log(chalk.cyan(`[KodaX] Long-running mode enabled`));
  if (options.parallel) console.log(chalk.cyan(`[KodaX] Parallel mode enabled`));
  if (ctx.confirmTools.size > 0) console.log(chalk.cyan(`[KodaX] Confirm: ${[...ctx.confirmTools].sort().join(', ')}`));
  console.log();

  let lastText = '';
  let incompleteRetryCount = 0;

  let iter = 0;
  for (; iter < options.maxIter; iter++) {
    try {
      const compacted = compactMessages(messages);

      console.log(chalk.magenta('\n[Assistant]'));
      let stopDots = startWaitingDots();
      const result = await provider.stream(compacted, TOOLS, systemPrompt, options.thinking);
      console.log();

      // 停止任何可能在流式传输期间创建的 spinner（input_json_delta 等）
      if (globalSpinner && !globalSpinner.isStopped()) {
        globalSpinner.stop();
      }
      globalSpinner = null;
      spinnerNewlined = false;  // 重置换行标志，为下一轮迭代准备

      // 如果 spinner 在流式输出期间被停止（text_delta 处理），重启它
      if (stopDots.isStopped()) {
        stopDots = startWaitingDots();
        stopDots.updateText('Processing...');
      }

      lastText = result.textBlocks.map(b => b.text).join(' ');

      // Promise 信号检测
      const [signal, reason] = checkPromiseSignal(lastText);
      if (signal) {
        console.log(chalk.cyan(`[Signal] ${signal}${reason ? `: ${reason}` : ''}`));
        if (signal === 'COMPLETE') {
          stopDots.stop();
          break;
        }
      }

      const assistantContent: ContentBlock[] = [...result.thinkingBlocks, ...result.textBlocks, ...result.toolBlocks];
      messages.push({ role: 'assistant', content: assistantContent });

      if (result.toolBlocks.length === 0) {
        stopDots.stop();
        console.log(chalk.green('\n[KodaX] Done!'));
        break;
      }

      // ============ 检测截断 + 自动重试 ============
      const incomplete = checkIncompleteToolCalls(result.toolBlocks);
      if (incomplete.length > 0) {
        stopDots.stop();  // 停止主 spinner
        incompleteRetryCount++;
        if (incompleteRetryCount <= MAX_INCOMPLETE_RETRIES) {
          console.log(chalk.yellow(`\n[KodaX] Detected incomplete tool call(s): ${incomplete.join(', ')}`));
          console.log(chalk.yellow(`[KodaX] Requesting completion (retry ${incompleteRetryCount}/${MAX_INCOMPLETE_RETRIES})...`));

          const retrySpinner = startWaitingDots();
          retrySpinner.updateText('Retrying...');

          // 移除刚才添加的 assistant message
          messages.pop();

          let retryPrompt: string;
          if (incompleteRetryCount === 1) {
            retryPrompt = `Your previous response was truncated. Missing required parameters:\n${incomplete.map(i => `- ${i}`).join('\n')}\n\nPlease provide the complete tool calls with ALL required parameters.\nFor large content, keep it concise (under 50 lines for write operations).`;
          } else {
            retryPrompt = `⚠️ CRITICAL: Your response was TRUNCATED again. This is retry ${incompleteRetryCount}/${MAX_INCOMPLETE_RETRIES}.\n\nMISSING PARAMETERS:\n${incomplete.map(i => `- ${i}`).join('\n')}\n\nYOU MUST:\n1. For 'write' tool: Keep content under 50 lines - write structure first, fill in later with 'edit'\n2. For 'edit' tool: Keep new_string under 30 lines - make smaller, focused changes\n3. Provide ALL required parameters in your tool call\n\nIf your response is truncated again, the task will FAIL.\nPROVIDE SHORT, COMPLETE PARAMETERS NOW.`;
          }
          messages.push({ role: 'user', content: retryPrompt });

          retrySpinner.stop();
          continue;
        } else {
          console.log(chalk.red(`\n[KodaX] Max retries reached for incomplete tool calls. Proceeding with error messages.`));
          incompleteRetryCount = 0;
        }
      } else {
        incompleteRetryCount = 0;
      }

      // 执行工具
      stopDots.stop();  // 停止主 spinner
      const toolResults: ToolResultBlock[] = [];

      if (options.parallel && result.toolBlocks.length > 1) {
        console.log(chalk.cyan(`\n[KodaX Parallel] Executing ${result.toolBlocks.length} tools...`));

        // 分离 bash（顺序）和非 bash（并行）
        const bashTools = result.toolBlocks.filter(tc => tc.name === 'bash');
        const nonBashTools = result.toolBlocks.filter(tc => tc.name !== 'bash');
        const resultMap = new Map<string, string>();

        // 非 bash 工具并行执行
        if (nonBashTools.length > 0) {
          const promises = nonBashTools.map(tc => executeTool(tc.name, tc.input, ctx).then(r => ({ id: tc.id, content: r })));
          const results = await Promise.all(promises);
          for (const r of results) resultMap.set(r.id, r.content);
        }

        // bash 工具顺序执行（避免 race condition）
        for (const tc of bashTools) {
          const content = await executeTool(tc.name, tc.input, ctx);
          resultMap.set(tc.id, content);
        }

        // 按原始顺序组装结果
        for (const tc of result.toolBlocks) {
          const content = resultMap.get(tc.id) ?? '[Error] No result';
          console.log(chalk.green(`[Result] ${content.slice(0, 200)}${content.length > 200 ? '...' : ''}`));
          toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content });
        }
      } else {
        for (const tc of result.toolBlocks) {
          console.log(chalk.yellow(`\n[Tool] ${tc.name}(${JSON.stringify(tc.input).slice(0, 80)}...)`));
          const toolSpinner = startWaitingDots();
          toolSpinner.updateText(`Executing ${tc.name}...`);
          const content = await executeTool(tc.name, tc.input, ctx);
          toolSpinner.stop();
          console.log(chalk.green(`[Result] ${content.slice(0, 300)}${content.length > 300 ? '...' : ''}`));
          toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content });
        }
      }

      messages.push({ role: 'user', content: toolResults });
      await saveSession(sessionId, messages, title, await getGitRoot() ?? '');
    } catch (e) {
      if (e instanceof Error && e.message.includes('interrupt')) {
        console.log(chalk.yellow('\n[KodaX] Interrupted'));
        break;
      }
      console.log(chalk.red(`\n[Error] ${e instanceof Error ? e.message : String(e)}`));
      break;
    }
  }

  await saveSession(sessionId, messages, title, await getGitRoot() ?? '');
  if (iter >= options.maxIter) {
    console.log(chalk.yellow('\n[KodaX] Max iterations reached'));
  }
  return [true, lastText];
}

// ============== Skill 系统 ==============

async function loadSkills(): Promise<Map<string, { desc: string; content: string }>> {
  const skills = new Map<string, { desc: string; content: string }>();
  const skillsDir = SKILLS_DIR;
  try {
    await fs.mkdir(skillsDir, { recursive: true });
    const files = await fs.readdir(skillsDir);
    for (const f of files) {
      const ext = path.extname(f);
      const skillName = f.replace(ext, '');

      if (ext === '.md') {
        // Markdown prompt skill
        try {
          const content = await fs.readFile(path.join(skillsDir, f), 'utf-8');
          const firstLine = content.split('\n')[0]?.replace(/^#\s*/, '').trim() ?? '';
          const desc = firstLine.slice(0, 60) || '(prompt skill)';
          skills.set(skillName, { desc, content });
        } catch { }
      } else if (ext === '.js' || ext === '.ts') {
        // 可编程 skill（动态导入）
        try {
          const mod = await import(path.join(skillsDir, f));
          for (const [key, value] of Object.entries(mod)) {
            if (key.startsWith('skill_') && typeof value === 'function') {
              const fnName = key.replace('skill_', '');
              const desc = (value as any).description ?? fnName;
              // 可编程 skill 的 content 存储为函数引用描述
              skills.set(fnName, { desc: String(desc).slice(0, 60), content: `[Programmable skill: ${fnName}]` });
            }
          }
        } catch { }
      }
    }
  } catch { }
  return skills;
}

// ============== CLI ==============

async function main() {
  const program = new Command()
    .name('kodax')
    .description('KodaX - 极致轻量化 Coding Agent')
    .version('1.0.0')
    .argument('[prompt...]', 'Your task')
    .option('--provider <name>', 'LLM provider', DEFAULT_PROVIDER)
    .option('--thinking', 'Enable thinking mode')
    .option('--confirm <tools>', 'Tools requiring confirmation')
    .option('--no-confirm', 'Disable confirmations')
    .option('--session <id>', 'Session: resume, list, or ID')
    .option('--parallel', 'Parallel tool execution')
    .option('--team <tasks>', 'Run multiple sub-agents in parallel (comma-separated)')
    .option('--init <task>', 'Initialize a long-running task')
    .option('--append', 'With --init: append to existing feature_list.json')
    .option('--overwrite', 'With --init: overwrite existing feature_list.json')
    .option('--max-iter <n>', 'Max iterations', '50')
    .option('--auto-continue', 'Auto-continue long-running task until all features pass')
    .option('--max-sessions <n>', 'Max sessions for --auto-continue', '50')
    .option('--max-hours <n>', 'Max hours for --auto-continue', '2')
    .parse();

  const opts = program.opts();
  const options: CliOptions = {
    provider: opts.provider ?? DEFAULT_PROVIDER,
    thinking: opts.thinking ?? false,
    noConfirm: opts.noConfirm === true || opts.confirm === false,
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
    prompt: program.args,
  };

  // 会话列表
  if (options.session === 'list') {
    const sessions = await listSessions();
    console.log(sessions.length ? 'Sessions:\n' + sessions.map(s => `  ${s.id} [${s.msgCount}] ${s.title}`).join('\n') : 'No sessions.');
    return;
  }

  let userPrompt = options.prompt.join(' ');

  // --auto-continue: 自动循环
  if (options.autoContinue) {
    if (!fsSync.existsSync(path.resolve(FEATURES_FILE))) {
      console.log(chalk.red(`[Error] --auto-continue requires a long-running project.`));
      console.log(`Run 'kodax --init "your project"' first.`);
      process.exit(1);
    }

    let firstSessionId: string | undefined;
    if (options.session === 'resume') {
      const sessions = await listSessions();
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
      const currentSessionId = sessionCount === 1 ? firstSessionId : undefined;
      const sessionOpts = { ...options, session: currentSessionId };
      const [success, lastText] = await runAgent(sessionOpts, prompt);

      if (!success) {
        console.log(chalk.red(`\n[KodaX Auto-Continue] Session failed, stopping`));
        break;
      }

      const [signal, reason] = checkPromiseSignal(lastText);
      if (signal === 'COMPLETE') {
        console.log('\n' + '='.repeat(60));
        console.log(chalk.green(`[KodaX Auto-Continue] Agent signaled COMPLETE`));
        console.log('='.repeat(60));
        break;
      } else if (signal === 'BLOCKED') {
        console.log('\n' + '='.repeat(60));
        console.log(chalk.yellow(`[KodaX Auto-Continue] Agent BLOCKED: ${reason}`));
        console.log('Waiting for human intervention...');
        console.log('='.repeat(60));
        break;
      } else if (signal === 'DECIDE') {
        console.log('\n' + '='.repeat(60));
        console.log(chalk.cyan(`[KodaX Auto-Continue] Agent needs decision: ${reason}`));
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
    const featuresPath = path.resolve(FEATURES_FILE);

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

    // SubAgent 流式输出锁
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

    // 独立的 SubAgent 运行
    const MAX_SUB_ROUNDS = 10;
    async function runSubAgent(taskIndex: number, task: string): Promise<{ result: string }> {
      const provider = getProvider(options.provider);
      const subCtx: ToolExecutionContext = {
        confirmTools: new Set(), // SubAgent 不需要确认
        backups: new Map(),
        noConfirm: true,
      };
      const subMessages: Message[] = [{ role: 'user', content: task }];
      const basePrompt = await buildSystemPrompt(options, true);
      const systemPrompt = basePrompt + "\n\nYou are a sub-agent working on a specific task. Focus only on your assigned task and provide a concise summary when done.";
      let lastText = '';

      for (let round = 0; round < MAX_SUB_ROUNDS; round++) {
        try {
          await acquireStreamLock();
          const taskPreview = task.slice(0, 50) + (task.length > 50 ? '...' : '');
          console.log(chalk.cyan(`\n[Agent ${taskIndex + 1}] ${chalk.dim(taskPreview)}`));

          let stopDots = startWaitingDots();
          const result = await rateLimitedCall(() =>
            provider.stream(subMessages, TOOLS, systemPrompt, options.thinking)
          );
          stopDots.stop();
          console.log();
          releaseStreamLock();

          lastText = result.textBlocks.map(b => b.text).join(' ');
          const assistantContent: ContentBlock[] = [...result.thinkingBlocks, ...result.textBlocks, ...result.toolBlocks];
          subMessages.push({ role: 'assistant', content: assistantContent });

          if (result.toolBlocks.length === 0) break;

          // 执行工具
          const toolResults: ToolResultBlock[] = [];
          for (const tc of result.toolBlocks) {
            const content = await executeTool(tc.name, tc.input, subCtx);
            toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content });
          }
          subMessages.push({ role: 'user', content: toolResults });
        } catch (e) {
          releaseStreamLock();
          console.log(chalk.red(`\n[Agent ${taskIndex + 1}] Error: ${e instanceof Error ? e.message : String(e)}`));
          break;
        }
      }
      return { result: lastText };
    }

    // 使用 stagger delay 启动所有 SubAgent
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

  // Skill 检查
  if (userPrompt.startsWith('/')) {
    const parts = userPrompt.slice(1).split(/\s+/, 2);
    const skillName = parts[0]!;
    const skills = await loadSkills();
    if (skills.has(skillName)) {
      const skill = skills.get(skillName)!;
      const skillPrompt = parts[1] ? `${skill.content}\n\nContext: ${parts[1]}` : skill.content;
      await runAgent(options, skillPrompt);
      return;
    }
  }

  // 无 prompt 显示帮助
  if (!userPrompt && !options.init) {
    console.log('KodaX - 极致轻量化 Coding Agent\n');
    console.log('Usage: kodax "your task"');
    console.log('       kodax /skill_name\n');
    console.log('Options:');
    console.log('  --provider NAME    LLM provider (anthropic, kimi, kimi-code, qwen, zhipu, openai, zhipu-coding)');
    console.log('  --thinking         Enable thinking mode');
    console.log('  --confirm TOOLS    Tools requiring confirmation');
    console.log('  --no-confirm       Disable all confirmations');
    console.log('  --session ID       Session management (resume, list, or ID)');
    console.log('  --parallel         Enable parallel tool execution');
    console.log('  --team TASKS       Run multiple sub-agents in parallel (comma-separated)');
    console.log('  --init TASK        Initialize a long-running task');
    console.log('  --append           With --init: append to existing feature_list.json');
    console.log('  --overwrite        With --init: overwrite existing feature_list.json');
    console.log('  --max-iter N       Max iterations per session (default: 50)');
    console.log('  --auto-continue    Auto-continue long-running task until all features pass');
    console.log('  --max-sessions N   Max sessions for --auto-continue (default: 50)');
    console.log('  --max-hours H      Max hours for --auto-continue (default: 2.0)\n');
    console.log('Skills:');
    const skills = await loadSkills();
    if (skills.size > 0) {
      for (const [name, info] of skills) console.log(`  /${name.padEnd(15)} ${info.desc}`);
    } else {
      console.log('  (no skills installed in ~/.kodax/skills/)');
    }
    return;
  }

  await runAgent(options, userPrompt);
}

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

main().catch(e => { console.error(chalk.red(`[Error] ${e.message}`)); process.exit(1); });

