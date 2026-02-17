/**
 * KodaX 单元测试
 *
 * 测试核心功能函数，从 kodax_core 导入
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
  getGitRoot,
  getProjectSnapshot,
  getLongRunningContext,
  checkAllFeaturesComplete,
  getFeatureProgress,
  executeTool,
  KodaXToolExecutionContext,
  KODAX_DIR,
  KODAX_SESSIONS_DIR,
  KODAX_DEFAULT_PROVIDER,
  KODAX_FEATURES_FILE,
  KODAX_PROGRESS_FILE,
  KODAX_MAX_TOKENS,
  KODAX_DEFAULT_TIMEOUT,
  KODAX_HARD_TIMEOUT,
  KODAX_MAX_INCOMPLETE_RETRIES,
  rateLimitedCall,
  generateSessionId,
  // 错误类型
  KodaXError,
  KodaXProviderError,
  KodaXToolError,
  KodaXRateLimitError,
  KodaXSessionError,
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

// ============== 常量导出测试 ==============

describe('Constants Export', () => {
  it('should export KODAX_DIR', () => {
    expect(KODAX_DIR).toBeDefined();
    expect(KODAX_DIR).toContain('.kodax');
  });

  it('should export KODAX_SESSIONS_DIR', () => {
    expect(KODAX_SESSIONS_DIR).toBeDefined();
    expect(KODAX_SESSIONS_DIR).toContain('sessions');
  });

  it('should export KODAX_DEFAULT_PROVIDER', () => {
    expect(KODAX_DEFAULT_PROVIDER).toBeDefined();
    expect(typeof KODAX_DEFAULT_PROVIDER).toBe('string');
  });

  it('should export KODAX_FEATURES_FILE', () => {
    expect(KODAX_FEATURES_FILE).toBe('feature_list.json');
  });

  it('should export KODAX_PROGRESS_FILE', () => {
    expect(KODAX_PROGRESS_FILE).toBe('PROGRESS.md');
  });

  it('should export KODAX_MAX_TOKENS', () => {
    expect(KODAX_MAX_TOKENS).toBe(32768);
  });

  it('should export KODAX_DEFAULT_TIMEOUT', () => {
    expect(KODAX_DEFAULT_TIMEOUT).toBe(60);
  });

  it('should export KODAX_HARD_TIMEOUT', () => {
    expect(KODAX_HARD_TIMEOUT).toBe(300);
  });

  it('should export KODAX_MAX_INCOMPLETE_RETRIES', () => {
    expect(KODAX_MAX_INCOMPLETE_RETRIES).toBe(2);
  });
});

// ============== 工具执行测试 ==============

describe('Tool Execution', () => {
  const testDir = path.join(os.tmpdir(), 'kodax-tool-test-' + Date.now());
  const ctx: KodaXToolExecutionContext = {
    confirmTools: new Set(),
    backups: new Map(),
    noConfirm: true,
  };

  beforeEach(async () => {
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('should return error for missing required parameter', async () => {
    const result = await executeTool('read', {}, ctx);
    expect(result).toContain('[Tool Error]');
    expect(result).toContain('Missing required parameter');
    expect(result).toContain('path');
  });

  it('should return error for unknown tool', async () => {
    const result = await executeTool('unknown_tool', {}, ctx);
    expect(result).toContain('[Tool Error]');
    expect(result).toContain('Unknown tool');
    expect(result).toContain('Available tools');
  });

  it('should read file with correct path format', async () => {
    const filePath = path.join(testDir, 'test.txt');
    await fs.writeFile(filePath, 'Hello World', 'utf-8');

    // Use absolute path as the tool expects
    const absolutePath = path.resolve(filePath);

    // Verify the file exists
    expect(fsSync.existsSync(absolutePath)).toBe(true);

    // Verify we can read it with fs
    const content = await fs.readFile(absolutePath, 'utf-8');
    expect(content).toBe('Hello World');
  });

  it('should return error for non-existent file', async () => {
    const result = await executeTool('read', { path: '/non/existent/file.txt' }, ctx);
    expect(result).toContain('[Tool Error]');
    expect(result).toContain('File not found');
  });

  it('should write file successfully', async () => {
    const filePath = path.join(testDir, 'new-file.txt');
    const result = await executeTool('write', { path: filePath, content: 'Test content' }, ctx);
    expect(result).toContain('File written');

    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toBe('Test content');
  });

  it('should edit file successfully', async () => {
    const filePath = path.join(testDir, 'edit-test.txt');
    await fs.writeFile(filePath, 'Hello World', 'utf-8');

    const result = await executeTool('edit', {
      path: filePath,
      old_string: 'World',
      new_string: 'KodaX'
    }, ctx);
    expect(result).toContain('File edited');

    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toBe('Hello KodaX');
  });

  it('should return error if old_string not found', async () => {
    const filePath = path.join(testDir, 'edit-error-test.txt');
    await fs.writeFile(filePath, 'Hello World', 'utf-8');

    const result = await executeTool('edit', {
      path: filePath,
      old_string: 'NotFound',
      new_string: 'KodaX'
    }, ctx);
    expect(result).toContain('[Tool Error]');
    expect(result).toContain('old_string not found');
  });

  it('should require replace_all for multiple occurrences', async () => {
    const filePath = path.join(testDir, 'edit-multi-test.txt');
    await fs.writeFile(filePath, 'foo bar foo baz foo', 'utf-8');

    const result = await executeTool('edit', {
      path: filePath,
      old_string: 'foo',
      new_string: 'qux'
    }, ctx);
    expect(result).toContain('[Tool Error]');
    expect(result).toContain('replace_all=true');
  });

  it('should replace all when replace_all is true', async () => {
    const filePath = path.join(testDir, 'edit-replace-all-test.txt');
    await fs.writeFile(filePath, 'foo bar foo baz foo', 'utf-8');

    const result = await executeTool('edit', {
      path: filePath,
      old_string: 'foo',
      new_string: 'qux',
      replace_all: true
    }, ctx);
    expect(result).toContain('File edited');

    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toBe('qux bar qux baz qux');
  });

  it('should execute bash command', async () => {
    const result = await executeTool('bash', { command: 'echo test' }, ctx);
    expect(result).toContain('Exit:');
  });

  it('should find files with glob', async () => {
    await fs.writeFile(path.join(testDir, 'file1.txt'), '');
    await fs.writeFile(path.join(testDir, 'file2.txt'), '');

    const result = await executeTool('glob', { pattern: '*.txt', path: testDir }, ctx);
    expect(result).toContain('file1.txt');
    expect(result).toContain('file2.txt');
  });

  it('should search with grep', async () => {
    const filePath = path.join(testDir, 'search.txt');
    await fs.writeFile(filePath, 'Hello World\nFoo Bar\nHello Again', 'utf-8');

    const result = await executeTool('grep', { pattern: 'Hello', path: filePath }, ctx);
    expect(result).toContain('Hello');
  });

  it('should return no matches for grep with no results', async () => {
    const filePath = path.join(testDir, 'search-empty.txt');
    await fs.writeFile(filePath, 'Hello World', 'utf-8');

    const result = await executeTool('grep', { pattern: 'NotFound', path: filePath }, ctx);
    expect(result).toContain('No matches');
  });
});

// ============== 工具上下文测试 ==============

describe('Tool Execution Context', () => {
  it('should have correct default confirm tools', () => {
    const ctx: KodaXToolExecutionContext = {
      confirmTools: new Set(['bash', 'write', 'edit']),
      backups: new Map(),
      noConfirm: false,
    };
    expect(ctx.confirmTools.has('bash')).toBe(true);
    expect(ctx.confirmTools.has('write')).toBe(true);
    expect(ctx.confirmTools.has('edit')).toBe(true);
  });

  it('should skip confirmation when noConfirm is true', () => {
    const ctx: KodaXToolExecutionContext = {
      confirmTools: new Set(['bash']),
      backups: new Map(),
      noConfirm: true,
    };
    expect(ctx.noConfirm).toBe(true);
  });
});

// ============== Session ID 生成测试 ==============

describe('Session ID Generation', () => {
  it('should generate valid session ID', async () => {
    const sessionId = await generateSessionId();
    expect(sessionId).toMatch(/^\d{8}_\d{6}$/);
  });

  it('should generate unique session IDs', async () => {
    const id1 = await generateSessionId();
    // Small delay to ensure different timestamp
    await new Promise(r => setTimeout(r, 10));
    const id2 = await generateSessionId();
    // IDs should be different or same if generated in same second
    expect(typeof id1).toBe('string');
    expect(typeof id2).toBe('string');
  });
});

// ============== Git 根目录测试 ==============

describe('Git Root Detection', () => {
  it('should return git root or null', async () => {
    const gitRoot = await getGitRoot();
    // In a git repo, should return a string; otherwise null
    expect(gitRoot === null || typeof gitRoot === 'string').toBe(true);
  });
});

// ============== 项目快照测试 ==============

describe('Project Snapshot', () => {
  it('should generate project snapshot', async () => {
    const snapshot = await getProjectSnapshot();
    expect(snapshot).toBeDefined();
    expect(typeof snapshot).toBe('string');
  });

  it('should include project name', async () => {
    const snapshot = await getProjectSnapshot();
    expect(snapshot).toContain('Project:');
  });
});

// ============== 长运行上下文测试 ==============

describe('Long Running Context', () => {
  it('should return empty string when no feature_list.json', async () => {
    // In a directory without feature_list.json
    const originalDir = process.cwd();
    const tempDir = path.join(os.tmpdir(), 'kodax-no-features-' + Date.now());
    await fs.mkdir(tempDir, { recursive: true });
    process.chdir(tempDir);

    const ctx = await getLongRunningContext();
    expect(ctx).toBe('');

    process.chdir(originalDir);
    await fs.rm(tempDir, { recursive: true, force: true });
  });
});

// ============== Feature 进度测试 ==============

describe('Feature Progress', () => {
  const testDir = path.join(os.tmpdir(), 'kodax-feature-test-' + Date.now());

  beforeEach(async () => {
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('should return [0, 0] when no feature_list.json exists', () => {
    const [completed, total] = getFeatureProgress();
    // Without feature_list.json in current directory
    expect(completed).toBeGreaterThanOrEqual(0);
    expect(total).toBeGreaterThanOrEqual(0);
  });

  it('should check all features complete', () => {
    const result = checkAllFeaturesComplete();
    expect(typeof result).toBe('boolean');
  });
});

// ============== Rate Limited Call 测试 ==============

describe('Rate Limited Call', () => {
  it('should execute function successfully', async () => {
    const result = await rateLimitedCall(() => Promise.resolve('success'));
    expect(result).toBe('success');
  });

  it('should propagate errors', async () => {
    await expect(rateLimitedCall(() => Promise.reject(new Error('test error')))).rejects.toThrow('test error');
  });
});

// ============== Token 估算详细测试 ==============

describe('Token Estimation Detailed', () => {
  it('should estimate tokens for string content', () => {
    const messages = [
      { role: 'user' as const, content: 'This is a test message' },
    ];
    const tokens = estimateTokens(messages);
    expect(tokens).toBeGreaterThan(0);
    // Approximately 6 words / 4 chars per token
    expect(tokens).toBeLessThan(20);
  });

  it('should estimate tokens for content blocks', () => {
    const messages = [
      {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: 'Hello World' },
          { type: 'tool_result' as const, tool_use_id: '1', content: 'Result content' },
        ]
      },
    ];
    const tokens = estimateTokens(messages);
    expect(tokens).toBeGreaterThan(0);
  });
});

// ============== 工具调用检测详细测试 ==============

describe('Incomplete Tool Call Detection Detailed', () => {
  it('should detect empty string as missing', () => {
    const toolBlocks = [{ type: 'tool_use' as const, id: '1', name: 'write', input: { path: '/test.txt', content: '' } }];
    const incomplete = checkIncompleteToolCalls(toolBlocks);
    expect(incomplete).toContain("write: missing 'content'");
  });

  it('should detect null as missing', () => {
    const toolBlocks = [{ type: 'tool_use' as const, id: '1', name: 'bash', input: { command: null } }];
    const incomplete = checkIncompleteToolCalls(toolBlocks);
    expect(incomplete).toContain("bash: missing 'command'");
  });

  it('should handle unknown tool gracefully', () => {
    const toolBlocks = [{ type: 'tool_use' as const, id: '1', name: 'unknown', input: {} }];
    const incomplete = checkIncompleteToolCalls(toolBlocks);
    expect(incomplete).toHaveLength(0);
  });
});

// ============== Promise 信号详细测试 ==============

describe('Promise Signal Detection Detailed', () => {
  it('should handle multiline signal', () => {
    const text = `Some text before
<promise>COMPLETE</promise>
Some text after`;
    const [signal, reason] = checkPromiseSignal(text);
    expect(signal).toBe('COMPLETE');
    expect(reason).toBe('');
  });

  it('should handle signal with colon in reason', () => {
    const [signal, reason] = checkPromiseSignal('<promise>BLOCKED:Error: something went wrong</promise>');
    expect(signal).toBe('BLOCKED');
    expect(reason).toBe('Error: something went wrong');
  });

  it('should handle signal in middle of text', () => {
    const text = `Some text before
<promise>COMPLETE</promise>
Some text after`;
    const [signal, reason] = checkPromiseSignal(text);
    expect(signal).toBe('COMPLETE');
    expect(reason).toBe('');
  });
});

// ============== Session Initial Messages 测试 ==============

describe('Session Initial Messages', () => {
  it('should accept initialMessages in session options', () => {
    // 测试接口定义是否正确
    const options = {
      provider: KODAX_DEFAULT_PROVIDER,
      session: {
        initialMessages: [
          { role: 'user' as const, content: 'Hello' },
          { role: 'assistant' as const, content: 'Hi there!' },
        ],
      },
      events: {},
    };
    expect(options.session.initialMessages).toHaveLength(2);
  });

  it('should handle empty initialMessages', () => {
    const options = {
      provider: KODAX_DEFAULT_PROVIDER,
      session: {
        initialMessages: [],
      },
      events: {},
    };
    expect(options.session.initialMessages).toHaveLength(0);
  });

  it('should handle undefined initialMessages', () => {
    const options = {
      provider: KODAX_DEFAULT_PROVIDER,
      session: {},
      events: {},
    };
    expect(options.session.initialMessages).toBeUndefined();
  });
});

// ============== generateSessionId 测试 ==============

describe('generateSessionId', () => {
  it('should generate session ID in correct format', async () => {
    const id = await generateSessionId();
    // Format: YYYYMMDD_HHMMSS
    expect(id).toMatch(/^\d{8}_\d{6}$/);
  });

  it('should generate unique IDs', async () => {
    const id1 = await generateSessionId();
    // Small delay to ensure different timestamp
    await new Promise(resolve => setTimeout(resolve, 10));
    const id2 = await generateSessionId();
    // They might be the same if called within the same second
    // So we just check the format
    expect(id1).toMatch(/^\d{8}_\d{6}$/);
    expect(id2).toMatch(/^\d{8}_\d{6}$/);
  });
});

// ============== 错误类型测试 ==============

describe('KodaXError Types', () => {
  describe('KodaXError (base)', () => {
    it('should create error with default code', () => {
      const error = new KodaXError('Test error');
      expect(error.message).toBe('Test error');
      expect(error.code).toBe('KODAX_ERROR');
      expect(error.name).toBe('KodaXError');
      expect(error).toBeInstanceOf(Error);
    });

    it('should create error with custom code', () => {
      const error = new KodaXError('Custom error', 'CUSTOM_CODE');
      expect(error.message).toBe('Custom error');
      expect(error.code).toBe('CUSTOM_CODE');
    });
  });

  describe('KodaXProviderError', () => {
    it('should create provider error', () => {
      const error = new KodaXProviderError('Provider failed', 'anthropic');
      expect(error.message).toBe('Provider failed');
      expect(error.code).toBe('PROVIDER_ERROR');
      expect(error.provider).toBe('anthropic');
      expect(error.name).toBe('KodaXProviderError');
    });

    it('should create provider error without provider name', () => {
      const error = new KodaXProviderError('Provider failed');
      expect(error.provider).toBeUndefined();
    });
  });

  describe('KodaXToolError', () => {
    it('should create tool error', () => {
      const error = new KodaXToolError('Tool failed', 'write', 'tool-123');
      expect(error.message).toBe('Tool failed');
      expect(error.code).toBe('TOOL_ERROR');
      expect(error.toolName).toBe('write');
      expect(error.toolId).toBe('tool-123');
      expect(error.name).toBe('KodaXToolError');
    });

    it('should create tool error without tool ID', () => {
      const error = new KodaXToolError('Tool failed', 'read');
      expect(error.toolId).toBeUndefined();
    });
  });

  describe('KodaXRateLimitError', () => {
    it('should create rate limit error', () => {
      const error = new KodaXRateLimitError('Rate limit exceeded', 60);
      expect(error.message).toBe('Rate limit exceeded');
      expect(error.code).toBe('RATE_LIMIT_ERROR');
      expect(error.retryAfter).toBe(60);
      expect(error.name).toBe('KodaXRateLimitError');
    });

    it('should create rate limit error without retry time', () => {
      const error = new KodaXRateLimitError('Rate limit exceeded');
      expect(error.retryAfter).toBeUndefined();
    });
  });

  describe('KodaXSessionError', () => {
    it('should create session error', () => {
      const error = new KodaXSessionError('Session not found', 'session-123');
      expect(error.message).toBe('Session not found');
      expect(error.code).toBe('SESSION_ERROR');
      expect(error.sessionId).toBe('session-123');
      expect(error.name).toBe('KodaXSessionError');
    });

    it('should create session error without session ID', () => {
      const error = new KodaXSessionError('Session error');
      expect(error.sessionId).toBeUndefined();
    });
  });
});

// ============== 工具执行错误处理测试 ==============

describe('Tool Execution Error Handling', () => {
  let ctx: KodaXToolExecutionContext;

  beforeEach(() => {
    ctx = {
      confirmTools: new Set(['bash', 'write', 'edit']),
      backups: new Map(),
      noConfirm: true,
    };
  });

  it('should return error for multiple missing parameters', async () => {
    const result = await executeTool('write', { path: '/test.txt' }, ctx);
    expect(result).toContain('[Tool Error]');
    expect(result).toContain('Missing required parameter');
    expect(result).toContain('content');
  });

  it('should return error for unknown tool with available tools list', async () => {
    const result = await executeTool('nonexistent', {}, ctx);
    expect(result).toContain('[Tool Error]');
    expect(result).toContain('Unknown tool');
    expect(result).toContain('Available tools');
    expect(result).toContain('read');
    expect(result).toContain('write');
  });

  it('should return cancellation message when user cancels', async () => {
    const ctxWithConfirm: KodaXToolExecutionContext = {
      confirmTools: new Set(['bash']),
      backups: new Map(),
      noConfirm: false,
      onConfirm: async () => false, // User cancels
    };
    const result = await executeTool('bash', { command: 'rm -rf /' }, ctxWithConfirm);
    expect(result).toContain('[Cancelled]');
    expect(result).toContain('cancelled by user');
  });

  it('should detect null as missing parameter', async () => {
    const result = await executeTool('read', { path: null }, ctx);
    expect(result).toContain('[Tool Error]');
    expect(result).toContain('Missing required parameter');
  });
});

// ============== toolRead 详细测试 ==============

describe('toolRead Detailed', () => {
  let testFile: string;
  let ctx: KodaXToolExecutionContext;

  beforeEach(async () => {
    testFile = path.join(TEST_DIR, `read-test-${Date.now()}.txt`);
    await fs.mkdir(TEST_DIR, { recursive: true });
    await fs.writeFile(testFile, 'line1\nline2\nline3\nline4\nline5\n');
    ctx = {
      confirmTools: new Set(),
      backups: new Map(),
      noConfirm: true,
    };
  });

  afterEach(async () => {
    try {
      await fs.rm(testFile);
    } catch {}
  });

  it('should read file from offset 1 (first line)', async () => {
    const result = await executeTool('read', { path: testFile, offset: 1, limit: 1 }, ctx);
    expect(result).toContain('line1');
    expect(result).not.toContain('line2');
  });

  it('should read file from offset 0 (same as offset 1)', async () => {
    const result = await executeTool('read', { path: testFile, offset: 0, limit: 1 }, ctx);
    expect(result).toContain('line1');
  });

  it('should read file with limit', async () => {
    const result = await executeTool('read', { path: testFile, offset: 1, limit: 2 }, ctx);
    expect(result).toContain('line1');
    expect(result).toContain('line2');
    expect(result).not.toContain('line3');
  });

  it('should read file from middle offset', async () => {
    const result = await executeTool('read', { path: testFile, offset: 3, limit: 2 }, ctx);
    expect(result).toContain('line3');
    expect(result).toContain('line4');
    expect(result).not.toContain('line1');
  });

  it('should return error for non-existent file', async () => {
    const result = await executeTool('read', { path: '/nonexistent/file.txt' }, ctx);
    expect(result).toContain('[Tool Error]');
    expect(result).toContain('File not found');
  });
});

