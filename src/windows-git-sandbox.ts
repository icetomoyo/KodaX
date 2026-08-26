import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';

interface GitConfigEnvPair {
  key: string;
  value: string;
}

interface ParsedGitConfigEnvironment {
  readonly argumentIndices: readonly number[];
  readonly pairs: readonly (GitConfigEnvPair & { readonly slot: number })[];
  readonly sawAny: boolean;
}

type GitConfigEnvKind = 'count' | 'key' | 'value';

function isMissingGitTrustPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function normalizeGitSafeDirectoryRootImplementation(
  root: string,
  resolveRealPath: typeof realpathSync,
  isMissing: (error: unknown) => boolean,
): string | undefined {
  try {
    const stripped = resolveRealPath(root).replaceAll('\\', '/').replace(/\/+$/, '');
    if (stripped === '') return undefined;
    return /^[A-Za-z]:$/.test(stripped) ? `${stripped}/` : stripped;
  } catch (error: unknown) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function normalizeGitSafeDirectoryRoot(root: string): string | undefined {
  return normalizeGitSafeDirectoryRootImplementation(root, realpathSync, isMissingGitTrustPath);
}

function isRepoBearingGitReadRootImplementation(
  root: string,
  readStat: typeof statSync,
  pathApi: Pick<typeof path, 'basename' | 'join'>,
  isMissing: (error: unknown) => boolean,
): boolean {
  try {
    const workspaceGit = readStat(pathApi.join(root, '.git'));
    if (workspaceGit.isDirectory() || workspaceGit.isFile()) return true;
  } catch (error: unknown) {
    if (!isMissing(error)) throw error;
  }
  const metadataRoot = pathApi.basename(root).toLowerCase() === '.git'
    || /[/\\]\.git[/\\]modules[/\\]/i.test(root);
  if (!metadataRoot) return false;
  try {
    return readStat(pathApi.join(root, 'HEAD')).isFile();
  } catch (error: unknown) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function isRepoBearingGitReadRoot(root: string): boolean {
  return isRepoBearingGitReadRootImplementation(root, statSync, path, isMissingGitTrustPath);
}

function windowsGitTrustRootsImplementation(
  cwd: string | undefined,
  allowWrite: readonly string[] | undefined,
  allowRead: readonly string[] | undefined,
  normalizeRoot: (root: string) => string | undefined,
  isRepoRoot: (root: string) => boolean,
): string[] {
  const candidates: string[] = [];
  if (typeof cwd === 'string' && cwd !== '') candidates.push(cwd);
  for (const root of allowRead ?? []) {
    if (isRepoRoot(root)) candidates.push(root);
  }
  candidates.push(...(allowWrite ?? []));
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (roots.length >= 8) break;
    const normalized = normalizeRoot(candidate);
    if (normalized === undefined) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(normalized);
  }
  return roots;
}

/** Exact, bounded Windows git trust derived only from authorized repository roots. */
export function windowsGitTrustRoots(
  cwd: string | undefined,
  allowWrite: readonly string[] | undefined,
  allowRead: readonly string[] | undefined,
): string[] {
  return windowsGitTrustRootsImplementation(
    cwd,
    allowWrite,
    allowRead,
    normalizeGitSafeDirectoryRoot,
    isRepoBearingGitReadRoot,
  );
}

function gitConfigEnvKind(name: string): GitConfigEnvKind | undefined {
  if (name === 'git_config_count') return 'count';
  if (/^git_config_key_\d+$/.test(name)) return 'key';
  if (/^git_config_value_\d+$/.test(name)) return 'value';
  return undefined;
}

function parseGitConfigEnvironmentImplementation(
  argv: readonly string[],
  separator: number,
  kindOf: (name: string) => GitConfigEnvKind | undefined,
  rejectShape: () => never,
  finishParsed: typeof finishParsedGitConfigEnvironment,
): ParsedGitConfigEnvironment {
  const slots = new Map<number, Partial<GitConfigEnvPair>>();
  const argumentIndices: number[] = [];
  let declaredCount: number | undefined;
  let sawAny = false;
  for (let index = 0; index < separator; index += 1) {
    if (argv[index] !== '--env' || index + 1 >= separator) continue;
    const assignment = argv[index + 1]!;
    const nameEnd = assignment.indexOf('=');
    const name = (nameEnd < 0 ? assignment : assignment.slice(0, nameEnd)).toLowerCase();
    const kind = kindOf(name);
    if (kind === undefined) continue;
    sawAny = true;
    argumentIndices.push(index);
    const raw = nameEnd < 0 ? '' : assignment.slice(nameEnd + 1);
    if (kind === 'count') {
      const parsed = Number.parseInt(raw, 10);
      if (declaredCount !== undefined || !Number.isSafeInteger(parsed)
        || parsed < 0 || String(parsed) !== raw) rejectShape();
      declaredCount = parsed;
      continue;
    }
    const slot = Number.parseInt(name.slice(`git_config_${kind}_`.length), 10);
    const pair = slots.get(slot) ?? {};
    if (!Number.isSafeInteger(slot) || slot < 0 || pair[kind] !== undefined) {
      rejectShape();
    }
    pair[kind] = raw;
    slots.set(slot, pair);
  }
  return finishParsed(slots, argumentIndices, declaredCount, sawAny, rejectShape);
}

function throwUnexpectedGitConfigShape(): never {
  throw new Error('ASRT GIT_CONFIG environment has an unexpected shape.');
}

function finishParsedGitConfigEnvironment(
  slots: ReadonlyMap<number, Partial<GitConfigEnvPair>>,
  argumentIndices: readonly number[],
  declaredCount: number | undefined,
  sawAny: boolean,
  rejectShape: () => never,
): ParsedGitConfigEnvironment {
  const complete = !sawAny || (
    declaredCount !== undefined
    && slots.size === declaredCount
    && [...slots].every(([slot, pair]) => (
      slot < declaredCount && pair.key !== undefined && pair.value !== undefined
    ))
  );
  if (!complete) rejectShape();
  const pairs = [...slots].map(([slot, pair]) => ({
    slot,
    key: pair.key!,
    value: pair.value!,
  }));
  return { argumentIndices, pairs, sawAny };
}

function parseGitConfigEnvironment(
  argv: readonly string[],
  separator: number,
): ParsedGitConfigEnvironment {
  return parseGitConfigEnvironmentImplementation(
    argv,
    separator,
    gitConfigEnvKind,
    throwUnexpectedGitConfigShape,
    finishParsedGitConfigEnvironment,
  );
}

function gitSafeDirectoryAssignments(
  trustRoots: readonly string[],
  preserved: readonly GitConfigEnvPair[],
): string[] {
  const pairs: GitConfigEnvPair[] = [];
  for (const root of trustRoots) {
    pairs.push(
      { key: 'safe.directory', value: root },
      { key: 'safe.directory', value: `${root}/*` },
    );
  }
  pairs.push(...preserved);
  const assignments = pairs.flatMap((pair, index) => [
    `GIT_CONFIG_KEY_${index}=${pair.key}`,
    `GIT_CONFIG_VALUE_${index}=${pair.value}`,
  ]);
  assignments.push(`GIT_CONFIG_COUNT=${pairs.length}`);
  return assignments;
}

function validatedEnvironmentEntries(
  environment: Readonly<NodeJS.ProcessEnv>,
  label: string,
): Array<readonly [string, string]> {
  const entries: Array<readonly [string, string]> = [];
  const names = new Set<string>();
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) continue;
    if (name === '' || name.includes('=') || name.includes('\0') || value.includes('\0')) {
      throw new Error(`Invalid ${label} environment entry.`);
    }
    const normalized = name.toUpperCase();
    if (names.has(normalized)) {
      throw new Error(`Ambiguous ${label} environment variable: ${name}.`);
    }
    names.add(normalized);
    entries.push([name, value]);
  }
  return entries;
}

