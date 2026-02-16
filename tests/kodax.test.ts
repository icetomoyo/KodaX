/**
 * KodaX 单元测试
 *
 * 测试核心功能函数，不依赖外部 API
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
