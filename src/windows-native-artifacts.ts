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
}

export interface WindowsNativeArtifactEntry {
  readonly file: string;
  readonly protocol: number;
  readonly sha256: string;
}

export type WindowsNativeArtifactKind = 'textTransaction' | 'shellSandbox';

export interface ResolvedWindowsNativeArtifact {
  readonly path: string;
  readonly entry: WindowsNativeArtifactEntry;
  readonly manifest: WindowsNativeArtifactManifest;
}

export interface ResolveWindowsNativeArtifactOptions {
  readonly sandboxReadSid?: string;
  readonly untrustedWriteRoots?: readonly string[];
}

interface PortableTextArtifactManifest {
  readonly version: 1;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly textTransaction: WindowsNativeArtifactEntry;
}

const MAX_NATIVE_ARTIFACT_BYTES = 64 * 1024 * 1024;
const WINDOWS_NATIVE_CACHE_VERSION = 'v1';

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

function artifactDirectories(moduleUrl: string): readonly string[] {
  const moduleDirectory = path.dirname(fileURLToPath(moduleUrl));
  const nativeDirectory = `win32-${process.arch}`;
  return [...new Set([
    path.join(moduleDirectory, 'native', nativeDirectory),
    path.join(moduleDirectory, '..', 'native', nativeDirectory),
    path.join(moduleDirectory, '..', 'dist', 'native', nativeDirectory),
    path.join(path.dirname(process.execPath), 'vendor', 'kodax-native', nativeDirectory),
  ].map((candidate) => path.resolve(candidate)))];
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

function parseManifestText(text: string): WindowsNativeArtifactManifest {
  const manifest = manifestObject(text);
  assertManifestHeader(manifest);
  for (const kind of ['textTransaction', 'shellSandbox'] as const) {
    assertManifestEntry(manifest, kind);
  }
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
  if (roots.some((root) => sameOrInside(root, directory) || sameOrInside(directory, root))) {
    throw new Error(
      `native artifact source overlaps a writable Runtime root: ${directory}. `
      + 'Use a production bundle with an embedded native manifest.',
    );
  }
}

function readVerifiedArtifact(file: string, expected: string): Buffer {
  const stat = fs.lstatSync(file);
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.nlink !== 1
    || stat.size > MAX_NATIVE_ARTIFACT_BYTES
  ) {
    throw new Error(`native artifact is not a bounded ordinary file: ${file}`);
  }
  const bytes = fs.readFileSync(file);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected.toLowerCase()) {
    throw new Error(`native artifact hash mismatch: ${file}`);
  }
  return bytes;
}

export function windowsNativeArtifactCacheRoot(): string {
  const localAppData = process.env.LOCALAPPDATA
    ?? path.join(os.homedir(), 'AppData', 'Local');
  return path.join(path.resolve(localAppData), 'KodaXNativeArtifactsV3');
}

export function assertWindowsNativeArtifactStoreNotDirectlyWritable(
  roots: readonly string[],
): void {
  const cacheRoot = windowsNativeArtifactCacheRoot();
  const conflict = roots.find((root) => (
    sameOrInside(cacheRoot, root) || sameOrInside(root, cacheRoot)
  ));
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
  const protectedRoots = process.platform === 'win32'
    ? trustedTextNativeArtifactStateRoots()
    : [ensureUnixTrustedTextStateRoot(), ensureUnixTrustedTextCoordinationRoot()];
  const candidateRoots = process.platform === 'win32'
    ? roots
    : roots.map(canonicalExistingPath);
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

function portableTextArtifactDirectories(moduleUrl: string): readonly string[] {
  const moduleDirectory = path.dirname(fileURLToPath(moduleUrl));
  const nativeDirectory = `${process.platform}-${process.arch}`;
  return [...new Set([
    path.join(moduleDirectory, 'native', nativeDirectory),
    path.join(moduleDirectory, '..', 'native', nativeDirectory),
    path.join(moduleDirectory, '..', 'dist', 'native', nativeDirectory),
    path.join(path.dirname(process.execPath), 'vendor', 'kodax-native', nativeDirectory),
  ].map((candidate) => path.resolve(candidate)))];
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
  for (const directory of portableTextArtifactDirectories(moduleUrl)) {
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
  kind: WindowsNativeArtifactKind,
  sha256: string,
  sandboxReadSid: string | undefined,
): string {
  const accessKey = sandboxReadSid === undefined
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
  if ($null -ne $sandboxSid) { [void]$security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sandboxSid, [Security.AccessControl.FileSystemRights]::ReadAndExecute, $allow)) }
  return $security
}
function Assert-NoReparse([string]$candidate) {
  $item = Get-Item -LiteralPath $candidate -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "reparse artifact path: $candidate" }
}
function Assert-AclShape($acl, [bool]$directory) {
  if (-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $hostSid.Value) { throw 'artifact ACL is not protected and host-owned' }
  $expected = @{}
  $expected[$hostSid.Value] = [int][Security.AccessControl.FileSystemRights]::FullControl
  $expected[$systemSid.Value] = [int][Security.AccessControl.FileSystemRights]::FullControl
  $readExecuteMask = [int]([Security.AccessControl.FileSystemRights]::ReadAndExecute -bor [Security.AccessControl.FileSystemRights]::Synchronize)
  if ($directory) { $expected[$usersSid.Value] = $readExecuteMask }
  if (-not $directory -and $null -ne $sandboxSid) { $expected[$sandboxSid.Value] = $readExecuteMask }
  $observed = @{}
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.IsInherited) { throw 'artifact ACL contains an inherited rule' }
    # Native v2 appends execution-specific DENY ACEs to deny-write roots. A
    # DENY cannot widen access, so it is safe to retain while the exact ALLOW
    # surface below remains closed and fully verified.
    if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Deny) { continue }
    $sid = $rule.IdentityReference.Value
    if (-not $expected.ContainsKey($sid) -or $observed.ContainsKey($sid)) { throw 'artifact ACL contains an unexpected allow rule' }
    if ([int]$rule.FileSystemRights -ne $expected[$sid]) { throw 'artifact ACL allow mask is invalid' }
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
    Assert-AclShape ([IO.Directory]::GetAccessControl($candidate)) $true
    return
  }
  [void][IO.Directory]::CreateDirectory($candidate, (New-DirectorySecurity))
  Assert-NoReparse $candidate
  Assert-AclShape ([IO.Directory]::GetAccessControl($candidate)) $true
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
$temporary = [IO.Path]::Combine($destinationDirectory, '.' + [Guid]::NewGuid().ToString('N') + '.tmp')
try {
  if (-not (Test-Path -LiteralPath $destination)) {
    $stream = [IO.FileStream]::new($temporary, [IO.FileMode]::CreateNew, [Security.AccessControl.FileSystemRights]::FullControl, [IO.FileShare]::None, 65536, [IO.FileOptions]::WriteThrough, (New-FileSecurity))
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    try { [IO.File]::Move($temporary, $destination) } catch { if (-not (Test-Path -LiteralPath $destination)) { throw } }
  }
  Assert-NoReparse $destination
  Assert-AclShape ([IO.File]::GetAccessControl($destination)) $false
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

function provisionProtectedArtifact(input: {
  readonly kind: WindowsNativeArtifactKind;
  readonly entry: WindowsNativeArtifactEntry;
  readonly bytes: Buffer;
  readonly sandboxReadSid?: string;
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
  for (const directory of artifactDirectories(moduleUrl)) {
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
  parseManifestEntryText,
  parseManifestText,
  protectedArtifactDirectory,
  sameOrInside,
};