function rewriteWindowsGitSafeDirectoryEnvironment(
  environment: Readonly<Record<string, string>>,
  trustRoots: readonly string[],
): Record<string, string> {
  const slots = new Map<number, Partial<GitConfigEnvPair>>();
  const preservedEnvironment: Array<readonly [string, string]> = [];
  let declaredCount: number | undefined;
  let sawAny = false;
  for (const [name, value] of Object.entries(environment)) {
    const normalized = name.toLowerCase();
    const kind = gitConfigEnvKind(normalized);
    if (kind === undefined) {
      preservedEnvironment.push([name, value]);
      continue;
    }
    sawAny = true;
    if (kind === 'count') {
      const parsed = Number.parseInt(value, 10);
      if (declaredCount !== undefined || !Number.isSafeInteger(parsed)
        || parsed < 0 || String(parsed) !== value) throwUnexpectedGitConfigShape();
      declaredCount = parsed;
      continue;
    }
    const slot = Number.parseInt(normalized.slice(`git_config_${kind}_`.length), 10);
    const pair = slots.get(slot) ?? {};
    if (!Number.isSafeInteger(slot) || slot < 0 || pair[kind] !== undefined) {
      throwUnexpectedGitConfigShape();
    }
    pair[kind] = value;
    slots.set(slot, pair);
  }
  const parsed = finishParsedGitConfigEnvironment(
    slots,
    [],
    declaredCount,
    sawAny,
    throwUnexpectedGitConfigShape,
  );
  const preservedGit = parsed.pairs
    .filter((pair) => pair.key.toLowerCase() !== 'safe.directory')
    .sort((left, right) => left.slot - right.slot);
  const result = Object.fromEntries(preservedEnvironment);
  for (const assignment of gitSafeDirectoryAssignments(trustRoots, preservedGit)) {
    const separator = assignment.indexOf('=');
    result[assignment.slice(0, separator)] = assignment.slice(separator + 1);
  }
  return result;
}

