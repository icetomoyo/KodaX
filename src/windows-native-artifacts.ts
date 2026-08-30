import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getAgentConfigHome } from '@kodax-ai/agent';

declare const KODAX_WINDOWS_NATIVE_MANIFEST_JSON: string | undefined;
declare const KODAX_NATIVE_MANIFEST_JSON: string | undefined;
declare const KODAX_NATIVE_MANIFESTS_JSON: string | undefined;

export interface WindowsNativeArtifactManifest {
  readonly version: 1;
  readonly platform: 'win32';
  readonly arch: string;
  readonly textTransaction: WindowsNativeArtifactEntry;
  readonly shellSandbox: WindowsNativeArtifactEntry;
  readonly asrtRunner: WindowsAsrtRunnerArtifactEntry;
}

export interface WindowsNativeArtifactEntry {
  readonly file: string;
  readonly protocol: number;
  readonly sha256: string;
}

export interface WindowsAsrtRunnerArtifactEntry {
  readonly file: 'srt-win.exe';
  readonly version: string;
  readonly sha256: string;
}

export type WindowsNativeArtifactKind = 'textTransaction' | 'shellSandbox';
type WindowsProtectedArtifactKind = WindowsNativeArtifactKind | 'asrtRunner';

export interface ResolvedWindowsNativeArtifact {
  readonly path: string;
  readonly entry: WindowsNativeArtifactEntry;
  readonly manifest: WindowsNativeArtifactManifest;
}

export interface ResolveWindowsNativeArtifactOptions {
  readonly sandboxReadSid?: string;
  readonly untrustedWriteRoots?: readonly string[];
}

export interface ResolvedWindowsAsrtRunnerArtifact {
  readonly path: string;
  readonly sha256: string;
  readonly developmentTrustRoots: readonly string[];
}

interface PortableTextArtifactManifest {
  readonly version: 1;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly textTransaction: WindowsNativeArtifactEntry;
}

const MAX_NATIVE_ARTIFACT_BYTES = 64 * 1024 * 1024;
const WINDOWS_NATIVE_CACHE_VERSION = 'v2';

function embeddedNativeManifestText(): string | undefined {
  if (
    typeof KODAX_NATIVE_MANIFESTS_JSON === 'string'
    && KODAX_NATIVE_MANIFESTS_JSON !== ''
  ) {
    const parsed: unknown = JSON.parse(KODAX_NATIVE_MANIFESTS_JSON);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('embedded native manifest map is invalid');
    }
    const value = (parsed as Readonly<Record<string, unknown>>)[
      `${process.platform}-${process.arch}`
    ];
    if (typeof value !== 'string' || value === '') {
      throw new Error(`embedded native manifest is missing for ${process.platform}-${process.arch}`);
    }
    return value;
  }
  if (process.platform === 'win32') {
    return typeof KODAX_WINDOWS_NATIVE_MANIFEST_JSON === 'string'
      && KODAX_WINDOWS_NATIVE_MANIFEST_JSON !== ''
      ? KODAX_WINDOWS_NATIVE_MANIFEST_JSON
      : undefined;
  }
  return typeof KODAX_NATIVE_MANIFEST_JSON === 'string'
    && KODAX_NATIVE_MANIFEST_JSON !== ''
    ? KODAX_NATIVE_MANIFEST_JSON
    : undefined;
}

function physicalElectronArtifactPath(candidate: string): string {
  const resolved = path.resolve(candidate);
  const parsed = path.parse(resolved);
  const components = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  const archiveIndex = components.findIndex(
    (component) => component.toLowerCase() === 'app.asar',
  );
  if (archiveIndex < 0) return resolved;
  const unpackedComponents = [...components];
  unpackedComponents[archiveIndex] = `${components[archiveIndex]!}.unpacked`;
  const unpacked = path.join(parsed.root, ...unpackedComponents);
  return fs.existsSync(unpacked) ? unpacked : resolved;
}

function artifactDirectories(
  moduleUrl: string,
  usePhysicalElectronArtifacts = false,
): readonly string[] {
  const moduleDirectory = path.dirname(fileURLToPath(moduleUrl));
  const nativeDirectory = `win32-${process.arch}`;
  return [...new Set([
    path.join(moduleDirectory, 'native', nativeDirectory),
    path.join(moduleDirectory, '..', 'native', nativeDirectory),
    path.join(moduleDirectory, '..', 'dist', 'native', nativeDirectory),
    path.join(path.dirname(process.execPath), 'vendor', 'kodax-native', nativeDirectory),
  ].map((candidate) => {
    const resolved = path.resolve(candidate);
    return usePhysicalElectronArtifacts ? physicalElectronArtifactPath(resolved) : resolved;
  }))];
}

function manifestObject(text: string): Partial<WindowsNativeArtifactManifest> {
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('manifest root is not an object');
  }
  return parsed as Partial<WindowsNativeArtifactManifest>;
}

function assertManifestHeader(manifest: Partial<WindowsNativeArtifactManifest>): void {
  if (
    manifest.version !== 1
    || manifest.platform !== 'win32'
    || manifest.arch !== process.arch
  ) {
    throw new Error('manifest platform, architecture, or version is incompatible');
  }
}

function assertManifestEntry(
  manifest: Partial<WindowsNativeArtifactManifest>,
  kind: WindowsNativeArtifactKind,
): WindowsNativeArtifactEntry {
  const entry = manifest[kind];
  if (
    typeof entry?.file !== 'string'
    || path.basename(entry.file) !== entry.file
    || !Number.isSafeInteger(entry.protocol)
    || !/^[0-9a-f]{64}$/i.test(entry.sha256 ?? '')
  ) {
    throw new Error(`manifest ${kind} entry is invalid`);
  }
  return entry;
}

