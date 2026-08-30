import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultCodingAgent } from '@kodax-ai/coding';
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

describe('standalone REPL shell permission boundary', () => {
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
        kind: 'tool',
        name: 'auto-mode',
        beforeTool,
        reviewHostBoundary,
        getStats: () => ({
          classifierHealth: 'healthy',
          denials: { consecutiveDenials: 0, recentOutcomes: [] },
          breaker: { state: 'closed', errors: [] },
        }),
        getStatsForTest: () => ({
          classifierHealth: 'healthy',
          denials: { consecutiveDenials: 0, recentOutcomes: [] },
          breaker: { state: 'closed', errors: [] },
        }),
        resetTurn: () => undefined,
        setProviderForTest: () => undefined,
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

    await expect(boundary.authorizeShellHostExecution(request)).resolves.toBe(true);
    expect(reviewHostBoundary).toHaveBeenCalledOnce();
  });

  it('keeps Full Access off the sandbox and reviewer while enforcing critical policy', async () => {
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
        adminRules: [{
          prefix: ['git', 'push'],
          decision: 'forbidden',
          justification: 'administrator blocks publishing',
          source: 'admin',
          sourcePath: 'host:test',
        }],
      },
    });

    await expect(boundary.shellSandbox.prepare({
      toolInput: request.toolInput,
      command: request.command,
      cwd: request.cwd,
      env: process.env,
    })).resolves.toBeUndefined();
    expect(prepare).not.toHaveBeenCalled();
    await expect(boundary.authorizeShellHostExecution(request)).resolves.toBe(true);
    await expect(boundary.authorizeShellHostExecution({
      ...request,
      command: 'rm -rf /',
      toolInput: { command: 'rm -rf /' },
    })).resolves.toContain('[Blocked] Exec Policy forbids');
    await expect(boundary.authorizeShellHostExecution({
      ...request,
      command: 'git push',
      toolInput: { command: 'git push' },
    })).resolves.toContain('administrator blocks publishing');
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

  it('consumes the exact Auto call and rejects input substitution under the same id', async () => {
    const configHome = await mkdtemp(join(tmpdir(), 'kodax-repl-shell-'));
    const reviewHostBoundary = vi.fn(async () => ({ action: 'allow' as const }));
    const boundary = createStandaloneShellPermissionBoundary({
      getPermissionMode: () => 'auto',
      getAutoGuardrail: () => ({ reviewHostBoundary } as never),
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
    })).resolves.toContain('did not match the exact sandboxed call');
    await expect(boundary.authorizeShellHostExecution({
      ...request,
      toolInput: { nested: { a: 1, b: 2 }, command: 'git status' },
    })).resolves.toContain('did not match the exact sandboxed call');
    expect(reviewHostBoundary).not.toHaveBeenCalled();
  });

  it('clears an Auto call after a sandboxed process starts', async () => {
    const configHome = await mkdtemp(join(tmpdir(), 'kodax-repl-shell-'));
    const boundary = createStandaloneShellPermissionBoundary({
      getPermissionMode: () => 'auto',
      getAutoGuardrail: () => ({
        reviewHostBoundary: vi.fn(async () => ({ action: 'allow' as const })),
      } as never),
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
      .resolves.toContain('did not match the exact sandboxed call');
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