/**
 * Merge the complete target environment without constructing argv-like secret
 * material. ASRT-owned control variables win, except PATH/PATHEXT, which remain
 * caller-owned for ordinary shell compatibility.
 */
export function mergeWindowsSandboxTargetEnvironment(
  controlledEnvironment: Readonly<Record<string, string>>,
  requestedEnvironment: Readonly<NodeJS.ProcessEnv>,
  gitTrustRoots: readonly string[],
): Record<string, string> {
  const controlled = validatedEnvironmentEntries(controlledEnvironment, 'ASRT-controlled');
  const requested = validatedEnvironmentEntries(requestedEnvironment, 'Windows target');
  const merged = new Map<string, readonly [string, string]>();
  for (const entry of controlled) merged.set(entry[0].toUpperCase(), entry);
  for (const entry of requested) {
    const normalized = entry[0].toUpperCase();
    if (merged.has(normalized) && normalized !== 'PATH' && normalized !== 'PATHEXT') continue;
    merged.set(normalized, entry);
  }
  return rewriteWindowsGitSafeDirectoryEnvironment(
    Object.fromEntries(merged.values()),
    gitTrustRoots,
  );
}

function replaceGitConfigEnvironment(
  argv: readonly string[],
  separator: number,
  parsed: ParsedGitConfigEnvironment,
  assignments: readonly string[],
): string[] {
  const indices = new Set(parsed.argumentIndices);
  const result: string[] = [];
  let replaced = false;
  for (let position = 0; position < argv.length; position += 1) {
    if (indices.has(position)) {
      if (!replaced) {
        for (const assignment of assignments) result.push('--env', assignment);
        replaced = true;
      }
      position += 1;
    } else {
      result.push(argv[position]!);
    }
  }
  if (!parsed.sawAny) {
    result.splice(separator, 0, ...assignments.flatMap((assignment) => ['--env', assignment]));
  }
  return result;
}