function assertManifestAsrtRunner(
  manifest: Partial<WindowsNativeArtifactManifest>,
): WindowsAsrtRunnerArtifactEntry {
  const entry = manifest.asrtRunner;
  if (
    entry?.file !== 'srt-win.exe'
    || typeof entry.version !== 'string'
    || entry.version === ''
    || !/^[0-9a-f]{64}$/i.test(entry.sha256 ?? '')
  ) {
    throw new Error('manifest asrtRunner entry is invalid');
  }
  return entry;
}

function parseManifestText(text: string): WindowsNativeArtifactManifest {
  const manifest = manifestObject(text);
  assertManifestHeader(manifest);
  for (const kind of ['textTransaction', 'shellSandbox'] as const) {
    assertManifestEntry(manifest, kind);
  }
  assertManifestAsrtRunner(manifest);
  return manifest as WindowsNativeArtifactManifest;
}

function parseManifestEntryText(
  text: string,
  kind: WindowsNativeArtifactKind,
): { readonly manifest: WindowsNativeArtifactManifest; readonly entry: WindowsNativeArtifactEntry } {
  const manifest = manifestObject(text);
  assertManifestHeader(manifest);
  const entry = assertManifestEntry(manifest, kind);
  return { manifest: manifest as WindowsNativeArtifactManifest, entry };
}

function sameOrInside(parent: string, candidate: string): boolean {
  const pathApi = process.platform === 'win32' ? path.win32 : path.posix;
  const relative = pathApi.relative(
    pathApi.resolve(parent),
    pathApi.resolve(candidate),
  );
  return relative === '' || (!relative.startsWith('..') && !pathApi.isAbsolute(relative));
}

function assertDevelopmentSourceIsOutsideWriteRoots(
  directory: string,
  roots: readonly string[],
): void {
  const canonicalDirectory = canonicalExistingPath(directory);
  if (roots.map(canonicalExistingPath).some((root) => (
    sameOrInside(root, canonicalDirectory) || sameOrInside(canonicalDirectory, root)
  ))) {
    throw new Error(
      `native artifact source overlaps a writable Runtime root: ${directory}. `
      + 'Use a production bundle with an embedded native manifest.',
    );
  }
}

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function readBoundedOrdinaryFile(file: string, requireSingleLink: boolean): Buffer {
  const before = fs.lstatSync(file);
  const invalid = (stat: fs.Stats): boolean => (
    !stat.isFile()
    || stat.isSymbolicLink()
    || (requireSingleLink && stat.nlink !== 1)
    || stat.size > MAX_NATIVE_ARTIFACT_BYTES
  );
  if (invalid(before)) {
    throw new Error(`native artifact is not a bounded ordinary file: ${file}`);
  }
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY);
  try {
    const opened = fs.fstatSync(descriptor);
    const current = fs.lstatSync(file);
    if (invalid(opened) || invalid(current)
      || !sameFileIdentity(before, opened) || !sameFileIdentity(opened, current)) {
      throw new Error(`native artifact is not a stable bounded ordinary file: ${file}`);
    }
    const buffer = Buffer.allocUnsafe(opened.size + 1);
    let length = 0;
    while (length < buffer.byteLength) {
      const count = fs.readSync(descriptor, buffer, length, buffer.byteLength - length, null);
      if (count === 0) break;
      length += count;
    }
    const after = fs.fstatSync(descriptor);
    if (length !== opened.size || invalid(after) || !sameFileIdentity(opened, after)) {
      throw new Error(`native artifact changed during bounded read: ${file}`);
    }
    return buffer.subarray(0, length);
  } finally {
    fs.closeSync(descriptor);
  }
}

function readHashPinnedArtifact(
  file: string,
  expected: string,
  requireSingleLink: boolean,
): Buffer {
  const bytes = readBoundedOrdinaryFile(file, requireSingleLink);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected.toLowerCase()) {
    throw new Error(`native artifact hash mismatch: ${file}`);
  }
  return bytes;
}

function readVerifiedArtifact(file: string, expected: string): Buffer {
  return readHashPinnedArtifact(file, expected, true);
}

export function windowsNativeArtifactCacheRoot(): string {
  const localAppData = process.env.LOCALAPPDATA
    ?? path.join(os.homedir(), 'AppData', 'Local');
  return path.join(path.resolve(localAppData), 'KodaXNativeArtifactsV3');
}

export function windowsSandboxControlDirectory(): string {
  return path.join(windowsNativeArtifactCacheRoot(), 'control-v1');
}

export function assertWindowsSandboxControlStateNotDirectlyAccessible(input: {
  readonly allowRead: readonly string[];
  readonly allowWrite: readonly string[];
  readonly denyRead: readonly string[];
  readonly denyWrite: readonly string[];
}): void {
  const cacheRoot = canonicalExistingPath(windowsNativeArtifactCacheRoot());
  const readConflict = input.allowRead.find((root) => {
    const canonical = canonicalExistingPath(root);
    return sameOrInside(cacheRoot, canonical);
  });
  const writeConflict = input.allowWrite.find((root) => {
    const canonical = canonicalExistingPath(root);
    return sameOrInside(cacheRoot, canonical) || sameOrInside(canonical, cacheRoot);
  });
  const allowConflict = readConflict ?? writeConflict;
  if (allowConflict !== undefined) {
    throw new Error(`Windows policy overlaps protected native shell control state: ${allowConflict}`);
  }
  const denyConflict = [...input.denyRead, ...input.denyWrite].find((root) => (
    sameOrInside(cacheRoot, canonicalExistingPath(root))
  ));
  if (denyConflict !== undefined) {
    throw new Error(`Windows deny policy targets protected native shell control state: ${denyConflict}`);
  }
}

export function assertWindowsNativeArtifactStoreNotDirectlyWritable(
  roots: readonly string[],
): void {
  const cacheRoot = canonicalExistingPath(windowsNativeArtifactCacheRoot());
  const conflict = roots.find((root) => {
    const canonical = canonicalExistingPath(root);
    return sameOrInside(cacheRoot, canonical) || sameOrInside(canonical, cacheRoot);
  });
  if (conflict !== undefined) {
    throw new Error(`Windows write policy targets protected native state: ${conflict}`);
  }
}

