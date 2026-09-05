import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setAgentConfigHome } from '@kodax-ai/agent';
import {
  createDefaultCodingAgent,
  runManagedTask,
  toolBash,
  type AutoModeToolGuardrail,
} from '@kodax-ai/coding';
import {
  KodaXBaseProvider,
  clearRuntimeModelProviders,
  registerModelProvider,
  type KodaXMessage,
  type KodaXProviderConfig,
  type KodaXStreamResult,
} from '@kodax-ai/llm';
import { describe, expect, it, vi } from 'vitest';
import { createStandaloneShellPermissionBoundary } from './standalone-shell-boundary.js';

const request = {
  toolCallId: 'bash-call',
  toolInput: { command: 'git status' },
  command: 'git status',
  cwd: process.cwd(),
  executable: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
  args: process.platform === 'win32'
    ? ['/d', '/s', '/c', 'git status']
    : ['-c', 'git status'],
  reason: 'sandbox_unavailable' as const,
};

class ShellCommandProvider extends KodaXBaseProvider {
  readonly name = 'standalone-shell-test';
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'KODAX_STANDALONE_SHELL_TEST_KEY',
    model: 'standalone-shell-test',
    supportsThinking: false,
  };
  constructor(private readonly commands: Readonly<Record<string, string>>) { super(); }

  async stream(messages: KodaXMessage[]): Promise<KodaXStreamResult> {
    const prompt = messages.find((message) => message.role === 'user')?.content;
    const command = typeof prompt === 'string' ? this.commands[prompt] : undefined;
    if (command === undefined) throw new Error('No shell command scripted for the current user prompt.');
    const completed = messages.some((message) => (
      Array.isArray(message.content) && message.content.some((block) => block.type === 'tool_result')
    ));
    const toolBlocks = completed ? [] : [{
      type: 'tool_use' as const, id: 'bash-call', name: 'bash', input: { command },
    }];
    return {
      toolBlocks,
      textBlocks: toolBlocks.length === 0 ? [{ type: 'text', text: 'Finished.' }] : [],
      thinkingBlocks: [],
      stopReason: 'end_turn',
    };
  }
}

function allowingAutoGuardrail(
  reviewHostBoundary: AutoModeToolGuardrail['reviewHostBoundary'],
): AutoModeToolGuardrail {
  const getStats: AutoModeToolGuardrail['getStats'] = () => ({
    classifierHealth: 'healthy',
    denials: { consecutive: 0, cumulative: 0, recent: [] },
    breaker: { timestamps: [] },
  });
  return {
    kind: 'tool', name: 'auto-mode', reviewHostBoundary,
    beforeTool: async () => ({ action: 'allow' }),
    getStats, getStatsForTest: getStats,
    resetTurn: () => undefined,
    setProviderForTest: () => undefined,
  };
}

