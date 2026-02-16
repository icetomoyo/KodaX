/**
 * KodaX Core - 极简 Coding Agent 核心模块
 *
 * 提供纯粹的 Agent 能力，可作为库被其他项目使用
 * 不依赖任何 CLI/UI 库
 */

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

const execAsync = promisify(exec);

// ============== 配置常量 ==============

export const KODAX_MAX_TOKENS = 32768;
export const KODAX_DEFAULT_TIMEOUT = 60;
export const KODAX_HARD_TIMEOUT = 300;
export const KODAX_COMPACT_THRESHOLD = 100000;
export const KODAX_COMPACT_KEEP_RECENT = 10;
export const KODAX_DIR = path.join(os.homedir(), '.kodax');
export const KODAX_SESSIONS_DIR = path.join(KODAX_DIR, 'sessions');

export const KODAX_DEFAULT_PROVIDER = process.env.KODAX_PROVIDER ?? 'zhipu-coding';

// 长时间运行状态文件
export const KODAX_FEATURES_FILE = 'feature_list.json';
export const KODAX_PROGRESS_FILE = 'PROGRESS.md';

// 并行 Agent 配置
export const KODAX_STAGGER_DELAY = 1.0;
export const KODAX_MAX_RETRIES = 3;
export const KODAX_RETRY_BASE_DELAY = 2;
export const KODAX_MAX_INCOMPLETE_RETRIES = 2;

// 全局 API 速率控制
const KODAX_API_MIN_INTERVAL = 0.5;
let lastApiCallTime = 0;
const apiLock = { locked: false, queue: [] as (() => void)[] };

