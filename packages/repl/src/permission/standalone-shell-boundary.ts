import { existsSync } from 'node:fs';
import path from 'node:path';
import { getAgentConfigHome } from '@kodax-ai/agent';
import type {
  GuardrailContext,
  RunnerToolCall,
  ToolGuardrail,
} from '@kodax-ai/agent';
import {
  evaluateShellExecPolicy,
  KodaXTrustedTextMutationError,
  loadExecPolicy,
  type AutoModeToolGuardrail,
  type ExecPolicyRule,
  type KodaXPreparedShellSandboxInvocation,
  type KodaXShellHostExecutionAuthorizer,
  type KodaXShellHostExecutionRequest,
  type KodaXShellSandbox,
  type KodaXTrustedTextMutationHost,
} from '@kodax-ai/coding';
import type { PermissionMode } from './types.js';

export type StandaloneShellPermissionReason = 'exec_policy_prompt' | 'mode_boundary';

export interface StandaloneExecPolicyOptions {
  readonly adminRules?: readonly ExecPolicyRule[];
  readonly trustedProjectRoots?: readonly string[];
}

export interface StandaloneShellPermissionBoundaryOptions {
  readonly getPermissionMode: () => PermissionMode;
  readonly getAutoGuardrail: () => AutoModeToolGuardrail;
  readonly shellSandbox?: KodaXShellSandbox;
  readonly requestUserPermission: (
    request: KodaXShellHostExecutionRequest,
    reason: StandaloneShellPermissionReason,
  ) => Promise<boolean | string>;
  readonly resolvePlanHostExecution?: (
    request: KodaXShellHostExecutionRequest,
  ) => boolean | string;
  readonly userConfigDir?: string;
  readonly projectRoot?: string;
  readonly execPolicy?: StandaloneExecPolicyOptions;
  readonly trustedTextMutationHost?: KodaXTrustedTextMutationHost;
}

export interface StandaloneShellPermissionBoundary {
  readonly autoGuardrail: ToolGuardrail;
  readonly shellSandbox: KodaXShellSandbox;
  readonly authorizeShellHostExecution: KodaXShellHostExecutionAuthorizer;
  readonly trustedTextMutationHost?: KodaXTrustedTextMutationHost;
}

interface PendingAutoReview {
  readonly call: RunnerToolCall;
  readonly context: GuardrailContext;
}

/** Fail-closed Runtime-equivalent routing for public REPLs without a Runtime owner. */
export function createStandaloneShellPermissionBoundary(
  options: StandaloneShellPermissionBoundaryOptions,
): StandaloneShellPermissionBoundary {
  const autoContexts = new Map<string, PendingAutoReview>();
  const projectPolicyPath = trustedProjectPolicyPath(options);
  const projectPolicySnapshotPath = projectPolicyPath !== undefined
    && existsSync(projectPolicyPath)
    ? projectPolicyPath
    : undefined;
  const policySnapshot = loadExecPolicy({
    userConfigDir: options.userConfigDir ?? getAgentConfigHome(),
    ...(options.projectRoot === undefined ? {} : { projectRoot: options.projectRoot }),
    trustProjectPolicy: projectPolicyPath !== undefined,
    adminRules: options.execPolicy?.adminRules,
  });
  const autoGuardrail: ToolGuardrail = {
    kind: 'tool',
    name: 'auto-mode',
    async beforeTool(call, context) {
      if (call.name !== 'bash') {
        return options.getAutoGuardrail().beforeTool?.(call, context)
          ?? { action: 'block', reason: 'Auto reviewer has no beforeTool hook.' };
      }
      autoContexts.set(call.id, { call, context });
      while (autoContexts.size > 64) {
        const oldest = autoContexts.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        autoContexts.delete(oldest);
      }
      return { action: 'allow' };
    },
  };
  const shellSandbox: KodaXShellSandbox = {
    ...(options.shellSandbox?.processTreeContainment === undefined
      ? {}
      : { processTreeContainment: options.shellSandbox.processTreeContainment }),
    async prepare(input) {
      if (options.getPermissionMode() === 'full-access') return undefined;
      if (options.shellSandbox === undefined) {
        throw new Error('Standalone REPL has no OS sandbox provider.');
      }
      const invocation = await options.shellSandbox.prepare({
        ...input,
        ...(projectPolicySnapshotPath === undefined
          ? {}
          : { trustedProjectExecPolicyPath: projectPolicySnapshotPath }),
      });
      return invocation === undefined
        ? undefined
        : cleanupCompletedAutoReview(invocation, input.toolCallId, input.toolInput, autoContexts);
    },
  };
  const authorizeShellHostExecution: KodaXShellHostExecutionAuthorizer = async (request) => {
    const policy = await policySnapshot;
    const invalid = policy.errors[0];
    if (invalid !== undefined) {
      return `[Blocked] Exec Policy could not be loaded from ${invalid.path}: ${invalid.message}`;
    }
    const evaluation = evaluateShellExecPolicy(request.command, policy.rules, {
      hostExecutable: request.executable,
    });
    if (evaluation.decision === 'allow') return true;
    if (evaluation.decision === 'prompt') {
      return options.requestUserPermission(request, 'exec_policy_prompt');
    }
    if (evaluation.decision === 'forbidden') {
      return `[Blocked] Exec Policy forbids this host operation: ${evaluation.justification ?? 'no justification supplied'}`;
    }

    const mode = options.getPermissionMode();
    if (mode === 'full-access') return true;
    if (mode === 'accept-edits') {
      return options.requestUserPermission(request, 'mode_boundary');
    }
    if (mode === 'plan') {
      return options.resolvePlanHostExecution?.(request)
        ?? '[Blocked] Plan mode cannot escalate this command to unsandboxed host execution.';
    }
    return reviewAutoHostBoundary(request, options.getAutoGuardrail(), autoContexts);
  };
  const trustedTextMutationHost = protectTrustedProjectPolicy(
    options.trustedTextMutationHost,
    projectPolicyPath,
  );
  return {
    autoGuardrail,
    shellSandbox,
    authorizeShellHostExecution,
    ...(trustedTextMutationHost === undefined ? {} : { trustedTextMutationHost }),
  };
}

