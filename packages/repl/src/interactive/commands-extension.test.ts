import os from 'os';
import path from 'path';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { setAgentConfigHome } from '@kodax-ai/agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createExtensionRuntime,
  getActiveExtensionRuntime,
  registerOfficialSandboxExtension,
} from '@kodax-ai/coding';
import { BUILTIN_COMMANDS, executeCommand, getCommandRegistry, isRegisteredHostCommand, parseHostCommand } from './commands.js';

describe('extension command host adapters', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-ext-cmd-'));
    setAgentConfigHome(tempDir);
    const registry = getCommandRegistry();
    registry.clear();
    getCommandRegistry();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    const registry = getCommandRegistry();
    registry.clear();
    getCommandRegistry();

    const runtime = getActiveExtensionRuntime();
    if (runtime) {
      await runtime.dispose();
    }
    setAgentConfigHome(undefined);
    await rm(tempDir, { recursive: true, force: true });
  });

  it('starts a registered alias in the Host without invoking its local handler', async () => {
    const handler = vi.fn(async () => ({ success: true }));
    getCommandRegistry().register({ name: 'host-run', aliases: ['hr'], source: 'extension',
      description: 'Host command', handler });
    const execute = vi.fn(async () => ({ kind: 'started', runId: 'host-run-1' }));
    const result = await executeCommand({ command: 'hr', args: ['two words', '--flag'] },
      { sessionId: 'session-1', gitRoot: tempDir } as never,
      { commandClient: { execute } } as never, {} as never);
    expect(execute).toHaveBeenCalledWith({ sessionId: 'session-1', inputId: expect.any(String),
      name: 'hr', args: ['two words', '--flag'] });
    expect(result).toEqual({ startedRunId: 'host-run-1' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('dispatches a Host-only extension name without a local extension runtime', async () => {
    expect(getActiveExtensionRuntime()).toBeNull();
    const execute = vi.fn(async () => ({ kind: 'started', runId: 'remote-extension' }));
    expect(await executeCommand({ command: 'remote-alias', args: ['topic'] },
      { sessionId: 's1', gitRoot: tempDir } as never,
      { commandClient: { execute } } as never, {} as never))
      .toEqual({ startedRunId: 'remote-extension' });
    expect(execute).toHaveBeenCalledWith({ sessionId: 's1', inputId: expect.any(String),
      name: 'remote-alias', args: ['topic'] });
  });

  it('prefers Host command names and aliases over same-named Skills while preserving explicit Skill syntax', async () => {
    for (const name of ['note', 'notes']) {
      const skillDir = path.join(tempDir, '.kodax', 'skills', name);
      await mkdir(skillDir, { recursive: true });
      await writeFile(path.join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: Local Skill\n---\nWrong local Skill.`);
    }
    const listHostCommands = vi.fn(async () => [{ name: 'note', aliases: ['notes'], description: 'Host extension', source: 'extension' }]);
    const execute = vi.fn(async (input: { name: string }) => input.name === 'unknown'
      ? { kind: 'completed' as const, success: false, message: 'Unknown command: /unknown' }
      : { kind: 'started' as const, runId: 'host-note' });
    const context = { sessionId: 's1', gitRoot: tempDir } as never;
    for (const name of ['note', 'notes']) {
      const parsed = await parseHostCommand(`/${name} topic`, tempDir, listHostCommands);
      expect(parsed).toEqual({ command: name, args: ['topic'] });
      expect(await executeCommand(parsed!, context, { commandClient: { execute } } as never, {} as never))
        .toEqual({ startedRunId: 'host-note' });
    }
    listHostCommands.mockClear();
    expect(await parseHostCommand('/skill:note topic', tempDir, listHostCommands)).toBeNull();
    expect(listHostCommands).not.toHaveBeenCalled();
    const unknown = await parseHostCommand('/unknown', tempDir, listHostCommands);
    expect(await executeCommand(unknown!, context, { commandClient: { execute } } as never, {} as never))
      .toEqual({ success: false, message: 'Unknown command: /unknown' });
  });

  it('classifies busy Host commands ahead of Skills while explicit Skills and unknown names keep their queue classification', async () => {
    const catalog = vi.fn(async () => [{ name: 'note', aliases: ['notes'], source: 'extension', description: 'Host command' }]);
    for (const name of ['note', 'notes']) {
      expect(await isRegisteredHostCommand({ command: name, args: [] }, tempDir, catalog)).toBe(true);
    }
    expect(await isRegisteredHostCommand({ command: 'skill', args: [], skillInvocation: { name: 'note' } }, tempDir, catalog)).toBe(false);
    expect(await isRegisteredHostCommand({ command: 'unknown', args: [] }, tempDir, catalog)).toBe(false);
  });

  it('executes an explicitly invoked command that disables automatic model invocation, and keeps help local', async () => {
    const handler = vi.fn();
    getCommandRegistry().register({ name: 'draft', source: 'extension', path: 'draft.md',
      disableModelInvocation: true, description: 'Draft command', handler });
    const execute = vi.fn(async () => ({ kind: 'started', runId: 'explicit-run' }));
    const readPrompt = vi.fn(async () => ({ title: 'Draft', text: 'Edit this.' }));
    const context = { sessionId: 'session-1', gitRoot: tempDir } as never;
    const callbacks = { commandClient: { execute, readPrompt } } as never;
    expect(await executeCommand({ command: 'draft', args: ['topic'] }, context, callbacks, {} as never))
      .toEqual({ startedRunId: 'explicit-run' });
    expect(execute).toHaveBeenCalledWith({ sessionId: 'session-1', inputId: expect.any(String), name: 'draft', args: ['topic'] });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await executeCommand({ command: 'draft', args: ['--help'] }, context, callbacks, {} as never);
    expect(readPrompt).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
  });

  it('leaves explicit Skill text to Host input admission while keeping registered commands local', async () => {
    const skillDir = path.join(tempDir, '.kodax', 'skills', 'probe');
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: probe\ndescription: Probe\n---\nTrusted Skill body.');
    expect(await parseHostCommand('/skill:probe args', tempDir)).toBeNull();
    expect(await parseHostCommand('/probe args', tempDir)).toBeNull();
    expect(await parseHostCommand('Use /probe on this', tempDir)).toBeNull();
    expect(await parseHostCommand('/review --lean', tempDir)).toEqual({ command: 'review', args: ['--lean'] });
    expect(await parseHostCommand('/unknown argument', tempDir)).toEqual({ command: 'unknown', args: ['argument'] });
  });

  it('executes active extension commands and maps invocation requests into REPL command results', async () => {
    const extensionPath = path.join(tempDir, 'command-extension.mjs');
    await writeFile(
      extensionPath,
      `export default function(api) {
        api.registerCommand({
          name: 'review-plan',
          aliases: ['rp'],
          description: 'Review a plan through the agent runtime',
          usage: '/review-plan <topic>',
          handler: async (args) => ({
            message: 'reviewing ' + (args[0] ?? 'nothing'),
            invocation: {
              prompt: 'Review plan for ' + (args[0] ?? 'general'),
              displayName: 'Review Plan',
              context: 'fork',
            },
          }),
        });
      }`,
      'utf8',
    );

    const runtime = createExtensionRuntime().activate();
    await runtime.loadExtension(extensionPath);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await executeCommand(
      { command: 'rp', args: ['auth'] },
      { sessionId: 'session-1', gitRoot: tempDir } as never,
      {} as never,
      {} as never,
    );

    expect(result).toMatchObject({
      invocation: {
        source: 'extension',
        prompt: 'Review plan for auth',
        displayName: 'Review Plan',
        context: 'fork',
      },
    });

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('reviewing auth');
  });

  it('shows active extension runtime commands in top-level help output', async () => {
    const extensionPath = path.join(tempDir, 'help-extension.mjs');
    await writeFile(
      extensionPath,
      `export default function(api) {
        api.registerCommand({
          name: 'runtime-stats',
          description: 'Show runtime stats',
          handler: async () => ({ message: 'stats' }),
        });
      }`,
      'utf8',
    );

    const runtime = createExtensionRuntime().activate();
    await runtime.loadExtension(extensionPath);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const helpCommand = BUILTIN_COMMANDS.find((cmd) => cmd.name === 'help');

    expect(helpCommand).toBeDefined();
    await helpCommand!.handler([], {} as never, {} as never, {} as never);

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Extensions:');
    expect(output).toContain('/runtime-stats');
  });

  it('lists Host-only commands and aliases in help without loading a local extension runtime', async () => {
    expect(getActiveExtensionRuntime()).toBeNull();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await executeCommand({ command: 'help', args: [] }, { sessionId: 's1', gitRoot: tempDir } as never,
      { listHostCommands: async () => [{ name: 'remote-note', aliases: ['rn'], description: 'Remote notes', source: 'extension' }] } as never,
      {} as never);
    const text = log.mock.calls.flat().join('\n');
    expect(text).toContain('/remote-note');
    expect(text).toContain('(rn)');
    expect(text).toContain('Remote notes');
  });

  it('reads detailed Host command help through its alias instead of opening a manual topic', async () => {
    const execute = vi.fn(async () => ({ kind: 'completed', success: true, message: 'Remote command help' }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await executeCommand({ command: 'help', args: ['rn'] }, { sessionId: 's1', gitRoot: tempDir } as never,
      { commandClient: { execute }, listHostCommands: async () => [{ name: 'remote-note', aliases: ['rn'], description: 'Remote notes', source: 'extension' }] } as never,
      {} as never)).toEqual({ success: true, message: 'Remote command help' });
    expect(execute).toHaveBeenCalledWith({ sessionId: 's1', inputId: expect.any(String), name: 'rn', args: ['--help'] });
  });

  it('reloads active extensions and prints diagnostics through builtin commands', async () => {
    const extensionPath = path.join(tempDir, 'diagnostic-extension.mjs');
    await writeFile(
      extensionPath,
      `export default function(api) {
        api.registerCommand({
          name: 'diag-cmd',
          description: 'Diagnostic command',
          handler: async () => ({ message: 'ok' }),
        });
        api.registerCapabilityProvider({
          id: 'diag-provider',
          kinds: ['tool'],
          describe: async (id) => ({ id }),
          execute: async (id) => ({ kind: 'tool', content: id }),
        });
      }`,
      'utf8',
    );

    const runtime = createExtensionRuntime().activate();
    await runtime.loadExtension(extensionPath);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await writeFile(
      extensionPath,
      `export default function(api) {
        api.registerCommand({
          name: 'diag-cmd-v2',
          description: 'Diagnostic command v2',
          handler: async () => ({ message: 'ok-v2' }),
        });
        api.registerCapabilityProvider({
          id: 'diag-provider-v2',
          kinds: ['tool'],
          describe: async (id) => ({ id }),
          execute: async (id) => ({ kind: 'tool', content: id }),
        });
      }`,
      'utf8',
    );

    const reloadCommand = BUILTIN_COMMANDS.find((cmd) => cmd.name === 'reload');
    expect(reloadCommand).toBeDefined();
    await reloadCommand!.handler(
      [],
      {} as never,
      { reloadAgentsFiles: async () => [] } as never,
      {} as never,
    );

    const extensionsCommand = BUILTIN_COMMANDS.find((cmd) => cmd.name === 'extensions');
    expect(extensionsCommand).toBeDefined();
    await extensionsCommand!.handler([], {} as never, {} as never, {} as never);

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Extension Runtime:');
    expect(output).toContain('diag-cmd-v2');
    expect(output).toContain('diag-provider-v2');
    expect(output).not.toContain('diag-cmd  Diagnostic command');
  });

  it('prepares discovered prompt commands through the Host binding (FEATURE_298 T37)', async () => {
    const cmdDir = path.join(tempDir, '.kodax', 'commands');
    await mkdir(cmdDir, { recursive: true });
    await writeFile(
      path.join(cmdDir, 'host-prep.md'),
      [
        '---',
        'description: Locally discovered command',
        'allowed-tools: Read',
        '---',
        '',
        'Local prompt body.',
      ].join('\n'),
      'utf8',
    );
    // Re-init the registry after chdir so it discovers the seeded command.
    const previousCwd = process.cwd();
    process.chdir(tempDir);
    const registry = getCommandRegistry();
    registry.clear();
    getCommandRegistry(tempDir);
    try {
      const seen: Array<{ name: string; projectRoot: string }> = [];
      const binding = {
        async prepare(input: { name: string; projectRoot: string }) {
          seen.push(input);
          if (input.name !== 'host-prep') return { kind: 'local' as const };
          return {
            kind: 'prepared' as const,
            invocation: {
              prompt: 'Host-prepared prompt body.',
              source: 'prompt' as const,
              displayName: 'host-prep',
              allowedTools: 'Read',
            },
          };
        },
      };
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const result = await executeCommand(
        { command: 'host-prep', args: [] },
        { sessionId: 'session-1', gitRoot: tempDir } as never,
        { prepareCommandInvocation: binding } as never,
        {} as never,
      );
      logSpy.mockRestore();

      expect(seen).toEqual([{ name: 'host-prep', projectRoot: tempDir }]);
      expect(result).toMatchObject({
        invocation: {
          prompt: 'Host-prepared prompt body.',
          source: 'prompt',
          displayName: 'host-prep',
        },
      });

      // Without a binding the local registry handler still runs.
      const local = await executeCommand(
        { command: 'host-prep', args: [] },
        { sessionId: 'session-1', gitRoot: tempDir } as never,
        {} as never,
        {} as never,
      );
      expect(local).toMatchObject({
        invocation: {
          prompt: 'Local prompt body.',
          source: 'prompt',
        },
      });
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('discovers newly added default extensions through manual /reload', async () => {
    const extensionDir = path.join(tempDir, 'extensions', 'fresh-extension');
    await mkdir(extensionDir, { recursive: true });
    await writeFile(
      path.join(extensionDir, 'extension.mjs'),
      `export default function(api) {
        api.registerCommand({
          name: 'fresh-cmd',
          description: 'Freshly discovered command',
          handler: async () => ({ message: 'fresh' }),
        });
      }`,
      'utf8',
    );

    expect(getActiveExtensionRuntime()).toBeNull();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const reloadCommand = BUILTIN_COMMANDS.find((cmd) => cmd.name === 'reload');
    expect(reloadCommand).toBeDefined();
    await reloadCommand!.handler(
      [],
      { gitRoot: tempDir } as never,
      { reloadAgentsFiles: async () => [] } as never,
      {} as never,
    );

    const runtime = getActiveExtensionRuntime();
    expect(runtime).not.toBeNull();
    expect(runtime!.getDiagnostics().commands.map((command) => command.name)).toContain('fresh-cmd');

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Extensions loaded: 1 module(s)');
  });

  it('does not create an extension runtime when /reload discovers no extension entrypoints', async () => {
    expect(getActiveExtensionRuntime()).toBeNull();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const reloadCommand = BUILTIN_COMMANDS.find((cmd) => cmd.name === 'reload');
    expect(reloadCommand).toBeDefined();
    await reloadCommand!.handler(
      [],
      { gitRoot: tempDir } as never,
      { reloadAgentsFiles: async () => [] } as never,
      {} as never,
    );

    expect(getActiveExtensionRuntime()).toBeNull();
    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).not.toContain('Extensions loaded:');
    expect(output).not.toContain('Extensions reloaded:');
  });

  it('keeps discovered extension registration idempotent across repeated /reload calls', async () => {
    const extensionDir = path.join(tempDir, 'extensions', 'repeat-extension');
    const entrypoint = path.join(extensionDir, 'extension.mjs');
    await mkdir(extensionDir, { recursive: true });
    await writeFile(
      entrypoint,
      `export default function(api) {
        api.registerCommand({
          name: 'repeat-cmd',
          description: 'Repeated command',
          handler: async () => ({ message: 'repeat' }),
        });
      }`,
      'utf8',
    );

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const reloadCommand = BUILTIN_COMMANDS.find((cmd) => cmd.name === 'reload');
    expect(reloadCommand).toBeDefined();
    await reloadCommand!.handler(
      [],
      { gitRoot: tempDir } as never,
      { reloadAgentsFiles: async () => [] } as never,
      {} as never,
    );
    logSpy.mockClear();
    await reloadCommand!.handler(
      [],
      { gitRoot: tempDir } as never,
      { reloadAgentsFiles: async () => [] } as never,
      {} as never,
    );

    const diagnostics = getActiveExtensionRuntime()!.getDiagnostics();
    expect(diagnostics.loadedExtensions.filter((extension) => extension.path === entrypoint)).toHaveLength(1);
    expect(diagnostics.commands.filter((command) => command.name === 'repeat-cmd')).toHaveLength(1);
    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Extensions reloaded: 1 module(s)');
    expect(output).not.toContain('Extensions loaded:');
  });

  it('loads newly configured extensions through manual /reload', async () => {
    const extensionDir = path.join(tempDir, 'configured-extension');
    const entrypoint = path.join(extensionDir, 'extension.mjs');
    await mkdir(extensionDir, { recursive: true });
    await writeFile(path.join(tempDir, 'config.json'), JSON.stringify({
      extensions: ['./configured-extension'],
    }), 'utf8');
    await writeFile(
      entrypoint,
      `export default function(api) {
        api.registerCommand({
          name: 'config-cmd',
          description: 'Configured command',
          handler: async () => ({ message: 'configured' }),
        });
      }`,
      'utf8',
    );

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const reloadCommand = BUILTIN_COMMANDS.find((cmd) => cmd.name === 'reload');
    expect(reloadCommand).toBeDefined();
    await reloadCommand!.handler(
      [],
      { gitRoot: tempDir } as never,
      { reloadAgentsFiles: async () => [] } as never,
      {} as never,
    );

    const diagnostics = getActiveExtensionRuntime()!.getDiagnostics();
    expect(diagnostics.commands.map((command) => command.name)).toContain('config-cmd');
    expect(diagnostics.loadedExtensions).toContainEqual(expect.objectContaining({
      path: entrypoint,
      loadSource: 'config',
    }));
    expect(logSpy.mock.calls.flat().join('\n')).toContain('Extensions loaded: 1 module(s)');
  });

  it('surfaces recorded reload failures in extension diagnostics output', async () => {
    const extensionPath = path.join(tempDir, 'failing-reload-extension.mjs');
    await writeFile(
      extensionPath,
      `export default function(api) {
        api.registerCommand({
          name: 'stable-cmd',
          description: 'Stable command',
          handler: async () => ({ message: 'stable' }),
        });
      }`,
      'utf8',
    );

    const runtime = createExtensionRuntime().activate();
    await runtime.loadExtension(extensionPath);

    await writeFile(
      extensionPath,
      `export default function(api) {
        api.registerCommand({
          name: 'stable-cmd',
          description: 'Broken command',
          handler: async () => ({ message: 'broken' }),
        });
        throw new Error('reload exploded');
      }`,
      'utf8',
    );

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const reloadCommand = BUILTIN_COMMANDS.find((cmd) => cmd.name === 'reload');
    expect(reloadCommand).toBeDefined();
    await reloadCommand!.handler(
      [],
      {} as never,
      { reloadAgentsFiles: async () => [] } as never,
      {} as never,
    );

    const extensionsCommand = BUILTIN_COMMANDS.find((cmd) => cmd.name === 'extensions');
    expect(extensionsCommand).toBeDefined();
    await extensionsCommand!.handler([], {} as never, {} as never, {} as never);

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Failures:');
    expect(output).not.toContain('Extensions reloaded:');
    expect(output).toContain('reload exploded');
    expect(output).toContain('stable-cmd');
  });

  it('prints official sandbox policy metadata through the existing extensions diagnostics surface', async () => {
    const runtime = createExtensionRuntime().activate();
    registerOfficialSandboxExtension(runtime, {
      workspaceRoot: tempDir,
      mode: 'best_effort',
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const extensionsCommand = BUILTIN_COMMANDS.find((cmd) => cmd.name === 'extensions');
    expect(extensionsCommand).toBeDefined();
    await extensionsCommand!.handler([], {} as never, {} as never, {} as never);

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('official-sandbox [resource]');
    expect(output).toContain('mode=best_effort');
    expect(output).toContain(`workspaceRoot=${tempDir}`);
    expect(output).toContain('guardedTools=write, edit, bash');
  });
});