export async function rateLimitedCall<T>(fn: () => Promise<T>): Promise<T> {
  while (apiLock.locked) {
    await new Promise<void>(resolve => apiLock.queue.push(resolve));
  }
  apiLock.locked = true;
  try {
    const elapsed = (Date.now() - lastApiCallTime) / 1000;
    if (elapsed < KODAX_API_MIN_INTERVAL) {
      await new Promise(r => setTimeout(r, (KODAX_API_MIN_INTERVAL - elapsed) * 1000));
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

// Promise 信号模式
const PROMISE_PATTERN = /<promise>(COMPLETE|BLOCKED|DECIDE)(?::(.*?))?<\/promise>/is;

export function checkPromiseSignal(text: string): [string, string] {
  const match = PROMISE_PATTERN.exec(text);
  if (match) return [match[1]!.toUpperCase(), match[2] ?? ''];
  return ['', ''];
}

// ============== 类型定义 ==============

export interface KodaXTextBlock { type: 'text'; text: string; }
export interface KodaXToolUseBlock { type: 'tool_use'; id: string; name: string; input: Record<string, unknown>; }
export interface KodaXToolResultBlock { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean; }
export interface KodaXThinkingBlock { type: 'thinking'; thinking: string; signature?: string; }
export interface KodaXRedactedThinkingBlock { type: 'redacted_thinking'; data: string; }
export type KodaXContentBlock = KodaXTextBlock | KodaXToolUseBlock | KodaXToolResultBlock | KodaXThinkingBlock | KodaXRedactedThinkingBlock;

export interface KodaXStreamResult {
  textBlocks: KodaXTextBlock[];
  toolBlocks: KodaXToolUseBlock[];
  thinkingBlocks: (KodaXThinkingBlock | KodaXRedactedThinkingBlock)[];
}

export interface KodaXMessage {
  role: 'user' | 'assistant';
  content: string | KodaXContentBlock[];
}

export interface KodaXSessionMeta {
  _type: 'meta';
  title: string;
  id: string;
  gitRoot: string;
  createdAt: string;
}

export interface KodaXToolDefinition {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

export interface KodaXProviderConfig {
  apiKeyEnv: string;
  baseUrl?: string;
  model: string;
  supportsThinking: boolean;
}

// ============== 事件接口 ==============

export interface KodaXEvents {
  // 流式输出
  onTextDelta?: (text: string) => void;
  onThinkingDelta?: (text: string, charCount: number) => void;
  onToolUseStart?: (tool: { name: string; id: string }) => void;
  onToolResult?: (result: { id: string; name: string; content: string }) => void;
  onToolInputDelta?: (toolName: string, partialJson: string) => void;

  // 状态通知
  onSessionStart?: (info: { provider: string; sessionId: string }) => void;
  onIterationStart?: (iter: number, maxIter: number) => void;
  onCompact?: (estimatedTokens: number) => void;
  onRetry?: (reason: string, attempt: number, maxAttempts: number) => void;
  onComplete?: () => void;
  onError?: (error: Error) => void;

  // 用户交互（可选，由 CLI 层实现）
  onConfirm?: (tool: string, input: Record<string, unknown>) => Promise<boolean>;
}

// ============== Agent 选项 ==============

export interface KodaXSessionOptions {
  id?: string;
  resume?: boolean;
  storage?: KodaXSessionStorage;
}

export interface KodaXContextOptions {
  gitRoot?: string | null;
  projectSnapshot?: string;
  longRunning?: {
    featuresFile?: string;
    progressFile?: string;
  };
}

export interface KodaXOptions {
  provider: string;
  thinking?: boolean;
  maxIter?: number;
  parallel?: boolean;
  noConfirm?: boolean;
  confirmTools?: Set<string>;
  session?: KodaXSessionOptions;
  context?: KodaXContextOptions;
  events: KodaXEvents;
}

// ============== 结果类型 ==============

export interface KodaXResult {
  success: boolean;
  lastText: string;
  signal?: 'COMPLETE' | 'BLOCKED' | 'DECIDE';
  signalReason?: string;
  messages: KodaXMessage[];
  sessionId: string;
}

// ============== 会话存储接口 ==============

export interface KodaXSessionStorage {
  save(id: string, data: { messages: KodaXMessage[]; title: string; gitRoot: string }): Promise<void>;
  load(id: string): Promise<{ messages: KodaXMessage[]; title: string; gitRoot: string } | null>;
  list?(gitRoot?: string): Promise<Array<{ id: string; title: string; msgCount: number }>>;
}

// ============== 工具执行上下文 ==============

export interface KodaXToolExecutionContext {
  confirmTools: Set<string>;
  backups: Map<string, string>;
  noConfirm: boolean;
  onConfirm?: (tool: string, input: Record<string, unknown>) => Promise<boolean>;
}

// ============== 工具定义 ==============

export const KODAX_TOOLS: KodaXToolDefinition[] = [
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

export const KODAX_TOOL_REQUIRED_PARAMS: Record<string, string[]> = {
  read: ['path'],
  write: ['path', 'content'],
  edit: ['path', 'old_string', 'new_string'],
  bash: ['command'],
  glob: ['pattern'],
  grep: ['pattern', 'path'],
  undo: [],
};

// 全局文件备份（用于 undo）
const FILE_BACKUPS = new Map<string, string>();

// ============== Provider 实现 ==============

export interface KodaXProviderStreamOptions {
  onTextDelta?: (text: string) => void;
  onThinkingDelta?: (text: string) => void;
  onToolInputDelta?: (toolName: string, partialJson: string) => void;
}

export abstract class KodaXBaseProvider {
  abstract readonly name: string;
  abstract readonly supportsThinking: boolean;
  protected abstract readonly config: KodaXProviderConfig;

  abstract stream(
    messages: KodaXMessage[],
    tools: KodaXToolDefinition[],
    system: string,
    thinking?: boolean,
    streamOptions?: KodaXProviderStreamOptions
  ): Promise<KodaXStreamResult>;

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
          // 通知调用方有重试
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

export abstract class KodaXAnthropicCompatProvider extends KodaXBaseProvider {
  abstract override readonly name: string;
  readonly supportsThinking = true;
  protected abstract override readonly config: KodaXProviderConfig;
  protected client!: Anthropic;

  protected initClient(): void {
    this.client = new Anthropic({ apiKey: this.getApiKey(), baseURL: this.config.baseUrl });
  }

  async stream(
    messages: KodaXMessage[],
    tools: KodaXToolDefinition[],
    system: string,
    thinking = false,
    streamOptions?: KodaXProviderStreamOptions
  ): Promise<KodaXStreamResult> {
    return this.withRateLimit(async () => {
      const kwargs: Anthropic.Messages.MessageCreateParams = {
        model: this.config.model,
        max_tokens: KODAX_MAX_TOKENS,
        system,
        messages: this.convertMessages(messages),
        tools: tools as Anthropic.Messages.Tool[],
        stream: true,
      };
      if (thinking) kwargs.thinking = { type: 'enabled', budget_tokens: 10000 };

      const textBlocks: KodaXTextBlock[] = [];
      const toolBlocks: KodaXToolUseBlock[] = [];
      const thinkingBlocks: (KodaXThinkingBlock | KodaXRedactedThinkingBlock)[] = [];

      let currentBlockType: string | null = null;
      let currentText = '';
      let currentThinking = '';
      let currentThinkingSignature = '';
      let currentToolId = '';
      let currentToolName = '';
      let currentToolInput = '';

      const response = await this.client.messages.create(kwargs);

      for await (const event of response as AsyncIterable<Anthropic.Messages.RawMessageStreamEvent>) {
        if (event.type === 'content_block_start') {
          const block = event.content_block;
          currentBlockType = block.type;
          if (block.type === 'thinking') {
            currentThinking = '';
            currentThinkingSignature = (block as any).signature ?? '';
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
            streamOptions?.onThinkingDelta?.(delta.thinking ?? '');
          } else if (delta.type === 'text_delta') {
            currentText += delta.text ?? '';
            streamOptions?.onTextDelta?.(delta.text ?? '');
          } else if (delta.type === 'input_json_delta') {
            currentToolInput += delta.partial_json ?? '';
            streamOptions?.onToolInputDelta?.(currentToolName, delta.partial_json ?? '');
          }
        } else if (event.type === 'content_block_stop') {
          if (currentBlockType === 'thinking') {
            if (currentThinking) {
              thinkingBlocks.push({ type: 'thinking', thinking: currentThinking, signature: currentThinkingSignature });
            }
          } else if (currentBlockType === 'redacted_thinking') {
            const block = (event as any).content_block;
            if (block?.data) {
              thinkingBlocks.push({ type: 'redacted_thinking', data: block.data });
            }
          } else if (currentBlockType === 'text') {
            if (currentText) textBlocks.push({ type: 'text', text: currentText });
          } else if (currentBlockType === 'tool_use') {
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

  private convertMessages(messages: KodaXMessage[]): Anthropic.Messages.MessageParam[] {
    return messages.map(m => {
      if (typeof m.content === 'string') return { role: m.role, content: m.content };
      const content: Anthropic.Messages.ContentBlockParam[] = [];
      // thinking blocks 必须放在最前面
      for (const b of m.content) {
        if (b.type === 'thinking') {
          content.push({ type: 'thinking', thinking: b.thinking, signature: b.signature ?? '' } as any);
        } else if (b.type === 'redacted_thinking') {
          content.push({ type: 'redacted_thinking', data: b.data } as any);
        }
      }
      for (const b of m.content) {
        if (b.type === 'text') content.push({ type: 'text', text: b.text });
      }
      for (const b of m.content) {
        if (b.type === 'tool_use' && m.role === 'assistant') content.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input });
        else if (b.type === 'tool_result' && m.role === 'user') content.push({ type: 'tool_result', tool_use_id: b.tool_use_id, content: b.content });
      }
      return { role: m.role, content } as Anthropic.Messages.MessageParam;
    });
  }
}

class AnthropicProvider extends KodaXAnthropicCompatProvider {
  readonly name = 'anthropic';
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    model: 'claude-sonnet-4-20250514',
    supportsThinking: true,
  };
  constructor() { super(); this.client = new Anthropic({ apiKey: this.getApiKey() }); }
}

class ZhipuCodingProvider extends KodaXAnthropicCompatProvider {
  readonly name = 'zhipu-coding';
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'ZHIPU_API_KEY',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    model: 'glm-5',
    supportsThinking: true,
  };
  constructor() { super(); this.initClient(); }
}

class KimiCodeProvider extends KodaXAnthropicCompatProvider {
  readonly name = 'kimi-code';
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'KIMI_API_KEY',
    baseUrl: 'https://api.kimi.com/coding/',
    model: 'k2p5',
    supportsThinking: true,
  };
  constructor() { super(); this.initClient(); }
}

// ============== OpenAI 兼容 Provider 基类 ==============

export abstract class KodaXOpenAICompatProvider extends KodaXBaseProvider {
  abstract override readonly name: string;
  readonly supportsThinking = false;
  protected abstract override readonly config: KodaXProviderConfig;
  protected client!: OpenAI;

  protected initClient(): void {
    this.client = new OpenAI({ apiKey: this.getApiKey(), baseURL: this.config.baseUrl });
  }

  async stream(
    messages: KodaXMessage[],
    tools: KodaXToolDefinition[],
    system: string,
    _thinking = false,
    streamOptions?: KodaXProviderStreamOptions
  ): Promise<KodaXStreamResult> {
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
        max_tokens: KODAX_MAX_TOKENS,
        stream: true,
      });

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (delta?.content) {
          textContent += delta.content;
          streamOptions?.onTextDelta?.(delta.content);
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const existing = toolCallsMap.get(tc.index) ?? { id: '', name: '', arguments: '' };
            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) existing.name = tc.function.name;
            if (tc.function?.arguments) {
              existing.arguments += tc.function.arguments;
              streamOptions?.onToolInputDelta?.(existing.name, tc.function.arguments);
            }
            toolCallsMap.set(tc.index, existing);
          }
        }
      }

      const textBlocks: KodaXTextBlock[] = textContent ? [{ type: 'text', text: textContent }] : [];
      const toolBlocks: KodaXToolUseBlock[] = [];
      for (const [, tc] of toolCallsMap) {
        if (tc.id && tc.name) {
          try { toolBlocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: JSON.parse(tc.arguments) }); }
          catch { toolBlocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: {} }); }
        }
      }
      return { textBlocks, toolBlocks, thinkingBlocks: [] };
    });
  }

  private convertMessages(messages: KodaXMessage[]): OpenAI.Chat.ChatCompletionMessageParam[] {
    return messages.map(m => {
      if (typeof m.content === 'string') return { role: m.role, content: m.content };
      const text = (m.content as KodaXContentBlock[]).filter((b): b is KodaXTextBlock => b.type === 'text').map(b => b.text).join('\n');
      return { role: m.role, content: text };
    });
  }
}

