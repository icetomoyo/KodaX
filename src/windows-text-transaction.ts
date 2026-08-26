import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';

import type {
  KodaXTrustedTextCommitInput,
  KodaXTrustedTextCommitOutcome,
  KodaXTrustedTextFileSnapshot,
  KodaXTrustedTextMutationHost,
} from '@kodax-ai/coding';
import { KodaXTrustedTextMutationError } from '@kodax-ai/coding';
import {
  assertTrustedTextNativeStateNotDirectlyWritable,
  ensureUnixTrustedTextCoordinationRoot,
  resolveTrustedTextNativeArtifact,
} from './windows-native-artifacts.js';

export const TRUSTED_TEXT_TRANSACTION_PROTOCOL = 4;
/** @deprecated Use TRUSTED_TEXT_TRANSACTION_PROTOCOL. */
export const WINDOWS_TEXT_TRANSACTION_PROTOCOL = TRUSTED_TEXT_TRANSACTION_PROTOCOL;

interface NativeTextSnapshot {
  readonly state: 'missing' | 'present';
  readonly content: string;
  readonly revision: string;
  readonly slotId: string;
  readonly canonicalPath: string;
}

interface NativeCommitOutcome {
  readonly status: 'written' | 'stale' | 'committed_uncertain';
  readonly slotId?: string;
  readonly currentRevision?: string;
  readonly preContent?: string;
  readonly preRevision?: string;
  readonly postRevision?: string;
  readonly abandonedLock?: boolean;
  readonly message?: string;
}

interface NativeTextTransactionRoot {
  snapshot(target: string): Promise<NativeTextSnapshot>;
  commit(
    target: string,
    expectedRevision: string,
    content: string,
    createParents: boolean,
    timeoutMs: number,
  ): Promise<NativeCommitOutcome>;
}

interface NativeTextTransactionBinding {
  textTransactionProtocol(): number;
  TrustedTextTransactionRoot: new (
    rootPath: string,
    stateRoot?: string,
  ) => NativeTextTransactionRoot;
}

interface AuthorizedTarget {
  readonly canonicalRoot: string;
  readonly canonicalTarget: string;
}

const require = createRequire(import.meta.url);
const LOCK_TIMEOUT_MS = 30_000;

let loadedBinding: NativeTextTransactionBinding | undefined;

export type TrustedTextNativeBindingProbe =
  | { readonly ready: true; readonly protocol: number }
  | { readonly ready: false; readonly error: string };

