import {
  KodaXClient as CodingKodaXClient,
  assertTrustedTextMutationPolicy,
  createDefaultCodingAgent as createCodingDefaultCodingAgent,
  createKodaXTaskRunner as createCodingKodaXTaskRunner,
  runKodaX as runCodingKodaX,
  runManagedTask as runCodingManagedTask,
  startKodaX as startCodingKodaX,
  resolveToolBridgeTarget,
  type Agent,
  type CreateKodaXTaskRunnerOptions,
  type KodaXAgentWorkerSpec,
  type KodaXOptions,
  type KodaXResult,
  type OrchestrationWorkerRunner,
  type PresetDispatcher,
  type RunningSession,
} from '@kodax-ai/coding';

import { createTrustedTextMutationHost } from './windows-text-transaction.js';
import { createTrustedTextApprovals } from './trusted-text-approvals.js';
import type { ToolGuardrail } from '@kodax-ai/agent';
import { isDeepStrictEqual } from 'node:util';
import type { KodaXTrustedTextToolCall } from '@kodax-ai/coding';

function withDirectTextApprovals<TOptions extends KodaXOptions>(
  options: TOptions, approvals: ReturnType<typeof createTrustedTextApprovals>,
): TOptions {
  const events = options.events;
  const reviewedCalls = new Map<string, KodaXTrustedTextToolCall>();
  return {
    ...options,
    guardrails: options.guardrails?.map((guardrail) => {
      if (guardrail.kind !== 'tool' || guardrail.name !== 'auto-mode') return guardrail;
      const beforeTool = (guardrail as ToolGuardrail).beforeTool;
      if (!beforeTool) return guardrail;
      return { ...guardrail, kind: 'tool', async beforeTool(call, context) {
        const bridge = resolveToolBridgeTarget(call);
        const concreteCall = bridge?.ok ? bridge.call : call;
        approvals.revoke(concreteCall.id);
        reviewedCalls.delete(concreteCall.id);
        const verdict = await beforeTool.call(guardrail, call, context);
        if (verdict.action === 'allow') reviewedCalls.set(concreteCall.id, structuredClone(concreteCall));
        return verdict;
      } } satisfies ToolGuardrail;
    }),
    events: {
      ...events,
      async beforeToolExecute(name, input, meta) {
        const id = meta?.toolId;
        const reviewed = id === undefined ? undefined : reviewedCalls.get(id);
        if (id !== undefined) { approvals.revoke(id); reviewedCalls.delete(id); }
        const decision = await events?.beforeToolExecute?.(name, input, meta);
        if (id !== undefined) {
          const call = { id, name, input };
          if (decision === true || (decision === undefined && isDeepStrictEqual(call, reviewed))) approvals.grant(call);
        }
        return decision ?? true;
      },
      onToolExecutionEnd(tool, meta) {
        approvals.revoke(tool.id);
        events?.onToolExecutionEnd?.(tool, meta);
      },
    },
  };
}

export function withTrustedTextMutationHost<TOptions extends KodaXOptions>(
  options: TOptions,
): TOptions {
  if (options.context?.trustedTextMutationHost !== undefined) return options;
  const workspaceRoot = options.context?.gitRoot
    ?? options.context?.executionCwd
    ?? process.cwd();
  const executionCwd = options.context?.executionCwd ?? workspaceRoot;
  const approvals = createTrustedTextApprovals(executionCwd,
    () => options.context?.resolveShellPermissionMode?.() === 'auto');
  const trustedTextMutationHost = createTrustedTextMutationHost(
    () => [
      workspaceRoot,
      executionCwd,
      ...(options.context?.workspaceSandboxRoots?.list() ?? []),
    ],
    (canonicalTarget) => assertTrustedTextMutationPolicy(
      canonicalTarget, executionCwd, [], options.context?.resolveShellPermissionMode?.() === 'full-access',
    ),
    () => options.context?.resolveShellPermissionMode?.() === 'full-access',
    approvals.authorize,
  );
  return withDirectTextApprovals({
    ...options,
    context: {
      ...options.context,
      trustedTextMutationHost,
    },
  } as TOptions, approvals);
}

/** KodaX-owned direct SDK entry with the native trusted-text authority bound. */
export function runKodaX(options: KodaXOptions, prompt: string): Promise<KodaXResult> {
  return runCodingKodaX(withTrustedTextMutationHost(options), prompt);
}

/** Non-blocking KodaX-owned direct SDK entry with the same trusted-text authority. */
export function startKodaX(options: KodaXOptions, prompt: string): RunningSession {
  return startCodingKodaX(withTrustedTextMutationHost(options), prompt);
}

/** Managed KodaX entry with the same direct trusted-text authority. */
export function runManagedTask(options: KodaXOptions, prompt: string): Promise<KodaXResult> {
  return runCodingManagedTask(withTrustedTextMutationHost(options), prompt);
}

/** Public task-runner factory whose default and custom Run paths receive the text authority. */
export function createKodaXTaskRunner<
  TTask extends KodaXAgentWorkerSpec = KodaXAgentWorkerSpec,
>(options: CreateKodaXTaskRunnerOptions<TTask>): OrchestrationWorkerRunner<TTask, string> {
  const runAgent = options.runAgent ?? runCodingKodaX;
  const createOptions = options.createOptions;
  return createCodingKodaXTaskRunner({
    ...options,
    createOptions: (task, context, defaultOptions) => withTrustedTextMutationHost(
      createOptions?.(task, context, defaultOptions) ?? defaultOptions,
    ),
    runAgent: (runOptions, prompt) => runAgent(withTrustedTextMutationHost(runOptions), prompt),
  });
}

/** Built-in coding preset whose Runner substrate binds final preset options at execution time. */
export function createDefaultCodingAgent(
  overrides: Partial<Omit<Agent, 'name' | 'instructions'>> = {},
): Agent {
  const codingAgent = createCodingDefaultCodingAgent(overrides);
  const substrate = codingAgent.substrateExecutor as PresetDispatcher;
  return Object.freeze({
    ...codingAgent,
    substrateExecutor: ((agent, input, options, tracingContext) => {
      const presetOptions = (options?.presetOptions ?? {}) as KodaXOptions;
      return substrate(
        agent,
        input,
        { ...options, presetOptions: withTrustedTextMutationHost(presetOptions) },
        tracingContext,
      );
    }) satisfies PresetDispatcher,
  });
}

/** Stateful direct SDK client with a fresh text authority for each send. */
export class KodaXClient extends CodingKodaXClient {
  constructor(options: KodaXOptions) {
    super(options, runKodaX);
  }
}

export { KodaXClient as Client };
