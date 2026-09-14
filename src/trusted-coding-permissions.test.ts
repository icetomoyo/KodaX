import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearRuntimeModelProviders, KodaXBaseProvider, KodaXNetworkError, registerModelProvider,
  type KodaXMessage, type KodaXToolDefinition, type KodaXProviderConfig, type KodaXStreamResult,
} from '@kodax-ai/llm';
import { runKodaX, runManagedTask, KodaXClient } from './trusted-coding-entry.js';
import { createAgent, type ToolGuardrail } from '@kodax-ai/agent';
import { createKodaXRuntime } from './sdk-runtime.js';
import { buildRunnerLlmAdapter } from '../packages/coding/src/task-engine/_internal/managed-task/llm-adapter.js';
import type { KodaXEvents } from '@kodax-ai/coding';

class TextPermissionProvider extends KodaXBaseProvider {
  static responses: KodaXStreamResult[] = [];
  static systems: string[] = [];
  static onRequest: (() => void | Promise<void>) | undefined;
  readonly name = 'text-permission-test';
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'KODAX_TEXT_PERMISSION_TEST_KEY', model: 'test', supportsThinking: false,
  };
  async stream(_messages: KodaXMessage[], _tools: KodaXToolDefinition[], system: string): Promise<KodaXStreamResult> {
    TextPermissionProvider.systems.push(system);
    await TextPermissionProvider.onRequest?.();
    const response = TextPermissionProvider.responses.shift();
    if (!response) throw new Error('Unexpected provider request');
    return response;
  }
}

class TextReviewProvider extends KodaXBaseProvider {
  static decision: 'allow' | 'ask' = 'allow';
  static calls = 0;
  readonly name = 'text-review-test';
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'KODAX_TEXT_PERMISSION_TEST_KEY', model: 'test', supportsThinking: false,
  };
  async stream(): Promise<KodaXStreamResult> {
    TextReviewProvider.calls += 1;
    return { textBlocks: [{ type: 'text', text: `<decision>${TextReviewProvider.decision}</decision><hazard>none</hazard><reason>Disposable test file.</reason>` }],
      thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
  }
}

