/**
 * A small shell over a case's fixed world, for multi-round chains. The pilot
 * showed that answering every unknown command with "exit 0, no output" made
 * agents spend their rounds debugging the sandbox instead of the task, so this
 * one answers the usual exploration plainly: `&&`, `||`, `;` and pipes,
 * `2>/dev/null` and `2>&1`, `cd`, `pwd`, `echo`, `find`, `which`, versions.
 *
 * Each segment first tries the case's canned commands, then the builtins, then
 * falls back to exit 0 with no output. Exported variables are prefixed to the
 * later segments as `NAME=value`, so a canned command can see a fixed PATH.
 */
import { WORKSPACE, type World } from '../feature-308-inferred/world.js';

interface Result {
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface State {
  cwd: string;
  exports: string[];
  lastExit: number;
}

const HOME = '/home/dev';
const PATH_VALUE = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
/** Tools on PATH unless a case's canned commands say otherwise. */
const ON_PATH = new Set(['node', 'npm', 'npx', 'git', 'docker', 'bash', 'sh', 'curl', 'python3', 'ls', 'cat', 'find', 'grep']);
const VERSIONS: Readonly<Record<string, string>> = { node: 'v22.11.0', npm: '10.9.0', npx: '10.9.0', git: 'git version 2.43.0', docker: 'Docker version 27.3.1, build ce12230' };

const done = (exit: number, stdout = '', stderr = ''): Result => ({ exit, stdout, stderr });

export function formatShell(command: string, result: Result): string {
  return `Command: ${command}\nExit: ${result.exit}\n${result.stdout}${result.stderr.length > 0 ? `\n[stderr]\n${result.stderr}` : ''}`;
}

// ---------------------------------------------------------------- parsing

interface Step {
  readonly op: '&&' | '||' | ';';
  readonly stages: readonly string[];
}

/** Splits at top-level `&&`, `||`, `;`, newlines and pipes, outside quotes and `$(...)`. */
export function parseCommand(command: string): readonly Step[] {
  const steps: Step[] = [];
  let stages: string[] = [];
  let current = '';
  let op: Step['op'] = ';';
  let quote: string | undefined;
  let depth = 0;
  const endStage = (): void => { stages.push(current.trim()); current = ''; };
  const endStep = (next: Step['op']): void => {
    endStage();
    if (stages.some((stage) => stage.length > 0)) steps.push({ op, stages: stages.filter((stage) => stage.length > 0) });
    stages = [];
    op = next;
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    const pair = command.slice(index, index + 2);
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      current += char;
    } else if (char === '\'' || char === '"') {
      quote = char;
      current += char;
    } else if (pair === '$(') {
      depth += 1;
      current += pair;
      index += 1;
    } else if (depth > 0) {
      if (char === ')') depth -= 1;
      current += char;
    } else if (pair === '&&' || pair === '||') {
      endStep(pair);
      index += 1;
    } else if (char === ';' || char === '\n') {
      endStep(';');
    } else if (char === '|' && command[index - 1] !== '>') {
      endStage();
    } else {
      current += char;
    }
  }
  endStep(';');
  return steps;
}

