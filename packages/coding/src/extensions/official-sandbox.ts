import path from 'path';
import type { KodaXToolExecutionContext } from '../types.js';
import type { KodaXExtensionRuntime } from './runtime.js';
import type { CapabilityProvider, CapabilityResult } from './types.js';
import { resolveExecutionPath } from '../runtime-paths.js';
import { createBuiltinToolDefinition } from '../tools/index.js';

export type OfficialSandboxMode = 'enforced' | 'best_effort';

export interface OfficialSandboxOptions {
  workspaceRoot: string;
  mode?: OfficialSandboxMode;
}

interface OfficialSandboxPolicySnapshot {
  mode: OfficialSandboxMode;
  workspaceRoot: string;
  guardedTools: string[];
  bashBlocklist: string[];
  semantics: string;
}

const OFFICIAL_SANDBOX_PROVIDER_ID = 'official-sandbox';

const DEFAULT_BASH_BLOCKLIST: Array<{ label: string; pattern: RegExp }> = [
  { label: 'git reset --hard', pattern: /\bgit\s+reset\s+--hard\b/i },
  { label: 'rm -rf', pattern: /\brm\s+-rf\b/i },
  { label: 'Remove-Item -Recurse', pattern: /\bremove-item\b[\s\S]*\b-recurse\b/i },
];

function isPathInsideWorkspace(targetPath: string, workspaceRoot: string): boolean {
  const resolvedWorkspace = path.resolve(workspaceRoot);
  const resolvedTarget = path.resolve(targetPath);
  if (resolvedWorkspace === resolvedTarget) {
    return true;
  }

  const relative = path.relative(resolvedWorkspace, resolvedTarget);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function buildPolicySnapshot(options: OfficialSandboxOptions): OfficialSandboxPolicySnapshot {
  const mode = options.mode ?? 'best_effort';
  const workspaceRoot = path.resolve(options.workspaceRoot);
  return {
    mode,
    workspaceRoot,
    guardedTools: ['write', 'edit', 'bash'],
    bashBlocklist: DEFAULT_BASH_BLOCKLIST.map((entry) => entry.label),
    semantics: mode === 'enforced'
      ? 'Workspace-bound file mutations and a narrow destructive bash blocklist are enforced.'
      : 'Workspace-bound file mutations and a narrow destructive bash blocklist are best-effort and should not be treated as complete isolation.',
  };
}

function formatPolicyContent(policy: OfficialSandboxPolicySnapshot): string {
  return [
    '# Official Sandbox Policy',
    '',
    `Mode: ${policy.mode}`,
    `Workspace root: ${policy.workspaceRoot}`,
    `Guarded tools: ${policy.guardedTools.join(', ')}`,
    `Bash blocklist: ${policy.bashBlocklist.join(', ')}`,
    '',
    policy.semantics,
  ].join('\n');
}

function buildPolicyResult(policy: OfficialSandboxPolicySnapshot): CapabilityResult {
  return {
    kind: 'resource',
    content: formatPolicyContent(policy),
    structuredContent: policy,
    metadata: {
      mode: policy.mode,
      workspaceRoot: policy.workspaceRoot,
      guardedTools: policy.guardedTools,
      bashBlocklist: policy.bashBlocklist,
    },
  };
}

function createPathGuardedTool(
  name: 'write' | 'edit',
  policy: OfficialSandboxPolicySnapshot,
) {
  const builtin = createBuiltinToolDefinition(name);
  if (!builtin) {
    throw new Error(`Missing builtin tool definition for "${name}".`);
  }

  // builtin write/edit are always sync handlers (ToolHandlerSync), cast to ensure type safety
  const syncHandler = builtin.handler as (input: Record<string, unknown>, ctx: KodaXToolExecutionContext) => Promise<string>;
  return {
    ...builtin,
    handler: async (input: Record<string, unknown>, ctx: KodaXToolExecutionContext): Promise<string> => {
      const rawPath = typeof input.path === 'string' ? input.path : '';
      const resolvedPath = resolveExecutionPath(rawPath, ctx);
      if (!isPathInsideWorkspace(resolvedPath, policy.workspaceRoot)) {
        return `[Tool Error] ${name}: Blocked by official sandbox (${policy.mode}). ${resolvedPath} is outside workspace root ${policy.workspaceRoot}.`;
      }
      return syncHandler(input, ctx);
    },
  };
}

export function registerOfficialSandboxExtension(
  runtime: KodaXExtensionRuntime,
  options: OfficialSandboxOptions,
): () => void {
  const policy = buildPolicySnapshot(options);
  const disposers: Array<() => void | Promise<void>> = [];

  const provider: CapabilityProvider = {
    id: OFFICIAL_SANDBOX_PROVIDER_ID,
    kinds: ['resource'],
    read: async (capabilityId) => {
      if (capabilityId !== 'policy') {
        return {
          kind: 'resource',
          content: `Unknown official sandbox resource: ${capabilityId}`,
          metadata: { providerId: OFFICIAL_SANDBOX_PROVIDER_ID },
        };
      }
      return buildPolicyResult(policy);
    },
    getDiagnostics: () => ({
      mode: policy.mode,
      workspaceRoot: policy.workspaceRoot,
      guardedTools: policy.guardedTools,
      bashBlocklist: policy.bashBlocklist,
    }),
  };

  disposers.push(runtime.registerCapabilityProvider(provider));
  disposers.push(runtime.registerTool(
    createPathGuardedTool('write', policy),
    {
      source: {
        kind: 'extension',
        id: `${OFFICIAL_SANDBOX_PROVIDER_ID}:write`,
        label: OFFICIAL_SANDBOX_PROVIDER_ID,
      },
    },
  ));
  disposers.push(runtime.registerTool(
    createPathGuardedTool('edit', policy),
    {
      source: {
        kind: 'extension',
        id: `${OFFICIAL_SANDBOX_PROVIDER_ID}:edit`,
        label: OFFICIAL_SANDBOX_PROVIDER_ID,
      },
    },
  ));
  disposers.push(runtime.registerHook(
    'tool:before',
    (context) => {
      if (context.name !== 'bash') {
        return undefined;
      }

      const command = typeof context.input.command === 'string'
        ? context.input.command
        : '';
      const matched = DEFAULT_BASH_BLOCKLIST.find((entry) => entry.pattern.test(command));
      if (!matched) {
        return undefined;
      }

      return `[Tool Error] bash: Blocked by official sandbox (${policy.mode}). Command matches destructive policy: ${matched.label}.`;
    },
    {
      source: {
        kind: 'runtime',
        id: `${OFFICIAL_SANDBOX_PROVIDER_ID}:hook:tool-before`,
        label: OFFICIAL_SANDBOX_PROVIDER_ID,
      },
    },
  ));

  return () => {
    for (const dispose of disposers.reverse()) {
      void dispose();
    }
  };
}