describe('public SDK trusted text permissions', () => {
  let root: string;
  let workspace: string;
  beforeEach(async () => {
    // Deliberately outside system Temp, with the target outside the effective workspace.
    root = await fs.mkdtemp(path.join(process.cwd(), '.text-permission-test-'));
    workspace = path.join(root, 'workspace');
    await fs.mkdir(workspace);
    vi.stubEnv('KODAX_HOME', path.join(root, 'home'));
    vi.stubEnv('KODAX_TEXT_PERMISSION_TEST_KEY', 'test');
    registerModelProvider('text-permission-test', () => new TextPermissionProvider());
    registerModelProvider('text-review-test', () => new TextReviewProvider());
    TextReviewProvider.calls = 0;
    TextPermissionProvider.systems = [];
    TextPermissionProvider.onRequest = undefined;
  });
  afterEach(async () => {
    clearRuntimeModelProviders();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it.each([
    ['runKodaX', runKodaX, 'full-access'], ['runManagedTask', runManagedTask, 'full-access'],
    ['runKodaX', runKodaX, 'auto'], ['runManagedTask', runManagedTask, 'auto'],
  ].map(([name, run, mode]) => ({ name, run, mode })) as {
    name: string; run: typeof runKodaX; mode: 'auto' | 'full-access';
  }[])(
    '$name applies $mode authority to an external write and edit', async ({ run, mode }) => {
      const target = path.join(root, 'external', 'result.txt');
      TextPermissionProvider.responses = [
        { textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use', toolBlocks: [
          { type: 'tool_use', id: 'external-write', name: 'write', input: { path: target, content: 'before' } },
        ] },
        { textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use', toolBlocks: [
          { type: 'tool_use', id: 'external-edit', name: 'edit', input: { path: target, old_string: 'before', new_string: 'after' } },
        ] },
        { textBlocks: [{ type: 'text', text: 'Done.' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' },
      ];
      const guardrails: ToolGuardrail[] = [{ kind: 'tool', name: 'auto-mode',
          beforeTool: async () => ({ action: 'allow' }),
      }];
      const result = await run({ provider: 'text-permission-test', agentMode: 'sa', reasoningMode: 'off', lsp: false,
        guardrails: mode === 'auto' ? guardrails : undefined,
        context: { executionCwd: workspace, gitRoot: workspace, skillsPrompt: '', repoIntelligenceMode: 'off',
          systemPromptOverride: 'Perform the requested text tools.', resolveShellPermissionMode: () => mode },
      }, 'Write before to the provided file, then edit it to after.');
      expect(JSON.stringify(result.messages)).not.toContain('outside the Runtime write roots');
      await expect(fs.readFile(target, 'utf8')).resolves.toBe('after');
    },
  );

  it('refreshes host permission facts on the next actual model request, even with a prompt override', async () => {
    let mode: 'full-access' | 'plan' = 'full-access';
    const target = path.join(workspace, 'read.txt');
    await fs.writeFile(target, 'readable');
    TextPermissionProvider.responses = [
      { textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use', toolBlocks: [
        { type: 'tool_use', id: 'read-mode-change', name: 'read', input: { path: target } },
      ] },
      { textBlocks: [{ type: 'text', text: 'Done.' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' },
    ];
    TextPermissionProvider.onRequest = () => { mode = 'plan'; };
    const result = await runKodaX({ provider: 'text-permission-test', reasoningMode: 'off', lsp: false,
      context: { executionCwd: workspace, gitRoot: workspace, skillsPrompt: '', repoIntelligenceMode: 'off',
        systemPromptOverride: 'SDK custom system instructions.', resolveShellPermissionMode: () => mode },
    }, 'Read the file.');
    expect(TextPermissionProvider.systems[0]).toContain('Current permission mode: full-access');
    expect(TextPermissionProvider.systems[1]).toContain('Current permission mode: plan');
    expect(TextPermissionProvider.systems[1]).not.toContain('Current permission mode: full-access');
    expect(TextPermissionProvider.systems[1]).toContain('config.json');
    expect(JSON.stringify(result.messages)).not.toContain('Effective permissions (host authority)');
  });

  it('does not invent effective permission facts when the SDK host supplies no mode', async () => {
    TextPermissionProvider.responses = [{ textBlocks: [{ type: 'text', text: 'Done.' }],
      thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' }];
    await runKodaX({ provider: 'text-permission-test', reasoningMode: 'off', lsp: false,
      context: { executionCwd: workspace, gitRoot: workspace, skillsPrompt: '', repoIntelligenceMode: 'off',
        systemPromptOverride: 'Only the SDK supplied instructions.' },
    }, 'Inspect.');
    expect(TextPermissionProvider.systems[0]).toBe('Only the SDK supplied instructions.');
  });

  it('reflects Runtime Session changes in real model requests instead of the caller default', async () => {
    const runtime = await createKodaXRuntime({ homeDir: root, sessionsDir: path.join(root, 'sessions'),
      sharedDaemonHost: true, defaultProvider: 'text-permission-test' });
    try {
      const session = await runtime.sessions.create({ projectPath: workspace });
      await runtime.sessions.updateSettings(session.id, { permissionMode: 'full-access', executionCwd: workspace });
      const target = path.join(root, 'runtime-external.txt');
      TextPermissionProvider.responses = [
        { textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use', toolBlocks: [
          { type: 'tool_use', id: 'runtime-write', name: 'write', input: { path: target, content: 'runtime full access' } },
        ] },
        { textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use', toolBlocks: [
          { type: 'tool_use', id: 'runtime-read', name: 'read', input: { path: target } },
        ] },
        { textBlocks: [{ type: 'text', text: 'Done.' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' },
      ];
      TextPermissionProvider.onRequest = async () => {
        if (TextPermissionProvider.systems.length === 2) {
          await runtime.sessions.updateSettings(session.id, { permissionMode: 'plan' });
        }
      };
      const handle = await runtime.runs.start({ sessionId: session.id, prompt: 'Write and read the provided file.',
        options: { lsp: false, reasoningMode: 'off', context: { executionCwd: workspace, gitRoot: workspace,
          skillsPrompt: '', repoIntelligenceMode: 'off', systemPromptOverride: 'Perform the requested tools.',
          resolveShellPermissionMode: () => 'accept-edits' } } });
      await handle.result;
      await expect(fs.readFile(target, 'utf8')).resolves.toBe('runtime full access');
      expect(TextPermissionProvider.systems[0]).toContain('Current permission mode: full-access');
      expect(TextPermissionProvider.systems[2]).toContain('Current permission mode: plan');
      expect(TextPermissionProvider.systems[2]).not.toContain('Current permission mode: full-access');
    } finally { await runtime.close(); }
  });

  it('refreshes permission facts for managed role provider calls', async () => {
    let mode: 'auto' | 'full-access' = 'auto';
    const received: string[] = [];
    const adapter = buildRunnerLlmAdapter({ provider: 'text-permission-test',
      context: { resolveShellPermissionMode: () => mode },
    }, async (_messages, _tools, system) => { received.push(system); return { textBlocks: [{ text: 'Done.' }] }; });
    const agent = createAgent({ name: 'permission-test', instructions: 'Review.' });
    const messages = [{ role: 'system' as const, content: 'Review.' }, { role: 'user' as const, content: 'Inspect.' }];
    await adapter(messages, agent);
    mode = 'full-access';
    await adapter(messages, agent);
    expect(received[0]).toContain('Current permission mode: auto');
    expect(received[1]).toContain('Current permission mode: full-access');
    expect(received[1]).not.toContain('Current permission mode: auto');
  });

  it('does not reuse a Client approval after execution was vetoed', async () => {
    const target = path.join(root, 'client-external.txt');
    let approved = true;
    const events: KodaXEvents = {
      beforeToolExecute: async () => true,
      onToolExecutionStart: () => { if (approved) throw new Error('Host veto after admission'); },
    };
    const client = new KodaXClient({ provider: 'text-permission-test', reasoningMode: 'off', lsp: false,
      context: { executionCwd: workspace, gitRoot: workspace, skillsPrompt: '', repoIntelligenceMode: 'off',
        systemPromptOverride: 'Perform the requested tools.', resolveShellPermissionMode: () => 'auto' },
      events,
    });
    for (const allowed of [true, false]) {
      approved = allowed;
      if (!allowed) events.beforeToolExecute = undefined;
      TextPermissionProvider.responses = [
        { textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use', toolBlocks: [
          { type: 'tool_use', id: 'reused-id', name: 'write', input: { path: target, content: 'must not appear' } },
        ] },
        { textBlocks: [{ type: 'text', text: 'Stopped.' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' },
      ];
      await client.send('Attempt the write.');
    }
    await expect(fs.access(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    { mode: 'auto', review: 'allow', decision: false },
    { mode: 'auto', review: 'block', decision: true },
    { mode: 'auto', review: undefined, decision: undefined },
    { mode: 'plan', review: undefined, decision: true },
    { mode: 'accept-edits', review: undefined, decision: true },
    { mode: 'full-access', review: undefined, decision: false },
  ] as const)('keeps $mode refusal binding (review=$review, host=$decision)', async ({ mode, review, decision }) => {
    const target = path.join(root, 'must-not-write.txt');
    const guardrails: ToolGuardrail[] = review === undefined ? [] : [{ kind: 'tool', name: 'auto-mode',
      beforeTool: async () => review === 'allow' ? { action: 'allow' } : { action: 'block', reason: 'Explicit forbid.' },
    }];
    TextPermissionProvider.responses = [
      { textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use', toolBlocks: [
        { type: 'tool_use', id: 'denied-write', name: 'write', input: { path: target, content: 'forbidden' } },
      ] },
      { textBlocks: [{ type: 'text', text: 'Stopped.' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' },
    ];
    await runKodaX({ provider: 'text-permission-test', reasoningMode: 'off', lsp: false, guardrails,
      context: { executionCwd: workspace, gitRoot: workspace, skillsPrompt: '', repoIntelligenceMode: 'off',
        systemPromptOverride: 'Use tools.', resolveShellPermissionMode: () => mode },
      events: decision === undefined ? undefined : { beforeToolExecute: async () => decision },
    }, 'Attempt the write.');
    await expect(fs.access(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('isolates simultaneous Client text approvals with identical tool IDs', async () => {
    let release!: () => void;
    const bothReviewed = new Promise<void>((resolve) => { release = resolve; });
    let reviews = 0;
    const guardrails: ToolGuardrail[] = [{ kind: 'tool', name: 'auto-mode', beforeTool: async () => {
      if (++reviews === 2) release();
      await bothReviewed;
      return { action: 'allow' };
    } }];
    const targets = [path.join(root, 'first.txt'), path.join(root, 'second.txt')];
    TextPermissionProvider.responses = [
      ...targets.map((target): KodaXStreamResult => ({ textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use', toolBlocks: [
        { type: 'tool_use', id: 'same-tool-id', name: 'write', input: { path: target, content: target } },
      ] })),
      ...targets.map((): KodaXStreamResult => ({ textBlocks: [{ type: 'text', text: 'Done.' }],
        thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' })),
    ];
    const client = new KodaXClient({ provider: 'text-permission-test', reasoningMode: 'off', lsp: false, guardrails,
      context: { executionCwd: workspace, gitRoot: workspace, skillsPrompt: '', repoIntelligenceMode: 'off',
        systemPromptOverride: 'Use tools.', resolveShellPermissionMode: () => 'auto' },
    });
    await Promise.all([client.send('First write.'), client.send('Second write.')]);
    for (const target of targets) await expect(fs.readFile(target, 'utf8')).resolves.toBe(target);
  });

  it.each(['direct', 'managed'] as const)('refreshes permissions before a %s provider retry', async (entry) => {
    let mode: 'full-access' | 'plan' = 'full-access';
    TextPermissionProvider.responses = [{ textBlocks: [{ type: 'text', text: 'Done.' }],
      thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' }];
    TextPermissionProvider.onRequest = () => {
      if (TextPermissionProvider.systems.length === 1) {
        mode = 'plan';
        throw new KodaXNetworkError('Temporary connection reset');
      }
    };
    const options = { provider: 'text-permission-test', reasoningMode: 'off' as const, lsp: false,
      context: { executionCwd: workspace, gitRoot: workspace, skillsPrompt: '', repoIntelligenceMode: 'off' as const,
        systemPromptOverride: 'Inspect.', resolveShellPermissionMode: () => mode },
    };
    if (entry === 'direct') await runKodaX(options, 'Inspect.');
    else await buildRunnerLlmAdapter(options)([{ role: 'user', content: 'Inspect.' }],
      createAgent({ name: 'permission-test', instructions: 'Inspect.' }));
    expect(TextPermissionProvider.systems[0]).toContain('Current permission mode: full-access');
    expect(TextPermissionProvider.systems[1]).toContain('Current permission mode: plan');
  });

  it.each([{ name: 'runKodaX', run: runKodaX }, { name: 'runManagedTask', run: runManagedTask }])(
    '$name applies Auto approval to a concrete bridged external write', async ({ run }) => {
      const target = path.join(root, 'bridge-external.txt');
      TextPermissionProvider.responses = [
        { textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use', toolBlocks: [
          { type: 'tool_use', id: 'bridge-write', name: 'tool_call', input: {
            name: 'write', input: { path: target, content: 'bridged approval' },
          } },
        ] },
        { textBlocks: [{ type: 'text', text: 'Done.' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' },
      ];
      const guardrails: ToolGuardrail[] = [{ kind: 'tool', name: 'auto-mode', beforeTool: async () => ({ action: 'allow' }) }];
      await run({ provider: 'text-permission-test', reasoningMode: 'off', agentMode: 'sa', lsp: false, guardrails,
        context: { executionCwd: workspace, gitRoot: workspace, skillsPrompt: '', repoIntelligenceMode: 'off',
          systemPromptOverride: 'Use tools.', resolveShellPermissionMode: () => 'auto' },
      }, 'Write through tool_call.');
      await expect(fs.readFile(target, 'utf8')).resolves.toBe('bridged approval');
    },
  );

  it.each(['allow', 'ask'] as const)('enforces actual Runtime reviewer %s on an external write', async (decision) => {
    const target = path.join(root, 'runtime-auto-external.txt');
    TextReviewProvider.decision = decision;
    TextPermissionProvider.responses = [
      { textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use', toolBlocks: [
        { type: 'tool_use', id: 'runtime-auto-write', name: 'write', input: { path: target, content: 'runtime auto' } },
      ] },
      { textBlocks: [{ type: 'text', text: 'Done.' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' },
    ];
    const runtime = await createKodaXRuntime({ homeDir: root, sessionsDir: path.join(root, 'sessions'),
      sharedDaemonHost: true, defaultProvider: 'text-permission-test' });
    try {
      const session = await runtime.sessions.create({ projectPath: workspace });
      await runtime.sessions.updateSettings(session.id, { permissionMode: 'auto', executionCwd: workspace,
        autoModeClassifierModel: 'text-review-test:test' });
      const handle = await runtime.runs.start({ sessionId: session.id, prompt: 'Write the approved external file.',
        options: { lsp: false, reasoningMode: 'off', context: { executionCwd: workspace, gitRoot: workspace,
          skillsPrompt: '', repoIntelligenceMode: 'off', systemPromptOverride: 'Use tools.' } } });
      await handle.result;
      expect(TextReviewProvider.calls).toBeGreaterThan(0);
      if (decision === 'allow') await expect(fs.readFile(target, 'utf8')).resolves.toBe('runtime auto');
      else await expect(fs.access(target)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await runtime.close(); }
  });
});
