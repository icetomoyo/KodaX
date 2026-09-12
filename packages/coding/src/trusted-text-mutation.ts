import path from 'node:path';

import type { KodaXTrustedTextFileSnapshot } from './types.js';

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

  readonly denialSource?: 'builtin_fallback' | 'runtime_integrity';
  readonly matchedRule?: string;
  readonly remediation?: string;

  constructor(input: {
    readonly code: KodaXTrustedTextMutationErrorCode;
    readonly path: string;
    readonly message: string;
    readonly expectedRevision?: string;
    readonly actualRevision?: string;
    readonly osCode?: number;
    readonly commitReceipt?: KodaXTrustedTextCommitUncertainReceipt;
    readonly cause?: unknown;
    readonly denialSource?: 'builtin_fallback' | 'runtime_integrity';
    readonly matchedRule?: string;
    readonly remediation?: string;
  }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = 'KodaXTrustedTextMutationError';
    this.code = input.code;
    this.path = input.path;
    this.expectedRevision = input.expectedRevision;
    this.actualRevision = input.actualRevision;
    this.osCode = input.osCode;
    this.commitReceipt = input.commitReceipt;
    this.denialSource = input.denialSource;
    this.matchedRule = input.matchedRule;
    this.remediation = input.remediation;
  }
}

/** Shared lexical/canonical policy for trusted main-process text mutations. */
export function assertTrustedTextMutationPolicy(
  filePath: string,
  _executionCwd = process.cwd(),
  protectedPaths: readonly string[] = [],
  allowGitMetadata = false,
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
  const protectedControl = protectedPaths.some((candidate) =>
    caseFold(path.resolve(candidate)) === caseFold(canonicalTarget));
  if (
    (!allowGitMetadata && components.some((component) => component.toLowerCase() === '.git'))
    || protectedControl
  ) {
    throw new KodaXTrustedTextMutationError({
      code: 'text_mutation_policy_denied',
      path: filePath,
      message: protectedControl ? `Trusted text mutation targets protected KodaX state: ${filePath}`
        : `Current permission mode protects Git metadata: ${filePath}`,
      denialSource: protectedControl ? 'runtime_integrity' : 'builtin_fallback',
      matchedRule: protectedControl ? 'protected_control_path' : 'protected_git_metadata',
      remediation: protectedControl ? 'Use the owning configuration/control API. Do not rewrite this operation through Shell.'
        : 'Ask the user to grant Full Access for the intended Git metadata edit; do not rewrite the command to evade this decision.',
    });
  }
}
