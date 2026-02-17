/**
 * KodaX CLI 层单元测试
 *
 * 测试 CLI 特有功能：Commands 系统、Spinner 等
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import { Command } from 'commander';

// 从 kodax_cli 导入 Commands 系统
import {
  loadCommands,
  parseCommandCall,
  processCommandCall,
  KODAX_COMMANDS_DIR,
  KodaXCommand,
} from '../src/kodax_cli.js';

// 默认 provider
const KODAX_DEFAULT_PROVIDER = 'zhipu-coding';

// ============== 模拟测试环境 ==============

const TEST_DIR = path.join(os.tmpdir(), 'kodax-cli-test-' + Date.now());

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

// ============== Commands 系统测试 ==============

describe('Commands System', () => {
  it('should export KODAX_COMMANDS_DIR', () => {
    expect(KODAX_COMMANDS_DIR).toBeDefined();
    expect(KODAX_COMMANDS_DIR).toContain('.kodax');
    expect(KODAX_COMMANDS_DIR).toContain('commands');
  });

  it('should load commands (empty or with existing)', async () => {
    const commands = await loadCommands();
    expect(commands).toBeInstanceOf(Map);
  });

  it('should load commands from custom directory', async () => {
    // 创建临时命令目录
    const customDir = path.join(TEST_DIR, 'commands');
    await fs.mkdir(customDir, { recursive: true });

    // 创建一个测试命令
    const commandContent = '# Test Command\nThis is a test command: {args}';
    await fs.writeFile(path.join(customDir, 'test.md'), commandContent);

    const commands = await loadCommands(customDir);
    expect(commands.has('test')).toBe(true);
    expect(commands.get('test')?.type).toBe('prompt');
    expect(commands.get('test')?.content).toContain('{args}');

    // 清理
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  });
});

describe('parseCommandCall', () => {
  it('should parse /command without args', () => {
    const result = parseCommandCall('/review');
    expect(result).not.toBeNull();
    expect(result![0]).toBe('review');
    expect(result![1]).toBeUndefined();
  });

  it('should parse /command with args', () => {
    const result = parseCommandCall('/review src/auth.ts');
    expect(result).not.toBeNull();
    expect(result![0]).toBe('review');
    expect(result![1]).toBe('src/auth.ts');
  });

  it('should return null for non-command input', () => {
    expect(parseCommandCall('hello world')).toBeNull();
    expect(parseCommandCall('normal text')).toBeNull();
  });

  it('should handle command with multiple words in args', () => {
    const result = parseCommandCall('/search find this pattern');
    expect(result).not.toBeNull();
    expect(result![0]).toBe('search');
    // Note: current implementation only captures first word after command
  });
});

describe('processCommandCall', () => {
  it('should process prompt command with {args} replacement', async () => {
    const commands = new Map<string, KodaXCommand>();
    commands.set('test', {
      name: 'test',
      description: 'Test command',
      content: 'Review this code: {args}',
      type: 'prompt',
    });

    const result = await processCommandCall('test', 'file.ts', commands, async () => 'mock');
    expect(result).toBe('Review this code: file.ts');
  });

  it('should return null for unknown command', async () => {
    const commands = new Map<string, KodaXCommand>();
    const result = await processCommandCall('unknown', 'args', commands, async () => 'mock');
    expect(result).toBeNull();
  });

  it('should handle command without {args} placeholder', async () => {
    const commands = new Map<string, KodaXCommand>();
    commands.set('simple', {
      name: 'simple',
      description: 'Simple command',
      content: 'Just do something',
      type: 'prompt',
    });

    const result = await processCommandCall('simple', 'ignored', commands, async () => 'mock');
    expect(result).toBe('Just do something');
  });
});

// ============== Spinner 测试 ==============

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
});

// ============== CLI 入口测试 ==============

describe('CLI Entry Point', () => {
  it('should have correct CLI entry in package.json', async () => {
    const pkgPath = path.join(process.cwd(), 'package.json');
    const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8'));
    expect(pkg.bin.kodax).toBe('./dist/kodax_cli.js');
  });

  it('should export commands directory constant', () => {
    expect(KODAX_COMMANDS_DIR).toBe(path.join(os.homedir(), '.kodax', 'commands'));
  });
});

// ============== CLI 选项解析测试 ==============

describe('CLI Option Parsing', () => {
  // 创建与 kodax_cli.ts 一致的 Command 配置
  function createTestCommand(): Command {
    return new Command()
      .allowUnknownOption(false)
      .option('-p, --prompt <text>', 'Task prompt')
      .option('-m, --provider <name>', 'LLM provider', KODAX_DEFAULT_PROVIDER)
      .option('-t, --thinking', 'Enable thinking mode')
      .option('-c, --confirm <tools>', 'Tools requiring confirmation')
      .option('-y, --no-confirm', 'Disable confirmations')
      .option('-s, --session <id>', 'Session')
      .option('-j, --parallel', 'Parallel tool execution');
  }

  it('should parse -p (prompt) option', () => {
    const program = createTestCommand();
    program.parse(['node', 'test', '-p', 'hello world']);
    const opts = program.opts();
    expect(opts.prompt).toBe('hello world');
  });

  it('should parse --prompt option', () => {
    const program = createTestCommand();
    program.parse(['node', 'test', '--prompt', 'hello world']);
    const opts = program.opts();
    expect(opts.prompt).toBe('hello world');
  });

  it('should parse -m (provider) option', () => {
    const program = createTestCommand();
    program.parse(['node', 'test', '-m', 'kimi-code']);
    const opts = program.opts();
    expect(opts.provider).toBe('kimi-code');
  });

  it('should parse --provider option', () => {
    const program = createTestCommand();
    program.parse(['node', 'test', '--provider', 'anthropic']);
    const opts = program.opts();
    expect(opts.provider).toBe('anthropic');
  });

  it('should have default provider', () => {
    const program = createTestCommand();
    program.parse(['node', 'test']);
    const opts = program.opts();
    expect(opts.provider).toBe(KODAX_DEFAULT_PROVIDER);
  });

  it('should parse -t (thinking) option', () => {
    const program = createTestCommand();
    program.parse(['node', 'test', '-t']);
    const opts = program.opts();
    expect(opts.thinking).toBe(true);
  });

  it('should parse --thinking option', () => {
    const program = createTestCommand();
    program.parse(['node', 'test', '--thinking']);
    const opts = program.opts();
    expect(opts.thinking).toBe(true);
  });

  it('should parse -c (confirm) option', () => {
    const program = createTestCommand();
    program.parse(['node', 'test', '-c', 'bash,write']);
    const opts = program.opts();
    expect(opts.confirm).toBe('bash,write');
  });

  it('should parse -y (auto mode) option', () => {
    const program = createTestCommand();
    program.parse(['node', 'test', '-y']);
    const opts = program.opts();
    // Commander converts --no-confirm to confirm: false
    expect(opts.confirm).toBe(false);
  });

  it('should parse -s (session) option', () => {
    const program = createTestCommand();
    program.parse(['node', 'test', '-s', 'resume']);
    const opts = program.opts();
    expect(opts.session).toBe('resume');
  });

  it('should parse -j (parallel) option', () => {
    const program = createTestCommand();
    program.parse(['node', 'test', '-j']);
    const opts = program.opts();
    expect(opts.parallel).toBe(true);
  });

  it('should parse multiple short options together', () => {
    const program = createTestCommand();
    program.parse(['node', 'test', '-t', '-j', '-m', 'kimi']);
    const opts = program.opts();
    expect(opts.thinking).toBe(true);
    expect(opts.parallel).toBe(true);
    expect(opts.provider).toBe('kimi');
  });

  it('should parse short and long options mixed', () => {
    const program = createTestCommand();
    program.parse(['node', 'test', '-t', '--provider', 'anthropic', '-y']);
    const opts = program.opts();
    expect(opts.thinking).toBe(true);
    expect(opts.provider).toBe('anthropic');
    // Commander converts --no-confirm (auto mode) to confirm: false
    expect(opts.confirm).toBe(false);
  });
});
