import os from 'os';
import path from 'path';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createExtensionRuntime,
  getActiveExtensionRuntime,
  registerOfficialSandboxExtension,
} from '@kodax/coding';
import { BUILTIN_COMMANDS, executeCommand, getCommandRegistry } from './commands.js';

describe('extension command host adapters', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-ext-cmd-'));
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
    await rm(tempDir, { recursive: true, force: true });
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