function trustedProjectPolicyPath(
  options: StandaloneShellPermissionBoundaryOptions,
): string | undefined {
  const root = options.projectRoot;
  return root !== undefined
    && options.execPolicy?.trustedProjectRoots?.some((candidate) => sameHostPath(candidate, root))
    ? path.join(root, '.kodax', 'exec-policy.jsonc')
    : undefined;
}

function protectTrustedProjectPolicy(
  host: KodaXTrustedTextMutationHost | undefined,
  protectedPath: string | undefined,
): KodaXTrustedTextMutationHost | undefined {
  if (host === undefined || protectedPath === undefined) return host;
  const assertAllowed = (candidate: string): void => {
    if (!sameHostPath(candidate, protectedPath)) return;
    throw new KodaXTrustedTextMutationError({
      code: 'text_mutation_policy_denied',
      path: candidate,
      message: `Trusted project Exec Policy is immutable for this standalone Run: ${candidate}`,
    });
  };
  return {
    async snapshot(input) {
      assertAllowed(input.path);
      const snapshot = await host.snapshot(input);
      assertAllowed(snapshot.canonicalPath);
      return snapshot;
    },
    async commit(input) {
      assertAllowed(input.path);
      return host.commit(input);
    },
  };
}

function sameHostPath(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === 'win32'
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

async function reviewAutoHostBoundary(
  request: KodaXShellHostExecutionRequest,
  guardrail: AutoModeToolGuardrail,
  contexts: Map<string, PendingAutoReview>,
): Promise<boolean | string> {
  const id = request.toolCallId;
  const pending = id === undefined ? undefined : contexts.get(id);
  if (id !== undefined) contexts.delete(id);
  const requestCall: RunnerToolCall | undefined = id === undefined
    ? undefined
    : { id, name: 'bash', input: { ...request.toolInput } };
  if (pending === undefined || requestCall === undefined || !sameToolCall(pending.call, requestCall)) {
    return '[Denied] Auto[LLM] host review did not match the exact sandboxed call.';
  }
  const verdict = await guardrail.reviewHostBoundary(pending.call, pending.context);
  return verdict.action === 'allow'
    ? true
    : `[Denied] ${'reason' in verdict ? verdict.reason ?? 'Auto[LLM] denied host execution.' : 'Auto[LLM] denied host execution.'}`;
}

function cleanupCompletedAutoReview(
  invocation: KodaXPreparedShellSandboxInvocation,
  id: string | undefined,
  input: Readonly<Record<string, unknown>>,
  contexts: Map<string, PendingAutoReview>,
): KodaXPreparedShellSandboxInvocation {
  return {
    ...invocation,
    async cleanup(cleanupInput) {
      try {
        return await invocation.cleanup(cleanupInput);
      } finally {
        if (cleanupInput?.execution === 'started_or_unknown' && id !== undefined) {
          const pending = contexts.get(id);
          if (pending !== undefined && sameToolInput(pending.call.input, input)) contexts.delete(id);
        }
      }
    },
  };
}

function sameToolCall(left: RunnerToolCall, right: RunnerToolCall): boolean {
  return left.id === right.id
    && left.name === right.name
    && sameToolInput(left.input, right.input);
}

function sameToolInput(
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
): boolean {
  try {
    return stableJson(left) === stableJson(right);
  } catch {
    return false;
  }
}

function stableJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return 'null';
  if (typeof value !== 'object') {
    if (
      !['string', 'number', 'boolean'].includes(typeof value)
      || (typeof value === 'number' && !Number.isFinite(value))
    ) throw new Error('unsafe value');
    return JSON.stringify(value);
  }
  if (ancestors.has(value)) throw new Error('cyclic value');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const ownKeys = Reflect.ownKeys(value);
      if (
        ownKeys.length !== value.length + 1
        || ownKeys.some((key) => (
          key !== 'length'
          && (typeof key !== 'string' || !/^\d+$/u.test(key))
        ))
      ) throw new Error('unsafe array');
      return `[${value.map((item) => stableJson(item, ancestors)).join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error('non-plain object');
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key === 'symbol')) throw new Error('symbol property');
    return `{${(keys as string[]).sort().map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor?.enumerable !== true || !('value' in descriptor)) {
        throw new Error('unsafe property');
      }
      return `${JSON.stringify(key)}:${stableJson(descriptor.value, ancestors)}`;
    }).join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}
