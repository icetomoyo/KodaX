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
  parsePermissionModeOption,
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

  it('should not attach a bare action to the root skill subcommand', async () => {
    const source = await fs.readFile(path.join(process.cwd(), 'src', 'kodax_cli.ts'), 'utf-8');
    expect(source).not.toContain('skillCommand.action(() =>');
  });

  it('should advertise ACP server help and register the ACP subcommand', async () => {
    const source = await fs.readFile(path.join(process.cwd(), 'src', 'kodax_cli.ts'), 'utf-8');
    expect(source).toContain("command('acp')");
    expect(source).toContain('kodax -h acp');
    expect(source).toContain('kodax acp serve');
  });

  it('should keep the root command executable when subcommands are registered', () => {
    const writes: string[] = [];
    const program = new Command()
      .name('kodax')
      .helpOption(false)
      .argument('[prompt...]')
      .option('-h, --help [topic]')
      .allowUnknownOption(false)
      .action(() => {});

    program
      .command('skill')
      .description('Built-in skill packaging and installation helpers')
      .command('init <name>');

    program.configureOutput({
      writeOut: (text) => { writes.push(text); },
      writeErr: (text) => { writes.push(text); },
    });

    expect(() => program.parse(['node', 'kodax'])).not.toThrow();
    expect(writes.join('')).toBe('');
  });

  it('should keep root help text aligned with current CLI behavior', async () => {
    const source = await fs.readFile(path.join(process.cwd(), 'src', 'kodax_cli.ts'), 'utf-8');
    expect(source).toContain('--model <name>');
    expect(source).toContain('kodax -h project');
    expect(source).toContain('/project ...            Project workflow commands');
    expect(source).toContain('Legacy no-op; current CLI already starts a fresh session by default');
    expect(source).toContain('Resume session by ID (no ID = list recent sessions, then resume the latest)');
    expect(source).toContain('/mode [plan|accept-edits|auto-in-project]');
    expect(source).toContain('Backward-compat alias; no effect in non-REPL CLI');
    expect(source).not.toContain('Pick session to resume');
    expect(source).not.toContain('echo "task" | kodax -p -');
    expect(source).not.toContain('/mode [code|ask]');
    expect(source).not.toContain('Enter interactive mode (auto-resume)');
  });

  it('should document provider and team caveats in help topics', async () => {
    const source = await fs.readFile(path.join(process.cwd(), 'src', 'kodax_cli.ts'), 'utf-8');
    expect(source).toContain('CLI bridge provider (latest-user-message only, MCP unavailable)');
    expect(source).toContain('Legacy orchestration-based parallel execution for loosely coupled tasks.');
    expect(source).toContain('not yet a fully shared-context multi-agent runtime');
    expect(source).toContain('Project mode spans two surfaces: non-REPL bootstrap commands and REPL /project commands.');
    expect(source).toContain('/project verify [#index|--last]');
  });

  it('should keep custom skill subcommand help aligned with current options', async () => {
    const source = await fs.readFile(path.join(process.cwd(), 'src', 'kodax_cli.ts'), 'utf-8');
    expect(source).toContain('Required Options:');
    expect(source).toContain('Usage: kodax skill eval [options]');
    expect(source).toContain('Usage: kodax skill compare [options] <workspace>');
    expect(source).toContain('Primary config (default: with_skill)');
    expect(source).toContain('Baseline config (default: without_skill)');
  });
});

// 创建与 kodax_cli.ts 一致的 Command 配置（全局可复用）
function createTestCommand(): Command {
  return new Command()
    .allowUnknownOption(false)
    .option('-p, --print <text>', 'Print mode: run single task and exit')
    .option('-c, --continue', 'Continue most recent conversation in current directory')
    .option('-n, --new', 'Legacy no-op; current CLI already starts a fresh session by default')
    .option('-r, --resume [id]', 'Resume session by ID (no ID = list recent sessions, then resume the latest)')
    .option('-m, --provider <name>', 'LLM provider', KODAX_DEFAULT_PROVIDER)
    .option('--model <name>', 'Model override')
    .option('-t, --thinking', 'Enable thinking mode')
    .option('--reasoning <mode>', 'Reasoning mode: off, auto, quick, balanced, deep')
    .option('-y, --auto', 'Backward-compat alias; no effect in non-REPL CLI')
    .option('-s, --session <op>', 'Legacy session operations: list, resume, delete <id>, delete-all, or raw session ID')
    .option('-j, --parallel', 'Parallel tool execution')
    .option('--no-session', 'Disable session persistence (print mode only)');
}

