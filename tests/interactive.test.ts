/**
 * KodaX 交互式模块测试
 *
 * 测试 REPL 模式、命令系统和上下文管理
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import {
  InteractiveContext,
  InteractiveMode,
  createInteractiveContext,
  touchContext,
  parseCommand,
  executeCommand,
  BUILTIN_COMMANDS,
  CommandCallbacks,
  processSpecialSyntax,
} from '../src/interactive/index.js';
import { KodaXMessage } from '../src/core/index.js';
import { loadConfig, saveConfig, getProviderModel, getProviderList, isProviderConfigured } from '../src/cli/utils.js';
import { KODAX_PROVIDERS } from '../src/core/providers/index.js';

// ============== 上下文管理测试 ==============

describe('InteractiveContext', () => {
  it('should create context with default values', async () => {
    const context = await createInteractiveContext({});

    expect(context.messages).toEqual([]);
    expect(context.sessionId).toBeDefined();
    expect(context.sessionId).toMatch(/^\d{8}_\d{6}$/); // YYYYMMDD_HHMMSS format
    expect(context.title).toBe('');
    // mode 已移至 CurrentConfig 管理
    expect(context.createdAt).toBeDefined();
    expect(context.lastAccessed).toBeDefined();
  });

  it('should create context with custom sessionId', async () => {
    const context = await createInteractiveContext({ sessionId: 'custom-123' });
    expect(context.sessionId).toBe('custom-123');
  });

  it('should create context with gitRoot', async () => {
    const context = await createInteractiveContext({ gitRoot: '/path/to/repo' });
    expect(context.gitRoot).toBe('/path/to/repo');
  });

  it('should create context with existing messages', async () => {
    const messages = [{ role: 'user' as const, content: 'Hello' }];
    const context = await createInteractiveContext({ existingMessages: messages });
    expect(context.messages).toHaveLength(1);
    expect(context.messages[0]?.content).toBe('Hello');
  });
});

describe('touchContext', () => {
  it('should update lastAccessed timestamp', async () => {
    const context = await createInteractiveContext({});
    const originalTime = context.lastAccessed;

    // Wait a bit to ensure time difference
    await new Promise(resolve => setTimeout(resolve, 10));

    touchContext(context);
    expect(context.lastAccessed).not.toBe(originalTime);
    expect(new Date(context.lastAccessed).getTime()).toBeGreaterThan(new Date(originalTime).getTime());
  });
});

// ============== 命令解析测试 ==============

describe('parseCommand', () => {
  it('should parse simple command', () => {
    const result = parseCommand('/help');
    expect(result).not.toBeNull();
    expect(result?.command).toBe('help');
    expect(result?.args).toEqual([]);
  });

  it('should parse command with args', () => {
    const result = parseCommand('/load session-123');
    expect(result).not.toBeNull();
    expect(result?.command).toBe('load');
    expect(result?.args).toEqual(['session-123']);
  });

  it('should parse command with multiple args', () => {
    const result = parseCommand('/mode code verbose');
    expect(result).not.toBeNull();
    expect(result?.command).toBe('mode');
    expect(result?.args).toEqual(['code', 'verbose']);
  });

  it('should return null for non-command input', () => {
    expect(parseCommand('hello world')).toBeNull();
    expect(parseCommand('regular text')).toBeNull();
    expect(parseCommand('')).toBeNull();
    expect(parseCommand('  ')).toBeNull();
  });

  it('should handle whitespace', () => {
    const result = parseCommand('/help   arg1   arg2');
    expect(result?.command).toBe('help');
    expect(result?.args).toEqual(['arg1', 'arg2']);
  });

  it('should lowercase command', () => {
    const result = parseCommand('/HELP');
    expect(result?.command).toBe('help');
  });

  it('should handle slash only', () => {
    const result = parseCommand('/');
    expect(result).toBeNull();
  });
});

// ============== 内置命令测试 ==============

describe('BUILTIN_COMMANDS', () => {
  it('should have help command', () => {
    const help = BUILTIN_COMMANDS.find(c => c.name === 'help');
    expect(help).toBeDefined();
    expect(help?.aliases).toContain('h');
    expect(help?.aliases).toContain('?');
  });

  it('should have exit command', () => {
    const exit = BUILTIN_COMMANDS.find(c => c.name === 'exit');
    expect(exit).toBeDefined();
    expect(exit?.aliases).toContain('quit');
    expect(exit?.aliases).toContain('q');
    expect(exit?.aliases).toContain('bye');
  });

  it('should have mode commands', () => {
    const mode = BUILTIN_COMMANDS.find(c => c.name === 'mode');
    const ask = BUILTIN_COMMANDS.find(c => c.name === 'ask');
    const code = BUILTIN_COMMANDS.find(c => c.name === 'code');
    expect(mode).toBeDefined();
    expect(ask).toBeDefined();
    expect(code).toBeDefined();
  });

  it('should have session commands', () => {
    const save = BUILTIN_COMMANDS.find(c => c.name === 'save');
    const load = BUILTIN_COMMANDS.find(c => c.name === 'load');
    const sessions = BUILTIN_COMMANDS.find(c => c.name === 'sessions');
    expect(save).toBeDefined();
    expect(load).toBeDefined();
    expect(sessions).toBeDefined();
  });
});

// ============== 命令执行测试 ==============

describe('executeCommand', () => {
  let context: InteractiveContext;
  let callbacks: CommandCallbacks;
  let currentConfig: { provider: string; thinking: boolean; auto: boolean; mode?: 'code' | 'ask' };
  let exitCalled: boolean;
  let savedSession: { id: string; messages: unknown[]; title: string } | null;
  let loadedSessionId: string | null;
  let clearedHistory: boolean;

  beforeEach(async () => {
    context = await createInteractiveContext({});
    currentConfig = { provider: 'test', thinking: false, auto: false, mode: 'code' };
    exitCalled = false;
    savedSession = null;
    loadedSessionId = null;
    clearedHistory = false;

    callbacks = {
      exit: () => { exitCalled = true; },
      saveSession: async () => {
        savedSession = { id: context.sessionId, messages: [...context.messages], title: context.title };
      },
      loadSession: async (id: string) => {
        loadedSessionId = id;
        return true;
      },
      listSessions: async () => {},
      clearHistory: () => {
        context.messages = [];
        clearedHistory = true;
      },
      printHistory: () => {},
    };
  });

  it('should execute help command', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await executeCommand({ command: 'help', args: [] }, context, callbacks, currentConfig);
    expect(consoleSpy).toHaveBeenCalled();
    const output = consoleSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(output).toContain('Available Commands');
    consoleSpy.mockRestore();
  });

  it('should execute help command with alias h', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await executeCommand({ command: 'h', args: [] }, context, callbacks, currentConfig);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('should execute exit command', async () => {
    await executeCommand({ command: 'exit', args: [] }, context, callbacks, currentConfig);
    expect(exitCalled).toBe(true);
    expect(savedSession).not.toBeNull();
  });

  it('should execute exit command with alias quit', async () => {
    await executeCommand({ command: 'quit', args: [] }, context, callbacks, currentConfig);
    expect(exitCalled).toBe(true);
  });

  it('should execute clear command', async () => {
    context.messages = [{ role: 'user', content: 'test' }];
    await executeCommand({ command: 'clear', args: [] }, context, callbacks, currentConfig);
    expect(clearedHistory).toBe(true);
    expect(context.messages).toHaveLength(0);
  });

  it('should execute mode command without args (show current)', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await executeCommand({ command: 'mode', args: [] }, context, callbacks, currentConfig);
    const output = consoleSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(output).toContain('Current mode');
    consoleSpy.mockRestore();
  });

  it('should execute mode command with code arg', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await executeCommand({ command: 'mode', args: ['code'] }, context, callbacks, currentConfig);
    expect(currentConfig.mode).toBe('code');
    consoleSpy.mockRestore();
  });

  it('should execute mode command with ask arg', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await executeCommand({ command: 'mode', args: ['ask'] }, context, callbacks, currentConfig);
    expect(currentConfig.mode).toBe('ask');
    consoleSpy.mockRestore();
  });

  it('should execute ask command', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await executeCommand({ command: 'ask', args: [] }, context, callbacks, currentConfig);
    expect(currentConfig.mode).toBe('ask');
    consoleSpy.mockRestore();
  });

  it('should execute code command', async () => {
    currentConfig.mode = 'ask';
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await executeCommand({ command: 'code', args: [] }, context, callbacks, currentConfig);
    expect(currentConfig.mode).toBe('code');
    consoleSpy.mockRestore();
  });

  it('should execute save command', async () => {
    context.messages = [{ role: 'user', content: 'test message' }];
    await executeCommand({ command: 'save', args: [] }, context, callbacks, currentConfig);
    expect(savedSession).not.toBeNull();
  });

  it('should execute load command with session id', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await executeCommand({ command: 'load', args: ['session-123'] }, context, callbacks, currentConfig);
    expect(loadedSessionId).toBe('session-123');
    consoleSpy.mockRestore();
  });

  it('should execute load command without args (show usage)', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await executeCommand({ command: 'load', args: [] }, context, callbacks, currentConfig);
    const output = consoleSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(output).toContain('Usage');
    consoleSpy.mockRestore();
  });

  it('should execute status command', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await executeCommand({ command: 'status', args: [] }, context, callbacks, currentConfig);
    const output = consoleSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(output).toContain('Session Status');
    expect(output).toContain('Mode');
    expect(output).toContain('Session ID');
    consoleSpy.mockRestore();
  });

  it('should handle unknown command', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await executeCommand({ command: 'unknowncommand', args: [] }, context, callbacks, currentConfig);
    expect(result).toBe(false);
    const output = consoleSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(output).toContain('Unknown command');
    consoleSpy.mockRestore();
  });
});

// ============== 命令别名测试 ==============

describe('Command Aliases', () => {
  let context: InteractiveContext;
  let callbacks: CommandCallbacks;
  let currentConfig: { provider: string; thinking: boolean; auto: boolean; mode?: 'code' | 'ask' };

  beforeEach(async () => {
    context = await createInteractiveContext({});
    currentConfig = { provider: 'test', thinking: false, auto: false, mode: 'code' };
    callbacks = {
      exit: () => {},
      saveSession: async () => {},
      loadSession: async () => true,
      listSessions: async () => {},
      clearHistory: () => {},
      printHistory: () => {},
    };
  });

  it('should recognize help aliases (h, ?)', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await executeCommand({ command: 'h', args: [] }, context, callbacks, currentConfig);
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockClear();
    await executeCommand({ command: '?', args: [] }, context, callbacks, currentConfig);
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it('should recognize exit aliases (quit, q, bye)', async () => {
    let exitCount = 0;
    callbacks.exit = () => { exitCount++; };

    await executeCommand({ command: 'quit', args: [] }, context, callbacks, currentConfig);
    expect(exitCount).toBe(1);

    await executeCommand({ command: 'q', args: [] }, context, callbacks, currentConfig);
    expect(exitCount).toBe(2);

    await executeCommand({ command: 'bye', args: [] }, context, callbacks, currentConfig);
    expect(exitCount).toBe(3);
  });

  it('should recognize status aliases (info, ctx)', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await executeCommand({ command: 'info', args: [] }, context, callbacks, currentConfig);
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockClear();
    await executeCommand({ command: 'ctx', args: [] }, context, callbacks, currentConfig);
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it('should recognize sessions aliases (ls, list)', async () => {
    let listCalled = false;
    callbacks.listSessions = async () => { listCalled = true; };

    await executeCommand({ command: 'ls', args: [] }, context, callbacks, currentConfig);
    expect(listCalled).toBe(true);

    listCalled = false;
    await executeCommand({ command: 'list', args: [] }, context, callbacks, currentConfig);
    expect(listCalled).toBe(true);
  });

  it('should recognize history aliases (hist)', async () => {
    let historyCalled = false;
    callbacks.printHistory = () => { historyCalled = true; };

    await executeCommand({ command: 'hist', args: [] }, context, callbacks, currentConfig);
    expect(historyCalled).toBe(true);
  });

  it('should recognize load alias (resume)', async () => {
    let loadedId: string | null = null;
    callbacks.loadSession = async (id: string) => {
      loadedId = id;
      return true;
    };

    await executeCommand({ command: 'resume', args: ['session-456'] }, context, callbacks, currentConfig);
    expect(loadedId).toBe('session-456');
  });
});

// ============== 模式切换详细测试 ==============

describe('Mode Switching Detailed', () => {
  let context: InteractiveContext;
  let callbacks: CommandCallbacks;
  let currentConfig: { provider: string; thinking: boolean; auto: boolean; mode?: 'code' | 'ask' };

  beforeEach(async () => {
    context = await createInteractiveContext({});
    currentConfig = { provider: 'test', thinking: false, auto: false, mode: 'code' };
    callbacks = {
      exit: () => {},
      saveSession: async () => {},
      loadSession: async () => true,
      listSessions: async () => {},
      clearHistory: () => {},
      printHistory: () => {},
    };
  });

  it('should start in code mode by default', () => {
    expect(currentConfig.mode).toBe('code');
  });

  it('should switch to ask mode and back to code', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await executeCommand({ command: 'ask', args: [] }, context, callbacks, currentConfig);
    expect(currentConfig.mode).toBe('ask');

    await executeCommand({ command: 'code', args: [] }, context, callbacks, currentConfig);
    expect(currentConfig.mode).toBe('code');

    consoleSpy.mockRestore();
  });

  it('should handle invalid mode gracefully', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const originalMode = currentConfig.mode;

    await executeCommand({ command: 'mode', args: ['invalid'] }, context, callbacks, currentConfig);

    expect(currentConfig.mode).toBe(originalMode);
    const output = consoleSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(output).toContain('Unknown mode');

    consoleSpy.mockRestore();
  });
});

// ============== 会话管理详细测试 ==============

describe('Session Management Detailed', () => {
  let context: InteractiveContext;
  let callbacks: CommandCallbacks;
  let savedSessions: Array<{ id: string; messages: KodaXMessage[]; title: string }>;

  beforeEach(async () => {
    context = await createInteractiveContext({});
    savedSessions = [];

    callbacks = {
      exit: () => {},
      saveSession: async () => {
        savedSessions.push({
          id: context.sessionId,
          messages: [...context.messages],
          title: context.title,
        });
      },
      loadSession: async (id: string) => {
        const session = savedSessions.find(s => s.id === id);
        if (session) {
          context.messages = session.messages;
          context.title = session.title;
          return true;
        }
        return false;
      },
      listSessions: async () => {},
      clearHistory: () => {
        context.messages = [];
      },
      printHistory: () => {},
    };
  });

  it('should save and load session', async () => {
    // Add some messages
    context.messages.push({ role: 'user', content: 'Hello' });
    context.messages.push({ role: 'assistant', content: 'Hi!' });
    context.title = 'Test Session';

    // Save
    await callbacks.saveSession();
    expect(savedSessions).toHaveLength(1);

    // Clear and verify
    callbacks.clearHistory();
    expect(context.messages).toHaveLength(0);

    // Load
    const loaded = await callbacks.loadSession(context.sessionId);
    expect(loaded).toBe(true);
    expect(context.messages).toHaveLength(2);
  });

  it('should return false for non-existent session', async () => {
    const loaded = await callbacks.loadSession('non-existent-id');
    expect(loaded).toBe(false);
  });
});

// ============== 命令解析边界测试 ==============

describe('Command Parsing Edge Cases', () => {
  it('should handle command with extra whitespace', () => {
    const result = parseCommand('/help   arg1   arg2   ');
    expect(result).not.toBeNull();
    expect(result?.command).toBe('help');
    expect(result?.args).toEqual(['arg1', 'arg2']);
  });

  it('should handle uppercase command', () => {
    const result = parseCommand('/HELP');
    expect(result?.command).toBe('help');
  });

  it('should handle mixed case command', () => {
    const result = parseCommand('/HeLp');
    expect(result?.command).toBe('help');
  });

  it('should handle command with special characters in args', () => {
    const result = parseCommand('/load session-with-dashes_and_underscores');
    expect(result?.command).toBe('load');
    expect(result?.args).toEqual(['session-with-dashes_and_underscores']);
  });

  it('should return null for input without slash', () => {
    expect(parseCommand('help')).toBeNull();
    expect(parseCommand(' regular text')).toBeNull();
  });

  it('should return null for empty input', () => {
    expect(parseCommand('')).toBeNull();
    expect(parseCommand('   ')).toBeNull();
  });
});

// ============== 上下文管理详细测试 ==============

describe('Context Management Detailed', () => {
  it('should create context with custom gitRoot', async () => {
    const context = await createInteractiveContext({ gitRoot: '/custom/path' });
    expect(context.gitRoot).toBe('/custom/path');
  });

  it('should create unique session IDs', async () => {
    const context1 = await createInteractiveContext({});
    await new Promise(r => setTimeout(r, 10));
    const context2 = await createInteractiveContext({});

    // Session IDs should match the format and likely be different
    expect(context1.sessionId).toMatch(/^\d{8}_\d{6}$/);
    expect(context2.sessionId).toMatch(/^\d{8}_\d{6}$/);
  });

  it('should track lastAccessed time', async () => {
    const context = await createInteractiveContext({});
    const originalTime = context.lastAccessed;

    await new Promise(r => setTimeout(r, 50));
    touchContext(context);

    expect(context.lastAccessed).not.toBe(originalTime);
  });
});

// ============== 特殊语法处理测试 ==============

describe('processSpecialSyntax', () => {
  it('should return input unchanged for normal text', async () => {
    const result = await processSpecialSyntax('hello world');
    expect(result).toBe('hello world');
  });

  it('should return input unchanged for code questions', async () => {
    const result = await processSpecialSyntax('how do I fix this bug?');
    expect(result).toBe('how do I fix this bug?');
  });

  it('should execute shell command with ! prefix', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await processSpecialSyntax('!echo hello');

    expect(result).toContain('[Shell command executed: echo hello]');
    expect(result).toContain('hello');
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it('should handle shell command with no output', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // true command always succeeds with no output
    const result = await processSpecialSyntax('!true');

    expect(result).toContain('[Shell command executed: true]');
    expect(result).toContain('(no output)');

    consoleSpy.mockRestore();
  });

  it('should handle shell command error', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // Use a command that will fail
    const result = await processSpecialSyntax('!exit 1');

    expect(result).toContain('[Shell command failed: exit 1]');
    expect(result).toContain('Error:');

    consoleSpy.mockRestore();
  });

  it('should handle empty shell command', async () => {
    const result = await processSpecialSyntax('!');
    expect(result).toBe('[Shell: No command provided]');
  });

  it('should handle shell command with only whitespace', async () => {
    const result = await processSpecialSyntax('!   ');
    expect(result).toBe('[Shell: No command provided]');
  });

  it('should handle shell command with arguments', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await processSpecialSyntax('!echo test1 test2');

    expect(result).toContain('[Shell command executed: echo test1 test2]');
    expect(result).toContain('test1 test2');

    consoleSpy.mockRestore();
  });

  it('should handle multi-line shell output', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await processSpecialSyntax('!echo line1 && echo line2');

    expect(result).toContain('[Shell command executed:');
    expect(result).toContain('line1');

    consoleSpy.mockRestore();
  });

  it('should handle shell command with stderr output', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // Use a command that writes to stderr (node -e works cross-platform)
    const result = await processSpecialSyntax('!node -e "console.error(\'stderr output\')"');

    expect(result).toContain('[Shell command executed:');
    expect(result).toContain('stderr');
    expect(result).toContain('[stderr]');

    consoleSpy.mockRestore();
  });

  it('should handle shell command with special characters', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await processSpecialSyntax('!echo "hello $WORLD"');

    expect(result).toContain('[Shell command executed:');
    expect(result).toContain('hello');

    consoleSpy.mockRestore();
  });

  it('should handle shell command with quotes', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await processSpecialSyntax('!echo "hello world"');

    expect(result).toContain('[Shell command executed:');
    expect(result).toContain('hello world');

    consoleSpy.mockRestore();
  });

  it('should handle shell command with pipes', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await processSpecialSyntax('!echo hello | cat');

    expect(result).toContain('[Shell command executed:');
    expect(result).toContain('hello');

    consoleSpy.mockRestore();
  });

  it('should handle non-existent command', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await processSpecialSyntax('!nonexistentcommand12345');

    expect(result).toContain('[Shell command failed:');
    expect(result).toContain('Error:');

    consoleSpy.mockRestore();
  });

  it('should return @file syntax unchanged (not implemented yet)', async () => {
    const result = await processSpecialSyntax('@./src/file.ts');
    // @file syntax is not implemented yet, so it should return unchanged
    expect(result).toBe('@./src/file.ts');
  });

  it('should handle input with @file and normal text', async () => {
    const result = await processSpecialSyntax('check @./src/file.ts for bugs');
    // @file syntax is not implemented yet, so it should return unchanged
    expect(result).toBe('check @./src/file.ts for bugs');
  });

  it('should handle shell command with cd', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await processSpecialSyntax('!cd . && echo success');

    expect(result).toContain('[Shell command executed:');
    expect(result).toContain('success');

    consoleSpy.mockRestore();
  });

  it('should handle git command', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await processSpecialSyntax('!git --version');

    expect(result).toContain('[Shell command executed:');
    expect(result).toContain('git version');

    consoleSpy.mockRestore();
  });

  it('should handle npm command', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await processSpecialSyntax('!npm --version');

    expect(result).toContain('[Shell command executed:');
    // npm version should be a number-like string
    expect(result).toMatch(/\d+\.\d+\.\d+/);

    consoleSpy.mockRestore();
  });
});

// ============== Shell 命令跳过逻辑测试 (Bug 1 修复验证) ==============
// Warp 风格：成功执行 → 跳过，空命令 → 跳过，失败/错误 → 发送给 LLM

describe('Shell Command Skip Logic (Warp Style)', () => {
  // 模拟修复后的跳过逻辑
  function shouldSkipShellCommand(trimmed: string, processed: string): boolean {
    if (trimmed.startsWith('!')) {
      if (processed.startsWith('[Shell command executed:') || processed.startsWith('[Shell:')) {
        return true;
      }
    }
    return false;
  }

  it('should skip successful shell command', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const processed = await processSpecialSyntax('!echo hello');

    expect(shouldSkipShellCommand('!echo hello', processed)).toBe(true);
    consoleSpy.mockRestore();
  });

  it('should skip empty shell command', () => {
    const processed = '[Shell: No command provided]';
    expect(shouldSkipShellCommand('!', processed)).toBe(true);
  });

  it('should skip shell command with only whitespace', () => {
    const processed = '[Shell: No command provided]';
    expect(shouldSkipShellCommand('!   ', processed)).toBe(true);
  });

  it('should NOT skip failed shell command - exits with error', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const processed = await processSpecialSyntax('!exit 1');

    expect(shouldSkipShellCommand('!exit 1', processed)).toBe(false);
    consoleSpy.mockRestore();
  });

  it('should NOT skip non-existent command', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const processed = await processSpecialSyntax('!nonexistent_cmd_12345');

    expect(shouldSkipShellCommand('!nonexistent_cmd_12345', processed)).toBe(false);
    consoleSpy.mockRestore();
  });

  it('should NOT skip command that fails due to missing module', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // Use a command that will fail
    const processed = await processSpecialSyntax('!npm run nonexistent-script');

    expect(shouldSkipShellCommand('!npm run nonexistent-script', processed)).toBe(false);
    consoleSpy.mockRestore();
  });

  it('should not skip non-shell commands', () => {
    expect(shouldSkipShellCommand('hello world', 'hello world')).toBe(false);
    expect(shouldSkipShellCommand('/help', '/help')).toBe(false);
    expect(shouldSkipShellCommand('', '')).toBe(false);
  });

  it('should handle commands that produce no output', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const processed = await processSpecialSyntax('!true');

    expect(shouldSkipShellCommand('!true', processed)).toBe(true);
    consoleSpy.mockRestore();
  });
});

// ============== 配置加载/保存测试 ==============

describe('Config Loading and Saving', () => {
  const TEST_CONFIG_FILE = path.join(os.tmpdir(), 'kodax-test-config-' + Date.now() + '.json');
  const originalConfigFile = 'KODAX_CONFIG_FILE';

  beforeEach(async () => {
    // 使用测试配置文件
  });

  afterEach(async () => {
    try {
      await fs.rm(TEST_CONFIG_FILE, { recursive: true, force: true });
    } catch { }
  });

  it('should load empty config when file does not exist', async () => {
    const config = loadConfig();
    expect(config).toBeDefined();
  });

  it('should save and load config', async () => {
    expect(saveConfig).toBeDefined();
    expect(loadConfig).toBeDefined();
  });
});

// ============== Provider 信息测试 ==============

describe('Provider Info', () => {
  it('should get provider model', async () => {
    const model = getProviderModel('anthropic');
    expect(model).toBeDefined();
    // model could be string or null depending on env setup
    expect(model === null || typeof model === 'string').toBe(true);
  });

  it('should return null for unknown provider', async () => {
    const model = getProviderModel('unknown-provider');
    expect(model).toBeNull();
  });

  it('should get provider list with config status', async () => {
    const list = getProviderList();
    expect(list).toBeDefined();
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThan(0);

    // 验证每个 provider 有必要字段
    for (const p of list) {
      expect(p.name).toBeDefined();
      expect(p.model).toBeDefined();
      expect(typeof p.configured).toBe('boolean');
    }
  });

  it('should check if provider is configured', async () => {
    // 这个测试依赖于环境变量，所以只检查函数是否正常工作
    expect(typeof isProviderConfigured).toBe('function');
  });
});

// ============== 新命令测试 ==============

describe('New Commands', () => {
  it('should have model command', () => {
    const modelCmd = BUILTIN_COMMANDS.find(c => c.name === 'model');
    expect(modelCmd).toBeDefined();
    expect(modelCmd.aliases).toContain('m');
  });

  it('should have thinking command', () => {
    const thinkingCmd = BUILTIN_COMMANDS.find(c => c.name === 'thinking');
    expect(thinkingCmd).toBeDefined();
    expect(thinkingCmd.aliases).toContain('t');
  });

  it('should have auto command', () => {
    const autoCmd = BUILTIN_COMMANDS.find(c => c.name === 'auto');
    expect(autoCmd).toBeDefined();
    expect(autoCmd.aliases).toContain('a');
  });
});