class OpenAIProvider extends KodaXOpenAICompatProvider {
  readonly name = 'openai';
  protected readonly config: KodaXProviderConfig = { apiKeyEnv: 'OPENAI_API_KEY', model: 'gpt-4o', supportsThinking: false };
  constructor() { super(); this.initClient(); }
}

class KimiProvider extends KodaXOpenAICompatProvider {
  readonly name = 'kimi';
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'KIMI_API_KEY', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-128k', supportsThinking: false,
  };
  constructor() { super(); this.initClient(); }
}

class QwenProvider extends KodaXOpenAICompatProvider {
  readonly name = 'qwen';
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'QWEN_API_KEY', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-max', supportsThinking: false,
  };
  constructor() { super(); this.initClient(); }
}

class ZhipuProvider extends KodaXOpenAICompatProvider {
  readonly name = 'zhipu';
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'ZHIPU_API_KEY', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus', supportsThinking: false,
  };
  constructor() { super(); this.initClient(); }
}

// ============== Provider 工厂 ==============

export const KODAX_PROVIDERS: Record<string, () => KodaXBaseProvider> = {
  anthropic: () => new AnthropicProvider(),
  openai: () => new OpenAIProvider(),
  kimi: () => new KimiProvider(),
  'kimi-code': () => new KimiCodeProvider(),
  qwen: () => new QwenProvider(),
  zhipu: () => new ZhipuProvider(),
  'zhipu-coding': () => new ZhipuCodingProvider(),
};

