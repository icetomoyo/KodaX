import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createProviderCredentialLeaseScope,
  getScopedProviderCredential,
  registerCustomProviders,
  runWithProviderCredentialLeaseScope,
  withProviderRequestCredential,
} from '@kodax-ai/llm';

const workflowHostMock = vi.hoisted(() => ({
  startManagedWorkflow: vi.fn(),
}));

vi.mock('../workflows/host.js', () => ({
  startManagedWorkflow: workflowHostMock.startManagedWorkflow,
}));

vi.mock('../workflows/run-manager.js', () => ({
  getDefaultWorkflowRunManager: () => ({}),
}));

import { buildToolExecutionContext, resolveResumeFromRunDir } from './tool-execution-context.js';

afterEach(() => {
  workflowHostMock.startManagedWorkflow.mockReset();
});

/**
 * Path-traversal guard for the model-supplied `resumeFromRunId` (FEATURE_246
 * Part D). resolveResumeFromRunDir is the only sanitization before the id is
 * joined onto runsBaseDir, so a regression here would silently reopen a
 * path-escape. These cases pin the charset + the '..' defense.
 */
describe('resolveResumeFromRunDir (path-traversal guard)', () => {
  const BASE = '/runs';

  it('resolves a well-formed run id under the base dir', () => {
    // Normalize slashes so the assertion holds on win32 + posix.
    expect(resolveResumeFromRunDir(BASE, 'run-abc123')?.replace(/\\/g, '/')).toBe('/runs/run-abc123');
    expect(resolveResumeFromRunDir(BASE, 'wf_09f5c105-c08')?.replace(/\\/g, '/')).toBe(
      '/runs/wf_09f5c105-c08',
    );
  });

  it('returns undefined for an absent id (no resume requested)', () => {
    expect(resolveResumeFromRunDir(BASE, undefined)).toBeUndefined();
    expect(resolveResumeFromRunDir(BASE, '')).toBeUndefined();
  });

  it('rejects a bare ".." that would escape the base dir', () => {
    // Passes the charset (dot is allowed) but must be caught by the includes('..') guard.
    expect(resolveResumeFromRunDir(BASE, '..')).toBeUndefined();
    expect(resolveResumeFromRunDir(BASE, 'a..b')).toBeUndefined();
  });

  it('rejects ids with slashes, leading separators, or path escapes', () => {
    expect(resolveResumeFromRunDir(BASE, '../etc')).toBeUndefined();
    expect(resolveResumeFromRunDir(BASE, '../../etc/passwd')).toBeUndefined();
    expect(resolveResumeFromRunDir(BASE, 'a/b')).toBeUndefined();
    expect(resolveResumeFromRunDir(BASE, '/abs')).toBeUndefined();
    expect(resolveResumeFromRunDir(BASE, '.hidden')).toBeUndefined(); // must start alnum
  });
});