// ============== CLI 选项解析测试 ==============

describe('CLI Option Parsing', () => {

  it('should parse -p (print) option', () => {
    const program = createTestCommand();
    program.parse(['node', 'test', '-p', 'hello world']);
    const opts = program.opts();
    expect(opts.print).toBe('hello world');
  });

  it('should parse --print option', () => {
    const program = createTestCommand();
    program.parse(['node', 'test', '--print', 'hello world']);
    const opts = program.opts();
    expect(opts.print).toBe('hello world');
  });

  it('should parse -c (continue) option', () => {
    const program = createTestCommand();
    program.parse(['node', 'test', '-c']);
    const opts = program.opts();
    expect(opts.continue).toBe(true);
  });

  it('should parse --continue option', () => {
    const program = createTestCommand();
    program.parse(['node', 'test', '--continue']);
    const opts = program.opts();
    expect(opts.continue).toBe(true);
  });

  it('should parse -r (resume) option with ID', () => {
    const program = createTestCommand();
    program.parse(['node', 'test', '-r', 'abc123']);
    const opts = program.opts();
    expect(opts.resume).toBe('abc123');
  });

  it('should parse --resume option with ID', () => {
    const program = createTestCommand();
    program.parse(['node', 'test', '--resume', 'session-456']);
    const opts = program.opts();
    expect(opts.resume).toBe('session-456');
  });

  it('should parse --resume without ID as boolean flag', () => {
    const program = createTestCommand();
    program.parse(['node', 'test', '--resume']);
    const opts = program.opts();
    expect(opts.resume).toBe(true);
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

  it('should parse --model option', () => {
    const program = createTestCommand();
    program.parse(['node', 'test', '--model', 'gpt-5.4']);
    const opts = program.opts();
    expect(opts.model).toBe('gpt-5.4');
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

  it('should parse -y (auto) option', () => {
    const program = createTestCommand();
    program.parse(['node', 'test', '-y']);
    const opts = program.opts();
    expect(opts.auto).toBe(true);
  });

  it('should parse --auto option', () => {
    const program = createTestCommand();
    program.parse(['node', 'test', '--auto']);
    const opts = program.opts();
    expect(opts.auto).toBe(true);
  });

  it('should parse -s (session) option', () => {
    const program = createTestCommand();
    program.parse(['node', 'test', '-s', 'resume']);
    const opts = program.opts();
    expect(opts.session).toBe('resume');
  });

  it('should parse -s (session) option with list', () => {
    const program = createTestCommand();
    program.parse(['node', 'test', '-s', 'list']);
    const opts = program.opts();
    expect(opts.session).toBe('list');
  });

  it('should parse -s (session) option with delete', () => {
    const program = createTestCommand();
    program.parse(['node', 'test', '-s', 'delete abc123']);
    const opts = program.opts();
    expect(opts.session).toBe('delete abc123');
  });

  it('should parse -j (parallel) option', () => {
    const program = createTestCommand();
    program.parse(['node', 'test', '-j']);
    const opts = program.opts();
    expect(opts.parallel).toBe(true);
  });

  it('should parse multiple short options together', () => {
    const program = createTestCommand();
    program.parse(['node', 'test', '-t', '-j', '-m', 'kimi', '-c']);
    const opts = program.opts();
    expect(opts.thinking).toBe(true);
    expect(opts.parallel).toBe(true);
    expect(opts.provider).toBe('kimi');
    expect(opts.continue).toBe(true);
  });

  it('should parse short and long options mixed', () => {
    const program = createTestCommand();
    program.parse(['node', 'test', '-t', '--provider', 'anthropic', '-y', '-r', 'abc']);
    const opts = program.opts();
    expect(opts.thinking).toBe(true);
    expect(opts.provider).toBe('anthropic');
    expect(opts.auto).toBe(true);
    expect(opts.resume).toBe('abc');
  });
});

// ============== Session 管理测试 ==============

describe('Session Management', () => {
  it('should handle session ID format', () => {
    const testIds = [
      '20250218_001946',
      'abc123def456',
      'session-001',
      'my_session_123',
    ];

    for (const id of testIds) {
      const program = createTestCommand();
      program.parse(['node', 'test', '-r', id]);
      const opts = program.opts();
      expect(opts.resume).toBe(id);
    }
  });

  it('should parse session list command', () => {
    const program = createTestCommand();
    program.parse(['node', 'test', '-s', 'list']);
    const opts = program.opts();
    expect(opts.session).toBe('list');
  });

  it('should parse session delete command', () => {
    const program = createTestCommand();
    program.parse(['node', 'test', '-s', 'delete abc123']);
    const opts = program.opts();
    expect(opts.session).toBe('delete abc123');
  });

  it('should parse session delete-all command', () => {
    const program = createTestCommand();
    program.parse(['node', 'test', '-s', 'delete-all']);
    const opts = program.opts();
    expect(opts.session).toBe('delete-all');
  });

  it('should handle print mode with session persistence', () => {
    const program = createTestCommand();
    program.parse(['node', 'test', '-p', 'my task']);
    const opts = program.opts();
    expect(opts.print).toBe('my task');
    // By default, -p saves session (unless --no-session is used)
  });

  it('should handle print mode without session persistence', () => {
    const program = createTestCommand();
    program.parse(['node', 'test', '-p', 'my task', '--no-session']);
    const opts = program.opts();
    expect(opts.print).toBe('my task');
    // --no-session disables session persistence
  });

  it('should handle continue mode without ID', () => {
    const program = createTestCommand();
    program.parse(['node', 'test', '-c']);
    const opts = program.opts();
    expect(opts.continue).toBe(true);
    // Should auto-resume most recent session
  });

  it('should handle resume with ID', () => {
    const program = createTestCommand();
    program.parse(['node', 'test', '-r', 'abc123']);
    const opts = program.opts();
    expect(opts.resume).toBe('abc123');
  });
});

// ============== CLI 行为测试 ==============

describe('CLI Behavior', () => {

  it('should handle empty arguments', () => {
    const program = createTestCommand();
    program.parse(['node', 'test']);
    const opts = program.opts();
    expect(opts.provider).toBe(KODAX_DEFAULT_PROVIDER);
    expect(opts.thinking).toBeUndefined();
    expect(opts.continue).toBeUndefined();
    expect(opts.resume).toBeUndefined();
    expect(opts.print).toBeUndefined();
  });

  it('should reject unknown options', () => {
    const program = createTestCommand();
    program.configureOutput({
      writeOut: () => {},
      writeErr: () => {},
    });
    expect(() => {
      program.parse(['node', 'test', '--unknown-option']);
    }).toThrow();
  });

  it('should handle combined short options', () => {
    const program = createTestCommand();
    // Note: commander doesn't support combined short options like -ty
    // Each option must be separate or have its own value
    program.parse(['node', 'test', '-t', '-y']);
    const opts = program.opts();
    expect(opts.thinking).toBe(true);
    expect(opts.auto).toBe(true);
  });

});

describe('parsePermissionModeOption', () => {
  it('accepts valid ACP permission modes', () => {
    expect(parsePermissionModeOption('accept-edits')).toBe('accept-edits');
    expect(parsePermissionModeOption('auto-in-project')).toBe('auto-in-project');
  });

  it('rejects invalid ACP permission modes', () => {
    expect(() => parsePermissionModeOption('architect')).toThrow(/Expected one of: plan, accept-edits, auto-in-project/);
  });
});