function unixNativeArtifactCacheRoot(): string {
  return path.join(unixTrustedTextStateRoot(), 'artifacts-v1');
}

export function unixTrustedTextStateRoot(): string {
  return path.join(path.resolve(getAgentConfigHome()), 'native-text-state-v1');
}

export function unixTrustedTextCoordinationRoot(): string {
  const uid = process.geteuid?.();
  if (uid === undefined) {
    throw new Error('Unix trusted text coordination requires an effective user identity');
  }
  const systemTemporaryRoot = process.platform === 'darwin' ? '/private/tmp' : '/tmp';
  return path.join(systemTemporaryRoot, `kodax-native-text-coordination-v1-${uid}`);
}

export function trustedTextNativeArtifactStateRoots(): readonly string[] {
  return process.platform === 'win32'
    ? [windowsNativeArtifactCacheRoot()]
    : [unixTrustedTextStateRoot(), unixTrustedTextCoordinationRoot()];
}

export function assertTrustedTextNativeStateNotDirectlyWritable(
  roots: readonly string[],
): void {
  assertTrustedTextNativeStateNotDirectlyAccessible(roots, 'write');
}

export function assertTrustedTextNativeStateNotDirectlyReadable(
  roots: readonly string[],
): void {
  assertTrustedTextNativeStateNotDirectlyAccessible(roots, 'read');
}

function assertTrustedTextNativeStateNotDirectlyAccessible(
  roots: readonly string[],
  access: 'read' | 'write',
): void {
  const protectedRoots = (process.platform === 'win32'
    ? trustedTextNativeArtifactStateRoots()
    : [ensureUnixTrustedTextStateRoot(), ensureUnixTrustedTextCoordinationRoot()])
    .map(canonicalExistingPath);
  const candidateRoots = roots.map(canonicalExistingPath);
  for (const protectedRoot of protectedRoots) {
    const conflict = candidateRoots.find((root) => (
      sameOrInside(protectedRoot, root) || sameOrInside(root, protectedRoot)
    ));
    if (conflict !== undefined) {
      throw new Error(`Runtime ${access} policy targets protected native text state: ${conflict}`);
    }
  }
}

function canonicalExistingPath(value: string): string {
  let existingAncestor = path.resolve(value);
  const missingSuffix: string[] = [];
  for (;;) {
    try {
      fs.lstatSync(existingAncestor);
    } catch (error: unknown) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw new Error(`Unable to inspect Runtime filesystem policy root: ${value}`, {
          cause: error,
        });
      }
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) {
        throw new Error(`Runtime filesystem policy root has no existing ancestor: ${value}`);
      }
      missingSuffix.unshift(path.basename(existingAncestor));
      existingAncestor = parent;
      continue;
    }
    try {
      return path.resolve(fs.realpathSync.native(existingAncestor), ...missingSuffix);
    } catch (error: unknown) {
      throw new Error(`Unable to canonicalize Runtime filesystem policy root: ${value}`, {
        cause: error,
      });
    }
  }
}

function portableTextArtifactDirectories(
  moduleUrl: string,
  usePhysicalElectronArtifacts: boolean,
): readonly string[] {
  const moduleDirectory = path.dirname(fileURLToPath(moduleUrl));
  const nativeDirectory = `${process.platform}-${process.arch}`;
  return [...new Set([
    path.join(moduleDirectory, 'native', nativeDirectory),
    path.join(moduleDirectory, '..', 'native', nativeDirectory),
    path.join(moduleDirectory, '..', 'dist', 'native', nativeDirectory),
    path.join(path.dirname(process.execPath), 'vendor', 'kodax-native', nativeDirectory),
  ].map((candidate) => {
    const resolved = path.resolve(candidate);
    return usePhysicalElectronArtifacts ? physicalElectronArtifactPath(resolved) : resolved;
  }))];
}

function parsePortableTextManifest(text: string): PortableTextArtifactManifest {
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('native text manifest root is not an object');
  }
  const manifest = parsed as Partial<PortableTextArtifactManifest>;
  const entry = manifest.textTransaction;
  if (
    manifest.version !== 1
    || manifest.platform !== process.platform
    || manifest.arch !== process.arch
    || typeof entry?.file !== 'string'
    || path.basename(entry.file) !== entry.file
    || !Number.isSafeInteger(entry.protocol)
    || !/^[0-9a-f]{64}$/i.test(entry.sha256 ?? '')
  ) {
    throw new Error('native text manifest is incompatible');
  }
  return manifest as PortableTextArtifactManifest;
}

function assertPrivateUnixDirectory(directory: string): void {
  const stat = fs.lstatSync(directory);
  const effectiveUid = process.geteuid?.();
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || (effectiveUid !== undefined && stat.uid !== effectiveUid)
    || (stat.mode & 0o077) !== 0
  ) {
    throw new Error(`native text state directory is not private and host-owned: ${directory}`);
  }
}

function ensurePrivateUnixDirectory(directory: string): void {
  const anchor = ensureUnixTrustedTextStateRoot();
  const relative = path.relative(anchor, directory);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('native text artifact escaped its cache root');
  }
  let current = anchor;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      fs.mkdirSync(current, { mode: 0o700 });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    assertPrivateUnixDirectory(current);
  }
}

export function ensureUnixTrustedTextStateRoot(): string {
  const agentHome = path.resolve(getAgentConfigHome());
  assertNoUnixSymlinkAncestor(agentHome);
  fs.mkdirSync(agentHome, { recursive: true, mode: 0o700 });
  assertNoUnixSymlinkAncestor(agentHome);
  if (fs.realpathSync.native(agentHome) !== agentHome) {
    throw new Error('Agent home must not resolve through a symbolic-link alias');
  }
  const directory = unixTrustedTextStateRoot();
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  assertPrivateUnixDirectory(directory);
  return fs.realpathSync.native(directory);
}

