/**
 * KodaX 单元测试
 *
 * 测试核心功能函数，不依赖外部 API
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';

// ============== 模拟测试环境 ==============

const TEST_DIR = path.join(os.tmpdir(), 'kodax-test-' + Date.now());

// ============== 辅助函数（从 kodax.ts 提取用于测试）==============

function checkPromiseSignal(text: string): [string, string] {
  const PROMISE_PATTERN = /<promise>(COMPLETE|BLOCKED|DECIDE)(?::(.*?))?<\/promise>/is;
  const match = PROMISE_PATTERN.exec(text);
  if (match) return [match[1]!.toUpperCase(), match[2] ?? ''];
  return ['', ''];
}

function estimateTokensSimple(content: string): number {
  return Math.ceil(content.length / 4);
}

function getEnvContext(): string {
  const p = process.platform;
  const isWin = p === 'win32';
  const cmdHint = isWin
    ? 'Use: dir, move, copy, del, mkdir (no -p needed)'
    : 'Use: ls, mv, cp, rm, mkdir -p';
  return `Platform: ${isWin ? 'Windows' : p === 'darwin' ? 'macOS' : 'Linux'}\n${cmdHint}\nNode: ${process.version}`;
}

// ============== Spinner 函数（用于测试）==============

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_COLORS = ['\x1b[36m', '\x1b[35m', '\x1b[34m']; // cyan, magenta, blue

/**
 * 创建一个可测试的 spinner
 * @param writeFn 可选的自定义写入函数（用于测试）
 * @param setIntervalFn 可选的自定义 setInterval 函数（用于测试）
 */
function createTestableSpinner(
  writeFn: (text: string) => void = (text) => process.stdout.write(text),
  setIntervalFn: typeof setInterval = setInterval
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

  const interval = setIntervalFn(() => {
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

function checkIncompleteToolCalls(toolBlocks: Array<{ name: string; input: Record<string, unknown> }>): string[] {
  const TOOL_REQUIRED_PARAMS: Record<string, string[]> = {
    read: ['path'],
    write: ['path', 'content'],
    edit: ['path', 'old_string', 'new_string'],
    bash: ['command'],
    glob: ['pattern'],
    grep: ['pattern', 'path'],
    undo: [],
  };

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

// ============== 测试用例 ==============

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
      expect(ctx).toContain('mkdir (no -p needed)');
    } else {
      expect(ctx).toContain('mkdir -p');
    }
  });
});

describe('Token Estimation', () => {
  it('should estimate tokens based on character count', () => {
    const content = 'Hello World'; // 11 chars
    const tokens = estimateTokensSimple(content);
    expect(tokens).toBe(Math.ceil(11 / 4)); // 3
  });

  it('should handle empty content', () => {
    const tokens = estimateTokensSimple('');
    expect(tokens).toBe(0);
  });

  it('should handle long content', () => {
    const content = 'a'.repeat(1000);
    const tokens = estimateTokensSimple(content);
    expect(tokens).toBe(250);
  });
});

describe('Incomplete Tool Call Detection', () => {
  it('should detect missing path in read tool', () => {
    const toolBlocks = [{ name: 'read', input: {} }];
    const incomplete = checkIncompleteToolCalls(toolBlocks);
    expect(incomplete).toContain("read: missing 'path'");
  });

  it('should detect missing content in write tool', () => {
    const toolBlocks = [{ name: 'write', input: { path: '/test.txt' } }];
    const incomplete = checkIncompleteToolCalls(toolBlocks);
    expect(incomplete).toContain("write: missing 'content'");
  });

  it('should detect missing parameters in edit tool', () => {
    const toolBlocks = [{ name: 'edit', input: { path: '/test.txt' } }];
    const incomplete = checkIncompleteToolCalls(toolBlocks);
    expect(incomplete).toContain("edit: missing 'old_string'");
    expect(incomplete).toContain("edit: missing 'new_string'");
  });

  it('should detect missing command in bash tool', () => {
    const toolBlocks = [{ name: 'bash', input: {} }];
    const incomplete = checkIncompleteToolCalls(toolBlocks);
    expect(incomplete).toContain("bash: missing 'command'");
  });

  it('should return empty for complete tool calls', () => {
    const toolBlocks = [
      { name: 'read', input: { path: '/test.txt' } },
      { name: 'write', input: { path: '/test.txt', content: 'hello' } },
    ];
    const incomplete = checkIncompleteToolCalls(toolBlocks);
    expect(incomplete).toHaveLength(0);
  });

  it('should not require parameters for undo tool', () => {
    const toolBlocks = [{ name: 'undo', input: {} }];
    const incomplete = checkIncompleteToolCalls(toolBlocks);
    expect(incomplete).toHaveLength(0);
  });
});

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

describe('Cross-Platform Command Hints', () => {
  it('should provide correct mkdir hint for current platform', () => {
    const ctx = getEnvContext();
    const isWin = process.platform === 'win32';

    if (isWin) {
      // Windows: no -p flag
      expect(ctx).toContain('mkdir (no -p needed)');
      expect(ctx).toContain('dir');
      expect(ctx).toContain('move');
    } else {
      // Unix/Mac: with -p flag
      expect(ctx).toContain('mkdir -p');
      expect(ctx).toContain('ls');
      expect(ctx).toContain('mv');
    }
  });
});

// ============== Spinner 测试 ==============

