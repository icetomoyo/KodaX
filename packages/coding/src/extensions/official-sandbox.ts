import path from 'path';
import type { KodaXToolExecutionContext } from '../types.js';
import type { KodaXExtensionRuntime } from './runtime.js';
import type { CapabilityProvider, CapabilityResult } from './types.js';
import { resolveExecutionPath } from '../runtime-paths.js';
import { createBuiltinToolDefinition } from '../tools/index.js';
import { parseBashCommand } from '../permissions/bash-ast.js';

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
  bashApprovals: string[];
  semantics: string;
}

const OFFICIAL_SANDBOX_PROVIDER_ID = 'official-sandbox';

const DEFAULT_BASH_BLOCKLIST: Array<{ label: string; pattern: RegExp }> = [
  { label: 'git reset --hard', pattern: /\bgit\s+reset\s+--hard\b/i },
];

const BASH_APPROVALS = ['recursive delete', 'delete outside the workspace'];
const DELETE_COMMANDS = new Set(['rm', 'rmdir', 'rd', 'del', 'erase', 'unlink', 'remove-item', 'ri']);
const DELETE_WORD = /\b(?:rm|rmdir|rd|del|erase|unlink|remove-item|ri)\b/i;

function commandName(token: string): string {
  return (token.replace(/\\/g, '/').split('/').at(-1) ?? '').toLowerCase().replace(/\.exe$/, '');
}

/** rm -r, -R or --recursive; PowerShell -Recurse or a prefix of it; cmd /s. */
function isRecursiveFlag(token: string): boolean {
  return token === '--recursive'
    || /^-[dfiIrRv]*[rR][dfiIrRv]*$/.test(token)
    || /^-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?$/i.test(token)
    || /^\/s$/i.test(token);
}

function deleteTargets(args: readonly string[]): string[] {
  return args.flatMap((token) => {
    const pathValue = /^-(?:literal)?path:(.+)$/i.exec(token)?.[1];
    if (pathValue !== undefined) return pathValue.split(',');
    if (token.startsWith('-') || /^\/[a-z]$/i.test(token)) return [];
    return token.split(',');
  }).map((target) => target.trim()).filter(Boolean);
}

function isOutsideWorkspace(target: string, cwd: string, workspaceRoot: string): boolean {
  // Variables, home paths and drive-relative paths cannot be resolved here, so they count as outside.
  if (/[$%`]/.test(target) || target.startsWith('~') || /^[a-z]:(?![\\/])/i.test(target)) return true;
  return !isPathInsideWorkspace(path.resolve(cwd, target), workspaceRoot);
}

function deleteApprovalReason(command: string, cwd: string, workspaceRoot: string): string | undefined {
  // Backslashes are path separators in Windows shells, not escapes.
  const tree = parseBashCommand(command.replace(/\\/g, '\\\\'));
  if (tree.unparseable) {
    return DELETE_WORD.test(command) ? 'Delete in a command the sandbox cannot check.' : undefined;
  }
  const reasons = new Set<string>();
  for (const stage of tree.statements.flatMap((statement) => statement.stages)) {
    // Searching the whole stage also covers wrappers such as sudo or xargs.
    const start = stage.argv.findIndex((token) => DELETE_COMMANDS.has(commandName(token)));
    if (start < 0) continue;
    const args = stage.argv.slice(start + 1);
    if (args.some(isRecursiveFlag)) reasons.add('Recursive delete.');
    const outside = deleteTargets(args).find((target) => isOutsideWorkspace(target, cwd, workspaceRoot));
    if (outside !== undefined) reasons.add(`Deletes ${outside}, outside the workspace root ${workspaceRoot}.`);
  }
  return reasons.size === 0 ? undefined : [...reasons].join(' ');
}

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
    bashApprovals: BASH_APPROVALS,
    semantics: mode === 'enforced'
      ? 'Workspace-bound file mutations, a narrow destructive bash blocklist, and approval for recursive or out-of-workspace deletes are enforced.'
      : 'Workspace-bound file mutations, a narrow destructive bash blocklist, and approval for recursive or out-of-workspace deletes are best-effort and should not be treated as complete isolation.',
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
    `Bash approvals: ${policy.bashApprovals.join(', ')}`,
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
      bashApprovals: policy.bashApprovals,
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
      bashApprovals: policy.bashApprovals,
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
      if (matched) {
        return `[Tool Error] bash: Blocked by official sandbox (${policy.mode}). Command matches destructive policy: ${matched.label}.`;
      }

      const reason = deleteApprovalReason(command, context.executionCwd ?? policy.workspaceRoot, policy.workspaceRoot);
      return reason === undefined ? undefined : { decision: 'ask' as const, reason };
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

