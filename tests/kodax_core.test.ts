/**
 * KodaX 单元测试
 *
 * 测试核心功能函数，从 kodax_core 导入
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';

// 从 kodax_core 导入函数
import {
  checkPromiseSignal,
  estimateTokens,
  getEnvContext,
  checkIncompleteToolCalls,
  KODAX_TOOLS,
  KODAX_TOOL_REQUIRED_PARAMS,
  KODAX_PROVIDERS,
  getProvider,
  runKodaX,
  KodaXClient,
  compactMessages,
} from '../src/kodax_core.js';

// ============== 模拟测试环境 ==============

const TEST_DIR = path.join(os.tmpdir(), 'kodax-test-' + Date.now());

// ============== Spinner 函数（用于 CLI 层测试）==============

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_COLORS = ['\x1b[36m', '\x1b[35m', '\x1b[34m'];

function createTestableSpinner(
  writeFn: (text: string) => void = (text) => process.stdout.write(text),
  setIntervalFn?: (cb: () => void, ms: number) => unknown
): { stop: () => void; updateText: (text: string) => void; isStopped: () => boolean; getFrameCount: () => number } {
  let frame = 0;
  let colorIdx = 0;
  let stopped = false;
  let currentText = 'Thinking...';

  const renderFrame = () => {
    if (stopped) return;
    const color = SPINNER_COLORS[colorIdx % SPINNER_COLORS.length];
    const reset = '\x1b[0m';
    const spinner = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
    writeFn(`\r${color}${spinner}${reset} ${currentText}    `);
  };

  const interval = (setIntervalFn ?? setInterval)(() => {
    frame++;
    if (frame % 10 === 0) colorIdx++;
    renderFrame();
  }, 80);

  renderFrame();

  const controller = {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(interval as ReturnType<typeof setInterval>);
      writeFn('\r                                        \r');
    },
    isStopped: () => stopped,
    updateText: (text: string) => {
      currentText = text;
    },
    getFrameCount: () => frame,
  };

  return controller;
}

// ============== Core 模块导出测试 ==============

describe('Core Module Exports', () => {
  it('should export runKodaX function', () => {
    expect(typeof runKodaX).toBe('function');
  });

  it('should export KodaXClient class', () => {
    expect(typeof KodaXClient).toBe('function');
  });

  it('should export KODAX_TOOLS array', () => {
    expect(Array.isArray(KODAX_TOOLS)).toBe(true);
    expect(KODAX_TOOLS.length).toBe(7);
  });

  it('should export KODAX_TOOL_REQUIRED_PARAMS', () => {
    expect(typeof KODAX_TOOL_REQUIRED_PARAMS).toBe('object');
    expect(KODAX_TOOL_REQUIRED_PARAMS.read).toContain('path');
    expect(KODAX_TOOL_REQUIRED_PARAMS.write).toContain('path');
    expect(KODAX_TOOL_REQUIRED_PARAMS.write).toContain('content');
  });

  it('should export KODAX_PROVIDERS', () => {
    expect(typeof KODAX_PROVIDERS).toBe('object');
    expect(Object.keys(KODAX_PROVIDERS)).toContain('anthropic');
    expect(Object.keys(KODAX_PROVIDERS)).toContain('openai');
    expect(Object.keys(KODAX_PROVIDERS)).toContain('zhipu-coding');
  });

  it('should export getProvider function', () => {
    expect(typeof getProvider).toBe('function');
  });

  it('should export compactMessages function', () => {
    expect(typeof compactMessages).toBe('function');
  });
});

// ============== Promise 信号检测测试 ==============

describe('Promise Signal Detection', () => {
  it('should detect COMPLETE signal', () => {
    const [signal, reason] = checkPromiseSignal('<promise>COMPLETE</promise>');
    expect(signal).toBe('COMPLETE');
    expect(reason).toBe('');
  });

  it('should detect BLOCKED signal with reason', () => {
    const [signal, reason] = checkPromiseSignal('<promise>BLOCKED:Need API key</promise>');
    expect(signal).toBe('BLOCKED');
    expect(reason).toBe('Need API key');
  });

  it('should detect DECIDE signal with question', () => {
    const [signal, reason] = checkPromiseSignal('<promise>DECIDE:Use PostgreSQL or MongoDB?</promise>');
    expect(signal).toBe('DECIDE');
    expect(reason).toBe('Use PostgreSQL or MongoDB?');
  });

  it('should return empty for no signal', () => {
    const [signal, reason] = checkPromiseSignal('Just normal text without signal');
    expect(signal).toBe('');
    expect(reason).toBe('');
  });

  it('should be case insensitive', () => {
    const [signal] = checkPromiseSignal('<promise>complete</promise>');
    expect(signal).toBe('COMPLETE');
  });
});

// ============== 环境上下文测试 ==============

describe('Environment Context', () => {
  it('should return platform info', () => {
    const ctx = getEnvContext();
    expect(ctx).toContain('Platform:');
    expect(ctx).toContain('Node:');
  });

  it('should include command hints', () => {
    const ctx = getEnvContext();
    expect(ctx).toContain('Use:');
  });

  it('should include mkdir hint for platform', () => {
    const ctx = getEnvContext();
    if (process.platform === 'win32') {
      expect(ctx).toContain('dir');
    } else {
      expect(ctx).toContain('ls');
    }
  });
});

// ============== Token 估算测试 ==============

describe('Token Estimation', () => {
  it('should estimate tokens for message array', () => {
    const messages = [
      { role: 'user' as const, content: 'Hello World' },
      { role: 'assistant' as const, content: 'Hi there!' },
    ];
    const tokens = estimateTokens(messages);
    expect(tokens).toBeGreaterThan(0);
  });

  it('should handle empty message array', () => {
    const tokens = estimateTokens([]);
    expect(tokens).toBe(0);
  });
});

// ============== 不完整工具调用检测测试 ==============

describe('Incomplete Tool Call Detection', () => {
  it('should detect missing path in read tool', () => {
    const toolBlocks = [{ type: 'tool_use' as const, id: '1', name: 'read', input: {} }];
    const incomplete = checkIncompleteToolCalls(toolBlocks);
    expect(incomplete).toContain("read: missing 'path'");
  });

  it('should detect missing content in write tool', () => {
    const toolBlocks = [{ type: 'tool_use' as const, id: '1', name: 'write', input: { path: '/test.txt' } }];
    const incomplete = checkIncompleteToolCalls(toolBlocks);
    expect(incomplete).toContain("write: missing 'content'");
  });

  it('should detect missing parameters in edit tool', () => {
    const toolBlocks = [{ type: 'tool_use' as const, id: '1', name: 'edit', input: { path: '/test.txt' } }];
    const incomplete = checkIncompleteToolCalls(toolBlocks);
    expect(incomplete).toContain("edit: missing 'old_string'");
    expect(incomplete).toContain("edit: missing 'new_string'");
  });

  it('should detect missing command in bash tool', () => {
    const toolBlocks = [{ type: 'tool_use' as const, id: '1', name: 'bash', input: {} }];
    const incomplete = checkIncompleteToolCalls(toolBlocks);
    expect(incomplete).toContain("bash: missing 'command'");
  });

  it('should return empty for complete tool calls', () => {
    const toolBlocks = [
      { type: 'tool_use' as const, id: '1', name: 'read', input: { path: '/test.txt' } },
      { type: 'tool_use' as const, id: '2', name: 'write', input: { path: '/test.txt', content: 'hello' } },
    ];
    const incomplete = checkIncompleteToolCalls(toolBlocks);
    expect(incomplete).toHaveLength(0);
  });

  it('should not require parameters for undo tool', () => {
    const toolBlocks = [{ type: 'tool_use' as const, id: '1', name: 'undo', input: {} }];
    const incomplete = checkIncompleteToolCalls(toolBlocks);
    expect(incomplete).toHaveLength(0);
  });
});

// ============== 文件操作测试 ==============

describe('File Operations', () => {
  beforeEach(async () => {
    await fs.mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  });

  it('should create and read file', async () => {
    const filePath = path.join(TEST_DIR, 'test.txt');
    const content = 'Hello KodaX!';

    await fs.writeFile(filePath, content, 'utf-8');
    const readContent = await fs.readFile(filePath, 'utf-8');

    expect(readContent).toBe(content);
  });

  it('should create nested directories', async () => {
    const nestedDir = path.join(TEST_DIR, 'a', 'b', 'c');
    await fs.mkdir(nestedDir, { recursive: true });
    expect(fsSync.existsSync(nestedDir)).toBe(true);
  });

  it('should list directory contents', async () => {
    await fs.writeFile(path.join(TEST_DIR, 'file1.txt'), '');
    await fs.writeFile(path.join(TEST_DIR, 'file2.txt'), '');

    const files = await fs.readdir(TEST_DIR);
    expect(files).toContain('file1.txt');
    expect(files).toContain('file2.txt');
  });
});

// ============== 跨平台命令提示测试 ==============

describe('Cross-Platform Command Hints', () => {
  it('should provide correct command hints for current platform', () => {
    const ctx = getEnvContext();
    const isWin = process.platform === 'win32';

    if (isWin) {
      expect(ctx).toContain('dir');
      expect(ctx).toContain('move');
    } else {
      expect(ctx).toContain('ls');
      expect(ctx).toContain('mv');
    }
  });
});

// ============== Spinner 测试 (CLI 层) ==============

describe('Spinner Animation', () => {
  it('should render first frame immediately', () => {
    const writes: string[] = [];
    const mockWrite = (text: string) => { writes.push(text); };
    const mockSetInterval = () => 123;

    const spinner = createTestableSpinner(mockWrite, mockSetInterval);

    expect(writes.length).toBe(1);
    expect(writes[0]).toContain('Thinking...');
    expect(spinner.isStopped()).toBe(false);
  });

  it('should stop spinner and clear line', () => {
    const writes: string[] = [];
    const mockWrite = (text: string) => { writes.push(text); };
    const mockSetInterval = () => 123;

    const spinner = createTestableSpinner(mockWrite, mockSetInterval);

    expect(spinner.isStopped()).toBe(false);
    spinner.stop();

    expect(spinner.isStopped()).toBe(true);
    expect(writes.length).toBe(2);
    expect(writes[1]).toMatch(/^\r\s+\r$/);
  });

  it('should not stop twice', () => {
    const writes: string[] = [];
    const mockWrite = (text: string) => { writes.push(text); };
    const mockSetInterval = () => 123;

    const spinner = createTestableSpinner(mockWrite, mockSetInterval);

    spinner.stop();
    const writeCountAfterFirstStop = writes.length;
    spinner.stop();

    expect(writes.length).toBe(writeCountAfterFirstStop);
  });

  it('should update text', () => {
    const writes: string[] = [];
    const mockWrite = (text: string) => { writes.push(text); };
    const mockSetInterval = () => 123;

    const spinner = createTestableSpinner(mockWrite, mockSetInterval);

    expect(writes[0]).toContain('Thinking...');
    spinner.updateText('Processing...');
    spinner.stop();

    expect(writes.length).toBe(2);
  });

  it('should use correct spinner frames', () => {
    const writes: string[] = [];
    const mockWrite = (text: string) => { writes.push(text); };
    const mockSetInterval = () => 123;

    createTestableSpinner(mockWrite, mockSetInterval);

    expect(writes[0]).toContain(SPINNER_FRAMES[0]);
  });

  it('should use color codes', () => {
    const writes: string[] = [];
    const mockWrite = (text: string) => { writes.push(text); };
    const mockSetInterval = () => 123;

    createTestableSpinner(mockWrite, mockSetInterval);

    expect(writes[0]).toContain('\x1b[');
  });
});

// ============== 工具定义测试 ==============

describe('Tool Definitions', () => {
  it('should have all 7 tools', () => {
    const toolNames = KODAX_TOOLS.map(t => t.name);
    expect(toolNames).toContain('read');
    expect(toolNames).toContain('write');
    expect(toolNames).toContain('edit');
    expect(toolNames).toContain('bash');
    expect(toolNames).toContain('glob');
    expect(toolNames).toContain('grep');
    expect(toolNames).toContain('undo');
  });

  it('should have proper schema for read tool', () => {
    const readTool = KODAX_TOOLS.find(t => t.name === 'read');
    expect(readTool).toBeDefined();
    expect(readTool!.input_schema.required).toContain('path');
  });

  it('should have proper schema for write tool', () => {
    const writeTool = KODAX_TOOLS.find(t => t.name === 'write');
    expect(writeTool).toBeDefined();
    expect(writeTool!.input_schema.required).toContain('path');
    expect(writeTool!.input_schema.required).toContain('content');
  });
});

// ============== Provider 测试 ==============

describe('Provider System', () => {
  it('should have 7 providers', () => {
    const providerCount = Object.keys(KODAX_PROVIDERS).length;
    expect(providerCount).toBe(7);
  });

  it('should throw error for unknown provider', () => {
    expect(() => getProvider('unknown-provider')).toThrow();
  });

  it('should return provider for valid name', () => {
    const provider = getProvider('zhipu-coding');
    expect(provider).toBeDefined();
    expect(provider.name).toBe('zhipu-coding');
  });
});

// ============== Compact Messages 测试 ==============

describe('Compact Messages', () => {
  it('should return same messages if under threshold', () => {
    const messages = [
      { role: 'user' as const, content: 'Hello' },
      { role: 'assistant' as const, content: 'Hi!' },
    ];
    const compacted = compactMessages(messages);
    expect(compacted).toEqual(messages);
  });
});