export function ensureUnixTrustedTextCoordinationRoot(): string {
  const directory = unixTrustedTextCoordinationRoot();
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  assertPrivateUnixDirectory(directory);
  return fs.realpathSync.native(directory);
}

function assertNoUnixSymlinkAncestor(value: string): void {
  const resolved = path.resolve(value);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const component of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new Error(`Agent home path contains a symbolic-link ancestor: ${current}`);
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

function provisionUnixTextArtifact(
  entry: WindowsNativeArtifactEntry,
  bytes: Buffer,
): string {
  const directory = path.join(
    unixNativeArtifactCacheRoot(),
    `${process.platform}-${process.arch}`,
    'textTransaction',
    entry.sha256.toLowerCase(),
  );
  ensurePrivateUnixDirectory(directory);
  const destination = path.join(directory, entry.file);
  if (!fs.existsSync(destination)) {
    const temporary = path.join(directory, `.${process.pid}-${Date.now()}.tmp`);
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(
        temporary,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY
          | fs.constants.O_NOFOLLOW,
        0o500,
      );
      let offset = 0;
      while (offset < bytes.length) {
        const written = fs.writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
        if (written === 0) throw new Error('native text artifact write made no progress');
        offset += written;
      }
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      try {
        fs.linkSync(temporary, destination);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      fs.rmSync(temporary, { force: true });
    }
  }
  const stat = fs.lstatSync(destination);
  const effectiveUid = process.geteuid?.();
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.nlink !== 1
    || (effectiveUid !== undefined && stat.uid !== effectiveUid)
    || (stat.mode & 0o777) !== 0o500
  ) {
    throw new Error('protected native text artifact has an unsafe identity or mode');
  }
  readVerifiedArtifact(destination, entry.sha256);
  return fs.realpathSync.native(destination);
}