describe('F270 actor principal wiring', () => {
  it.each(['completed', 'failed'] as const)(
    'closes a detached Workflow credential scope after %s settlement',
    async (status) => {
      const attributions: unknown[] = [];
      let settleWorkflow: ((value: unknown) => void) | undefined;
      let releaseDelayed: (() => void) | undefined;
      let delayedRequest: Promise<unknown> | undefined;
      const parentScope = createProviderCredentialLeaseScope({
        allowedProviders: ['openai'],
        async acquire(provider, _purpose, _signal, attribution) {
          attributions.push(attribution);
          return `${provider}-workflow-secret`;
        },
      });
      workflowHostMock.startManagedWorkflow.mockImplementation(async (input) => {
        await expect(withProviderRequestCredential(
          'openai',
          'workflow',
          undefined,
          () => getScopedProviderCredential('openai'),
        )).resolves.toBe('openai-workflow-secret');
        delayedRequest = new Promise<void>((resolve) => {
          releaseDelayed = resolve;
        }).then(() => withProviderRequestCredential(
          'openai',
          'workflow',
          undefined,
          () => getScopedProviderCredential('openai'),
        )).catch((error: unknown) => error);
        const done = new Promise<unknown>((resolve) => {
          settleWorkflow = resolve;
        });
        return {
          kind: 'started',
          runId: input.runId,
          managed: {
            done,
            getSnapshot: () => ({ status }),
          },
        };
      });
      const ctx = buildToolExecutionContext({
        options: {
          provider: 'openai',
          agentMode: 'ama',
          workflowRunsBaseDir: '/workflow-runs',
          context: { workflowIntent: 'explicit' },
        },
        runtime: undefined,
        managedProtocolPayloadRef: { current: undefined },
      });

      const started = await runWithProviderCredentialLeaseScope(parentScope, () =>
        ctx.workflowHost!.startInline({
          manifest: {
            name: 'credential-lifecycle',
            description: 'Credential lifecycle fixture',
            readOnly: true,
          },
          source: 'async function run() { return {}; }',
          args: {},
        }));
      expect(started.kind).toBe('started');
      const [attribution] = attributions as Array<{
        readonly kind: string;
        readonly workflowRunId: string;
      }>;
      expect(attribution).toMatchObject({
        kind: 'workflow',
        workflowRunId: expect.stringMatching(/^run-/),
      });
      settleWorkflow?.(status === 'completed'
        ? {
            kind: 'completed',
            result: {},
            state: { events: [] },
          }
        : {
            kind: 'failed',
            error: new Error('workflow failed'),
            state: { events: [] },
          });
      if (started.kind === 'started') await started.done;
      releaseDelayed?.();
      await expect(delayedRequest).resolves.toMatchObject({
        message: expect.stringContaining('no longer active'),
      });
      expect(attributions).toHaveLength(1);
      parentScope.close();
    },
  );

  it('closes a detached Workflow credential scope immediately on cancellation', async () => {
    const abortController = new AbortController();
    let postAbortAcquire: Promise<unknown> | undefined;
    let settleWorkflow: ((value: unknown) => void) | undefined;
    const parentScope = createProviderCredentialLeaseScope({
      allowedProviders: ['openai'],
      async acquire() { return 'openai-workflow-secret'; },
    });
    workflowHostMock.startManagedWorkflow.mockImplementation(async (input) => {
      const aborted = new Promise<void>((resolve) => {
        input.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      postAbortAcquire = aborted.then(() => withProviderRequestCredential(
          'openai',
          'workflow',
          undefined,
          () => getScopedProviderCredential('openai'),
        )).catch((error: unknown) => error);
      return {
        kind: 'started',
        runId: input.runId,
        managed: {
          done: new Promise((resolve) => { settleWorkflow = resolve; }),
          getSnapshot: () => ({ status: 'running' }),
        },
      };
    });
    const ctx = buildToolExecutionContext({
      options: {
        provider: 'openai',
        agentMode: 'ama',
        workflowRunsBaseDir: '/workflow-runs',
        abortSignal: abortController.signal,
        context: { workflowIntent: 'explicit' },
      },
      runtime: undefined,
      managedProtocolPayloadRef: { current: undefined },
    });
    const started = await runWithProviderCredentialLeaseScope(parentScope, () =>
      ctx.workflowHost!.startInline({
        manifest: {
          name: 'credential-cancellation',
          description: 'Credential cancellation fixture',
          readOnly: true,
        },
        source: 'async function run() { return {}; }',
        args: {},
      }));

    abortController.abort(new Error('cancel workflow'));
    await expect(postAbortAcquire).resolves.toMatchObject({
      message: expect.stringContaining('no longer active'),
    });
    settleWorkflow?.({
      kind: 'failed',
      error: new Error('cancelled'),
      state: { events: [] },
    });
    if (started.kind === 'started') await started.done;
    parentScope.close();
  });

  it('invalidates detached Workflow authority immediately when the parent lease is revoked', async () => {
    const brokerController = new AbortController();
    let postRevokeAcquire: Promise<unknown> | undefined;
    let settleWorkflow: ((value: unknown) => void) | undefined;
    const parentScope = createProviderCredentialLeaseScope({
      allowedProviders: ['openai'],
      signal: brokerController.signal,
      async acquire() { return 'openai-workflow-secret'; },
    });
    workflowHostMock.startManagedWorkflow.mockImplementation(async (input) => {
      const revoked = new Promise<void>((resolve) => {
        brokerController.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      postRevokeAcquire = revoked.then(() => withProviderRequestCredential(
        'openai',
        'workflow',
        undefined,
        () => getScopedProviderCredential('openai'),
      )).catch((error: unknown) => error);
      return {
        kind: 'started',
        runId: input.runId,
        managed: {
          done: new Promise((resolve) => { settleWorkflow = resolve; }),
          getSnapshot: () => ({ status: 'running' }),
        },
      };
    });
    const ctx = buildToolExecutionContext({
      options: {
        provider: 'openai',
        agentMode: 'ama',
        workflowRunsBaseDir: '/workflow-runs',
        context: { workflowIntent: 'explicit' },
      },
      runtime: undefined,
      managedProtocolPayloadRef: { current: undefined },
    });
    const started = await runWithProviderCredentialLeaseScope(parentScope, () =>
      ctx.workflowHost!.startInline({
        manifest: {
          name: 'credential-revocation',
          description: 'Credential revocation fixture',
          readOnly: true,
        },
        source: 'async function run() { return {}; }',
        args: {},
      }));

    brokerController.abort(new Error('lease revoked'));
    await expect(postRevokeAcquire).resolves.toMatchObject({
      message: expect.stringContaining('no longer active'),
    });
    settleWorkflow?.({
      kind: 'failed',
      error: new Error('revoked'),
      state: { events: [] },
    });
    if (started.kind === 'started') await started.done;
    parentScope.close();
  });

  it('binds Provider credentials into default-shell filtering', () => {
    const ctx = buildToolExecutionContext({
      options: {
        provider: 'openai',
      },
      runtime: undefined,
      managedProtocolPayloadRef: { current: undefined },
    });

    expect(ctx.providerCredentialEnvironmentNames).toContain('OPENAI_API_KEY');
  });

  it('filters non-standard credentials from the default shell too', () => {
    registerCustomProviders([{
      name: 'inactive-shell-review-provider',
      protocol: 'openai',
      baseUrl: 'https://inactive.invalid/v1',
      apiKeyEnv: 'INACTIVE_PROVIDER_AUTH',
      model: 'inactive-model',
    }]);
    try {
      const ctx = buildToolExecutionContext({
        options: {
          provider: 'openai',
        },
        runtime: undefined,
        managedProtocolPayloadRef: { current: undefined },
      });

      expect(ctx.providerCredentialEnvironmentNames).toContain(
        'INACTIVE_PROVIDER_AUTH',
      );
    } finally {
      registerCustomProviders([]);
    }
  });

  it('snapshots prompt-cache and context-diagnostic controls for child runtimes', () => {
    const ctx = buildToolExecutionContext({
      options: {
        provider: 'mock',
        disablePromptCache: false,
        context: { contextDiagnostics: true },
      },
      runtime: undefined,
      managedProtocolPayloadRef: { current: undefined },
    });

    expect(ctx.parentAgentConfig).toMatchObject({
      provider: 'mock',
      disablePromptCache: false,
      contextDiagnostics: true,
    });
  });

  it('binds SDK sandbox envPass to the current run and child snapshot', () => {
    const sandbox = { envPass: ['GH_TOKEN'] } as const;
    const ctx = buildToolExecutionContext({
      options: { provider: 'mock', sandbox },
      runtime: undefined,
      managedProtocolPayloadRef: { current: undefined },
    });

    expect(ctx.sandbox).toEqual(sandbox);
    expect(ctx.parentAgentConfig?.sandbox).toEqual(sandbox);
  });

  it('creates one root-bound collaboration principal for a standalone AMA run', () => {
    const ctx = buildToolExecutionContext({
      options: { provider: 'mock', agentMode: 'ama' },
      runtime: undefined,
      managedProtocolPayloadRef: { current: undefined },
    });

    expect(ctx.actorControl?.callerPath).toBe('/root');
    expect(ctx.actorControl?.list()).toMatchObject({
      maxConcurrentThreads: 4,
      activeNonRootTurns: 0,
    });
    expect(ctx.sendMessageTurnCounter).toEqual({ count: 0 });
  });

  it('preserves a Runtime-injected actor principal instead of creating a second tree', () => {
    const injected = { callerPath: '/root/injected' } as NonNullable<
      import('../types.js').KodaXContextOptions['actorControl']
    >;
    const ctx = buildToolExecutionContext({
      options: {
        provider: 'mock',
        agentMode: 'ama',
        context: {
          actorControl: injected,
          contextIdentitySessionId: 'logical-root-session',
          currentAgentId: '/root/injected',
          parentAgentId: '/root',
        },
      },
      sessionId: 'physical-worker-session',
      runtime: undefined,
      managedProtocolPayloadRef: { current: undefined },
    });

    expect(ctx.actorControl).toBe(injected);
    expect(ctx.sessionId).toBe('physical-worker-session');
    expect(ctx.contextIdentitySessionId).toBe('logical-root-session');
    expect(ctx.currentAgentId).toBe('/root/injected');
    expect(ctx.parentAgentId).toBe('/root');
  });
});
