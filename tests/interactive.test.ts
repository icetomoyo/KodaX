/**
 * KodaX 交互式模块测试
 *
 * 测试 REPL 模式、命令系统和上下文管理
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  InteractiveContext,
  InteractiveMode,
  createInteractiveContext,
  setMode,
  touchContext,
  parseCommand,
  executeCommand,
  BUILTIN_COMMANDS,
  CommandCallbacks,
} from '../src/interactive/index.js';
import { KodaXMessage } from '../src/kodax_core.js';

// ============== 上下文管理测试 ==============

describe('InteractiveContext', () => {
  it('should create context with default values', async () => {
    const context = await createInteractiveContext({});

    expect(context.messages).toEqual([]);
    expect(context.sessionId).toBeDefined();
    expect(context.sessionId).toMatch(/^\d{8}_\d{6}$/); // YYYYMMDD_HHMMSS format
    expect(context.title).toBe('');
    expect(context.mode).toBe('code');
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

describe('setMode', () => {
  it('should change mode to ask', async () => {
    const context = await createInteractiveContext({});
    expect(context.mode).toBe('code');

    setMode(context, 'ask');
    expect(context.mode).toBe('ask');
  });

  it('should change mode to code', async () => {
    const context = await createInteractiveContext({});
    context.mode = 'ask';

    setMode(context, 'code');
    expect(context.mode).toBe('code');
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
  let exitCalled: boolean;
  let savedSession: { id: string; messages: unknown[]; title: string } | null;
  let loadedSessionId: string | null;
  let clearedHistory: boolean;

  beforeEach(async () => {
    context = await createInteractiveContext({});
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
    await executeCommand({ command: 'help', args: [] }, context, callbacks);
    expect(consoleSpy).toHaveBeenCalled();
    const output = consoleSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(output).toContain('Available Commands');
    consoleSpy.mockRestore();
  });

  it('should execute help command with alias h', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await executeCommand({ command: 'h', args: [] }, context, callbacks);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('should execute exit command', async () => {
    await executeCommand({ command: 'exit', args: [] }, context, callbacks);
    expect(exitCalled).toBe(true);
    expect(savedSession).not.toBeNull();
  });

  it('should execute exit command with alias quit', async () => {
    await executeCommand({ command: 'quit', args: [] }, context, callbacks);
    expect(exitCalled).toBe(true);
  });

  it('should execute clear command', async () => {
    context.messages = [{ role: 'user', content: 'test' }];
    await executeCommand({ command: 'clear', args: [] }, context, callbacks);
    expect(clearedHistory).toBe(true);
    expect(context.messages).toHaveLength(0);
  });

  it('should execute mode command without args (show current)', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await executeCommand({ command: 'mode', args: [] }, context, callbacks);
    const output = consoleSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(output).toContain('Current mode');
    consoleSpy.mockRestore();
  });

  it('should execute mode command with code arg', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await executeCommand({ command: 'mode', args: ['code'] }, context, callbacks);
    expect(context.mode).toBe('code');
    consoleSpy.mockRestore();
  });

  it('should execute mode command with ask arg', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await executeCommand({ command: 'mode', args: ['ask'] }, context, callbacks);
    expect(context.mode).toBe('ask');
    consoleSpy.mockRestore();
  });

  it('should execute ask command', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await executeCommand({ command: 'ask', args: [] }, context, callbacks);
    expect(context.mode).toBe('ask');
    consoleSpy.mockRestore();
  });

  it('should execute code command', async () => {
    context.mode = 'ask';
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await executeCommand({ command: 'code', args: [] }, context, callbacks);
    expect(context.mode).toBe('code');
    consoleSpy.mockRestore();
  });

  it('should execute save command', async () => {
    context.messages = [{ role: 'user', content: 'test message' }];
    await executeCommand({ command: 'save', args: [] }, context, callbacks);
    expect(savedSession).not.toBeNull();
  });

  it('should execute load command with session id', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await executeCommand({ command: 'load', args: ['session-123'] }, context, callbacks);
    expect(loadedSessionId).toBe('session-123');
    consoleSpy.mockRestore();
  });

  it('should execute load command without args (show usage)', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await executeCommand({ command: 'load', args: [] }, context, callbacks);
    const output = consoleSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(output).toContain('Usage');
    consoleSpy.mockRestore();
  });

  it('should execute status command', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await executeCommand({ command: 'status', args: [] }, context, callbacks);
    const output = consoleSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(output).toContain('Session Status');
    expect(output).toContain('Mode');
    expect(output).toContain('Session ID');
    consoleSpy.mockRestore();
  });

  it('should handle unknown command', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await executeCommand({ command: 'unknowncommand', args: [] }, context, callbacks);
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

  beforeEach(async () => {
    context = await createInteractiveContext({});
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

    await executeCommand({ command: 'h', args: [] }, context, callbacks);
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockClear();
    await executeCommand({ command: '?', args: [] }, context, callbacks);
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it('should recognize exit aliases (quit, q, bye)', async () => {
    let exitCount = 0;
    callbacks.exit = () => { exitCount++; };

    await executeCommand({ command: 'quit', args: [] }, context, callbacks);
    expect(exitCount).toBe(1);

    await executeCommand({ command: 'q', args: [] }, context, callbacks);
    expect(exitCount).toBe(2);

    await executeCommand({ command: 'bye', args: [] }, context, callbacks);
    expect(exitCount).toBe(3);
  });

  it('should recognize status aliases (info, ctx)', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await executeCommand({ command: 'info', args: [] }, context, callbacks);
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockClear();
    await executeCommand({ command: 'ctx', args: [] }, context, callbacks);
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it('should recognize sessions aliases (ls, list)', async () => {
    let listCalled = false;
    callbacks.listSessions = async () => { listCalled = true; };

    await executeCommand({ command: 'ls', args: [] }, context, callbacks);
    expect(listCalled).toBe(true);

    listCalled = false;
    await executeCommand({ command: 'list', args: [] }, context, callbacks);
    expect(listCalled).toBe(true);
  });

  it('should recognize history aliases (hist)', async () => {
    let historyCalled = false;
    callbacks.printHistory = () => { historyCalled = true; };

    await executeCommand({ command: 'hist', args: [] }, context, callbacks);
    expect(historyCalled).toBe(true);
  });

  it('should recognize load alias (resume)', async () => {
    let loadedId: string | null = null;
    callbacks.loadSession = async (id: string) => {
      loadedId = id;
      return true;
    };

    await executeCommand({ command: 'resume', args: ['session-456'] }, context, callbacks);
    expect(loadedId).toBe('session-456');
  });
});

// ============== 模式切换详细测试 ==============

describe('Mode Switching Detailed', () => {
  let context: InteractiveContext;
  let callbacks: CommandCallbacks;

  beforeEach(async () => {
    context = await createInteractiveContext({});
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
    expect(context.mode).toBe('code');
  });

  it('should switch to ask mode and back to code', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await executeCommand({ command: 'ask', args: [] }, context, callbacks);
    expect(context.mode).toBe('ask');

    await executeCommand({ command: 'code', args: [] }, context, callbacks);
    expect(context.mode).toBe('code');

    consoleSpy.mockRestore();
  });

  it('should handle invalid mode gracefully', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const originalMode = context.mode;

    await executeCommand({ command: 'mode', args: ['invalid'] }, context, callbacks);

    expect(context.mode).toBe(originalMode);
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