export function resolveTrustedTextNativeArtifact(
  moduleUrl: string,
  expectedProtocol: number,
  untrustedWriteRoots: readonly string[],
): string {
  assertTrustedTextNativeStateNotDirectlyWritable(untrustedWriteRoots);
  if (process.platform === 'win32') {
    return resolveWindowsNativeArtifact(
      moduleUrl,
      'textTransaction',
      expectedProtocol,
      { untrustedWriteRoots },
    ).path;
  }
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    throw new Error(`Trusted text transactions are unavailable on ${process.platform}.`);
  }
  const embedded = embeddedNativeManifestText();
  const diagnostics: string[] = [];
  for (const directory of portableTextArtifactDirectories(moduleUrl, embedded !== undefined)) {
    const manifestPath = path.join(directory, 'manifest.json');
    try {
      assertDevelopmentSourceIsOutsideWriteRoots(directory, untrustedWriteRoots);
      const manifest = parsePortableTextManifest(
        embedded ?? fs.readFileSync(manifestPath, 'utf8'),
      );
      if (manifest.textTransaction.protocol !== expectedProtocol) {
        throw new Error(
          `textTransaction protocol ${manifest.textTransaction.protocol} does not match ${expectedProtocol}`,
        );
      }
      const source = path.join(directory, manifest.textTransaction.file);
      const bytes = readVerifiedArtifact(source, manifest.textTransaction.sha256);
      return provisionUnixTextArtifact(manifest.textTransaction, bytes);
    } catch (error: unknown) {
      diagnostics.push(`${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`A compatible KodaX text transaction artifact is unavailable. ${diagnostics.join(' | ')}`);
}

function protectedArtifactDirectory(
  kind: WindowsProtectedArtifactKind,
  sha256: string,
  sandboxReadSid: string | undefined,
  localUsersReadExecute = false,
): string {
  const accessKey = localUsersReadExecute
    ? 'local-users'
    : sandboxReadSid === undefined
      ? 'host-only'
      : `sandbox-${createHash('sha256').update(sandboxReadSid.toUpperCase()).digest('hex').slice(0, 16)}`;
  return path.join(
    windowsNativeArtifactCacheRoot(),
    WINDOWS_NATIVE_CACHE_VERSION,
    `win32-${process.arch}`,
    kind,
    accessKey,
    sha256.toLowerCase(),
  );
}

// The fixed System32 provisioner receives only bytes already authenticated by
// the embedded release manifest. It creates every cache component with its
// final protected DACL; existing components are verified and never repaired
// through a path-based ACL mutation.
const PROVISION_PROTECTED_ARTIFACT = String.raw`
$ErrorActionPreference = 'Stop'
$payloadText = [Console]::In.ReadToEnd()
if ([Text.Encoding]::UTF8.GetByteCount($payloadText) -gt 90000000) { throw 'payload exceeds bound' }
$payload = $payloadText | ConvertFrom-Json
$hostSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$usersSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
$sandboxSid = if ([string]::IsNullOrEmpty([string]$payload.sandboxReadSid)) { $null } else { [Security.Principal.SecurityIdentifier]::new([string]$payload.sandboxReadSid) }
$localUsersReadExecute = [bool]$payload.localUsersReadExecute
$inherit = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
$none = [Security.AccessControl.PropagationFlags]::None
$allow = [Security.AccessControl.AccessControlType]::Allow
function New-DirectorySecurity {
  $security = [Security.AccessControl.DirectorySecurity]::new()
  $security.SetAccessRuleProtection($true, $false)
  $security.SetOwner($hostSid)
  [void]$security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($hostSid, [Security.AccessControl.FileSystemRights]::FullControl, $inherit, $none, $allow))
  [void]$security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($systemSid, [Security.AccessControl.FileSystemRights]::FullControl, $inherit, $none, $allow))
  [void]$security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($usersSid, [Security.AccessControl.FileSystemRights]::ReadAndExecute, $inherit, $none, $allow))
  return $security
}
function New-FileSecurity {
  $security = [Security.AccessControl.FileSecurity]::new()
  $security.SetAccessRuleProtection($true, $false)
  $security.SetOwner($hostSid)
  [void]$security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($hostSid, [Security.AccessControl.FileSystemRights]::FullControl, $allow))
  [void]$security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($systemSid, [Security.AccessControl.FileSystemRights]::FullControl, $allow))
  if ($localUsersReadExecute) { [void]$security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($usersSid, [Security.AccessControl.FileSystemRights]::ReadAndExecute, $allow)) }
  elseif ($null -ne $sandboxSid) { [void]$security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sandboxSid, [Security.AccessControl.FileSystemRights]::ReadAndExecute, $allow)) }
  return $security
}
function Assert-NoReparse([string]$candidate) {
  $item = Get-Item -LiteralPath $candidate -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "reparse artifact path: $candidate" }
}
function Assert-AclShape($acl, [bool]$directory, [string]$candidate) {
  if (-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $hostSid.Value) { throw 'artifact ACL is not protected and host-owned' }
  $expected = @{}
  $expected[$hostSid.Value] = [int][Security.AccessControl.FileSystemRights]::FullControl
  $expected[$systemSid.Value] = [int][Security.AccessControl.FileSystemRights]::FullControl
  $readExecuteMask = [int]([Security.AccessControl.FileSystemRights]::ReadAndExecute -bor [Security.AccessControl.FileSystemRights]::Synchronize)
  if ($directory) { $expected[$usersSid.Value] = $readExecuteMask }
  if (-not $directory -and $localUsersReadExecute) { $expected[$usersSid.Value] = $readExecuteMask }
  elseif (-not $directory -and $null -ne $sandboxSid) { $expected[$sandboxSid.Value] = $readExecuteMask }
  $observed = @{}
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.IsInherited) { throw 'artifact ACL contains an inherited rule' }
    # Existing DENY ACEs can be legacy KodaX state or administrator policy.
    # Shape alone cannot prove ownership, so never remove or rewrite them. A
    # DENY cannot widen access, and is safe to retain while the exact ALLOW
    # surface below remains closed and fully verified.
    if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Deny) { continue }
    $sid = $rule.IdentityReference.Value
    if (-not $expected.ContainsKey($sid) -or $observed.ContainsKey($sid)) { throw "artifact ACL contains an unexpected allow rule for $sid at $candidate" }
    if ([int]$rule.FileSystemRights -ne $expected[$sid]) { throw "artifact ACL allow mask is invalid for $sid at $candidate" }
    if ($directory) {
      if ($rule.InheritanceFlags -ne $inherit -or $rule.PropagationFlags -ne $none) { throw 'artifact directory ACL inheritance is invalid' }
    } elseif ($rule.InheritanceFlags -ne [Security.AccessControl.InheritanceFlags]::None) {
      throw 'artifact file ACL inheritance is invalid'
    }
    $observed[$sid] = $true
  }
  foreach ($sid in $expected.Keys) { if (-not $observed.ContainsKey($sid)) { throw 'artifact ACL is missing a required allow rule' } }
}
function Ensure-ProtectedDirectory([string]$candidate) {
  if (Test-Path -LiteralPath $candidate) {
    Assert-NoReparse $candidate
    Assert-AclShape ([IO.Directory]::GetAccessControl($candidate)) $true $candidate
    return
  }
  [void][IO.Directory]::CreateDirectory($candidate, (New-DirectorySecurity))
  Assert-NoReparse $candidate
  Assert-AclShape ([IO.Directory]::GetAccessControl($candidate)) $true $candidate
}
$cacheRoot = [IO.Path]::GetFullPath([string]$payload.cacheRoot)
$anchor = [IO.Path]::GetFullPath([string]$payload.anchor)
$destinationDirectory = [IO.Path]::GetFullPath([string]$payload.destinationDirectory)
if (-not $cacheRoot.StartsWith($anchor + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'cache root escaped host LocalAppData' }
if (-not $destinationDirectory.StartsWith($cacheRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'destination escaped cache root' }
Assert-NoReparse $anchor
$current = $anchor
$relative = $destinationDirectory.Substring($anchor.Length).TrimStart([IO.Path]::DirectorySeparatorChar)
foreach ($part in ($relative -split '[\\/]')) {
  if ([string]::IsNullOrEmpty($part)) { continue }
  $current = [IO.Path]::Combine($current, $part)
  Ensure-ProtectedDirectory $current
}
$bytes = [Convert]::FromBase64String([string]$payload.bytes)
$hash = [Security.Cryptography.SHA256]::Create()
try { $actual = ([BitConverter]::ToString($hash.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() } finally { $hash.Dispose() }
if ($actual -ne ([string]$payload.sha256).ToLowerInvariant()) { throw 'provisioning payload hash mismatch' }
$destination = [IO.Path]::Combine($destinationDirectory, [string]$payload.file)
# Keep the CreateNew staging name short. PowerShell 5.1 FileStream still hits
# MAX_PATH on otherwise valid LocalAppData roots before long-path policy is
# enabled, while GetRandomFileName retains cross-process collision resistance.
$temporary = [IO.Path]::Combine($destinationDirectory, '.' + [IO.Path]::GetRandomFileName() + '.tmp')
try {
  if (-not (Test-Path -LiteralPath $destination)) {
    $stream = [IO.FileStream]::new($temporary, [IO.FileMode]::CreateNew, [Security.AccessControl.FileSystemRights]::FullControl, [IO.FileShare]::None, 65536, [IO.FileOptions]::WriteThrough, (New-FileSecurity))
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    try { [IO.File]::Move($temporary, $destination) } catch { if (-not (Test-Path -LiteralPath $destination)) { throw } }
  }
  Assert-NoReparse $destination
  Assert-AclShape ([IO.File]::GetAccessControl($destination)) $false $destination
  # A sibling Runtime may already be executing this content-addressed image.
  # Verification must share an immutable published file for read/delete or
  # artifact provisioning itself becomes a cross-Runtime admission lock.
  $share = [IO.FileShare]::Read -bor [IO.FileShare]::Delete
  $stream = [IO.FileStream]::new($destination, [IO.FileMode]::Open, [IO.FileAccess]::Read, $share)
  try {
    $publishedHasher = [Security.Cryptography.SHA256]::Create()
    try { $publishedHash = ([BitConverter]::ToString($publishedHasher.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() } finally { $publishedHasher.Dispose() }
  } finally { $stream.Dispose() }
  if ($publishedHash -ne $actual) { throw 'published artifact hash mismatch' }
  [Console]::Out.Write($destination)
} finally {
  if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
}
`;

const ENSURE_PROTECTED_CONTROL_DIRECTORY = String.raw`
$ErrorActionPreference = 'Stop'
$payload = ([Console]::In.ReadToEnd() | ConvertFrom-Json)
$hostSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$inherit = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
$none = [Security.AccessControl.PropagationFlags]::None
$allow = [Security.AccessControl.AccessControlType]::Allow
function Assert-NoReparse([string]$candidate) {
  $item = Get-Item -LiteralPath $candidate -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "reparse control path: $candidate" }
}
function New-ControlSecurity {
  $security = [Security.AccessControl.DirectorySecurity]::new()
  $security.SetAccessRuleProtection($true, $false)
  $security.SetOwner($hostSid)
  [void]$security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($hostSid, [Security.AccessControl.FileSystemRights]::FullControl, $inherit, $none, $allow))
  [void]$security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($systemSid, [Security.AccessControl.FileSystemRights]::FullControl, $inherit, $none, $allow))
  return $security
}
function Assert-ControlSecurity([string]$candidate) {
  $acl = [IO.Directory]::GetAccessControl($candidate)
  if (-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $hostSid.Value) {
    throw 'control directory ACL is not protected and host-owned'
  }
  $expected = @{}
  $expected[$hostSid.Value] = $true
  $expected[$systemSid.Value] = $true
  $observed = @{}
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.IsInherited -or $rule.AccessControlType -ne $allow) { throw 'control directory ACL contains an unexpected rule' }
    $sid = $rule.IdentityReference.Value
    if (-not $expected.ContainsKey($sid) -or $observed.ContainsKey($sid)) { throw 'control directory ACL contains an unexpected principal' }
    if ($rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or $rule.InheritanceFlags -ne $inherit -or $rule.PropagationFlags -ne $none) {
      throw 'control directory ACL rule shape is invalid'
    }
    $observed[$sid] = $true
  }
  foreach ($sid in $expected.Keys) { if (-not $observed.ContainsKey($sid)) { throw 'control directory ACL is missing a required principal' } }
}
function Test-ControlOwnerProcessAlive([uint32]$processId) {
  if ($processId -gt [int]::MaxValue) { return $false }
  try {
    return $null -ne [Diagnostics.Process]::GetProcessById([int]$processId)
  } catch [ArgumentException] {
    return $false
  } catch {
    return $true
  }
}
function Remove-ProvenStaleControlEntries([string]$candidate) {
  $now = [DateTimeOffset]::UtcNow
  foreach ($entry in [IO.Directory]::EnumerateFiles($candidate)) {
    $item = Get-Item -LiteralPath $entry -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.Length -gt 1048576) { continue }
    $match = [regex]::Match($item.Name, '^windows-(shell|network|terminal)-([0-9]+)-[0-9a-fA-F-]{36}\.json$')
    if (-not $match.Success) { continue }
    $ownerPid = 0L
    if (-not [long]::TryParse($match.Groups[2].Value, [ref]$ownerPid) -or $ownerPid -le 0 -or $ownerPid -gt [uint32]::MaxValue) { continue }
    if (Test-ControlOwnerProcessAlive ([uint32]$ownerPid)) { continue }
    $kind = $match.Groups[1].Value
    $retire = $false
    if ($kind -eq 'network') {
      # A network request is deleted as soon as its broker reads it. A dead
      # creator plus two launch budgets proves this file was never admitted.
      $retire = $item.LastWriteTimeUtc -lt $now.UtcDateTime.AddMinutes(-1)
    } else {
      try { $record = ([IO.File]::ReadAllText($entry) | ConvertFrom-Json) } catch { continue }
      if ($kind -eq 'shell') {
        $deadline = 0L
        $retire = [long]::TryParse([string]$record.operationDeadlineUnixMs, [ref]$deadline) -and $deadline -lt $now.ToUnixTimeMilliseconds()
      } else {
        # A terminal record is disposable only after native Job drainage was
        # durably observed. Unknown or partial records remain fail-closed.
        $retire = $record.jobDrained -eq $true
      }
    }
    if ($retire) { [IO.File]::Delete($entry) }
  }
}
$cacheRoot = [IO.Path]::GetFullPath([string]$payload.cacheRoot)
$controlRoot = [IO.Path]::GetFullPath([string]$payload.controlRoot)
$action = [string]$payload.action
if ([IO.Path]::GetDirectoryName($controlRoot) -ne $cacheRoot) { throw 'control directory escaped native cache root' }
if (-not (Test-Path -LiteralPath $cacheRoot -PathType Container)) { throw 'protected native cache root is unavailable' }
Assert-NoReparse $cacheRoot
if ($action -eq 'verify') {
  if (-not (Test-Path -LiteralPath $controlRoot -PathType Container)) { throw 'protected native shell control state is not initialized; run kodax sandbox setup' }
  Assert-NoReparse $controlRoot
} elseif ($action -eq 'ensure') {
  if (Test-Path -LiteralPath $controlRoot) {
    Assert-NoReparse $controlRoot
  } else {
    [void][IO.Directory]::CreateDirectory($controlRoot, (New-ControlSecurity))
    Assert-NoReparse $controlRoot
  }
} elseif ($action -eq 'repair') {
  if (Test-Path -LiteralPath $controlRoot) {
    Assert-NoReparse $controlRoot
    $existing = [IO.Directory]::GetAccessControl($controlRoot)
    if ($existing.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $hostSid.Value) { throw 'refusing to repair native shell control state not owned by the host' }
    Remove-ProvenStaleControlEntries $controlRoot
    $entries = [IO.Directory]::EnumerateFileSystemEntries($controlRoot).GetEnumerator()
    try { $notEmpty = $entries.MoveNext() } finally { $entries.Dispose() }
    if ($notEmpty) { throw 'refusing to repair non-empty native shell control state; close KodaX and remove the directory manually' }
    [IO.Directory]::SetAccessControl($controlRoot, (New-ControlSecurity))
  } else {
    [void][IO.Directory]::CreateDirectory($controlRoot, (New-ControlSecurity))
  }
  Assert-NoReparse $controlRoot
} else {
  throw 'invalid native shell control state action'
}
Assert-ControlSecurity $controlRoot
[Console]::Out.Write($controlRoot)
`;

function runWindowsSandboxControlDirectoryAction(
  action: 'verify' | 'ensure' | 'repair',
): string {
  if (process.platform !== 'win32') {
    throw new Error('KodaX Windows native shell control state is unavailable on this platform.');
  }
  const cacheRoot = windowsNativeArtifactCacheRoot();
  const controlRoot = windowsSandboxControlDirectory();
  const powershell = path.join(
    process.env.SystemRoot ?? String.raw`C:\Windows`,
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
  );
  const result = spawnSync(powershell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(ENSURE_PROTECTED_CONTROL_DIRECTORY, 'utf16le').toString('base64'),
  ], {
    input: JSON.stringify({ action, cacheRoot, controlRoot }),
    encoding: 'utf8',
    env: process.env,
    shell: false,
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error !== undefined || result.status !== 0) {
    const reason = result.error?.message ?? (result.stderr.trim() || `exit ${String(result.status)}`);
    throw new Error(`Cannot ${action} protected KodaX native shell control state: ${reason}`);
  }
  if (result.stdout.trim().toLowerCase() !== controlRoot.toLowerCase()) {
    throw new Error('Native shell control verifier returned an unexpected path.');
  }
  const canonicalCache = fs.realpathSync.native(cacheRoot);
  const canonicalControl = fs.realpathSync.native(controlRoot);
  if (!sameOrInside(canonicalCache, canonicalControl)) {
    throw new Error('Native shell control state escaped its physical cache root.');
  }
  return canonicalControl;
}

export function verifyWindowsSandboxControlDirectory(): string {
  return runWindowsSandboxControlDirectoryAction('verify');
}

export function ensureWindowsSandboxControlDirectory(): string {
  return runWindowsSandboxControlDirectoryAction('ensure');
}

export function repairWindowsSandboxControlDirectory(): string {
  return runWindowsSandboxControlDirectoryAction('repair');
}

function provisionProtectedArtifact(input: {
  readonly kind: WindowsProtectedArtifactKind;
  readonly entry: Pick<WindowsNativeArtifactEntry, 'file' | 'sha256'>;
  readonly bytes: Buffer;
  readonly sandboxReadSid?: string;
  readonly localUsersReadExecute?: boolean;
}): string {
  if (input.sandboxReadSid !== undefined && !/^S-\d+(?:-\d+)+$/i.test(input.sandboxReadSid)) {
    throw new Error('Native artifact sandbox-read SID is invalid.');
  }
  const cacheRoot = windowsNativeArtifactCacheRoot();
  const anchor = path.dirname(cacheRoot);
  const destinationDirectory = protectedArtifactDirectory(
    input.kind,
    input.entry.sha256,
    input.sandboxReadSid,
    input.localUsersReadExecute === true,
  );
  const powershell = path.join(
    process.env.SystemRoot ?? String.raw`C:\Windows`,
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
  );
  const result = spawnSync(powershell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(PROVISION_PROTECTED_ARTIFACT, 'utf16le').toString('base64'),
  ], {
    input: JSON.stringify({
      cacheRoot,
      anchor,
      destinationDirectory,
      file: input.entry.file,
      sha256: input.entry.sha256,
      bytes: input.bytes.toString('base64'),
      sandboxReadSid: input.sandboxReadSid ?? '',
      localUsersReadExecute: input.localUsersReadExecute === true,
    }),
    encoding: 'utf8',
    env: process.env,
    shell: false,
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error !== undefined || result.status !== 0) {
    const reason = result.error?.message ?? (result.stderr.trim() || `exit ${String(result.status)}`);
    throw new Error(`Cannot provision protected KodaX native artifact: ${reason}`);
  }
  const destination = result.stdout.trim();
  const expected = path.join(destinationDirectory, input.entry.file);
  if (destination.toLowerCase() !== expected.toLowerCase()) {
    throw new Error('Native artifact provisioner returned an unexpected path.');
  }
  readVerifiedArtifact(destination, input.entry.sha256);
  const canonicalRoot = fs.realpathSync.native(cacheRoot);
  const canonicalDestination = fs.realpathSync.native(destination);
  if (!sameOrInside(canonicalRoot, canonicalDestination)) {
    throw new Error('Protected native artifact escaped its physical cache root.');
  }
  return canonicalDestination;
}

export function provisionWindowsAsrtRunner(
  bytes: Buffer,
  expectedSha256: string,
): { readonly path: string; readonly sha256: string } {
  if (process.platform !== 'win32') {
    throw new Error('The protected ASRT Windows runner is unavailable on this platform.');
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_NATIVE_ARTIFACT_BYTES) {
    throw new Error('The ASRT Windows runner has an invalid size.');
  }
  if (!/^[0-9a-f]{64}$/i.test(expectedSha256)) {
    throw new Error('The ASRT Windows runner trusted digest is invalid.');
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== expectedSha256.toLowerCase()) {
    throw new Error('The ASRT Windows runner does not match its trusted release digest.');
  }
  const protectedPath = provisionProtectedArtifact({
    kind: 'asrtRunner',
    entry: { file: 'srt-win.exe', sha256 },
    bytes,
    localUsersReadExecute: true,
  });
  return { path: protectedPath, sha256 };
}

export function resolveWindowsAsrtRunnerArtifact(
  moduleUrl: string,
  sourcePath: string,
  expectedVersion: string,
  options: { readonly untrustedWriteRoots?: readonly string[] } = {},
): ResolvedWindowsAsrtRunnerArtifact {
  if (process.platform !== 'win32') {
    throw new Error('The protected ASRT Windows runner is unavailable on this platform.');
  }
  assertWindowsNativeArtifactStoreNotDirectlyWritable(options.untrustedWriteRoots ?? []);
  const trustedManifestText = embeddedNativeManifestText();
  const resolvedSourcePath = trustedManifestText === undefined
    ? path.resolve(sourcePath)
    : physicalElectronArtifactPath(sourcePath);
  const sourceDirectory = path.dirname(resolvedSourcePath);
  const candidates = trustedManifestText === undefined
    ? artifactDirectories(moduleUrl).map((directory) => ({
        manifestPath: path.join(directory, 'manifest.json'),
        manifestText: undefined as string | undefined,
        developmentTrustRoots: [directory, sourceDirectory] as readonly string[],
      }))
    : [{
        manifestPath: '<embedded native manifest>',
        manifestText: trustedManifestText,
        developmentTrustRoots: [] as readonly string[],
      }];
  const diagnostics: string[] = [];
  for (const candidate of candidates) {
    try {
      for (const trustRoot of candidate.developmentTrustRoots) {
        assertDevelopmentSourceIsOutsideWriteRoots(
          trustRoot,
          options.untrustedWriteRoots ?? [],
        );
      }
      const embeddedManifest = candidate.manifestText !== undefined;
      const manifest = parseManifestText(candidate.manifestText
        ?? readBoundedOrdinaryFile(candidate.manifestPath, true).toString('utf8'));
      if (manifest.asrtRunner.version !== expectedVersion) {
        throw new Error(
          `asrtRunner version ${manifest.asrtRunner.version} does not match ${expectedVersion}`,
        );
      }
      // Package stores may hard-link production source bytes. Only an embedded
      // digest is an immutable trust root; development manifests and sources
      // remain single-link so writable aliases cannot redefine both together.
      const bytes = readHashPinnedArtifact(
        resolvedSourcePath,
        manifest.asrtRunner.sha256,
        !embeddedManifest,
      );
      const protectedRunner = provisionWindowsAsrtRunner(bytes, manifest.asrtRunner.sha256);
      return {
        ...protectedRunner,
        developmentTrustRoots: candidate.developmentTrustRoots,
      };
    } catch (error: unknown) {
      diagnostics.push(
        `${candidate.manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  throw new Error(
    `A trusted ASRT Windows runner is unavailable. ${diagnostics.join(' | ')}`,
  );
}