const unquote = (value: string): string => value.replace(/^(['"])([\s\S]*)\1$/, '$2');

/** Shell words, quotes removed; good enough for the commands agents explore with. */
function words(segment: string): string[] {
  return [...segment.matchAll(/'[^']*'|"[^"]*"|\S+/g)].map((match) => unquote(match[0]));
}

// ---------------------------------------------------------------- the world as a file system

function resolvePath(state: State, target: string): string {
  const expanded = target.replace(/^~(?=\/|$)/, HOME).replace(/^\$HOME(?=\/|$)/, HOME);
  const absolute = expanded.startsWith('/') ? expanded : `${state.cwd}/${expanded}`;
  const parts: string[] = [];
  for (const part of absolute.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

/** Workspace-relative path, or undefined outside the workspace. */
function inWorkspace(absolute: string): string | undefined {
  if (absolute === WORKSPACE) return '';
  return absolute.startsWith(`${WORKSPACE}/`) ? absolute.slice(WORKSPACE.length + 1) : undefined;
}

function filesUnder(world: World, dir: string): readonly string[] {
  return Object.keys(world.files).filter((file) => dir === '' || file.startsWith(`${dir}/`)).sort();
}

function listDir(world: World, dir: string): readonly string[] {
  const prefix = dir === '' ? '' : `${dir}/`;
  const entries = new Set<string>();
  for (const file of filesUnder(world, dir)) {
    const rest = file.slice(prefix.length);
    entries.add(rest.includes('/') ? `${rest.split('/')[0]}/` : rest);
  }
  return [...entries].sort();
}

const isDir = (world: World, relative: string): boolean => relative === '' || filesUnder(world, relative).length > 0;

// ---------------------------------------------------------------- builtins

function expand(state: State, text: string): string {
  return text
    .replace(/\$\(pwd\)/g, state.cwd)
    .replace(/\$\{?PATH\}?/g, PATH_VALUE)
    .replace(/\$\{?HOME\}?/g, HOME)
    .replace(/\$\{?(?:USER|LOGNAME)\}?/g, 'dev')
    .replace(/\$\{?PWD\}?/g, state.cwd)
    .replace(/\$\?/g, String(state.lastExit))
    .replace(/\$\{?[A-Za-z_]\w*\}?/g, '');
}

function readFiles(world: World, state: State, name: string, targets: readonly string[], lines?: number): Result {
  let stdout = '';
  let stderr = '';
  let exit = 0;
  for (const target of targets) {
    const relative = inWorkspace(resolvePath(state, target));
    const content = relative === undefined ? undefined : world.files[relative];
    if (content === undefined) {
      stderr += `${name}: ${target}: ${relative !== undefined && isDir(world, relative) ? 'Is a directory' : 'No such file or directory'}\n`;
      exit = 1;
    } else {
      stdout += lines === undefined ? content : `${content.split('\n').slice(0, lines).join('\n')}\n`;
    }
  }
  return done(exit, stdout, stderr);
}

function listing(world: World, state: State, args: readonly string[]): Result {
  const long = args.some((arg) => /^-\w*l/.test(arg));
  const recursive = args.some((arg) => /^-\w*R/.test(arg));
  const targets = args.filter((arg) => !arg.startsWith('-'));
  let stdout = '';
  let stderr = '';
  let exit = 0;
  for (const target of targets.length === 0 ? ['.'] : targets) {
    const relative = inWorkspace(resolvePath(state, target));
    if (relative !== undefined && world.files[relative] !== undefined) {
      stdout += `${long ? '-rw-r--r-- 1 dev dev ' : ''}${target}\n`;
    } else if (relative !== undefined && isDir(world, relative)) {
      const entries = recursive ? filesUnder(world, relative).map((file) => (relative === '' ? file : file.slice(relative.length + 1))) : listDir(world, relative);
      const header = targets.length > 1 ? `${target}:\n` : '';
      stdout += header + entries.map((entry) => (long ? `${entry.endsWith('/') ? 'drwxr-xr-x' : '-rw-r--r--'} 1 dev dev ${entry}` : entry)).join('\n') + '\n';
    } else {
      stderr += `ls: cannot access '${target}': No such file or directory\n`;
      exit = 2;
    }
  }
  return done(exit, stdout, stderr);
}

function globToRegExp(pattern: string): RegExp {
  return new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
}

function find(world: World, state: State, args: readonly string[]): Result {
  const root = args[0] !== undefined && !args[0].startsWith('-') ? args[0] : '.';
  const names = args.flatMap((arg, index) => (arg === '-name' || arg === '-iname') && args[index + 1] !== undefined ? [globToRegExp(args[index + 1]!)] : []);
  const relative = inWorkspace(resolvePath(state, root));
  if (relative === undefined) return done(0);
  if (!isDir(world, relative)) return done(1, '', `find: '${root}': No such file or directory\n`);
  const prefix = root.replace(/\/$/, '');
  const hits = filesUnder(world, relative)
    .filter((file) => names.length === 0 || names.some((name) => name.test(file.split('/').at(-1)!)))
    .map((file) => `${prefix}/${relative === '' ? file : file.slice(relative.length + 1)}`);
  return done(0, hits.length === 0 ? '' : `${hits.join('\n')}\n`);
}

function which(args: readonly string[], style: 'which' | 'type'): Result {
  const tools = args.filter((arg) => !arg.startsWith('-'));
  const found = tools.filter((tool) => ON_PATH.has(tool));
  const stdout = found.map((tool) => (style === 'type' ? `${tool} is /usr/bin/${tool}` : `/usr/bin/${tool}`)).join('\n');
  const missing = tools.filter((tool) => !ON_PATH.has(tool));
  const stderr = style === 'type' ? missing.map((tool) => `bash: type: ${tool}: not found`).join('\n') : '';
  return done(missing.length === 0 ? 0 : 1, stdout.length === 0 ? '' : `${stdout}\n`, stderr.length === 0 ? '' : `${stderr}\n`);
}

function builtin(world: World, state: State, segment: string): Result | undefined {
  const [name, ...args] = words(segment);
  if (name === undefined) return done(0);
  if (name === 'cd') {
    const target = resolvePath(state, args[0] ?? HOME);
    const relative = inWorkspace(target);
    if (relative !== undefined && !isDir(world, relative)) return done(1, '', `bash: cd: ${args[0]}: No such file or directory\n`);
    state.cwd = target;
    return done(0);
  }
  if (name === 'export') {
    state.exports.push(...args.filter((arg) => arg.includes('=')).map((arg) => arg.replace(/=(.*)$/, (_, value: string) => `="${value}"`)));
    return done(0);
  }
  if (name === 'true' || name === ':' || name === 'set') return done(0);
  if (name === 'false') return done(1);
  if (name === 'pwd') return done(0, `${state.cwd}\n`);
  if (name === 'whoami') return done(0, 'dev\n');
  if (name === 'hostname') return done(0, 'devbox\n');
  if (name === 'uname') return done(0, args.includes('-a') ? 'Linux devbox 6.8.0-45-generic #45-Ubuntu SMP x86_64 GNU/Linux\n' : 'Linux\n');
  if (name === 'echo') return done(0, `${expand(state, args.filter((arg) => !/^-[neE]+$/.test(arg)).join(' '))}${args.includes('-n') ? '' : '\n'}`);
  if (name === 'printf') return done(0, expand(state, (args[0] ?? '').replace(/\\n/g, '\n').replace(/%s/g, args[1] ?? '')));
  if (name === 'env' || name === 'printenv') return done(0, `PATH=${PATH_VALUE}\nHOME=${HOME}\nUSER=dev\nPWD=${state.cwd}\n`);
  if (name === 'cat') return readFiles(world, state, 'cat', args.filter((arg) => !arg.startsWith('-')));
  if (name === 'head') {
    const count = /-n\s*(\d+)|-(\d+)/.exec(args.join(' '));
    return readFiles(world, state, 'head', args.filter((arg, index) => !arg.startsWith('-') && !/^\d+$/.test(arg) && args[index - 1] !== '-n'), Number(count?.[1] ?? count?.[2] ?? 10));
  }
  if (name === 'ls') return listing(world, state, args);
  if (name === 'find') return find(world, state, args);
  if (name === 'which' || name === 'whereis') return which(args, 'which');
  if (name === 'type') return which(args, 'type');
  if (name === 'command' && args[0] === '-v') return which(args.slice(1), 'which');
  if (VERSIONS[name] !== undefined && args.length === 1 && /^(?:-v|--version|version)$/.test(args[0]!)) return done(0, `${VERSIONS[name]}\n`);
  return undefined;
}

// ---------------------------------------------------------------- pipes and redirects

function filter(stage: string, input: Result): Result {
  const [name, ...args] = words(stage);
  const text = input.stdout;
  const lines = text.length === 0 ? [] : text.replace(/\n$/, '').split('\n');
  const out = (kept: readonly string[], exit = 0): Result => done(exit, kept.length === 0 ? '' : `${kept.join('\n')}\n`, input.stderr);
  const count = Number(/-n\s*(\d+)|-(\d+)/.exec(args.join(' '))?.slice(1).find((value) => value !== undefined) ?? 10);
  if (name === 'head') return out(lines.slice(0, count));
  if (name === 'tail') return out(lines.slice(-count));
  if (name === 'sort') return out([...lines].sort());
  if (name === 'wc') return done(0, `${lines.length}\n`, input.stderr);
  if (name === 'grep') {
    const pattern = args.find((arg) => !arg.startsWith('-')) ?? '';
    let matcher: RegExp;
    try {
      matcher = new RegExp(pattern, args.some((arg) => /^-\w*i/.test(arg)) ? 'i' : '');
    } catch {
      return done(2, '', `grep: invalid pattern\n`);
    }
    const invert = args.some((arg) => /^-\w*v/.test(arg));
    const kept = lines.filter((line) => matcher.test(line) !== invert);
    return out(kept, kept.length === 0 ? 1 : 0);
  }
  return out(lines);
}

interface Redirects {
  readonly segment: string;
  readonly merge: boolean;
  readonly dropStdout: boolean;
  readonly dropStderr: boolean;
}

function redirects(stage: string): Redirects {
  const merge = /\s2>&1\b/.test(stage) || /\s&>/.test(stage);
  const dropStderr = /\s2>\s*\/dev\/null/.test(stage) || /\s&>\s*\/dev\/null/.test(stage);
  const dropStdout = /(?:^|\s)(?:1)?>\s*(?!&)\S+/.test(stage.replace(/\s2>\s*\S+/g, '').replace(/\s2>&1\b/g, ''));
  const segment = stage.replace(/\s*(?:\d?>>?|&>)\s*(?:&\d|\S+)/g, '').trim();
  return { segment, merge, dropStdout: dropStdout && !/&>/.test(stage), dropStderr };
}

function runStage(world: World, state: State, stage: string): Result {
  const { segment, merge, dropStdout, dropStderr } = redirects(stage);
  const prefixed = [...state.exports, segment].join(' ');
  const canned = world.commands?.find((item) => item.match.test(prefixed));
  const raw = canned !== undefined
    ? done(canned.exit, canned.stdout, canned.stderr ?? '')
    : builtin(world, state, segment) ?? done(0);
  const stdout = (dropStdout ? '' : raw.stdout) + (merge && !dropStderr ? raw.stderr : '');
  const stderr = merge || dropStderr ? '' : raw.stderr;
  return done(raw.exit, stdout, stderr);
}

/** The bash tool's answer to `command` in `world`, in the shape the real tool prints. */
export function answerShell(world: World, command: string): string {
  const state: State = { cwd: WORKSPACE, exports: [], lastExit: 0 };
  let stdout = '';
  let stderr = '';
  for (const step of parseCommand(command)) {
    if (step.op === '&&' && state.lastExit !== 0) continue;
    if (step.op === '||' && state.lastExit === 0) continue;
    let result = runStage(world, state, step.stages[0]!);
    for (const stage of step.stages.slice(1)) result = filter(stage, result);
    stdout += result.stdout;
    stderr += result.stderr;
    state.lastExit = result.exit;
  }
  return formatShell(command, done(state.lastExit, stdout, stderr.replace(/\n$/, '')));
}