describe('standalone REPL shell permission boundary', () => {
  it.each(['allow', 'block'] as const)('reviews the current managed call after cleanup proves its target never started (%s)', async (action) => {
    const workDir = await mkdtemp(join(tmpdir(), 'kodax-standalone-auto-'));
    const configHome = join(workDir, 'config');
    const command = 'node -e "require(\'fs\').appendFileSync(\'effect.txt\',\'once\')"';
    const prompt = 'Create the requested effect exactly once.';
    const controller = new AbortController();
    const reviewHostBoundary = vi.fn<AutoModeToolGuardrail['reviewHostBoundary']>(async () => (
      action === 'allow' ? { action: 'allow' } : { action: 'block', reason: 'Auto rejected this command.' }
    ));
    const boundary = createStandaloneShellPermissionBoundary({
      getPermissionMode: () => 'auto',
      getAutoGuardrail: () => allowingAutoGuardrail(reviewHostBoundary),
      userConfigDir: configHome,
      requestUserPermission: async () => false,
      shellSandbox: {
        prepare: async () => ({
          executable: process.execPath,
          args: ['-e', 'process.exit(1)'],
          env: process.env,
          cleanup: async () => ({
            version: 1,
            state: 'pre_start_unavailable',
            diagnostic: 'wrapper exited before target creation',
          }),
        }),
      },
    });
    const provider = new ShellCommandProvider({ [prompt]: command });
    registerModelProvider('standalone-shell-test', () => provider);
    setAgentConfigHome(configHome);
    vi.stubEnv('KODAX_STANDALONE_SHELL_TEST_KEY', 'test-key');
    try {
      await runManagedTask({
        provider: 'standalone-shell-test',
        agentMode: 'sa', reasoningMode: 'off', lsp: false, maxIter: 2,
        abortSignal: controller.signal,
        guardrails: [boundary.autoGuardrail],
        context: {
          configHome, executionCwd: workDir, gitRoot: workDir,
          repoIntelligenceMode: 'off',
          skillsPrompt: '',
          shellSandbox: boundary.shellSandbox,
          authorizeShellHostExecution: boundary.authorizeShellHostExecution,
          resolveShellPermissionMode: boundary.resolveShellPermissionMode,
        },
      }, prompt);

      if (action === 'allow') {
        expect(await readFile(join(workDir, 'effect.txt'), 'utf8')).toBe('once');
      } else {
        await expect(readFile(join(workDir, 'effect.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      }
      expect(reviewHostBoundary).toHaveBeenCalledOnce();
      const [call, context] = reviewHostBoundary.mock.calls[0]!;
      expect(call.input.command).toBe(command);
      expect(context.messages).toContainEqual(expect.objectContaining({ role: 'user', content: prompt }));
      expect(context.abortSignal).toBe(controller.signal);
      expect(context.permissionIntent).toEqual({ rootUserIntent: prompt });
    } finally {
      clearRuntimeModelProviders();
      setAgentConfigHome(undefined);
      vi.unstubAllEnvs();
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it.each([true, false])('applies a single Edits decision without changing the mode (%s)', async (allowed) => {
    const workDir = await mkdtemp(join(tmpdir(), 'kodax-standalone-edits-'));
    const configHome = join(workDir, 'config');
    const command = 'node -e "require(\'fs\').appendFileSync(\'effect.txt\',\'once\')"';
    const requestUserPermission = vi.fn(async () => allowed);
    const boundary = createStandaloneShellPermissionBoundary({
      getPermissionMode: () => 'accept-edits',
      getAutoGuardrail: () => { throw new Error('Edits must not enter Auto review.'); },
      requestUserPermission,
      userConfigDir: configHome,
    });
    setAgentConfigHome(configHome);
    try {
      const result = await toolBash({ command }, {
        backups: new Map(), executionCwd: workDir,
        shellSandbox: boundary.shellSandbox,
        authorizeShellHostExecution: boundary.authorizeShellHostExecution,
        resolveShellPermissionMode: boundary.resolveShellPermissionMode,
      });
      expect(requestUserPermission).toHaveBeenCalledOnce();
      expect(boundary.resolveShellPermissionMode()).toBe('accept-edits');
      if (allowed) {
        expect(await readFile(join(workDir, 'effect.txt'), 'utf8')).toBe('once');
      } else {
        expect(result).toContain('[Denied]');
        await expect(readFile(join(workDir, 'effect.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      }
    } finally {
      setAgentConfigHome(undefined);
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it('keeps concurrent managed Auto reviews bound to their own intent and cancellation', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'kodax-standalone-concurrent-'));
    const configHome = join(workDir, 'config');
    const runs = ['parent', 'child'].map((name) => ({
      name,
      cwd: join(workDir, name),
      prompt: `Complete the ${name} task.`,
      command: `node -e "require('fs').appendFileSync('effect.txt','${name}')"`,
      controller: new AbortController(),
      intent: { rootUserIntent: 'Complete the project.', delegatedObjective: `${name} objective` },
    }));
    await Promise.all(runs.map((run) => mkdir(run.cwd)));
    const reviewHostBoundary = vi.fn<AutoModeToolGuardrail['reviewHostBoundary']>(async () => ({ action: 'allow' }));
    const boundary = createStandaloneShellPermissionBoundary({
      getPermissionMode: () => 'auto',
      getAutoGuardrail: () => allowingAutoGuardrail(reviewHostBoundary),
      userConfigDir: configHome,
      requestUserPermission: async () => false,
      shellSandbox: { prepare: async () => undefined },
    });
    const provider = new ShellCommandProvider(Object.fromEntries(runs.map((run) => [run.prompt, run.command])));
    registerModelProvider('standalone-shell-test', () => provider);
    setAgentConfigHome(configHome);
    vi.stubEnv('KODAX_STANDALONE_SHELL_TEST_KEY', 'test-key');
    try {
      await Promise.all(runs.map((run) => runManagedTask({
        provider: 'standalone-shell-test',
        agentMode: 'sa', reasoningMode: 'off', lsp: false, maxIter: 2,
        abortSignal: run.controller.signal,
        guardrails: [boundary.autoGuardrail],
        context: {
          configHome, executionCwd: run.cwd, gitRoot: run.cwd,
          repoIntelligenceMode: 'off', skillsPrompt: '',
          permissionIntent: run.intent,
          shellSandbox: boundary.shellSandbox,
          authorizeShellHostExecution: boundary.authorizeShellHostExecution,
          resolveShellPermissionMode: boundary.resolveShellPermissionMode,
        },
      }, run.prompt)));

      expect(reviewHostBoundary).toHaveBeenCalledTimes(2);
      for (const run of runs) {
        expect(await readFile(join(run.cwd, 'effect.txt'), 'utf8')).toBe(run.name);
        const [, context] = reviewHostBoundary.mock.calls.find(([call]) => call.input.command === run.command)!;
        expect(context.messages).toContainEqual(expect.objectContaining({ role: 'user', content: run.prompt }));
        expect(context.permissionIntent).toEqual(run.intent);
        expect(context.abortSignal).toBe(run.controller.signal);
      }
    } finally {
      clearRuntimeModelProviders();
      setAgentConfigHome(undefined);
      vi.unstubAllEnvs();
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it('defers Auto review until the sandbox reports a real host boundary', async () => {
    const configHome = await mkdtemp(join(tmpdir(), 'kodax-repl-shell-'));
    const reviewHostBoundary = vi.fn(async () => ({ action: 'allow' as const }));
    const beforeTool = vi.fn(async () => ({ action: 'block' as const, reason: 'preflight review' }));
    const prepare = vi.fn(async () => ({
      executable: process.execPath,
      args: ['--version'],
      env: process.env,
      cleanup: async () => undefined,
    }));
    const boundary = createStandaloneShellPermissionBoundary({
      getPermissionMode: () => 'auto',
      getAutoGuardrail: () => ({
        ...allowingAutoGuardrail(reviewHostBoundary),
        beforeTool,
      }),
      shellSandbox: { prepare },
      requestUserPermission: vi.fn(async () => false),
      userConfigDir: configHome,
    });
    const call = { id: 'bash-call', name: 'bash', input: request.toolInput };
    const context = { agent: createDefaultCodingAgent(), messages: [] };

    await expect(boundary.autoGuardrail.beforeTool?.(call, context))
      .resolves.toEqual({ action: 'allow' });
    await expect(boundary.shellSandbox.prepare({
      toolCallId: call.id,
      toolInput: call.input,
      command: request.command,
      cwd: request.cwd,
      env: process.env,
    })).resolves.toBeDefined();
    expect(beforeTool).not.toHaveBeenCalled();
    expect(reviewHostBoundary).not.toHaveBeenCalled();

    await expect(boundary.authorizeShellHostExecution(request, context)).resolves.toBe(true);
    expect(reviewHostBoundary).toHaveBeenCalledOnce();
  });

  it('keeps Full Access off sandbox and approval paths while enforcing dangerous policy', async () => {
    const configHome = await mkdtemp(join(tmpdir(), 'kodax-repl-shell-'));
    const prepare = vi.fn();
    const getAutoGuardrail = vi.fn(() => {
      throw new Error('Full Access must not construct the reviewer');
    });
    const requestUserPermission = vi.fn(async () => false);
    const boundary = createStandaloneShellPermissionBoundary({
      getPermissionMode: () => 'full-access',
      getAutoGuardrail,
      shellSandbox: { prepare },
      requestUserPermission,
      userConfigDir: configHome,
      execPolicy: {
        adminRules: [
          {
            prefix: ['git', 'push'],
            decision: 'forbidden',
            justification: 'administrator blocks publishing',
          },
          {
            prefix: ['git', 'fetch'],
            decision: 'prompt',
            justification: 'fetch requires approval',
          },
        ],
      },
    });

    const directCommand = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
      "process.stdout.write('standalone-full-access')",
    )}`;
    const result = await toolBash({ command: directCommand }, {
      backups: new Map(),
      toolCallId: 'standalone-full-access',
      shellSandbox: boundary.shellSandbox,
      resolveShellPermissionMode: boundary.resolveShellPermissionMode,
      authorizeShellHostExecution: boundary.authorizeShellHostExecution,
    });
    expect(result).toContain('standalone-full-access');
    expect(prepare).not.toHaveBeenCalled();
    await expect(boundary.authorizeShellHostExecution({
      ...request,
      command: 'rm -rf /',
      toolInput: { command: 'rm -rf /' },
      reason: 'direct-host',
    })).resolves.toContain('[Blocked] Exec Policy forbids');
    await expect(boundary.authorizeShellHostExecution({
      ...request,
      command: 'git push',
      toolInput: { command: 'git push' },
      reason: 'direct-host',
    })).resolves.toContain('administrator blocks publishing');
    await expect(boundary.authorizeShellHostExecution({
      ...request,
      command: 'git fetch',
      toolInput: { command: 'git fetch' },
      reason: 'direct-host',
    })).resolves.toContain('cannot prompt under Full Access');
    expect(getAutoGuardrail).not.toHaveBeenCalled();
    expect(requestUserPermission).not.toHaveBeenCalled();
  });

  it.each(['classic', 'ink'] as const)(
    'routes standalone %s Edits through the user boundary after sandbox unavailability',
    async () => {
      const configHome = await mkdtemp(join(tmpdir(), 'kodax-repl-shell-'));
      const requestUserPermission = vi.fn(async () => true);
      const boundary = createStandaloneShellPermissionBoundary({
        getPermissionMode: () => 'accept-edits',
        getAutoGuardrail: () => {
          throw new Error('Edits must not construct the Auto reviewer');
        },
        requestUserPermission,
        userConfigDir: configHome,
      });

      await expect(boundary.shellSandbox.prepare({
        toolInput: request.toolInput,
        command: request.command,
        cwd: request.cwd,
        env: process.env,
      })).rejects.toThrow('no OS sandbox provider');
      await expect(boundary.authorizeShellHostExecution(request)).resolves.toBe(true);
      expect(requestUserPermission).toHaveBeenCalledWith(request, 'mode_boundary');
    },
  );

  it('keeps unmatched Plan host execution fail-closed without prompting', async () => {
    const configHome = await mkdtemp(join(tmpdir(), 'kodax-repl-shell-'));
    const requestUserPermission = vi.fn(async () => true);
    const boundary = createStandaloneShellPermissionBoundary({
      getPermissionMode: () => 'plan',
      getAutoGuardrail: () => {
        throw new Error('Plan must not construct the Auto reviewer');
      },
      requestUserPermission,
      userConfigDir: configHome,
    });

    await expect(boundary.authorizeShellHostExecution(request))
      .resolves.toContain('[Blocked] Plan mode');
    expect(requestUserPermission).not.toHaveBeenCalled();
  });

  it('requires a current dispatch context even if a before-tool hook already ran', async () => {
    const configHome = await mkdtemp(join(tmpdir(), 'kodax-repl-shell-'));
    const reviewHostBoundary = vi.fn(async () => ({ action: 'allow' as const }));
    const boundary = createStandaloneShellPermissionBoundary({
      getPermissionMode: () => 'auto',
      getAutoGuardrail: () => allowingAutoGuardrail(reviewHostBoundary),
      requestUserPermission: vi.fn(async () => false),
      userConfigDir: configHome,
    });
    const call = { id: 'bash-call', name: 'bash', input: { command: 'git status', nested: { b: 2, a: 1 } } };
    const context = { agent: createDefaultCodingAgent(), messages: [] };
    await boundary.autoGuardrail.beforeTool?.(call, context);

    await expect(boundary.authorizeShellHostExecution({
      ...request,
      toolInput: { command: 'git push', nested: { a: 1, b: 2 } },
      command: 'git push',
    })).resolves.toContain('requires the current tool dispatch context');
    await expect(boundary.authorizeShellHostExecution({
      ...request,
      toolInput: { nested: { a: 1, b: 2 }, command: 'git status' },
    })).resolves.toContain('requires the current tool dispatch context');
    expect(reviewHostBoundary).not.toHaveBeenCalled();
  });

  it('does not retain authorization context after sandbox cleanup', async () => {
    const configHome = await mkdtemp(join(tmpdir(), 'kodax-repl-shell-'));
    const boundary = createStandaloneShellPermissionBoundary({
      getPermissionMode: () => 'auto',
      getAutoGuardrail: () => allowingAutoGuardrail(vi.fn(async () => ({ action: 'allow' as const }))),
      shellSandbox: {
        prepare: async () => ({
          executable: process.execPath,
          args: [],
          env: process.env,
          cleanup: async () => undefined,
        }),
      },
      requestUserPermission: vi.fn(async () => false),
      userConfigDir: configHome,
    });
    const call = { id: 'bash-call', name: 'bash', input: request.toolInput };
    await boundary.autoGuardrail.beforeTool?.(call, {
      agent: createDefaultCodingAgent(),
      messages: [],
    });
    const invocation = await boundary.shellSandbox.prepare({
      toolCallId: call.id,
      toolInput: call.input,
      command: request.command,
      cwd: request.cwd,
      env: process.env,
    });
    await invocation?.cleanup({ execution: 'started_or_unknown' });

    await expect(boundary.authorizeShellHostExecution(request))
      .resolves.toContain('requires the current tool dispatch context');
  });

  it('snapshots trusted project policy and protects it from text mutation', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'kodax-repl-policy-'));
    const configHome = await mkdtemp(join(tmpdir(), 'kodax-repl-shell-'));
    const policyPath = join(projectRoot, '.kodax', 'exec-policy.jsonc');
    await mkdir(join(projectRoot, '.kodax'));
    await writeFile(policyPath, JSON.stringify({ rules: [{
      prefix: ['git', 'status'],
      decision: 'allow',
      justification: 'trusted snapshot',
    }] }));
    const host = { snapshot: vi.fn(), commit: vi.fn() };
    const prepare = vi.fn(async () => undefined);
    const boundary = createStandaloneShellPermissionBoundary({
      getPermissionMode: () => 'auto',
      getAutoGuardrail: () => { throw new Error('unused'); },
      requestUserPermission: vi.fn(async () => false),
      userConfigDir: configHome,
      projectRoot,
      execPolicy: { trustedProjectRoots: [projectRoot] },
      shellSandbox: { prepare },
      trustedTextMutationHost: host as never,
    });
    await boundary.shellSandbox.prepare({
      toolCallId: 'trusted-project-policy',
      toolInput: request.toolInput,
      command: request.command,
      cwd: projectRoot,
      env: process.env,
    });
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({
      trustedProjectExecPolicyPath: policyPath,
    }));
    await expect(boundary.authorizeShellHostExecution(request)).resolves.toBe(true);
    await writeFile(policyPath, JSON.stringify({ rules: [{
      prefix: ['git', 'status'],
      decision: 'forbidden',
      justification: 'changed later',
    }] }));

    await expect(boundary.authorizeShellHostExecution(request)).resolves.toBe(true);
    await expect(boundary.trustedTextMutationHost?.snapshot({
      path: policyPath,
      createParentDirectories: false,
    })).rejects.toMatchObject({ code: 'text_mutation_policy_denied' });
    expect(host.snapshot).not.toHaveBeenCalled();
  });
});