export function assertWindowsAsrtRunnerTrustOutsideWriteRoots(
  developmentTrustRoots: readonly string[],
  untrustedWriteRoots: readonly string[],
): void {
  for (const trustRoot of developmentTrustRoots) {
    assertDevelopmentSourceIsOutsideWriteRoots(trustRoot, untrustedWriteRoots);
  }
}

export function resolveWindowsNativeArtifact(
  moduleUrl: string,
  kind: WindowsNativeArtifactKind,
  expectedProtocol: number,
  options: ResolveWindowsNativeArtifactOptions = {},
): ResolvedWindowsNativeArtifact {
  if (process.platform !== 'win32') {
    throw new Error('KodaX Windows native artifacts are unavailable on this platform.');
  }
  assertWindowsNativeArtifactStoreNotDirectlyWritable(options.untrustedWriteRoots ?? []);
  const trustedManifestText = embeddedNativeManifestText();
  const diagnostics: string[] = [];
  for (const directory of artifactDirectories(moduleUrl, trustedManifestText !== undefined)) {
    const manifestPath = path.join(directory, 'manifest.json');
    try {
      assertDevelopmentSourceIsOutsideWriteRoots(directory, options.untrustedWriteRoots ?? []);
      const { manifest, entry } = parseManifestEntryText(
        trustedManifestText ?? fs.readFileSync(manifestPath, 'utf8'),
        kind,
      );
      if (entry.protocol !== expectedProtocol) {
        throw new Error(`${kind} protocol ${entry.protocol} does not match ${expectedProtocol}`);
      }
      const artifactPath = path.join(directory, entry.file);
      const bytes = readVerifiedArtifact(artifactPath, entry.sha256);
      const protectedPath = provisionProtectedArtifact({
        kind,
        entry,
        bytes,
        ...(options.sandboxReadSid === undefined ? {} : { sandboxReadSid: options.sandboxReadSid }),
      });
      return { path: protectedPath, entry, manifest };
    } catch (error: unknown) {
      diagnostics.push(`${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(
    `A compatible KodaX ${kind} native artifact is unavailable. ${diagnostics.join(' | ')}`,
  );
}

export const _internalWindowsNativeArtifacts = {
  assertDevelopmentSourceIsOutsideWriteRoots,
  artifactDirectories,
  physicalElectronArtifactPath,
  parseManifestEntryText,
  assertManifestAsrtRunner,
  parseManifestText,
  protectedArtifactDirectory,
  sameOrInside,
};
