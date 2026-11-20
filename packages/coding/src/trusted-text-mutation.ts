import path from 'node:path';

import {
  canonicalizeAgentHomePolicyPath,
  isAgentHomeHostLoadedTarget,
} from './permissions/agent-home-policy.js';
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

const foldPathCase = (value: string): string => (
  process.platform === 'win32' ? value.toLowerCase() : value
);

/**
 * The lexical and resolved spellings of one location. Directory aliases
 * (junctions, symlinked ancestors, macOS `/var`, Windows short names) give a
 * location several spellings. Undefined when an existing ancestor cannot be resolved.
 */
function pathSpellings(candidate: string): string[] | undefined {
  const lexical = path.resolve(candidate);
  const resolved = canonicalizeAgentHomePolicyPath(lexical);
  return resolved === undefined ? undefined : [...new Set([lexical, resolved].map(foldPathCase))];
}

/** True when both paths name the same location, including through directory aliases. */
export function isSameFilesystemPath(left: string, right: string): boolean {
  const leftSpellings = pathSpellings(left) ?? [foldPathCase(path.resolve(left))];
  const rightSpellings = pathSpellings(right) ?? [foldPathCase(path.resolve(right))];
  return leftSpellings.some((spelling) => rightSpellings.includes(spelling));
}

/** A protected path that cannot be resolved protects everything, so an alias cannot slip past it. */
export function targetsProtectedPath(target: string, protectedPath: string): boolean {
  return pathSpellings(protectedPath) === undefined || isSameFilesystemPath(target, protectedPath);
}

/** Shared lexical/canonical policy for trusted main-process text mutations. */
export function assertTrustedTextMutationPolicy(
  filePath: string,
  executionCwd = process.cwd(),
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
  // After the UNC/device check: classification touches the filesystem.
  if (isAgentHomeHostLoadedTarget(filePath, executionCwd)) {
    throw new KodaXTrustedTextMutationError({
      code: 'text_mutation_policy_denied',
      path: filePath,
      message: `Trusted text mutation targets KodaX extensions or integrations the Host loads as trusted: ${filePath}`,
      denialSource: 'runtime_integrity',
      matchedRule: 'protected_agent_home_state',
      remediation: 'The Host loads this state as trusted configuration, so only the user can change it. Tell the user what to change instead of rewriting this operation through Shell.',
    });
  }
  const components = path.resolve(filePath).split(/[\\/]+/);
  const protectedControl = protectedPaths.some((candidate) => targetsProtectedPath(filePath, candidate));
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
