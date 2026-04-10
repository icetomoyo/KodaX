import os from 'os';
import path from 'path';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listPluginSkillPaths } from '@kodax/skills';
import { executeTool } from '../tools/index.js';
import type { KodaXToolExecutionContext } from '../types.js';
import {
  createExtensionRuntime,
  emitActiveExtensionEvent,
  getActiveExtensionRuntime,
  registerOfficialSandboxExtension,
  runActiveExtensionHook,
} from './index.js';

declare global {
  // eslint-disable-next-line no-var
  var __kodaxExtensionEvents: string[] | undefined;
}

describe('KodaXExtensionRuntime', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-ext-'));
    globalThis.__kodaxExtensionEvents = [];
  });

  afterEach(async () => {
    const runtime = getActiveExtensionRuntime();
    if (runtime) {
      await runtime.dispose();
    }
    delete globalThis.__kodaxExtensionEvents;
    await rm(tempDir, { recursive: true, force: true });
  });

  it('loads extension tools, hooks, skill paths, and event handlers', async () => {
    const skillDir = path.join(tempDir, 'skills');
    const extensionPath = path.join(tempDir, 'sample-extension.mjs');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      extensionPath,
      `export default function(api) {
        api.registerTool({
          name: 'extension_echo',
          description: 'Echo text from extension',
          input_schema: {
            type: 'object',
            properties: {
              text: { type: 'string' }
            },
            required: ['text']
          },
          handler: async (input) => 'echo:' + String(input.text)
        });
        api.registerSkillPath('./skills');
        api.hook('tool:before', (context) => {
          if (context.name === 'read') {
            return '[Tool Error] blocked by extension';
          }
        });
        api.on('text:delta', ({ text }) => {
          globalThis.__kodaxExtensionEvents = globalThis.__kodaxExtensionEvents ?? [];
          globalThis.__kodaxExtensionEvents.push(text);
        });
      }`,
      'utf8',
    );

    const runtime = createExtensionRuntime().activate();
    await runtime.loadExtension(extensionPath);

    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      executionCwd: tempDir,
      gitRoot: tempDir,
    };

    await expect(
      executeTool('extension_echo', { text: 'hello' }, ctx),
    ).resolves.toBe('echo:hello');

    await expect(
      runActiveExtensionHook('tool:before', {
        name: 'read',
        input: { path: 'demo.txt' },
        executionCwd: tempDir,
        gitRoot: tempDir,
      }),
    ).resolves.toBe('[Tool Error] blocked by extension');

    await emitActiveExtensionEvent('text:delta', { text: 'chunk-1' });
    expect(globalThis.__kodaxExtensionEvents).toEqual(['chunk-1']);
    expect(listPluginSkillPaths()).toContain(skillDir);
    expect(runtime.getDiagnostics().tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'extension_echo',
          source: expect.objectContaining({
            kind: 'extension',
            path: extensionPath,
          }),
        }),
      ]),
    );

    await runtime.dispose();

    await expect(
      executeTool('extension_echo', { text: 'hello' }, ctx),
    ).resolves.toContain('Unknown tool');
    expect(listPluginSkillPaths()).not.toContain(skillDir);
  });

  it('loads TypeScript extensions and preserves runtime defaults before a session is bound', async () => {
    const extensionPath = path.join(tempDir, 'sample-extension.ts');
    await writeFile(
      extensionPath,
      `export default function(api) {
        api.runtime.setActiveTools([]);
        api.runtime.setModelSelection({ model: 'ts-extension-model' });
        api.runtime.setThinkingLevel('balanced');
      }`,
      'utf8',
    );

    const runtime = createExtensionRuntime();
    await runtime.loadExtension(extensionPath);

    expect(runtime.getDefaults()).toEqual({
      activeTools: [],
      modelSelection: { model: 'ts-extension-model' },
      thinkingLevel: 'balanced',
    });

    await runtime.dispose();

    expect(runtime.getDefaults()).toEqual({
      activeTools: undefined,
      modelSelection: {},
      thinkingLevel: undefined,
    });
  });

  it('cleans up partial registrations when extension activation fails', async () => {
    const extensionPath = path.join(tempDir, 'broken-extension.mjs');
    await writeFile(
      extensionPath,
      `export default function(api) {
        api.registerTool({
          name: 'broken_tool',
          description: 'Should not leak after activation failure',
          input_schema: {
            type: 'object',
            properties: {},
          },
          handler: async () => 'broken',
        });
        throw new Error('activation failed');
      }`,
      'utf8',
    );

    const runtime = createExtensionRuntime();
    await expect(runtime.loadExtension(extensionPath)).rejects.toThrow('activation failed');

    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      executionCwd: tempDir,
      gitRoot: tempDir,
    };
    await expect(executeTool('broken_tool', {}, ctx)).resolves.toContain('Unknown tool');
  });

  it('surfaces override provenance, hook participation, and recorded failures in diagnostics', async () => {
    const failingExtensionPath = path.join(tempDir, 'failing-extension.mjs');
    const overridingExtensionPath = path.join(tempDir, 'overriding-extension.mjs');

    await writeFile(
      failingExtensionPath,
      `export default function() {
        throw new Error('config activation failed');
      }`,
      'utf8',
    );

    await writeFile(
      overridingExtensionPath,
      `export default function(api) {
        api.registerTool({
          name: 'read',
          description: 'Override built-in read for diagnostics',
          input_schema: {
            type: 'object',
            properties: {
              path: { type: 'string' }
            },
            required: ['path']
          },
          handler: async (input) => 'override:' + String(input.path),
        });
        api.hook('tool:before', () => undefined);
      }`,
      'utf8',
    );

    const runtime = createExtensionRuntime();
    await runtime.loadExtensions(
      [failingExtensionPath, overridingExtensionPath],
      { continueOnError: true, loadSource: 'config' },
    );

    const diagnostics = runtime.getDiagnostics();

    expect(diagnostics.loadedExtensions).toEqual([
      expect.objectContaining({
        path: overridingExtensionPath,
        label: 'overriding-extension.mjs',
        loadSource: 'config',
      }),
    ]);
    expect(diagnostics.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: 'load',
          target: failingExtensionPath,
          message: 'config activation failed',
          source: expect.objectContaining({
            kind: 'extension',
            path: failingExtensionPath,
          }),
        }),
      ]),
    );
    expect(diagnostics.hooks).toEqual([
      expect.objectContaining({
        hook: 'tool:before',
        order: 1,
        source: expect.objectContaining({
          kind: 'extension',
          path: overridingExtensionPath,
        }),
      }),
    ]);
    expect(diagnostics.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'read',
          source: expect.objectContaining({
            kind: 'extension',
            path: overridingExtensionPath,
          }),
          shadowedSources: expect.arrayContaining([
            expect.objectContaining({
              kind: 'builtin',
              label: 'read',
            }),
          ]),
        }),
      ]),
    );

    await runtime.dispose();
  });

  it('warns when continueOnError suppresses extension load and reload failures', async () => {
    const extensionPath = path.join(tempDir, 'warnable-extension.mjs');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await writeFile(
      extensionPath,
      `export default function() {
        throw new Error('initial load exploded');
      }`,
      'utf8',
    );

    const runtime = createExtensionRuntime();
    await runtime.loadExtensions([extensionPath], {
      continueOnError: true,
      loadSource: 'config',
    });

    expect(warnSpy).toHaveBeenCalledWith(
      '[kodax:extension]',
      `Failed to load extension "${extensionPath}" during load:`,
      'initial load exploded',
    );

    await writeFile(
      extensionPath,
      `export default function(api) {
        api.registerTool({
          name: 'warn_reload',
          description: 'Reload warning test',
          input_schema: {
            type: 'object',
            properties: {},
          },
          handler: async () => 'ok',
        });
      }`,
      'utf8',
    );

    await runtime.loadExtension(extensionPath);

    await writeFile(
      extensionPath,
      `export default function() {
        throw new Error('reload exploded');
      }`,
      'utf8',
    );

    await runtime.reloadExtensions({ continueOnError: true });

    expect(warnSpy).toHaveBeenCalledWith(
      '[kodax:extension]',
      `Failed to reload extension "${extensionPath}":`,
      'reload exploded',
    );

    warnSpy.mockRestore();
    await runtime.dispose();
  });

  it('exposes capability provider search, describe, execute, read, prompt, and refresh surfaces', async () => {
    const extensionPath = path.join(tempDir, 'capability-extension.mjs');
    await writeFile(
      extensionPath,
      `export default function(api) {
        api.registerCommand({
          name: 'capability.inspect',
          aliases: ['cap-inspect'],
          description: 'Inspect registered capabilities',
          usage: '/capability.inspect [id]',
          metadata: { visibility: 'internal' },
          handler: async (args) => ({
            message: 'inspect:' + (args[0] ?? 'all'),
          }),
        });
        api.registerCapabilityProvider({
          id: 'test-capability-provider',
          kinds: ['tool', 'resource', 'prompt'],
          search: async (query, options) => [{ query, options }],
          describe: async (id) => ({ id, title: 'Capability ' + id }),
          execute: async (id, input) => ({ kind: 'tool', content: id + ':' + String(input.value) }),
          read: async (id, options) => ({ kind: 'resource', structuredContent: { id, options } }),
          getPrompt: async (id, args) => ({ id, args }),
          refresh: async () => {
            globalThis.__kodaxExtensionEvents = globalThis.__kodaxExtensionEvents ?? [];
            globalThis.__kodaxExtensionEvents.push('refreshed');
          },
        });
      }`,
      'utf8',
    );

    const runtime = createExtensionRuntime();
    await runtime.loadExtension(extensionPath);

    await expect(
      runtime.searchCapabilities('test-capability-provider', 'needle', {
        kind: 'resource',
        limit: 2,
      }),
    ).resolves.toEqual([{ query: 'needle', options: { kind: 'resource', limit: 2 } }]);

    await expect(
      runtime.describeCapability('test-capability-provider', 'cap-1'),
    ).resolves.toEqual({ id: 'cap-1', title: 'Capability cap-1' });

    await expect(
      runtime.executeCapability('test-capability-provider', 'cap-1', { value: 'x' }),
    ).resolves.toEqual({ kind: 'tool', content: 'cap-1:x' });

    await expect(
      runtime.readCapability('test-capability-provider', 'cap-1', { format: 'json' }),
    ).resolves.toEqual({
      kind: 'resource',
      structuredContent: { id: 'cap-1', options: { format: 'json' } },
    });

    await expect(
      runtime.getCapabilityPrompt('test-capability-provider', 'cap-1', { mood: 'calm' }),
    ).resolves.toEqual({ id: 'cap-1', args: { mood: 'calm' } });
    expect(runtime.getCommand('cap-inspect')).toMatchObject({
      name: 'capability.inspect',
      aliases: ['cap-inspect'],
      usage: '/capability.inspect [id]',
    });

    expect(runtime.getDiagnostics()).toMatchObject({
      loadedExtensions: [{ path: extensionPath, label: 'capability-extension.mjs' }],
      capabilityProviders: [{
        id: 'test-capability-provider',
        kinds: ['tool', 'resource', 'prompt'],
        source: {
          kind: 'extension',
          path: extensionPath,
        },
      }],
      commands: [{
        name: 'capability.inspect',
        aliases: ['cap-inspect'],
        description: 'Inspect registered capabilities',
        usage: '/capability.inspect [id]',
        metadata: { visibility: 'internal' },
        source: {
          kind: 'extension',
          path: extensionPath,
        },
      }],
    });

    await expect(
      runtime.refreshCapabilityProviders('test-capability-provider'),
    ).resolves.toBeUndefined();
    expect(globalThis.__kodaxExtensionEvents).toContain('refreshed');

    await runtime.dispose();
    expect(runtime.listCapabilityProviders()).toEqual([]);
  });

  it('supports runtime-owned capability providers with prompt context and diagnostics metadata', async () => {
    const runtime = createExtensionRuntime();
    const refreshSpy = vi.fn(async () => undefined);

    runtime.registerCapabilityProvider({
      id: 'runtime-provider',
      kinds: ['tool'],
      getPromptContext: () => '## Runtime Capability\nUse runtime-owned tools.',
      getDiagnostics: () => ({ serverCount: 1, trust: 'workspace' }),
      refresh: refreshSpy,
    });

    await expect(runtime.getCapabilityPromptContext('runtime-provider')).resolves.toBe(
      '## Runtime Capability\nUse runtime-owned tools.',
    );
    await expect(runtime.refreshCapabilityProviders('runtime-provider')).resolves.toBeUndefined();
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(runtime.getDiagnostics().capabilityProviders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'runtime-provider',
          source: expect.objectContaining({
            kind: 'runtime',
            id: 'runtime:capability:runtime-provider',
            label: 'runtime-provider',
          }),
          metadata: {
            serverCount: 1,
            trust: 'workspace',
          },
        }),
      ]),
    );

    await runtime.dispose();
  });

  it('registers an official sandbox policy provider with guarded tool overrides and honest mode diagnostics', async () => {
    const workspaceRoot = path.join(tempDir, 'workspace');
    const outsideRoot = path.join(tempDir, 'outside');
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(outsideRoot, { recursive: true });
    await writeFile(path.join(workspaceRoot, 'inside.txt'), 'inside', 'utf8');
    await writeFile(path.join(outsideRoot, 'outside.txt'), 'outside', 'utf8');

    const runtime = createExtensionRuntime();
    registerOfficialSandboxExtension(runtime, {
      workspaceRoot,
      mode: 'enforced',
    });

    expect(runtime.getDiagnostics().capabilityProviders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'official-sandbox',
          metadata: expect.objectContaining({
            mode: 'enforced',
            workspaceRoot,
            guardedTools: ['write', 'edit', 'bash'],
          }),
        }),
      ]),
    );

    await expect(runtime.readCapability('official-sandbox', 'policy')).resolves.toEqual(
      expect.objectContaining({
        kind: 'resource',
        structuredContent: expect.objectContaining({
          mode: 'enforced',
          workspaceRoot,
          guardedTools: ['write', 'edit', 'bash'],
        }),
      }),
    );

    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      executionCwd: workspaceRoot,
      gitRoot: workspaceRoot,
    };

    await expect(
      executeTool('write', {
        path: path.join(workspaceRoot, 'inside.txt'),
        content: 'updated',
      }, ctx),
    ).resolves.toContain('File updated:');

    await expect(
      executeTool('write', {
        path: path.join(outsideRoot, 'outside.txt'),
        content: 'blocked',
      }, ctx),
    ).resolves.toContain('Blocked by official sandbox (enforced)');

    await expect(
      executeTool('edit', {
        path: path.join(outsideRoot, 'outside.txt'),
        old_string: 'outside',
        new_string: 'blocked',
      }, ctx),
    ).resolves.toContain('Blocked by official sandbox (enforced)');

    await expect(
      runtime.runHook('tool:before', {
        name: 'bash',
        input: { command: 'git reset --hard HEAD~1' },
        executionCwd: workspaceRoot,
        gitRoot: workspaceRoot,
      }),
    ).resolves.toContain('Command matches destructive policy: git reset --hard');

    await expect(
      runtime.runHook('tool:before', {
        name: 'bash',
        input: { command: 'git status' },
        executionCwd: workspaceRoot,
        gitRoot: workspaceRoot,
      }),
    ).resolves.toBeUndefined();

    await runtime.dispose();
  });

  it('keeps the previous extension active when a hot reload fails', async () => {
    const extensionPath = path.join(tempDir, 'reloadable-extension.mjs');
    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      executionCwd: tempDir,
      gitRoot: tempDir,
    };
    const runtime = createExtensionRuntime();

    await writeFile(
      extensionPath,
      `export default function(api) {
        api.registerTool({
          name: 'reload_echo',
          description: 'Echo stable version',
          input_schema: {
            type: 'object',
            properties: {},
          },
          handler: async () => 'v1',
        });
      }`,
      'utf8',
    );

    await runtime.loadExtension(extensionPath);
    await expect(executeTool('reload_echo', {}, ctx)).resolves.toBe('v1');

    await writeFile(
      extensionPath,
      `export default function(api) {
        api.registerTool({
          name: 'reload_echo',
          description: 'Broken replacement',
          input_schema: {
            type: 'object',
            properties: {},
          },
          handler: async () => 'v2',
        });
        throw new Error('reload failed');
      }`,
      'utf8',
    );

    await expect(runtime.loadExtension(extensionPath)).rejects.toThrow('reload failed');
    await expect(executeTool('reload_echo', {}, ctx)).resolves.toBe('v1');
  });

  it('records persistence failures for non-JSON state and session records', async () => {
    const extensionPath = path.join(tempDir, 'persistence-guard-extension.mjs');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await writeFile(
      extensionPath,
      `export default function(api) {
        api.hook('session:hydrate', (context) => {
          context.setState('bad-hydrate', new Map([['key', 'value']]));
          context.appendRecord('bad-hydrate-record', new Set(['x']));
        });
        api.hook('turn:settle', () => {
          api.runtime.setSessionState('bad-runtime', new Map([['key', 'value']]));
          api.runtime.appendSessionRecord('bad-runtime-record', new Set(['x']));
        });
      }`,
      'utf8',
    );

    const setSessionState = vi.fn();
    const appendSessionRecord = vi.fn();
    const runtime = createExtensionRuntime();
    runtime.bindController({
      queueUserMessage: () => {},
      getSessionState: () => undefined,
      setSessionState,
      getSessionStateSnapshot: () => ({}),
      appendSessionRecord,
      listSessionRecords: () => [],
      clearSessionRecords: () => 0,
      getActiveTools: () => [],
      setActiveTools: () => {},
      getModelSelection: () => ({}),
      setModelSelection: () => {},
      getThinkingLevel: () => undefined,
      setThinkingLevel: () => {},
    });
    await runtime.loadExtension(extensionPath);

    await runtime.hydrateSession('session-1');
    await runtime.runHook('turn:settle', {
      sessionId: 'session-1',
      lastText: 'done',
      hadToolCalls: false,
      success: true,
      queueUserMessage: () => {},
      setModelSelection: () => {},
      setThinkingLevel: () => {},
    });

    expect(setSessionState).not.toHaveBeenCalled();
    expect(appendSessionRecord).not.toHaveBeenCalled();
    expect(runtime.getDiagnostics().failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: 'persistence',
          target: 'sessionState:bad-hydrate',
        }),
        expect.objectContaining({
          stage: 'persistence',
          target: 'sessionRecord:bad-hydrate-record',
        }),
        expect.objectContaining({
          stage: 'persistence',
          target: 'sessionState:bad-runtime',
        }),
        expect.objectContaining({
          stage: 'persistence',
          target: 'sessionRecord:bad-runtime-record',
        }),
      ]),
    );
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
    await runtime.dispose();
  });
});
