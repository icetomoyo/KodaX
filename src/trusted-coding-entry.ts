import {
  KodaXClient as CodingKodaXClient,
  assertTrustedTextMutationPolicy,
  createDefaultCodingAgent as createCodingDefaultCodingAgent,
  createKodaXTaskRunner as createCodingKodaXTaskRunner,
  runKodaX as runCodingKodaX,
  runManagedTask as runCodingManagedTask,
  startKodaX as startCodingKodaX,
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

export function withTrustedTextMutationHost<TOptions extends KodaXOptions>(
  options: TOptions,
): TOptions {
  if (options.context?.trustedTextMutationHost !== undefined) return options;
  const workspaceRoot = options.context?.gitRoot
    ?? options.context?.executionCwd
    ?? process.cwd();
  const executionCwd = options.context?.executionCwd ?? workspaceRoot;
  const trustedTextMutationHost = createTrustedTextMutationHost(
    () => [
      workspaceRoot,
      executionCwd,
      ...(options.context?.workspaceSandboxRoots?.list() ?? []),
    ],
    (canonicalTarget) => assertTrustedTextMutationPolicy(canonicalTarget, executionCwd),
  );
  return {
    ...options,
    context: {
      ...options.context,
      trustedTextMutationHost,
    },
  } as TOptions;
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

/** Stateful direct SDK client whose runs share the constructor-bound text authority. */
export class KodaXClient extends CodingKodaXClient {
  constructor(options: KodaXOptions) {
    super(withTrustedTextMutationHost(options));
  }
}

export { KodaXClient as Client };