function assertLocalDriveAbsolutePath(value: string, label: string): void {
  const normalized = value.replaceAll('/', '\\');
  const lower = normalized.toLowerCase();
  const remainder = normalized.slice(3);
  const components = remainder === '' ? [] : remainder.split('\\');
  const invalidComponent = components.some((component) => {
    const stem = component.split('.', 1)[0]!.toUpperCase();
    const reserved = ['CON', 'PRN', 'AUX', 'NUL', 'CONIN$', 'CONOUT$'].includes(stem)
      || /^(?:COM|LPT)[1-9¹²³]$/.test(stem);
    return component === ''
      || component === '.'
      || component === '..'
      || component.endsWith('.')
      || component.endsWith(' ')
      || /[\u0000-\u001f<>"|?*]/.test(component)
      || /~[0-9¹²³]/.test(component)
      || reserved;
  });
  if (
    value.includes('\0')
    || normalized.startsWith('\\\\')
    || lower.startsWith('\\??\\')
    || lower.startsWith('\\device\\')
    || lower.startsWith('\\global??\\')
    || lower.startsWith('globalroot\\')
    || !/^[A-Za-z]:\\/.test(normalized)
    || normalized.slice(2).includes(':')
    || invalidComponent
  ) {
    throw new KodaXTrustedTextMutationError({
      code: 'text_mutation_unsafe_path',
      path: value,
      message: `Trusted text mutation ${label} must use a local drive-absolute path; UNC and device namespaces are denied: ${value}`,
    });
  }
}

function assertSupportedAbsolutePath(value: string, label: string): void {
  if (process.platform === 'win32') {
    assertLocalDriveAbsolutePath(value, label);
    return;
  }
  if (
    value.includes('\0')
    || !path.isAbsolute(value)
    || value.startsWith('//')
  ) {
    throw new KodaXTrustedTextMutationError({
      code: 'text_mutation_unsafe_path',
      path: value,
      message: `Trusted text mutation ${label} must use a local absolute path: ${value}`,
    });
  }
}

function sameOrInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizedRootCandidates(roots: readonly string[]): readonly string[] {
  const unique = new Map<string, string>();
  for (const candidate of roots) {
    const resolved = path.resolve(candidate);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (!unique.has(key)) unique.set(key, resolved);
  }
  return [...unique.values()].sort((left, right) => right.length - left.length);
}

function authorizeTarget(target: string, roots: readonly string[]): AuthorizedTarget {
  assertSupportedAbsolutePath(target, 'target');
  for (const root of roots) assertSupportedAbsolutePath(root, 'write root');
  const resolvedTarget = path.resolve(target);
  const lexicalRoot = normalizedRootCandidates(roots).find((candidate) => (
    candidate !== resolvedTarget && sameOrInside(candidate, resolvedTarget)
  ));
  if (lexicalRoot === undefined) {
    throw new KodaXTrustedTextMutationError({
      code: 'text_mutation_policy_denied',
      path: target,
      message: `Trusted text mutation target is outside the Runtime write roots: ${target}`,
    });
  }
  let canonicalRoot: string;
  try {
    const stat = fs.lstatSync(lexicalRoot);
    if (!stat.isDirectory()) throw new Error('write root is not a directory');
    canonicalRoot = fs.realpathSync.native(lexicalRoot);
  } catch (cause) {
    throw new KodaXTrustedTextMutationError({
      code: 'text_mutation_unsafe_path',
      path: target,
      message: `Trusted text mutation write root is unavailable: ${lexicalRoot}`,
      cause,
    });
  }
  return {
    canonicalRoot,
    canonicalTarget: path.join(canonicalRoot, path.relative(lexicalRoot, resolvedTarget)),
  };
}

function loadNativeBinding(writeRoots: readonly string[]): NativeTextTransactionBinding {
  assertTrustedTextNativeStateNotDirectlyWritable(writeRoots);
  if (loadedBinding !== undefined) return loadedBinding;
  const bindingPath = resolveTrustedTextNativeArtifact(
    import.meta.url,
    TRUSTED_TEXT_TRANSACTION_PROTOCOL,
    writeRoots,
  );
  const candidate = loadNativeBindingFile(bindingPath);
  loadedBinding = validateNativeBinding(candidate);
  return loadedBinding;
}

/**
 * Explicit diagnostic probe used by release artifacts and `kodax doctor
 * --native-text`. It may provision the verified content-addressed addon cache,
 * but it never opens or mutates a workspace file.
 */
export function probeTrustedTextNativeBinding(): TrustedTextNativeBindingProbe {
  try {
    const binding = loadNativeBinding([]);
    return { ready: true, protocol: binding.textTransactionProtocol() };
  } catch (error: unknown) {
    return {
      ready: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function validateNativeBinding(
  candidate: Partial<NativeTextTransactionBinding>,
): NativeTextTransactionBinding {
  if (
    typeof candidate.textTransactionProtocol !== 'function'
    || typeof candidate.TrustedTextTransactionRoot !== 'function'
    || candidate.textTransactionProtocol() !== TRUSTED_TEXT_TRANSACTION_PROTOCOL
  ) {
    throw new Error(
      `The KodaX trusted text transaction binding must implement protocol ${TRUSTED_TEXT_TRANSACTION_PROTOCOL}.`,
    );
  }
  return candidate as NativeTextTransactionBinding;
}

function loadNativeBindingFile(bindingPath: string): Partial<NativeTextTransactionBinding> {
  if (process.platform === 'win32') {
    return require(bindingPath) as Partial<NativeTextTransactionBinding>;
  }
  const descriptor = fs.openSync(
    bindingPath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024 * 1024) {
      throw new Error('The protected native text binding has an unsafe identity.');
    }
    const expectedHash = path.basename(path.dirname(bindingPath)).toLowerCase();
    const bytes = fs.readFileSync(descriptor);
    const actualHash = createHash('sha256').update(bytes).digest('hex');
    if (!/^[0-9a-f]{64}$/.test(expectedHash) || actualHash !== expectedHash) {
      throw new Error('The protected native text binding changed after provisioning.');
    }
    const container: { exports: unknown } = { exports: {} };
    const descriptorPath = process.platform === 'linux'
      ? `/proc/self/fd/${descriptor}`
      : `/dev/fd/${descriptor}`;
    process.dlopen(container, descriptorPath);
    return container.exports as Partial<NativeTextTransactionBinding>;
  } finally {
    fs.closeSync(descriptor);
  }
}

function createNativeRoot(
  binding: NativeTextTransactionBinding,
  canonicalRoot: string,
): NativeTextTransactionRoot {
  return process.platform === 'win32'
    ? new binding.TrustedTextTransactionRoot(canonicalRoot)
    : new binding.TrustedTextTransactionRoot(
      canonicalRoot,
      ensureUnixTrustedTextCoordinationRoot(),
    );
}

interface EncodedNativeError {
  readonly code?: string;
  readonly message?: string;
  readonly os_code?: number;
}

function mappedNativeErrorCode(code: string | undefined) {
  switch (code) {
    case 'invalid_path':
    case 'reparse_point':
    case 'hard_link':
      return 'text_mutation_unsafe_path' as const;
    case 'unauthorized_path':
      return 'text_mutation_policy_denied' as const;
    case 'remote_filesystem':
    case 'unsupported_filesystem':
    case 'unsupported_platform':
      return 'text_mutation_unsupported_filesystem' as const;
    case 'contended':
      return 'text_mutation_contended' as const;
    case 'stale':
      return 'text_mutation_stale' as const;
    case 'metadata_preservation':
      return 'text_mutation_metadata_preservation_failed' as const;
    default:
      return 'text_mutation_io_failed' as const;
  }
}

function translateNativeError(target: string, error: unknown): never {
  if (error instanceof KodaXTrustedTextMutationError) throw error;
  const message = error instanceof Error ? error.message : String(error);
  const marker = 'KODAX_TEXT_TRANSACTION:';
  const offset = message.indexOf(marker);
  let encoded: EncodedNativeError = {};
  if (offset >= 0) {
    try {
      const parsed: unknown = JSON.parse(message.slice(offset + marker.length));
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        encoded = parsed as EncodedNativeError;
      }
    } catch {
      encoded = {};
    }
  }
  throw new KodaXTrustedTextMutationError({
    code: mappedNativeErrorCode(encoded.code),
    path: target,
    message: encoded.message ?? message,
    ...(typeof encoded.os_code === 'number' ? { osCode: encoded.os_code } : {}),
    cause: error,
  });
}

function publicSnapshot(snapshot: NativeTextSnapshot): KodaXTrustedTextFileSnapshot {
  return {
    state: snapshot.state,
    content: snapshot.content,
    revision: snapshot.revision,
    slot: snapshot.slotId,
    canonicalPath: snapshot.canonicalPath,
  };
}

function requireWrittenOutcome(
  target: string,
  content: string,
  outcome: NativeCommitOutcome,
): KodaXTrustedTextCommitOutcome {
  if (outcome.status === 'stale') {
    if (typeof outcome.currentRevision !== 'string') {
      throw new Error('Native text transaction returned a stale result without a revision.');
    }
    return { status: 'stale', currentRevision: outcome.currentRevision };
  }
  if (
    typeof outcome.slotId !== 'string'
    || typeof outcome.preContent !== 'string'
    || typeof outcome.preRevision !== 'string'
    || typeof outcome.postRevision !== 'string'
  ) {
    throw new Error('Native text transaction returned an incomplete commit receipt.');
  }
  const receipt = {
    before: {
      state: outcome.preRevision.startsWith('missing:') ? 'missing' : 'present',
      content: outcome.preContent,
      revision: outcome.preRevision,
      slot: outcome.slotId,
      canonicalPath: target,
    },
    after: {
      state: 'present',
      content,
      revision: outcome.postRevision,
      slot: outcome.slotId,
      canonicalPath: target,
    },
    recoveredAbandonedLock: outcome.abandonedLock === true,
  };
  if (outcome.status === 'committed_uncertain') {
    if (typeof outcome.message !== 'string' || outcome.message === '') {
      throw new Error('Native text transaction returned an uncertain commit without a reason.');
    }
    return {
      status: 'committed_uncertain',
      ...receipt,
      reason: outcome.message,
    };
  }
  return { status: 'written', ...receipt };
}

export function createTrustedTextMutationHost(
  roots: () => readonly string[],
  authorizeCanonicalTarget: (canonicalTarget: string) => void,
): KodaXTrustedTextMutationHost {
  return {
    async snapshot(input) {
      if (input.signal?.aborted) throw input.signal.reason;
      assertSupportedAbsolutePath(input.path, 'target');
      const target = authorizeTarget(input.path, roots());
      authorizeCanonicalTarget(target.canonicalTarget);
      try {
        const binding = loadNativeBinding(roots());
        const nativeRoot = createNativeRoot(binding, target.canonicalRoot);
        return publicSnapshot(await nativeRoot.snapshot(target.canonicalTarget));
      } catch (error: unknown) {
        translateNativeError(target.canonicalTarget, error);
      }
    },
    async commit(input: KodaXTrustedTextCommitInput) {
      if (input.signal?.aborted) throw input.signal.reason;
      assertSupportedAbsolutePath(input.path, 'target');
      const target = authorizeTarget(input.path, roots());
      authorizeCanonicalTarget(target.canonicalTarget);
      try {
        const binding = loadNativeBinding(roots());
        const nativeRoot = createNativeRoot(binding, target.canonicalRoot);
        const outcome = await nativeRoot.commit(
          target.canonicalTarget,
          input.expectedRevision,
          input.content,
          input.createParentDirectories,
          LOCK_TIMEOUT_MS,
        );
        return requireWrittenOutcome(target.canonicalTarget, input.content, outcome);
      } catch (error: unknown) {
        translateNativeError(target.canonicalTarget, error);
      }
    },
  };
}

/** @deprecated The trusted text authority is cross-platform. */
export const createWindowsTrustedTextMutationHost = createTrustedTextMutationHost;

export const _internalWindowsTextTransaction = {
  authorizeTarget,
  requireWrittenOutcome,
  validateNativeBinding,
};
