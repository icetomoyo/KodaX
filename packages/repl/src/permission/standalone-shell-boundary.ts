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
  formatExecPolicyConfigurationError,
  formatExecPolicyRejection,
  KodaXTrustedTextMutationError,
  loadExecPolicy,
  type AutoModeToolGuardrail,
  type ExecPolicyRuleInput,
  type KodaXShellHostExecutionAuthorizer,
  type KodaXShellHostExecutionRequest,
  type KodaXShellPermissionMode,
  type KodaXShellSandbox,
  type KodaXTrustedTextMutationHost,
} from '@kodax-ai/coding';
import type { PermissionMode } from './types.js';

export type StandaloneShellPermissionReason = 'exec_policy_prompt' | 'mode_boundary';

export interface StandaloneExecPolicyOptions {
  readonly adminRules?: readonly ExecPolicyRuleInput[];
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
  readonly resolveShellPermissionMode: () => KodaXShellPermissionMode;
  readonly authorizeShellHostExecution: KodaXShellHostExecutionAuthorizer;
  readonly trustedTextMutationHost?: KodaXTrustedTextMutationHost;
}

/** Fail-closed Runtime-equivalent routing for public REPLs without a Runtime owner. */
export function createStandaloneShellPermissionBoundary(
  options: StandaloneShellPermissionBoundaryOptions,
): StandaloneShellPermissionBoundary {
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
      return { action: 'allow' };
    },
  };
  const shellSandbox: KodaXShellSandbox = {
    ...(options.shellSandbox?.processTreeContainment === undefined
      ? {}
      : { processTreeContainment: options.shellSandbox.processTreeContainment }),
    async prepare(input) {
      if (options.shellSandbox === undefined) {
        throw new Error('Standalone REPL has no OS sandbox provider.');
      }
      return options.shellSandbox.prepare({
        ...input,
        ...(projectPolicySnapshotPath === undefined
          ? {}
          : { trustedProjectExecPolicyPath: projectPolicySnapshotPath }),
      });
    },
  };
  const resolveShellPermissionMode = (): KodaXShellPermissionMode => {
    const mode = options.getPermissionMode();
    return mode === 'auto-in-project' ? 'auto' : mode;
  };
  const authorizeShellHostExecution: KodaXShellHostExecutionAuthorizer = async (request, context) => {
    const mode = request.permissionMode
      ?? (request.reason === 'direct-host' ? 'full-access' : resolveShellPermissionMode());
    const policy = await policySnapshot;
    const invalid = policy.errors[0];
    if (invalid !== undefined) {
      return formatExecPolicyConfigurationError(invalid, mode);
    }
    const evaluation = evaluateShellExecPolicy(request.command, policy.rules, {
      hostExecutable: request.executable,
      permissionMode: mode,
    });
    if (evaluation.decision === 'allow') return true;
    if (evaluation.decision === 'prompt') {
      if (request.reason === 'direct-host') {
        return formatExecPolicyRejection(evaluation, mode);
      }
      return options.requestUserPermission(request, 'exec_policy_prompt');
    }
    if (evaluation.decision === 'forbidden') {
      return formatExecPolicyRejection(evaluation, mode);
    }

    if (request.reason === 'direct-host') return true;
    if (mode === 'accept-edits') {
      return options.requestUserPermission(request, 'mode_boundary');
    }
    if (mode === 'plan') {
      return options.resolvePlanHostExecution?.(request)
        ?? '[Blocked] Plan mode cannot escalate this command to unsandboxed host execution.';
    }
    return reviewAutoHostBoundary(request, options.getAutoGuardrail(), context);
  };
  const trustedTextMutationHost = protectTrustedProjectPolicy(
    options.trustedTextMutationHost,
    projectPolicyPath,
  );
  return {
    autoGuardrail,
    shellSandbox,
    resolveShellPermissionMode,
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
  context: GuardrailContext | undefined,
): Promise<boolean | string> {
  const id = request.toolCallId;
  if (context === undefined || id === undefined) {
    return '[Denied] Auto[LLM] host review requires the current tool dispatch context.';
  }
  const call: RunnerToolCall = {
    id,
    name: 'bash',
    input: { ...request.toolInput, command: request.command },
  };
  const verdict = await guardrail.reviewHostBoundary(call, context);
  return verdict.action === 'allow'
    ? true
    : `[Denied] ${'reason' in verdict ? verdict.reason ?? 'Auto[LLM] denied host execution.' : 'Auto[LLM] denied host execution.'}`;
}