describe('Spinner Animation', () => {
  it('should render first frame immediately (not waiting 80ms)', () => {
    const writes: string[] = [];
    const mockWrite = (text: string) => { writes.push(text); };

    // 使用永远不会触发的 setInterval mock
    const mockSetInterval = () => 123 as unknown as NodeJS.Timeout;

    const spinner = createTestableSpinner(mockWrite, mockSetInterval);

    // 立即检查是否有写入（第一帧应该立即渲染）
    expect(writes.length).toBe(1);
    expect(writes[0]).toContain('Thinking...');
    expect(spinner.isStopped()).toBe(false);
  });

  it('should stop spinner and clear line', () => {
    const writes: string[] = [];
    const mockWrite = (text: string) => { writes.push(text); };
    const mockSetInterval = () => 123 as unknown as NodeJS.Timeout;

    const spinner = createTestableSpinner(mockWrite, mockSetInterval);

    expect(spinner.isStopped()).toBe(false);

    spinner.stop();

    expect(spinner.isStopped()).toBe(true);
    // 应该有两次写入：第一帧 + 清除行
    expect(writes.length).toBe(2);
    // 最后一行应该是清除行的内容（空格）
    expect(writes[1]).toMatch(/^\r\s+\r$/);
  });

  it('should not stop twice', () => {
    const writes: string[] = [];
    const mockWrite = (text: string) => { writes.push(text); };
    const mockSetInterval = () => 123 as unknown as NodeJS.Timeout;

    const spinner = createTestableSpinner(mockWrite, mockSetInterval);

    spinner.stop();
    const writeCountAfterFirstStop = writes.length;

    spinner.stop(); // 第二次停止应该被忽略

    expect(writes.length).toBe(writeCountAfterFirstStop);
  });

  it('should update text', () => {
    const writes: string[] = [];
    const mockWrite = (text: string) => { writes.push(text); };
    const mockSetInterval = () => 123 as unknown as NodeJS.Timeout;

    const spinner = createTestableSpinner(mockWrite, mockSetInterval);

    expect(writes[0]).toContain('Thinking...');

    spinner.updateText('Processing...');
    spinner.stop();

    // 清除行之前应该没有新的渲染（因为我们 mock 了 setInterval）
    // 但是 stop() 会写入清除行
    expect(writes.length).toBe(2);
  });

  it('should not render after stop', () => {
    const writes: string[] = [];
    const mockWrite = (text: string) => { writes.push(text); };
    const mockSetInterval = () => 123 as unknown as NodeJS.Timeout;

    const spinner = createTestableSpinner(mockWrite, mockSetInterval);

    spinner.stop();
    const writeCountAfterStop = writes.length;

    // 尝试再次更新文本（这不会触发新的写入，因为已停止）
    spinner.updateText('Should not render');

    expect(writes.length).toBe(writeCountAfterStop);
  });

  it('should use correct spinner frames', () => {
    const writes: string[] = [];
    const mockWrite = (text: string) => { writes.push(text); };
    const mockSetInterval = () => 123 as unknown as NodeJS.Timeout;

    createTestableSpinner(mockWrite, mockSetInterval);

    // 第一帧应该使用第一个 spinner 字符
    expect(writes[0]).toContain(SPINNER_FRAMES[0]);
  });

  it('should use color codes', () => {
    const writes: string[] = [];
    const mockWrite = (text: string) => { writes.push(text); };
    const mockSetInterval = () => 123 as unknown as NodeJS.Timeout;

    createTestableSpinner(mockWrite, mockSetInterval);

    // 应该包含颜色代码
    expect(writes[0]).toContain('\x1b['); // ANSI 转义序列
  });
});

describe('Spinner Edge Cases', () => {
  it('should handle rapid stop immediately after start', () => {
    const writes: string[] = [];
    const mockWrite = (text: string) => { writes.push(text); };
    const mockSetInterval = () => 123 as unknown as NodeJS.Timeout;

    const spinner = createTestableSpinner(mockWrite, mockSetInterval);
    spinner.stop(); // 立即停止

    // 即使立即停止，也应该有两次写入
    expect(writes.length).toBe(2);
    expect(spinner.isStopped()).toBe(true);
  });

  it('should track frame count correctly', () => {
    const writes: string[] = [];
    const mockWrite = (text: string) => { writes.push(text); };
    let intervalCallback: (() => void) | null = null;
    const mockSetInterval = (cb: () => void) => {
      intervalCallback = cb;
      return 123 as unknown as NodeJS.Timeout;
    };

    const spinner = createTestableSpinner(mockWrite, mockSetInterval);

    // 初始帧计数为 0（第一帧立即渲染）
    expect(spinner.getFrameCount()).toBe(0);

    // 手动触发 interval 回调模拟时间流逝
    if (intervalCallback) {
      intervalCallback(); // frame++ -> 1
      expect(spinner.getFrameCount()).toBe(1);
    }

    spinner.stop();
    expect(spinner.isStopped()).toBe(true);
  });

  it('should handle multiple updateText calls', () => {
    const writes: string[] = [];
    const mockWrite = (text: string) => { writes.push(text); };
    const mockSetInterval = () => 123 as unknown as NodeJS.Timeout;

    const spinner = createTestableSpinner(mockWrite, mockSetInterval);

    spinner.updateText('Step 1');
    spinner.updateText('Step 2');
    spinner.updateText('Step 3');

    spinner.stop();

    // 应该正常停止，没有错误
    expect(spinner.isStopped()).toBe(true);
  });
});
