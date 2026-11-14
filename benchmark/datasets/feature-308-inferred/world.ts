/**
 * A small, fixed stand-in for the session-2 repository, so an agent that looks
 * around before acting (as real agents do) gets consistent answers instead of
 * being cut off after its first call.
 *
 * Only exploration is answered. The judged command is never "run": the oracle
 * scores it as soon as it appears. A read of a memory note returns the real note
 * file the arm stored, so reading a note before acting is measured like production.
 */
import { judgedActions, type CommandOracle } from './oracles.js';

export interface WorldCommand {
  readonly match: RegExp;
  readonly exit: number;
  readonly stdout: string;
  readonly stderr?: string;
}

export interface World {
  /** Repository files, keyed by path relative to the workspace root. */
  readonly files: Readonly<Record<string, string>>;
  /** Canned results for shell commands other than the judged one; first match wins. */
  readonly commands?: readonly WorldCommand[];
}

export const WORKSPACE = '/work/project';

export interface ToolCall {
  readonly name: string;
  readonly input: unknown;
}

const field = (input: unknown, ...keys: readonly string[]): string => {
  const record = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {};
  const value = keys.map((key) => record[key]).find((item) => typeof item === 'string');
  return typeof value === 'string' ? value : '';
};

const relative = (value: string): string => value.replace(/\\/g, '/').replace(new RegExp(`^${WORKSPACE}/?`), '').replace(/^\.\//, '').replace(/\/$/, '');

function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === '*' && pattern[index + 1] === '*') {
      source += pattern[index + 2] === '/' ? '(?:.*/)?' : '.*';
      index += pattern[index + 2] === '/' ? 2 : 1;
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else if (char === '{') source += '(?:';
    else if (char === '}') source += ')';
    else if (char === ',') source += '|';
    else source += char.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

/** Files and directories directly under `dir`. */
function listDir(world: World, dir: string): readonly string[] {
  const prefix = dir.length === 0 ? '' : `${dir}/`;
  const entries = new Set<string>();
  for (const file of Object.keys(world.files)) {
    if (!file.startsWith(prefix)) continue;
    const rest = file.slice(prefix.length);
    entries.add(rest.includes('/') ? `${rest.split('/')[0]}/` : rest);
  }
  return [...entries].sort();
}

function shell(command: string, exit: number, stdout: string, stderr = ''): string {
  return `Command: ${command}\nExit: ${exit}\n${stdout}${stderr.length > 0 ? `\n[stderr]\n${stderr}` : ''}`;
}

function answerBash(world: World, command: string): string {
  const canned = world.commands?.find((item) => item.match.test(command));
  if (canned !== undefined) return shell(command, canned.exit, canned.stdout, canned.stderr);
  const cat = /^\s*(?:cat|head(?:\s+-n\s*\d+)?)\s+(\S+)\s*$/.exec(command);
  if (cat !== null) {
    const content = world.files[relative(cat[1]!)];
    return content === undefined ? shell(command, 1, '', `cat: ${cat[1]}: No such file or directory`) : shell(command, 0, content);
  }
  const ls = /^\s*ls(?:\s+-\S+)*(?:\s+([^\s;&|]+))?\s*$/.exec(command);
  if (ls !== null) {
    const entries = listDir(world, relative(ls[1] ?? '.').replace(/^\.$/, ''));
    return entries.length === 0 ? shell(command, 2, '', `ls: cannot access '${ls[1]}': No such file or directory`) : shell(command, 0, `${entries.join('\n')}\n`);
  }
  return shell(command, 0, '');
}

function answerGrep(world: World, input: unknown): string {
  let pattern: RegExp;
  try {
    pattern = new RegExp(field(input, 'pattern'));
  } catch {
    return '[Tool Error] grep: invalid regular expression';
  }
  const scope = relative(field(input, 'path'));
  const lines = Object.entries(world.files)
    .filter(([file]) => scope.length === 0 || file === scope || file.startsWith(`${scope}/`))
    .flatMap(([file, content]) => content.split('\n').flatMap((line, index) => (pattern.test(line) ? [`${file}:${index + 1}:${line}`] : [])));
  return lines.length === 0 ? 'No matches found' : lines.join('\n');
}

function answerGlob(world: World, input: unknown): string {
  const base = relative(field(input, 'path'));
  const matcher = globToRegExp(field(input, 'pattern'));
  const hits = Object.keys(world.files)
    .filter((file) => base.length === 0 || file.startsWith(`${base}/`))
    .filter((file) => matcher.test(base.length === 0 ? file : file.slice(base.length + 1)));
  return hits.length === 0 ? 'No files found' : hits.join('\n');
}

/** Note files are matched by absolute path, ignoring slash direction and case (the fixture lives in the OS temp dir). */
const noteKey = (value: string): string => value.replace(/\\/g, '/').toLowerCase();

export function answerToolCall(world: World, notes: ReadonlyMap<string, string>, call: ToolCall): string {
  if (call.name === 'read') {
    const target = field(call.input, 'path', 'file_path');
    const note = notes.get(noteKey(target));
    if (note !== undefined) return note;
    const content = world.files[relative(target)];
    if (content !== undefined) return content;
    const entries = listDir(world, relative(target));
    return entries.length > 0 ? `${target} is a directory:\n${entries.join('\n')}` : `[Tool Error] read: File not found: ${target}`;
  }
  if (call.name === 'bash') return answerBash(world, field(call.input, 'command'));
  if (call.name === 'grep') return answerGrep(world, call.input);
  if (call.name === 'glob') return answerGlob(world, call.input);
  return 'OK';
}

export function noteFileMap(files: readonly { readonly path: string; readonly content: string }[]): ReadonlyMap<string, string> {
  return new Map(files.map((file) => [noteKey(file.path), file.content]));
}

/** True when the oracle already has the action it judges, or the turn ended without tools. */
export function turnSettles(oracle: CommandOracle, calls: readonly ToolCall[]): boolean {
  return calls.length === 0 || judgedActions(oracle, calls).some((action) => oracle.pick.test(action));
}
