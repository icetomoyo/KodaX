import os from 'os';
import path from 'path';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  listPluginSkillPaths,
  setKodaXDiagnosticSink,
  type KodaXDiagnostic,
} from '@kodax-ai/agent';
import { executeTool } from '../tools/index.js';
import type { KodaXToolExecutionContext } from '../types.js';
import {
  combineExtensionRuntimes,
  createExtensionRuntime,
  emitActiveExtensionEvent,
  getActiveExtensionRuntime,
  registerOfficialSandboxExtension,
  runActiveExtensionHook,
} from './index.js';
import {
  _resetAgentResolverForTesting,
  resolveConstructedAgent,
  resolveConstructedAgentSource,
} from '../construction/index.js';

declare global {
  // eslint-disable-next-line no-var
  var __kodaxExtensionEvents: string[] | undefined;
  // eslint-disable-next-line no-var
  var __kodaxTodoEvents: Array<{ event: string; payload: unknown }> | undefined;
  // eslint-disable-next-line no-var
  var __kodaxTodoHookCalls: Array<{ hook: string; payload: unknown }> | undefined;
}

describe('KodaXExtensionRuntime', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-ext-'));
    globalThis.__kodaxExtensionEvents = [];
    globalThis.__kodaxTodoEvents = [];
    globalThis.__kodaxTodoHookCalls = [];
  });

  afterEach(async () => {
    const runtime = getActiveExtensionRuntime();
    if (runtime) {
      await runtime.dispose();
    }
    delete globalThis.__kodaxExtensionEvents;
    delete globalThis.__kodaxTodoEvents;
    delete globalThis.__kodaxTodoHookCalls;
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
        api.runtime.setThinkingLevel('medium');
      }`,
      'utf8',
    );

    const runtime = createExtensionRuntime();
    await runtime.loadExtension(extensionPath);

    expect(runtime.getDefaults()).toEqual({
      activeTools: [],
      modelSelection: { model: 'ts-extension-model' },
      thinkingLevel: 'medium',
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
    const diagnostics: KodaXDiagnostic[] = [];
    const restoreDiagnostics = setKodaXDiagnosticSink((diagnostic) => {
      diagnostics.push(diagnostic);
    });

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

    expect(diagnostics).toContainEqual(expect.objectContaining({
      source: 'coding:extension',
      level: 'warn',
      message: expect.stringContaining(`Failed to load extension "${extensionPath}" during load:`),
    }));
    expect(diagnostics.at(-1)?.message).toContain('initial load exploded');

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

    expect(diagnostics).toContainEqual(expect.objectContaining({
      source: 'coding:extension',
      level: 'warn',
      message: expect.stringContaining(`Failed to reload extension "${extensionPath}":`),
    }));
    expect(diagnostics.at(-1)?.message).toContain('reload exploded');

    restoreDiagnostics();
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
          searchSnapshot: async (query, options) => ({
            items: [{ query, options, snapshot: true }],
            revision: 'test-revision',
            complete: true,
            freshness: 'live',
          }),
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
      runtime.searchCapabilitySnapshot('test-capability-provider', 'needle', {
        kind: 'resource',
      }),
    ).resolves.toEqual({
      items: [{ query: 'needle', options: { kind: 'resource' }, snapshot: true }],
      revision: 'test-revision',
      complete: true,
      freshness: 'live',
    });

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

  it('combines extension runtimes with primary capability priority and deduped tool diagnostics', async () => {
    const sessionRuntime = createExtensionRuntime();
    const globalRuntime = createExtensionRuntime();
    sessionRuntime.registerCapabilityProvider({
      id: 'mcp',
      kinds: ['tool'],
      search: async () => [{ id: 'session/tool:echo', name: 'echo', kind: 'tool' }],
      searchSnapshot: async () => ({
        items: [{ id: 'session/tool:echo', name: 'echo', kind: 'tool' }],
        revision: 'session-v1',
        complete: true,
        freshness: 'live',
      }),
      getPromptContext: async () => 'session MCP context',
    });
    globalRuntime.registerCapabilityProvider({
      id: 'mcp',
      kinds: ['tool'],
      search: async () => [{ id: 'global/tool:echo', name: 'echo', kind: 'tool' }],
      searchSnapshot: async () => ({
        items: [{ id: 'global/tool:echo', name: 'echo', kind: 'tool' }],
        revision: 'global-v1',
        complete: false,
        freshness: 'stale',
        failures: [{ source: 'global', message: 'offline' }],
      }),
      getPromptContext: async () => 'global MCP context',
    });

    const combined = combineExtensionRuntimes(sessionRuntime, globalRuntime);

    await expect(combined.searchCapabilities('mcp', 'echo', { kind: 'tool', limit: 1 }))
      .resolves
      .toEqual([{ id: 'session/tool:echo', name: 'echo', kind: 'tool' }]);
    await expect(combined.getCapabilityPromptContext('mcp'))
      .resolves
      .toBe('global MCP context\n\nsession MCP context');
    await expect(combined.searchCapabilitySnapshot('mcp', 'echo', { kind: 'tool' }))
      .resolves
      .toEqual(expect.objectContaining({
        items: [
          { id: 'session/tool:echo', name: 'echo', kind: 'tool' },
          { id: 'global/tool:echo', name: 'echo', kind: 'tool' },
        ],
        revision: expect.any(String),
        complete: false,
        freshness: 'mixed',
        failures: [{ source: 'global', message: 'offline' }],
      }));

    const toolDiagnostics = combined.getDiagnostics().tools;
    const toolKeys = toolDiagnostics.map((tool) => `${tool.name}:${tool.source.kind}:${tool.source.id}`);
    expect(new Set(toolKeys).size).toBe(toolKeys.length);
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

  it('reads an uncapped legacy provider search without claiming a complete snapshot', async () => {
    const runtime = createExtensionRuntime().activate();
    const search = vi.fn(async () => [{ id: 'legacy:one' }]);
    runtime.registerCapabilityProvider({
      id: 'legacy-search',
      kinds: ['tool'],
      search,
    });

    await expect(runtime.searchCapabilitySnapshot('legacy-search', '', {})).resolves.toEqual({
      items: [{ id: 'legacy:one' }],
      complete: false,
      freshness: 'unknown',
    });
    expect(search).toHaveBeenCalledWith('', { limit: Number.MAX_SAFE_INTEGER });

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
    const diagnostics: KodaXDiagnostic[] = [];
    const restoreDiagnostics = setKodaXDiagnosticSink((diagnostic) => {
      diagnostics.push(diagnostic);
    });

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
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'coding:extension:persistence-guard-extension.mjs',
          level: 'warn',
          message: expect.stringContaining('Ignoring non-JSON session state'),
        }),
        expect.objectContaining({
          source: 'coding:extension:persistence-guard-extension.mjs',
          level: 'warn',
          message: expect.stringContaining('Ignoring non-JSON session record'),
        }),
      ]),
    );

    restoreDiagnostics();
    await runtime.dispose();
  });

  // ===========================================================================
  // FEATURE_170 v0.7.41 — todo:* events + hooks contract
  // ===========================================================================

  it('delivers todo:created / todo:updated / todo:deleted events to subscribers', async () => {
    const extensionPath = path.join(tempDir, 'todo-events-ext.mjs');
    await writeFile(
      extensionPath,
      `export default function(api) {
        api.on('todo:created', (payload) => {
          globalThis.__kodaxTodoEvents = globalThis.__kodaxTodoEvents ?? [];
          globalThis.__kodaxTodoEvents.push({ event: 'todo:created', payload });
        });
        api.on('todo:updated', (payload) => {
          globalThis.__kodaxTodoEvents.push({ event: 'todo:updated', payload });
        });
        api.on('todo:deleted', (payload) => {
          globalThis.__kodaxTodoEvents.push({ event: 'todo:deleted', payload });
        });
      }`,
      'utf8',
    );

    const runtime = createExtensionRuntime().activate();
    await runtime.loadExtension(extensionPath);

    const item = { id: 'todo_1', content: 'Step 1', status: 'pending' as const };

    await emitActiveExtensionEvent('todo:created', {
      id: item.id,
      item,
      source: 'tool',
    });
    await emitActiveExtensionEvent('todo:updated', {
      id: item.id,
      before: item,
      after: { ...item, status: 'in_progress' as const },
      changedFields: ['status'],
      source: 'tool',
    });
    await emitActiveExtensionEvent('todo:deleted', {
      id: item.id,
      item,
      source: 'tool',
    });

    expect(globalThis.__kodaxTodoEvents).toHaveLength(3);
    expect(globalThis.__kodaxTodoEvents?.[0]).toMatchObject({
      event: 'todo:created',
      payload: { id: 'todo_1', source: 'tool' },
    });
    expect(globalThis.__kodaxTodoEvents?.[1]).toMatchObject({
      event: 'todo:updated',
      payload: { changedFields: ['status'], source: 'tool' },
    });
    expect(globalThis.__kodaxTodoEvents?.[2]).toMatchObject({
      event: 'todo:deleted',
      payload: { id: 'todo_1', source: 'tool' },
    });

    await runtime.dispose();
  });

  it('propagates todo:before-create blocking string reason', async () => {
    const extensionPath = path.join(tempDir, 'todo-hook-ext.mjs');
    await writeFile(
      extensionPath,
      `export default function(api) {
        api.hook('todo:before-create', (context) => {
          globalThis.__kodaxTodoHookCalls = globalThis.__kodaxTodoHookCalls ?? [];
          globalThis.__kodaxTodoHookCalls.push({ hook: 'todo:before-create', payload: context });
          if (String(context.seed.content).includes('forbidden')) {
            return 'extension policy: forbidden content';
          }
        });
      }`,
      'utf8',
    );

    const runtime = createExtensionRuntime().activate();
    await runtime.loadExtension(extensionPath);

    const blocked = await runActiveExtensionHook('todo:before-create', {
      seed: { content: 'do the forbidden thing' },
    });
    const allowed = await runActiveExtensionHook('todo:before-create', {
      seed: { content: 'do the allowed thing' },
    });

    expect(blocked).toBe('extension policy: forbidden content');
    expect(allowed).toBeUndefined();
    expect(globalThis.__kodaxTodoHookCalls).toHaveLength(2);

    await runtime.dispose();
  });

  it('propagates todo:before-complete blocking false (no reason)', async () => {
    const extensionPath = path.join(tempDir, 'todo-hook-false-ext.mjs');
    await writeFile(
      extensionPath,
      `export default function(api) {
        api.hook('todo:before-complete', () => false);
      }`,
      'utf8',
    );

    const runtime = createExtensionRuntime().activate();
    await runtime.loadExtension(extensionPath);

    const result = await runActiveExtensionHook('todo:before-complete', {
      id: 'todo_1',
      item: { id: 'todo_1', content: 'X', status: 'in_progress' },
    });
    expect(result).toBe(false);

    await runtime.dispose();
  });

  it('todo:before-* hooks allow when handler returns void', async () => {
    const extensionPath = path.join(tempDir, 'todo-hook-void-ext.mjs');
    await writeFile(
      extensionPath,
      `export default function(api) {
        api.hook('todo:before-create', () => undefined);
        api.hook('todo:before-complete', () => undefined);
      }`,
      'utf8',
    );

    const runtime = createExtensionRuntime().activate();
    await runtime.loadExtension(extensionPath);

    await expect(
      runActiveExtensionHook('todo:before-create', { seed: { content: 'X' } }),
    ).resolves.toBeUndefined();
    await expect(
      runActiveExtensionHook('todo:before-complete', {
        id: 'todo_1',
        item: { id: 'todo_1', content: 'X', status: 'in_progress' },
      }),
    ).resolves.toBeUndefined();

    await runtime.dispose();
  });

  it('todo:before-* hook fault is isolated — throw becomes recorded failure, hook returns undefined (allow)', async () => {
    const extensionPath = path.join(tempDir, 'todo-hook-throw-ext.mjs');
    await writeFile(
      extensionPath,
      `export default function(api) {
        api.hook('todo:before-create', () => {
          throw new Error('extension bug — should not block the mutation');
        });
        api.hook('todo:before-complete', () => {
          throw new Error('extension bug — should not block completion');
        });
      }`,
      'utf8',
    );

    const runtime = createExtensionRuntime().activate();
    await runtime.loadExtension(extensionPath);

    // Both throwing hooks must resolve to undefined (allow), NOT propagate
    // the error — this is the fault-isolation contract that already
    // exists for `tool:before` and must hold for the new hooks too.
    await expect(
      runActiveExtensionHook('todo:before-create', { seed: { content: 'X' } }),
    ).resolves.toBeUndefined();
    await expect(
      runActiveExtensionHook('todo:before-complete', {
        id: 'todo_1',
        item: { id: 'todo_1', content: 'X', status: 'in_progress' },
      }),
    ).resolves.toBeUndefined();

    const failures = runtime.getDiagnostics().failures;
    expect(failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: 'hook', target: 'todo:before-create' }),
        expect.objectContaining({ stage: 'hook', target: 'todo:before-complete' }),
      ]),
    );

    await runtime.dispose();
  });
});

describe('KodaXExtensionRuntime — FEATURE_191 registerAgent', () => {
  let tempDir: string;

  beforeEach(async () => {
    _resetAgentResolverForTesting();
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-ext-ra-'));
  });

  afterEach(async () => {
    const runtime = getActiveExtensionRuntime();
    if (runtime) {
      await runtime.dispose();
    }
    _resetAgentResolverForTesting();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('registers a constructed agent via api.registerAgent and tags source="extension"', async () => {
    const extensionPath = path.join(tempDir, 'ext-with-agent.mjs');
    await writeFile(
      extensionPath,
      `export default async function(api) {
        await api.registerAgent('ext-reviewer', {
          instructions: 'You review code from an extension.',
          description: 'Extension-supplied code reviewer',
          tools: [{ ref: 'builtin:read' }],
        });
      }`,
      'utf8',
    );

    const runtime = createExtensionRuntime().activate();
    await runtime.loadExtension(extensionPath);

    const agent = resolveConstructedAgent('ext-reviewer');
    expect(agent).toBeDefined();
    expect(agent?.instructions).toBe('You review code from an extension.');
    expect(resolveConstructedAgentSource('ext-reviewer')).toBe('extension');
  });

  it('auto-unregisters the agent on extension dispose (disposable chain)', async () => {
    const extensionPath = path.join(tempDir, 'ext-dispose.mjs');
    await writeFile(
      extensionPath,
      `export default async function(api) {
        await api.registerAgent('disposable-reviewer', {
          instructions: 'Goes away when the extension does.',
          description: 'Transient extension agent',
        });
      }`,
      'utf8',
    );

    const runtime = createExtensionRuntime().activate();
    await runtime.loadExtension(extensionPath);
    expect(resolveConstructedAgent('disposable-reviewer')).toBeDefined();

    await runtime.dispose();
    expect(resolveConstructedAgent('disposable-reviewer')).toBeUndefined();
  });

  it('returns a dispose fn that can be called manually mid-session', async () => {
    let disposeRef: (() => void) | null = null;
    globalThis.__kodaxTestExtAgentDispose = (fn: () => void) => {
      disposeRef = fn;
    };
    const extensionPath = path.join(tempDir, 'ext-manual-dispose.mjs');
    await writeFile(
      extensionPath,
      `export default async function(api) {
        const dispose = await api.registerAgent('manual-dispose', {
          instructions: 'I can be unregistered mid-session.',
          description: 'Manual-dispose target',
        });
        globalThis.__kodaxTestExtAgentDispose(dispose);
      }`,
      'utf8',
    );

    const runtime = createExtensionRuntime().activate();
    await runtime.loadExtension(extensionPath);
    expect(resolveConstructedAgent('manual-dispose')).toBeDefined();

    expect(disposeRef).not.toBeNull();
    disposeRef!();
    expect(resolveConstructedAgent('manual-dispose')).toBeUndefined();

    delete (globalThis as { __kodaxTestExtAgentDispose?: unknown })
      .__kodaxTestExtAgentDispose;
    await runtime.dispose();
  });

  it('throws when admission rejects the manifest', async () => {
    // Trigger a deterministic rejection: `declaredInvariants` containing
    // an unknown invariant id fails the manifest schema audit per
    // construction/admission-bridge.ts:99 ("let unknown ids fail loudly
    // in the audit"). The extension activation will propagate the
    // throw, so loadExtension records a failure rather than silently
    // dropping the registration.
    const extensionPath = path.join(tempDir, 'ext-rejected.mjs');
    await writeFile(
      extensionPath,
      `export default async function(api) {
        await api.registerAgent('rejected', {
          instructions: 'I will be rejected by admission.',
          description: 'will be rejected',
          declaredInvariants: ['nonexistentInvariantForTesting'],
        });
      }`,
      'utf8',
    );

    const runtime = createExtensionRuntime().activate();
    await expect(runtime.loadExtension(extensionPath)).rejects.toThrow(
      /unknown invariant id "nonexistentInvariantForTesting"/,
    );

    // Agent must NOT be registered on rejection.
    expect(resolveConstructedAgent('rejected')).toBeUndefined();
  });

  it.each(['one', 'all'])('drains admitted %s capability refresh before replacement disposal', async (selection) => {
    const runtime = createExtensionRuntime();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const dispose = vi.fn();
    runtime.registerCapabilityProvider({ id: 'refreshing', kinds: ['tool'],
      refresh: async () => { entered(); await gate; }, dispose });
    const refreshing = runtime.refreshCapabilityProviders(selection === 'one' ? 'refreshing' : undefined);
    await started;
    const replacing = runtime.replaceCapabilityProvider('refreshing', { id: 'refreshing', kinds: ['tool'] });
    try {
      expect(dispose).not.toHaveBeenCalled();
    } finally {
      release();
      await refreshing;
      await replacing;
      await runtime.dispose();
    }
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('atomically replaces a capability provider and disposes superseded state once', async () => {
    const runtime = createExtensionRuntime();
    const firstDispose = vi.fn(async () => undefined);
    const secondDispose = vi.fn(async () => undefined);
    runtime.registerCapabilityProvider({
      id: 'hot-provider', kinds: ['tool'],
      search: async () => [{ version: 1 }], dispose: firstDispose,
    });
    await runtime.replaceCapabilityProvider('hot-provider', {
      id: 'hot-provider', kinds: ['tool'],
      search: async () => [{ version: 2 }], dispose: secondDispose,
    });

    expect(runtime.hasCapabilityProvider('hot-provider')).toBe(true);
    await expect(runtime.searchCapabilities('hot-provider', '')).resolves.toEqual([{ version: 2 }]);
    expect(firstDispose).toHaveBeenCalledOnce();
    await runtime.dispose();
    expect(firstDispose).toHaveBeenCalledOnce();
    expect(secondDispose).toHaveBeenCalledOnce();
  });
});

declare global {
  // Used by the manual-dispose test to bridge a closure across the
  // extension boundary (the extension runs in a tsImport sandbox).
  // eslint-disable-next-line no-var
  var __kodaxTestExtAgentDispose: ((fn: () => void) => void) | undefined;
}