function rewriteWindowsGitSafeDirectoryArgvImplementation(
  argv: readonly string[],
  trustRoots: readonly string[],
  parseEnvironment: typeof parseGitConfigEnvironment,
  createAssignments: typeof gitSafeDirectoryAssignments,
  replaceEnvironment: typeof replaceGitConfigEnvironment,
): string[] {
  const separator = argv.lastIndexOf('--');
  if (separator < 0) throw new Error('ASRT Windows wrapper omitted its child separator.');
  const parsed = parseEnvironment(argv, separator);
  const preserved = parsed.pairs
    .filter((pair) => pair.key.toLowerCase() !== 'safe.directory')
    .sort((left, right) => left.slot - right.slot);
  const assignments = createAssignments(trustRoots, preserved);
  return replaceEnvironment(argv, separator, parsed, assignments);
}

/** Replace every ASRT safe.directory entry; malformed input fails closed. */
export function rewriteWindowsGitSafeDirectoryArgv(
  argv: readonly string[],
  trustRoots: readonly string[],
): string[] {
  return rewriteWindowsGitSafeDirectoryArgvImplementation(
    argv,
    trustRoots,
    parseGitConfigEnvironment,
    gitSafeDirectoryAssignments,
    replaceGitConfigEnvironment,
  );
}

/** Source evaluated by the isolated broker; all injected functions are dependency-free. */
export function windowsGitBrokerHelpersSource(): string {
  return String.raw`
const isMissingGitTrustPath = ${isMissingGitTrustPath.toString()};
const normalizeGitSafeDirectoryRootImplementation = ${normalizeGitSafeDirectoryRootImplementation.toString()};
const normalizeGitSafeDirectoryRoot = (root) => (
  normalizeGitSafeDirectoryRootImplementation(root, realpathSync, isMissingGitTrustPath)
);
const isRepoBearingGitReadRootImplementation = ${isRepoBearingGitReadRootImplementation.toString()};
const isRepoBearingGitReadRoot = (root) => (
  isRepoBearingGitReadRootImplementation(root, statSync, path, isMissingGitTrustPath)
);
const windowsGitTrustRootsImplementation = ${windowsGitTrustRootsImplementation.toString()};
const windowsGitTrustRoots = (input) => {
  const filesystem = (input.config && input.config.filesystem) || {};
  return windowsGitTrustRootsImplementation(
    input.cwd,
    filesystem.allowWrite,
    filesystem.allowRead,
    normalizeGitSafeDirectoryRoot,
    isRepoBearingGitReadRoot,
  );
};
const gitConfigEnvKind = ${gitConfigEnvKind.toString()};
const throwUnexpectedGitConfigShape = ${throwUnexpectedGitConfigShape.toString()};
const finishParsedGitConfigEnvironment = ${finishParsedGitConfigEnvironment.toString()};
const parseGitConfigEnvironmentImplementation = ${parseGitConfigEnvironmentImplementation.toString()};
const parseGitConfigEnvironment = (argv, separator) => (
  parseGitConfigEnvironmentImplementation(
    argv,
    separator,
    gitConfigEnvKind,
    throwUnexpectedGitConfigShape,
    finishParsedGitConfigEnvironment,
  )
);
const gitSafeDirectoryAssignments = ${gitSafeDirectoryAssignments.toString()};
const replaceGitConfigEnvironment = ${replaceGitConfigEnvironment.toString()};
const rewriteWindowsGitSafeDirectoryArgvImplementation = ${rewriteWindowsGitSafeDirectoryArgvImplementation.toString()};
const rewriteWindowsGitSafeDirectoryArgv = (argv, trustRoots) => (
  rewriteWindowsGitSafeDirectoryArgvImplementation(
    argv,
    trustRoots,
    parseGitConfigEnvironment,
    gitSafeDirectoryAssignments,
    replaceGitConfigEnvironment,
  )
);
`;
}
