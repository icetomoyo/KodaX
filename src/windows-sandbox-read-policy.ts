import { lstatSync, readFileSync, readdirSync, realpathSync, type Dirent } from 'node:fs';
import path from 'node:path';
import { globSync } from 'glob';
import { emitKodaXDiagnostic } from '@kodax-ai/agent';

// Match Codex setup.rs (9688359977). These are ACL exclusions, not read denials.
const PROFILE_EXCLUSIONS = [
  '.ssh', '.tsh', '.brev', '.gnupg', '.aws', '.azure', '.kube', '.docker',
  '.config', '.npm', '.pki', '.terraform.d',
];
const SSH_PATH_DIRECTIVES = new Set([
  'certificatefile', 'controlpath', 'globalknownhostsfile', 'identityagent',
  'identityfile', 'revokedhostkeys', 'userknownhostsfile',
]);

function pathKey(value: string): string {
  try { return realpathSync.native(value).toLowerCase(); }
  catch (error: unknown) {
    if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      emitKodaXDiagnostic({ source: 'sandbox:ssh-config', level: 'warn',
        message: `Cannot canonicalize SSH ACL path: ${value}`, detail: error });
    }
    return path.resolve(value).toLowerCase();
  }
}

function inside(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`);
}

function sshWords(line: string): string[] {
  const words: string[] = [];
  let word = '';
  let quote: string | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (char === '#' && quote === undefined) break;
    if (char === quote) { quote = undefined; continue; }
    if ((char === '"' || char === "'") && quote === undefined) { quote = char; continue; }
    const next = line[index + 1];
    if (char === '\\' && next !== undefined
      && (['"', "'", '\\'].includes(next) || (quote === undefined && next === ' '))) {
      word += next;
      index += 1;
    } else if (/\s/.test(char) && quote === undefined) {
      if (word) words.push(word);
      word = '';
    } else word += char;
  }
  if (word) words.push(word);
  return words;
}

function sshPath(argument: string, home: string, relativeBase?: string): string | undefined {
  if (argument.toLowerCase() === 'none') return undefined;
  if (['~', '%d', '${HOME}'].includes(argument)) return home;
  const expanded = argument.replace(/^(?:~|%d|\$\{HOME\})[/\\]/, `${home}${path.sep}`);
  if (path.isAbsolute(expanded)) return path.resolve(expanded);
  return relativeBase === undefined ? undefined : path.resolve(relativeBase, expanded);
}

function visitSshConfig(file: string, home: string, paths: string[], visited: Set<string>, depth = 0): void {
  const key = pathKey(file);
  if (visited.has(key)) return;
  if (depth >= 32) {
    emitKodaXDiagnostic({ source: 'sandbox:ssh-config', level: 'warn',
      message: `SSH Include depth limit reached; dependencies beyond this config were not inspected: ${file}` });
    return;
  }
  visited.add(key);
  let contents: string;
  try { contents = readFileSync(file, 'utf8'); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    emitKodaXDiagnostic({ source: 'sandbox:ssh-config', level: 'warn',
      message: `Cannot inspect SSH configuration dependencies: ${file}`, detail: error });
    return;
  }
  for (const line of contents.split(/\r?\n/)) {
    const words = sshWords(line.replace(/^(\s*[^\s=]+)\s*=\s*/, '$1 '));
    const directive = words.shift()?.toLowerCase();
    if (directive === undefined) continue;
    for (const word of words) {
      const target = sshPath(word, home, directive === 'include' ? path.join(home, '.ssh') : undefined);
      if (target === undefined) continue;
      if (directive === 'include') {
        for (const included of globSync(target.replace(/\\/g, '/'), { nodir: true })) {
          paths.push(included);
          visitSshConfig(included, home, paths, visited, depth + 1);
        }
      } else if (SSH_PATH_DIRECTIVES.has(directive)) paths.push(target);
    }
  }
}

export function windowsSandboxAclExclusions(home: string): string[] {
  const paths: string[] = [];
  visitSshConfig(path.join(home, '.ssh', 'config'), home, paths, new Set());
  const homeKey = pathKey(home);
  const excluded = PROFILE_EXCLUSIONS.map((name) => path.join(home, name));
  for (const file of paths) {
    const relative = path.relative(homeKey, pathKey(file));
    if (relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) {
      excluded.push(path.join(home, relative.split(path.sep)[0]!));
    }
  }
  return [...new Set(excluded.map((root) => path.resolve(root)))];
}

// Migration only: inspect SSH metadata, never private-key contents or the whole home.
export function windowsSandboxSshCleanupRoots(home: string): string[] {
  const paths: string[] = [];
  visitSshConfig(path.join(home, '.ssh', 'config'), home, paths, new Set());
  const pending = [path.join(home, '.ssh')];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    paths.push(directory);
    let entries: Dirent[];
    try {
      if (lstatSync(directory).isSymbolicLink()) continue;
      entries = readdirSync(directory, { withFileTypes: true });
    }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const file = path.join(directory, entry.name);
      paths.push(file);
      if (entry.isDirectory()) pending.push(file);
    }
  }
  return [...new Set(paths.filter((file) => inside(pathKey(home), pathKey(file))))];
}

export function windowsSandboxAclRoots(
  roots: readonly string[], home: string, excluded: readonly string[],
): string[] {
  const homeKey = pathKey(home);
  const exclusions = excluded.flatMap((root) => [path.resolve(root).toLowerCase(), pathKey(root)]);
  const expanded = roots.flatMap((root) => pathKey(root) === homeKey
    ? readdirSync(home, { withFileTypes: true }).filter((entry) => !entry.isSymbolicLink())
      .map((entry) => path.join(home, entry.name))
    : [root]);
  return [...new Set(expanded)].filter((root) => {
    const keys = [path.resolve(root).toLowerCase(), pathKey(root)];
    return !keys.some((key) => exclusions.some((excludedKey) => inside(excludedKey, key)));
  });
}
