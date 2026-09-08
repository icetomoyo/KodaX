import path from 'node:path';

import type { KodaXToolExecutionContext, KodaXTrustedTextFileSnapshot } from './types.js';
import { resolveExecutionPath } from './runtime-paths.js';
import { canonicalizeAgentHomePolicyPath } from './permissions/agent-home-policy.js';

/** Called by trusted dispatchers only after the concrete tool passed permission checks. */
export function withApprovedTextMutationTarget(
  tool: string,
  input: Readonly<Record<string, unknown>>,
  ctx: KodaXToolExecutionContext,
): KodaXToolExecutionContext {
  if (!['write', 'edit', 'multi_edit', 'insert_after_anchor', 'undo'].includes(tool)) return ctx;
  const target = tool === 'undo' ? [...ctx.backups.keys()].at(-1) : input.path;
  return {
    ...ctx,
    approvedTextMutationPath: typeof target === 'string' && target.trim() !== ''
      ? resolveExecutionPath(target, ctx)
      : undefined,
  };
}

export type KodaXTrustedTextMutationErrorCode =
  | 'text_mutation_stale'
  | 'text_mutation_contended'
  | 'text_mutation_commit_uncertain'
  | 'text_mutation_unsafe_path'
  | 'text_mutation_policy_denied'
  | 'text_mutation_identity_changed'
  | 'text_mutation_unsupported_filesystem'
  | 'text_mutation_metadata_preservation_failed'
  | 'text_mutation_io_failed';

export interface KodaXTrustedTextCommitUncertainReceipt {
  readonly before: KodaXTrustedTextFileSnapshot;
  readonly after: KodaXTrustedTextFileSnapshot;
}

/** Stable structured failure surface for trusted main-process text tools. */
export class KodaXTrustedTextMutationError extends Error {
  readonly code: KodaXTrustedTextMutationErrorCode;
  readonly path: string;
  readonly expectedRevision?: string;
  readonly actualRevision?: string;
  readonly osCode?: number;
  readonly commitReceipt?: KodaXTrustedTextCommitUncertainReceipt;

  constructor(input: {
    readonly code: KodaXTrustedTextMutationErrorCode;
    readonly path: string;
    readonly message: string;
    readonly expectedRevision?: string;
    readonly actualRevision?: string;
    readonly osCode?: number;
    readonly commitReceipt?: KodaXTrustedTextCommitUncertainReceipt;
    readonly cause?: unknown;
  }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = 'KodaXTrustedTextMutationError';
    this.code = input.code;
    this.path = input.path;
    this.expectedRevision = input.expectedRevision;
    this.actualRevision = input.actualRevision;
    this.osCode = input.osCode;
    this.commitReceipt = input.commitReceipt;
  }
}

/** Shared lexical/canonical policy for trusted main-process text mutations. */
export function assertTrustedTextMutationPolicy(
  filePath: string,
  _executionCwd = process.cwd(),
  protectedPaths: readonly string[] = [],
): void {
  const windowsPath = filePath.replaceAll('/', '\\');
  if (
    filePath.includes('\0')
    || windowsPath.startsWith('\\\\')
    || /^\\(?:\?\?|device|global\?\?|\?\?|\.)\\/i.test(windowsPath)
    || (process.platform === 'win32' && /^[A-Za-z]:[^\\]/.test(windowsPath))
    || (process.platform === 'win32' && /^[A-Za-z]:\\/.test(windowsPath)
      && windowsPath.slice(2).includes(':'))
  ) {
    throw new KodaXTrustedTextMutationError({
      code: 'text_mutation_unsafe_path',
      path: filePath,
      message: `Trusted text mutation denied a UNC, device, drive-relative, or ADS path: ${filePath}`,
    });
  }
  const components = path.resolve(filePath).split(/[\\/]+/);
  const canonicalTarget = path.resolve(filePath);
  const caseFold = (value: string): string => (
    process.platform === 'win32' ? value.toLowerCase() : value
  );
  if (
    components.some((component) => component.toLowerCase() === '.git')
    || protectedPaths.some((candidate) => {
      const canonicalProtectedPath = canonicalizeAgentHomePolicyPath(candidate);
      return canonicalProtectedPath === undefined
        || [candidate, canonicalProtectedPath].some((protectedPath) => (
          caseFold(path.resolve(protectedPath)) === caseFold(canonicalTarget)
        ));
    })
  ) {
    throw new KodaXTrustedTextMutationError({
      code: 'text_mutation_policy_denied',
      path: filePath,
      message: `Trusted text mutation targets protected KodaX state: ${filePath}`,
    });
  }
}