export function getProvider(name?: string): KodaXBaseProvider {
  const n = name ?? KODAX_DEFAULT_PROVIDER;
  const factory = KODAX_PROVIDERS[n];
  if (!factory) throw new Error(`Unknown provider: ${n}. Available: ${Object.keys(KODAX_PROVIDERS).join(', ')}`);
  return factory();
}

// ============== 工具执行 ==============

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext
): Promise<string> {
  const required = KODAX_TOOL_REQUIRED_PARAMS[name] ?? [];
  for (const p of required) {
    if (input[p] === undefined) return `[Tool Error] ${name}: Missing required parameter '${p}'`;
  }

  if (ctx.confirmTools.has(name) && !ctx.noConfirm) {
    const confirmed = ctx.onConfirm ? await ctx.onConfirm(name, input) : true;
    if (!confirmed) return 'Operation cancelled by user';
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

async function toolWrite(input: Record<string, unknown>, ctx: KodaXToolExecutionContext): Promise<string> {
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

async function toolEdit(input: Record<string, unknown>, ctx: KodaXToolExecutionContext): Promise<string> {
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
  const timeout = userTimeout ? Math.min(KODAX_HARD_TIMEOUT, userTimeout) : KODAX_DEFAULT_TIMEOUT;
  const capped = userTimeout && userTimeout > KODAX_HARD_TIMEOUT;

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
      if (capped) out += `\n[Note] Timeout capped at ${KODAX_HARD_TIMEOUT}s`;
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

  const stat = fsSync.existsSync(resolvedPath) ? fsSync.statSync(resolvedPath) : null;
  if (stat?.isFile()) {
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

async function toolUndo(ctx: KodaXToolExecutionContext): Promise<string> {
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

// ============== 上下文获取 ==============

export async function getGitRoot(): Promise<string | null> {
  try { const { stdout } = await execAsync('git rev-parse --show-toplevel'); return stdout.trim(); } catch { return null; }
}

export async function getGitContext(): Promise<string> {
  try {
    const { stdout: check } = await execAsync('git rev-parse --is-inside-work-tree');
    if (!check.trim()) return '';

    const lines: string[] = [];

    try {
      const { stdout: branch } = await execAsync('git branch --show-current');
      if (branch.trim()) lines.push(`Git Branch: ${branch.trim()}`);
    } catch { }

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

export function getEnvContext(): string {
  const p = process.platform;
  const isWin = p === 'win32';
  const cmdHint = isWin
    ? 'Use: dir, move, copy, del'
    : 'Use: ls, mv, cp, rm';
  return `Platform: ${isWin ? 'Windows' : p === 'darwin' ? 'macOS' : 'Linux'}\n${cmdHint}\nNode: ${process.version}`;
}

// ============== Token 估算 ==============

export function estimateTokens(messages: KodaXMessage[]): number {
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

export function compactMessages(messages: KodaXMessage[]): KodaXMessage[] {
  if (estimateTokens(messages) <= KODAX_COMPACT_THRESHOLD) return messages;
  const recent = messages.slice(-KODAX_COMPACT_KEEP_RECENT);
  const old = messages.slice(0, -KODAX_COMPACT_KEEP_RECENT);
  const summary = old.map(m => {
    const content = typeof m.content === 'string' ? m.content : (m.content as KodaXContentBlock[]).filter((b): b is KodaXTextBlock => b.type === 'text').map(b => b.text).join(' ');
    return `- ${m.role}: ${content.slice(0, 100)}...`;
  }).join('\n');
  return [{ role: 'user', content: `[对话历史摘要]\n${summary}` }, ...recent];
}

// ============== 项目快照 ==============

export async function getProjectSnapshot(maxDepth = 2, maxFiles = 50): Promise<string> {
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

// ============== 长运行任务辅助 ==============

export async function getLongRunningContext(): Promise<string> {
  const parts: string[] = [];
  const featuresPath = path.resolve(KODAX_FEATURES_FILE);
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
  const progressPath = path.resolve(KODAX_PROGRESS_FILE);
  if (fsSync.existsSync(progressPath)) {
    try {
      const progress = await fs.readFile(progressPath, 'utf-8');
      if (progress.trim()) parts.push(`\n## Last Session Progress (from PROGRESS.md)\n\n${progress.slice(0, 1500)}`);
    } catch { }
  }
  return parts.join('\n');
}

export function checkAllFeaturesComplete(): boolean {
  const featuresPath = path.resolve(KODAX_FEATURES_FILE);
  if (!fsSync.existsSync(featuresPath)) return false;
  try {
    const features = JSON.parse(fsSync.readFileSync(featuresPath, 'utf-8'));
    for (const f of features.features ?? []) {
      if (!f.passes) return false;
    }
    return true;
  } catch { return false; }
}

export function getFeatureProgress(): [number, number] {
  const featuresPath = path.resolve(KODAX_FEATURES_FILE);
  if (!fsSync.existsSync(featuresPath)) return [0, 0];
  try {
    const features = JSON.parse(fsSync.readFileSync(featuresPath, 'utf-8'));
    const total = (features.features ?? []).length;
    const completed = (features.features ?? []).filter((f: any) => f.passes).length;
    return [completed, total];
  } catch { return [0, 0]; }
}

export function checkIncompleteToolCalls(toolBlocks: KodaXToolUseBlock[]): string[] {
  const incomplete: string[] = [];
  for (const tc of toolBlocks) {
    const required = KODAX_TOOL_REQUIRED_PARAMS[tc.name] ?? [];
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

export async function buildSystemPrompt(options: KodaXOptions, isNewSession: boolean): Promise<string> {
  const contextParts: string[] = [];

  contextParts.push(getEnvContext());
  contextParts.push(`Working Directory: ${process.cwd()}`);

  if (isNewSession) {
    const gitCtx = await getGitContext();
    if (gitCtx) contextParts.push(gitCtx);

    const snapshot = await getProjectSnapshot();
    if (snapshot) contextParts.push(snapshot);
  }

  const isLongRunning = fsSync.existsSync(path.resolve(KODAX_FEATURES_FILE)) && !options.context?.longRunning;
  if (isLongRunning) {
    const longCtx = await getLongRunningContext();
    if (longCtx) contextParts.push(longCtx);
  }

  let prompt = SYSTEM_PROMPT.replace('{context}', contextParts.join('\n\n'));

  if (isLongRunning) {
    prompt += LONG_RUNNING_PROMPT;
  }

  return prompt;
}

// ============== 会话管理 ==============

export async function generateSessionId(): Promise<string> {
  const now = new Date();
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
}

// ============== 核心 Agent 函数 ==============

export async function runKodaX(
  options: KodaXOptions,
  prompt: string
): Promise<KodaXResult> {
  const provider = getProvider(options.provider);
  if (!provider.isConfigured()) {
    throw new Error(`Provider "${options.provider}" not configured. Set ${options.provider.toUpperCase().replace('-', '_')}_API_KEY`);
  }

  const maxIter = options.maxIter ?? 50;
  const sessionId = options.session?.id ?? await generateSessionId();
  const events = options.events;

  // 加载或初始化消息
  let messages: KodaXMessage[] = [];
  let title = '';

  if (options.session?.storage && options.session.id) {
    const loaded = await options.session.storage.load(options.session.id);
    if (loaded) {
      messages = loaded.messages;
      title = loaded.title;
    }
  }

  messages.push({ role: 'user', content: prompt });
  if (!title) title = prompt.slice(0, 50) + (prompt.length > 50 ? '...' : '');

  const ctx: KodaXToolExecutionContext = {
    confirmTools: options.confirmTools ?? new Set(['bash', 'write', 'edit']),
    backups: new Map(),
    noConfirm: options.noConfirm ?? false,
    onConfirm: events.onConfirm,
  };

  const systemPrompt = await buildSystemPrompt(options, messages.length === 1);

  // 通知会话开始
  events.onSessionStart?.({ provider: provider.name, sessionId });

  let lastText = '';
  let incompleteRetryCount = 0;

  for (let iter = 0; iter < maxIter; iter++) {
    try {
      events.onIterationStart?.(iter + 1, maxIter);

      const compacted = compactMessages(messages);
      if (compacted !== messages) {
        events.onCompact?.(estimateTokens(messages));
      }

      // 流式调用 Provider
      const result = await provider.stream(compacted, KODAX_TOOLS, systemPrompt, options.thinking, {
        onTextDelta: (text) => events.onTextDelta?.(text),
        onThinkingDelta: (text) => events.onThinkingDelta?.(text, 0),
        onToolInputDelta: (name, json) => events.onToolInputDelta?.(name, json),
      });

      lastText = result.textBlocks.map(b => b.text).join(' ');

      // Promise 信号检测
      const [signal, reason] = checkPromiseSignal(lastText);
      if (signal) {
        if (signal === 'COMPLETE') {
          events.onComplete?.();
          return {
            success: true,
            lastText,
            signal: 'COMPLETE',
            messages,
            sessionId,
          };
        }
      }

      const assistantContent: KodaXContentBlock[] = [...result.thinkingBlocks, ...result.textBlocks, ...result.toolBlocks];
      messages.push({ role: 'assistant', content: assistantContent });

      if (result.toolBlocks.length === 0) {
        events.onComplete?.();
        break;
      }

      // 检测截断 + 自动重试
      const incomplete = checkIncompleteToolCalls(result.toolBlocks);
      if (incomplete.length > 0) {
        incompleteRetryCount++;
        if (incompleteRetryCount <= KODAX_MAX_INCOMPLETE_RETRIES) {
          events.onRetry?.(`Incomplete tool calls: ${incomplete.join(', ')}`, incompleteRetryCount, KODAX_MAX_INCOMPLETE_RETRIES);
          messages.pop();
          let retryPrompt: string;
          if (incompleteRetryCount === 1) {
            retryPrompt = `Your previous response was truncated. Missing required parameters:\n${incomplete.map(i => `- ${i}`).join('\n')}\n\nPlease provide the complete tool calls with ALL required parameters.\nFor large content, keep it concise (under 50 lines for write operations).`;
          } else {
            retryPrompt = `⚠️ CRITICAL: Your response was TRUNCATED again. This is retry ${incompleteRetryCount}/${KODAX_MAX_INCOMPLETE_RETRIES}.\n\nMISSING PARAMETERS:\n${incomplete.map(i => `- ${i}`).join('\n')}\n\nYOU MUST:\n1. For 'write' tool: Keep content under 50 lines - write structure first, fill in later with 'edit'\n2. For 'edit' tool: Keep new_string under 30 lines - make smaller, focused changes\n3. Provide ALL required parameters in your tool call\n\nIf your response is truncated again, the task will FAIL.\nPROVIDE SHORT, COMPLETE PARAMETERS NOW.`;
          }
          messages.push({ role: 'user', content: retryPrompt });
          continue;
        } else {
          incompleteRetryCount = 0;
        }
      } else {
        incompleteRetryCount = 0;
      }

      // 执行工具
      const toolResults: KodaXToolResultBlock[] = [];

      if (options.parallel && result.toolBlocks.length > 1) {
        // 分离 bash（顺序）和非 bash（并行）
        const bashTools = result.toolBlocks.filter(tc => tc.name === 'bash');
        const nonBashTools = result.toolBlocks.filter(tc => tc.name !== 'bash');
        const resultMap = new Map<string, string>();

        if (nonBashTools.length > 0) {
          const promises = nonBashTools.map(tc => executeTool(tc.name, tc.input, ctx).then(r => ({ id: tc.id, content: r })));
          const results = await Promise.all(promises);
          for (const r of results) resultMap.set(r.id, r.content);
        }

        for (const tc of bashTools) {
          const content = await executeTool(tc.name, tc.input, ctx);
          resultMap.set(tc.id, content);
        }

        for (const tc of result.toolBlocks) {
          const content = resultMap.get(tc.id) ?? '[Error] No result';
          events.onToolResult?.({ id: tc.id, name: tc.name, content });
          toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content });
        }
      } else {
        for (const tc of result.toolBlocks) {
          events.onToolUseStart?.({ name: tc.name, id: tc.id });
          const content = await executeTool(tc.name, tc.input, ctx);
          events.onToolResult?.({ id: tc.id, name: tc.name, content });
          toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content });
        }
      }

      messages.push({ role: 'user', content: toolResults });

      // 保存会话
      if (options.session?.storage) {
        await options.session.storage.save(sessionId, { messages, title, gitRoot: await getGitRoot() ?? '' });
      }
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      events.onError?.(error);
      return {
        success: false,
        lastText,
        messages,
        sessionId,
      };
    }
  }

  // 最终保存
  if (options.session?.storage) {
    await options.session.storage.save(sessionId, { messages, title, gitRoot: await getGitRoot() ?? '' });
  }

  // 检查最终信号
  const [finalSignal, finalReason] = checkPromiseSignal(lastText);

  return {
    success: true,
    lastText,
    signal: finalSignal as 'COMPLETE' | 'BLOCKED' | 'DECIDE' | undefined,
    signalReason: finalReason,
    messages,
    sessionId,
  };
}

// ============== 高级模式 - Client 类 ==============

export class KodaXClient {
  private options: KodaXOptions;
  private sessionId: string;
  private messages: KodaXMessage[] = [];

  constructor(options: KodaXOptions) {
    this.options = options;
    this.sessionId = options.session?.id ?? '';
  }

  async send(prompt: string): Promise<KodaXResult> {
    const result = await runKodaX(
      {
        ...this.options,
        session: {
          ...this.options.session,
          id: this.sessionId || undefined,
        },
      },
      prompt
    );

    this.sessionId = result.sessionId;
    this.messages = result.messages;
    return result;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getMessages(): KodaXMessage[] {
    return [...this.messages];
  }

  clear(): void {
    this.messages = [];
    this.sessionId = '';
  }
}
