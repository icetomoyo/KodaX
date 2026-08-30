import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAgentConfigHome, isPathInsideDirectory } from '@kodax-ai/agent';
import type { RunnerToolCall } from '@kodax-ai/agent';
import { minimatch } from 'minimatch';
import type {
  AutoModePermissionOperation,
  AutoModePermissionReview,
  AutoModePermissionTarget,
  AutoModeRulesContext,
} from './guardrail.js';
import {
  collectDeterministicBashWriteTargets,
  extractPathsFromCommand,
  findGitSubcommandIndex,
  isBashReadCommand,
  isBashWriteCommand,
  isShellReadOnlyArgv,
  parseGitGrepShortOption,
  tokenizeRawCommandStages,
} from '../../permissions/permission.js';
import { isNullDevice, parseBashCommand } from '../../permissions/bash-ast.js';
import type { BashCommandTree, BashPipelineStage } from '../../permissions/bash-ast.js';
import {
  analyzePowerShellMutation,
  isPowerShellMutationCommand,
} from '../../permissions/powershell-mutation.js';
import {
  isAutoReadableAgentHomePath,
  isAutoWritableAgentHomePath,
  isProtectedAgentHomeRemovalTarget,
} from '../../permissions/agent-home-policy.js';

const FILE_TOOLS = new Set(['write', 'edit', 'multi_edit', 'insert_after_anchor']);
const READ_FILE_TOOLS = new Set(['read', 'grep', 'glob']);
const SENSITIVE_PATH_PARTS = new Set([
  '.ssh', '.aws', '.azure', '.gnupg', '.kube', '.docker', '.kodax', '.agents',
  '.codex', '.claude', '.gemini', '.direnv', '.terraform.d', '.password-store',
]);
const SENSITIVE_FILES = new Set([
  '.env', '.envrc', '.pgpass', '.npmrc', '.pypirc', '.netrc', '.git-credentials', 'credentials',
  'credentials.json', 'application_default_credentials.json', 'id_rsa', 'id_ed25519',
  '.gitconfig', '.terraformrc', '.condarc', '.bashrc', '.bash_profile', '.zshrc', '.zprofile',
  '.profile', '.bash_history', '.zsh_history',
]);
const ENV_TEMPLATE_FILES = new Set(['.env.example', '.env.sample', '.env.template']);
const SENSITIVE_SELECTOR_NAMES = [...SENSITIVE_PATH_PARTS, ...SENSITIVE_FILES];
const SENSITIVE_ENV_NAME = /(?:^|_)(?:api_?key|access_?key|secret|token|password|passwd|credentials?|private_?key|signing_?key|encryption_?key|auth|cookie|pat|jwt|database_?url|db_?url|redis_?url|mongodb_?url|connection_?string|sentry_?dsn)(?:_|$)|^(?:pgpassword|mysql_pwd|kubeconfig|git_askpass)$/i;
// Provider values are user-controlled process data, not filesystem metadata.
// Only a small set of conventional diagnostic names is safe enough for the
// deterministic fast path; every other exact selector is interpreted by LLM.
const SAFE_PROCESS_DATA_NAME = /^(?:_|psitem|true|false|null|lastexitcode|path|pathext|home|pwd|oldpwd|temp|tmp|tmpdir|userprofile|homedrive|homepath|username|userdomain|computername|hostname|logname|user|os|comspec|systemroot|systemdrive|windir|processor_architecture|processor_identifier|processor_level|processor_revision|number_of_processors|psmodulepath|psversiontable|term|colorterm|lang|lc_(?:all|ctype)|shell)$/i;
const SENSITIVE_GIT_CONFIG_SELECTOR = /credential|extraheader|oauth|token|password|passwd|secret|askpass|sslkey|cookie|proxy/i;
const SENSITIVE_GIT_URL_SELECTOR = /^(?:remote\..+\.(?:url|pushurl)|submodule\..+\.url|url\..+\.(?:insteadof|pushinsteadof))$/i;
// Only these user metadata keys are known to be non-secret. Treating all of
// user.* as safe would admit custom keys such as user.password/user.token.
const SAFE_GIT_CONFIG_REGEXP_SELECTOR = /^\^user\\\.(?:(?:name|email)|\((?:\?:)?name\|email\))\$$/i;
const POSITIONAL_READ_COMMANDS = new Set([
  'cat', 'type', 'get-content', 'head', 'tail', 'less', 'more', 'wc', 'fc',
]);
const REGEX_READ_COMMANDS = new Set([
  'rg', 'ripgrep', 'grep', 'egrep', 'fgrep', 'findstr', 'select-string', 'sed', 'awk',
]);
const POWERSHELL_PROVIDER_READ_COMMANDS: Readonly<Record<string, string>> = {
  'get-childitem': 'get-childitem', gci: 'get-childitem', dir: 'get-childitem', ls: 'get-childitem',
  'get-item': 'get-item', gi: 'get-item',
  'get-content': 'get-content', gc: 'get-content', cat: 'get-content', type: 'get-content',
  'select-string': 'select-string', sls: 'select-string',
  'get-variable': 'get-variable', gv: 'get-variable',
};
const POWERSHELL_SWITCH_PARAMETERS = new Set([
  'allmatches', 'casesensitive', 'directory', 'file', 'followsymlink', 'force',
  'hidden', 'list', 'name', 'notmatch', 'quiet', 'raw', 'readonly', 'recurse',
  'simplematch', 'stream', 'system', 'wait',
]);
const POWERSHELL_COMMON_VALUE_PARAMETERS = [
  'erroraction', 'errorvariable', 'informationaction', 'informationvariable',
  'outbuffer', 'outvariable', 'pipelinevariable', 'progressaction',
  'warningaction', 'warningvariable',
] as const;
const POWERSHELL_COMMON_VALUE_ALIASES = new Set([
  'ea', 'ev', 'infa', 'iv', 'ob', 'ov', 'pv', 'proga', 'wa', 'wv',
]);
const POWERSHELL_COMMON_SWITCH_PARAMETERS = new Set(['debug', 'verbose']);
const POWERSHELL_READ_PARAMETERS: Readonly<Record<string, readonly string[]>> = {
  'get-content': [
    'path', 'literalpath', 'filter', 'include', 'exclude', 'delimiter', 'encoding',
    'readcount', 'totalcount', 'tail', 'raw', 'wait', 'stream', 'credential',
  ],
  'select-string': [
    'path', 'literalpath', 'include', 'exclude', 'pattern', 'simplematch',
    'casesensitive', 'quiet', 'list', 'allmatches', 'notmatch', 'encoding',
    'context', 'raw', 'culture', 'inputobject',
  ],
  'get-childitem': [
    'path', 'literalpath', 'filter', 'include', 'exclude', 'recurse', 'file',
    'directory', 'force', 'name', 'depth', 'attributes', 'hidden', 'readonly',
    'system', 'followsymlink',
  ],
  'get-item': [
    'path', 'literalpath', 'filter', 'include', 'exclude', 'force', 'credential',
  ],
  'get-variable': [
    'name', 'valueonly', 'scope', 'include', 'exclude',
  ],
};
const GIT_NON_PATH_VALUE_OPTIONS = new Set([
  '-g', '-s', '--format', '--pretty', '--date', '--encoding', '--diff-algorithm',
  '--word-diff-regex', '--diff-filter', '--find-object', '--line-prefix',
  '--grep', '--author', '--committer', '--since', '--after', '--until', '--before',
  '--max-count', '-n', '--skip', '--min-parents', '--max-parents',
]);
const TARGETED_WRITE_COMMANDS = new Set([
  'rm', 'rmdir', 'mkdir', 'touch', 'mv', 'move', 'ren', 'del', 'erase', 'rd',
  'cp', 'copy', 'chmod', 'chown', 'dd', 'tee',
  'remove-item', 'set-content', 'add-content', 'out-file', 'new-item',
  'copy-item', 'move-item', 'rename-item', 'ni',
]);
const GIT_REMOTE_WRITE_ACTIONS = new Set([
  'add', 'remove', 'rm', 'rename', 'set-head', 'set-branches',
  'set-url', 'prune', 'update',
]);
const GIT_BRANCH_WRITE_FLAGS = new Set([
  '-d', '-m', '-c', '-f', '--force', '--delete', '--move', '--copy',
  '--edit-description', '--set-upstream-to', '--unset-upstream', '--create-reflog',
  '--track', '--no-track', '--recurse-submodules',
]);
const GIT_TAG_WRITE_FLAGS = new Set([
  '-a', '--annotate', '-s', '--sign', '-u', '--local-user', '-d', '--delete',
  '-f', '--force', '-m', '--message', '-F', '--file', '--create-reflog',
].map((token) => token.toLowerCase()));

function expandPermissionPath(targetPath: string): string {
  const tempDir = os.tmpdir();
  const aliases: ReadonlyArray<readonly [RegExp, string]> = [
    [/^%temp%/i, tempDir], [/^%tmp%/i, tempDir],
    [/^\$env:temp\b/i, tempDir], [/^\$env:tmp\b/i, tempDir],
    [/^\$tmpdir\b/i, tempDir], [/^\$temp\b/i, tempDir], [/^\$tmp\b/i, tempDir],
  ];
  let expanded = targetPath === '~'
    ? os.homedir()
    : /^~[\\/]/.test(targetPath)
      ? path.join(os.homedir(), targetPath.slice(2))
      : targetPath;
  const homePrefix = /^(?:\$\{HOME\}|\$HOME|\$env:(?:home|userprofile)|%userprofile%)(?=$|[\\/])/i;
  expanded = expanded.replace(homePrefix, os.homedir());
  for (const [pattern, replacement] of aliases) {
    if (pattern.test(expanded)) expanded = expanded.replace(pattern, replacement);
  }
  return expanded;
}

function normalizeShellTarget(targetPath: string): string | undefined {
  const expanded = expandPermissionPath(targetPath);
  if (/[$%*?`^]/.test(expanded) || /![^!\r\n]+!/.test(expanded) || /^~/.test(expanded)) {
    return undefined;
  }
  return expanded;
}

function hasTempEnvironmentPathPrefix(targetPath: string): boolean {
  return /^(?:%temp%|%tmp%|\$env:(?:temp|tmp)|\$\{env:(?:temp|tmp)\}|\$\{(?:tmpdir|temp|tmp)\}|\$(?:tmpdir|temp|tmp))(?=$|[\\/])/i
    .test(targetPath);
}

function normalizeLiteralShellTarget(targetPath: string): string | undefined {
  const expanded = expandPermissionPath(targetPath);
  // PowerShell -LiteralPath suppresses wildcard expansion only. Variables,
  // expressions, and home syntax can still be resolved before parameter
  // binding, so they remain non-deterministic here.
  if (/[$%`{}^]/.test(expanded) || /![^!\r\n]+!/.test(expanded) || /^~/.test(expanded)) {
    return undefined;
  }
  return expanded;
}

function hasShellReadExpansion(targetPath: string): boolean {
  const expanded = expandPermissionPath(targetPath);
  return /[$%*?`^\[\]{}]/.test(expanded)
    || /![^!\r\n]+!/.test(expanded)
    || /^~/.test(expanded)
    || /^:\([^)]*\battr(?::|=|\s)/i.test(expanded);
}

function hasDynamicShellReadExpansion(targetPath: string): boolean {
  const expanded = expandPermissionPath(targetPath);
  return /[$%`^]/.test(expanded)
    || /![^!\r\n]+!/.test(expanded)
    || /^~/.test(expanded)
    || /^\\\\[.?]\\/.test(expanded)
    || /^:\([^)]*\battr(?::|=|\s)/i.test(expanded);
}

function unresolvedSearchFilterTarget(filter: string): string {
  return `\${search-filter:${filter}}`;
}

function selectorLiteralEvidence(pattern: string, sensitiveName: string): number {
  const extension = sensitiveName.startsWith('.') ? '' : path.posix.extname(sensitiveName);
  const withoutExtension = extension && pattern.toLowerCase().endsWith(extension)
    ? pattern.slice(0, -extension.length)
    : pattern;
  const withoutNegativeExtglobs = withoutExtension.replace(/!\([^()]*\)/g, '');
  const singletonClasses = withoutNegativeExtglobs.replace(
    /\[([^\]]*)\]/g,
    (_match, body: string) => /^[a-z0-9]$/i.test(body) ? body : '',
  );
  return (singletonClasses.match(/[a-z0-9]/gi) ?? []).length;
}

function globSensitiveSelectorCandidate(value: string): string | undefined {
  for (const segment of value.split(/[\\/]+/)) {
    for (const sensitiveName of SENSITIVE_SELECTOR_NAMES) {
      if (selectorLiteralEvidence(segment, sensitiveName) < 2) continue;
      if (minimatch(sensitiveName, segment, {
        dot: true,
        nocase: true,
        nonegate: true,
        windowsPathsNoEscape: true,
      })) return sensitiveName;
    }
  }
  return undefined;
}

function sensitiveSearchSelectorCandidate(value: string): string | undefined {
  if (isExcludingGitPathspec(value)) return undefined;
  const direct = sensitivePathCandidate(value);
  if (direct) return direct;
  const fragments = value.toLowerCase().split(/[\\/|,(){}]+/)
    .map((fragment) => fragment.replace(/^[!+@*?\[\]]+|[!+@*?\[\]]+$/g, ''))
    .filter(Boolean);
  const explicit = fragments.find((fragment) => isSensitivePath(fragment));
  if (explicit) return explicit;
  return globSensitiveSelectorCandidate(value);
}

function collectLiteralReadTargets(tree: BashCommandTree): ReadonlySet<string> {
  const targets = new Set<string>();
  const nonLiteralTargets = new Set<string>();
  for (const statement of tree.statements) {
    for (const stage of statement.stages) {
      const literalIndexes = new Set<number>();
      const executable = canonicalPowerShellReadExecutable(stage);
      if (!executable) {
        for (const token of stage.argv) nonLiteralTargets.add(token);
        continue;
      }
      for (let index = 1; index < stage.argv.length; index += 1) {
        const token = stage.argv[index] ?? '';
        const attached = parseAttachedPowerShellReadParameter(executable, token);
        if (attached?.name === 'literalpath') {
          targets.add(attached.value);
          // The shared regex-role extractor historically retains the colon in
          // an attached short-option value. Preserve that spelling too.
          targets.add(':' + attached.value);
          literalIndexes.add(index);
          continue;
        }
        if (resolvePowerShellReadParameter(executable, token) !== 'literalpath') {
          continue;
        }
        const value = stage.argv[index + 1];
        if (value) {
          targets.add(value);
          literalIndexes.add(index + 1);
        }
        index += 1;
      }
      for (let index = 0; index < stage.argv.length; index += 1) {
        if (literalIndexes.has(index)) continue;
        const token = stage.argv[index] ?? '';
        nonLiteralTargets.add(token);
        const separator = Math.max(token.indexOf(':'), token.indexOf('='));
        if (separator > 0) nonLiteralTargets.add(token.slice(separator + 1));
      }
    }
  }
  return new Set([...targets].filter((target) => !nonLiteralTargets.has(target)));
}

function canonicalPowerShellReadExecutable(stage: BashPipelineStage): string | undefined {
  return POWERSHELL_PROVIDER_READ_COMMANDS[shellExecutable(stage)];
}

function isUnambiguousPowerShellReadStage(stage: BashPipelineStage): boolean {
  const executable = shellExecutable(stage);
  return executable.includes('-') || ['gci', 'gi', 'gc', 'sls', 'gv'].includes(executable);
}

function hasDynamicPowerShellParameterBinding(stage: BashPipelineStage): boolean {
  return canonicalPowerShellReadExecutable(stage) !== undefined
    && stage.argv.slice(1).some((token) => (
      /^@(?:(?:global|script|local|private):)?[a-z_][a-z0-9_]*$/i.test(token)
    ));
}

function parseAttachedPowerShellReadParameter(
  executable: string,
  token: string,
): { readonly name?: string; readonly value: string } | undefined {
  const match = /^-([^:]+):(.*)$/s.exec(token);
  if (!match) return undefined;
  const prefix = match[1]?.toLowerCase() ?? '';
  if (prefix === 'pspath') return { name: 'literalpath', value: match[2] ?? '' };
  const candidates = (POWERSHELL_READ_PARAMETERS[executable] ?? [])
    .filter((name) => name.startsWith(prefix));
  return {
    ...(candidates.length === 1 ? { name: candidates[0]! } : {}),
    value: match[2] ?? '',
  };
}

function resolvePowerShellReadParameter(
  executable: string,
  token: string,
): string | undefined {
  if (!/^-[a-z][a-z-]*$/i.test(token)) return undefined;
  const prefix = token.slice(1).toLowerCase();
  if (prefix === 'pspath') return 'literalpath';
  const candidates = (POWERSHELL_READ_PARAMETERS[executable] ?? [])
    .filter((name) => name.startsWith(prefix));
  return candidates.length === 1 ? candidates[0] : undefined;
}

function powerShellCommonParameterConsumesValue(token: string): boolean | undefined {
  if (!/^-[a-z][a-z-]*$/i.test(token)) return undefined;
  const prefix = token.slice(1).toLowerCase();
  if (POWERSHELL_COMMON_VALUE_ALIASES.has(prefix)) return true;
  if (POWERSHELL_COMMON_SWITCH_PARAMETERS.has(prefix)) return false;
  const valueCandidates = POWERSHELL_COMMON_VALUE_PARAMETERS
    .filter((name) => name.startsWith(prefix));
  const switchCandidates = [...POWERSHELL_COMMON_SWITCH_PARAMETERS]
    .filter((name) => name.startsWith(prefix));
  if (valueCandidates.length + switchCandidates.length !== 1) return undefined;
  return valueCandidates.length === 1;
}

interface PowerShellReadPathOperand {
  readonly value: string;
  readonly literal: boolean;
}

const POSITIONAL_CONTENT_READ_VALUE_PARAMETERS: Readonly<Record<string, ReadonlySet<string>>> = {
  head: new Set(['-c', '--bytes', '-n', '--lines']),
  tail: new Set(['-c', '--bytes', '-n', '--lines', '--max-unchanged-stats', '--pid', '-s', '--sleep-interval']),
  less: new Set(['-p', '-P', '-t', '-T', '-x', '--pattern', '--prompt', '--tag', '--tag-file', '--tabs']),
};
const LESS_SHORT_VALUE_OPTIONS = new Set(['b', 'h', 'j', 'k', 'p', 'P', 't', 'T', 'x', 'y', 'z']);
const TREE_SHORT_VALUE_OPTIONS = new Set(['H', 'I', 'L', 'P', 'T']);
const TREE_ALL_SHORT_VALUE_OPTIONS = new Set([...TREE_SHORT_VALUE_OPTIONS, 'o']);
const TREE_LONG_VALUE_OPTIONS = new Set([
  '--charset', '--filelimit', '--output', '--sort', '--timefmt',
]);
const LESS_TAG_OPTIONS = new Set(['T']);
const LESS_OUTPUT_OPTIONS = new Set(['o', 'O']);
const TREE_OUTPUT_OPTIONS = new Set(['o']);

interface ShortOptionValue {
  readonly matched: boolean;
  readonly attachedValue?: string;
}

function shortOptionValue(
  token: string,
  targets: ReadonlySet<string>,
  valueOptions: ReadonlySet<string>,
): ShortOptionValue {
  if (!/^-[^-]/.test(token)) return { matched: false };
  const body = token.slice(1);
  for (let index = 0; index < body.length; index += 1) {
    const option = body[index] ?? '';
    if (targets.has(option)) {
      const attachedValue = body.slice(index + 1) || undefined;
      return attachedValue === undefined
        ? { matched: true }
        : { matched: true, attachedValue };
    }
    if (valueOptions.has(option)) return { matched: false };
  }
  return { matched: false };
}

function powerShellReadPathOperands(stage: BashPipelineStage): readonly PowerShellReadPathOperand[] {
  const executable = canonicalPowerShellReadExecutable(stage);
  if (!executable) return [];
  const operands: PowerShellReadPathOperand[] = [];
  let selectStringPatternBound = false;
  for (let index = 1; index < stage.argv.length; index += 1) {
    const token = stage.argv[index] ?? '';
    const attached = parseAttachedPowerShellReadParameter(executable, token);
    if (attached) {
      if (attached.name === 'path' || attached.name === 'literalpath') {
        operands.push({ value: attached.value, literal: attached.name === 'literalpath' });
      }
      if (executable === 'select-string' && attached.name === 'pattern') {
        selectStringPatternBound = true;
      }
      continue;
    }
    const parameter = resolvePowerShellReadParameter(executable, token);
    if (parameter) {
      if (POWERSHELL_SWITCH_PARAMETERS.has(parameter)) continue;
      const value = stage.argv[index + 1];
      if (value && (parameter === 'path' || parameter === 'literalpath')) {
        operands.push({ value, literal: parameter === 'literalpath' });
      }
      if (executable === 'select-string' && parameter === 'pattern') {
        selectStringPatternBound = true;
      }
      index += 1;
      continue;
    }
    const commonConsumesValue = powerShellCommonParameterConsumesValue(token);
    if (commonConsumesValue !== undefined) {
      if (commonConsumesValue) index += 1;
      continue;
    }
    if (token.startsWith('-')) continue;
    if (executable === 'select-string' && !selectStringPatternBound) {
      selectStringPatternBound = true;
      continue;
    }
    operands.push({ value: token, literal: false });
  }
  return operands;
}

function positionalContentReadPathOperands(
  stage: BashPipelineStage,
): readonly PowerShellReadPathOperand[] {
  const executable = shellExecutable(stage);
  if (!POSITIONAL_READ_COMMANDS.has(executable)) return [];
  const operands: PowerShellReadPathOperand[] = [];
  const valueParameters = POSITIONAL_CONTENT_READ_VALUE_PARAMETERS[executable];
  let optionsEnded = false;
  for (let index = 1; index < stage.argv.length; index += 1) {
    const token = stage.argv[index] ?? '';
    if (executable === 'less') {
      const shortTagFile = shortOptionValue(token, LESS_TAG_OPTIONS, LESS_SHORT_VALUE_OPTIONS);
      if (shortTagFile.matched) {
        const tagFile = shortTagFile.attachedValue ?? stage.argv[index + 1];
        if (tagFile) operands.push({ value: tagFile, literal: false });
        if (shortTagFile.attachedValue === undefined) index += 1;
        continue;
      }
      if (gitLongOptionMatches(token, '--tag-file')) {
        const separator = token.indexOf('=');
        const tagFile = separator >= 0 ? token.slice(separator + 1) : stage.argv[index + 1];
        if (tagFile) operands.push({ value: tagFile, literal: false });
        if (separator < 0) index += 1;
        continue;
      }
    }
    if (!optionsEnded && token === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && valueParameters?.has(token)) {
      index += 1;
      continue;
    }
    if (!optionsEnded && (token.startsWith('-') || /^\/[a-z]+(?::[^\\/]+)?$/i.test(token))) {
      continue;
    }
    if (executable === 'more' && /^\+\d+$/.test(token)) continue;
    operands.push({ value: token, literal: false });
  }
  return operands;
}

function modeledContentReadPathOperands(
  tree: BashCommandTree,
): readonly PowerShellReadPathOperand[] {
  const operands: PowerShellReadPathOperand[] = [];
  for (const statement of tree.statements) {
    for (const stage of statement.stages) {
      const canonical = canonicalPowerShellReadExecutable(stage);
      if (canonical === 'get-content' || canonical === 'select-string') {
        operands.push(...powerShellReadPathOperands(stage));
      } else {
        operands.push(...positionalContentReadPathOperands(stage));
        operands.push(...gitContentReadPathOperands(stage));
        operands.push(...commandFileListPathOperands(stage));
      }
    }
  }
  return operands;
}

function commandFileListPathOperands(
  stage: BashPipelineStage,
): readonly PowerShellReadPathOperand[] {
  const executable = shellExecutable(stage);
  if (executable === 'tree') return treeFileListPathOperands(stage.argv);
  if (executable !== 'find') return [];
  const operands: PowerShellReadPathOperand[] = [];
  for (let index = 1; index < stage.argv.length; index += 1) {
    const token = stage.argv[index] ?? '';
    const attached = /^--?files0-from=(.*)$/i.exec(token);
    if (attached) {
      if (attached[1]) operands.push({ value: attached[1], literal: false });
      continue;
    }
    if (/^--?files0-from$/i.test(token)) {
      const value = stage.argv[index + 1];
      if (value) operands.push({ value, literal: false });
      index += 1;
    }
  }
  return operands;
}

function treeFileListPathOperands(
  argv: readonly string[],
): readonly PowerShellReadPathOperand[] {
  const attachedInputs = argv.slice(1).flatMap((token) => {
    const match = /^--from(?:tab)?file=(.*)$/i.exec(token);
    return match?.[1] ? [match[1]] : [];
  });
  const fromFileMode = attachedInputs.length > 0
    || argv.slice(1).some((token) => /^--from(?:tab)?file$/i.test(token));
  if (!fromFileMode) return [];

  const inputs = [...attachedInputs];
  let optionsEnded = false;
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    if (/^--from(?:tab)?file(?:=|$)/i.test(token)) continue;
    if (token === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded) {
      const shortValue = shortOptionValue(
        token,
        TREE_ALL_SHORT_VALUE_OPTIONS,
        TREE_ALL_SHORT_VALUE_OPTIONS,
      );
      if (shortValue.matched) {
        if (shortValue.attachedValue === undefined) index += 1;
        continue;
      }
      const longName = token.split('=', 1)[0]?.toLowerCase() ?? '';
      if (TREE_LONG_VALUE_OPTIONS.has(longName)) {
        if (!token.includes('=')) index += 1;
        continue;
      }
      if (token.startsWith('-')) continue;
    }
    inputs.push(token);
  }
  return inputs.map((value) => ({ value, literal: false }));
}

function environmentProviderName(selector: string): string | undefined {
  const match = /^(?:env:|environment::|microsoft\.powershell\.core(?:\\)?environment::|microsoft\.powershell\.coreenvironment::)[\\/]?(.*)$/i
    .exec(selector.trim());
  return match?.[1];
}

function variableProviderName(selector: string): string | undefined {
  const match = /^(?:variable:|microsoft\.powershell\.core(?:\\)?variable::|microsoft\.powershell\.corevariable::)[\\/]?(.*)$/i
    .exec(selector.trim());
  return match?.[1];
}

function nonFileSystemPowerShellProvider(selector: string): string | undefined {
  const trimmed = selector.trim();
  // PowerShell accepts both drive-rooted (`C:\x`) and drive-relative
  // (`C:x`) FileSystem paths. shell-quote may remove the separators from an
  // unquoted drive-rooted path, so a single-letter drive prefix must never be
  // reinterpreted as a custom provider name.
  if (/^[a-z]:/i.test(trimmed)) return undefined;
  // The POSIX tokenizer removes the provider qualifier's backslash. Reuse the
  // provider-aware parsers before treating the result as a generic provider.
  if (environmentProviderName(trimmed) !== undefined
    || variableProviderName(trimmed) !== undefined) return undefined;
  const qualified = /^(?:microsoft\.powershell\.core\\)?([a-z][\w.-]*)::/i.exec(trimmed);
  const drive = /^([a-z][\w.-]*):/i.exec(trimmed);
  const provider = (qualified?.[1] ?? drive?.[1])?.toLowerCase();
  if (!provider || ['environment', 'env', 'filesystem', 'variable'].includes(provider)) {
    return undefined;
  }
  return provider;
}

function sensitiveProviderSelector(name: string, literal: boolean): boolean {
  if (!name) return true;
  if (!literal && /[*?\[\]{}]/.test(name)) return true;
  return SENSITIVE_ENV_NAME.test(name) || !SAFE_PROCESS_DATA_NAME.test(name);
}

function powerShellVariableSelectors(stage: BashPipelineStage): readonly string[] {
  if (canonicalPowerShellReadExecutable(stage) !== 'get-variable') return [];
  const selectors: string[] = [];
  for (let index = 1; index < stage.argv.length; index += 1) {
    const token = stage.argv[index] ?? '';
    const attached = parseAttachedPowerShellReadParameter('get-variable', token);
    if (attached) {
      if (attached.name === 'name' || attached.name === 'include') {
        selectors.push(attached.value);
      }
      continue;
    }
    const parameter = resolvePowerShellReadParameter('get-variable', token);
    if (parameter) {
      if (parameter === 'valueonly') continue;
      const value = stage.argv[index + 1];
      if (value && (parameter === 'name' || parameter === 'include')) selectors.push(value);
      index += 1;
      continue;
    }
    const commonConsumesValue = powerShellCommonParameterConsumesValue(token);
    if (commonConsumesValue !== undefined) {
      if (commonConsumesValue) index += 1;
      continue;
    }
    if (!token.startsWith('-')) selectors.push(token);
  }
  return selectors;
}

function sensitivePowerShellVariableRead(stage: BashPipelineStage): boolean {
  if (canonicalPowerShellReadExecutable(stage) !== 'get-variable') return false;
  const selectors = powerShellVariableSelectors(stage);
  return selectors.length === 0 || selectors.some((value) => (
    value.split(',').some((name) => sensitiveProviderSelector(name, false))
  ));
}

function sensitivePowerShellEnvironmentRead(stage: BashPipelineStage): boolean {
  return powerShellReadPathOperands(stage).some(({ value, literal }) => (
    value.split(',').some((selector) => {
      const environmentName = environmentProviderName(selector);
      if (environmentName !== undefined) {
        return sensitiveProviderSelector(environmentName, literal);
      }
      const variableName = variableProviderName(selector);
      return variableName !== undefined && sensitiveProviderSelector(variableName, literal);
    })
  ));
}

function sensitivePowerShellProcessDataRead(stage: BashPipelineStage): boolean {
  return powerShellReadPathOperands(stage).some(({ value }) => (
    value.split(',').some((selector) => nonFileSystemPowerShellProvider(selector) !== undefined)
  ));
}

function sensitivePowerShellPipelineProviderRead(tree: BashCommandTree): boolean {
  const pipelineBoundPathCommands = new Set(['get-childitem', 'get-item', 'get-content']);
  return tree.statements.some((statement) => statement.stages.some((stage, index) => {
    const executable = canonicalPowerShellReadExecutable(stage);
    return index > 0
      && executable !== undefined
      && pipelineBoundPathCommands.has(executable)
      && powerShellReadPathOperands(stage).length === 0;
  }));
}

/** Resolve symlinks/junctions through the deepest existing path prefix. */
export function canonicalizeAutoModePath(
  targetPath: string,
  baseDir?: string,
): string | undefined {
  if (!targetPath.trim() || targetPath.includes('\0')) return undefined;
  const expanded = expandPermissionPath(targetPath);
  if (process.platform === 'win32' && /^[a-z]:[^\\/]/i.test(expanded)) return undefined;
  const resolved = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(baseDir ?? process.cwd(), expanded);
  const suffix: string[] = [];
  let current = resolved;

  for (;;) {
    try {
      fs.lstatSync(current);
    } catch (error) {
      const code = error instanceof Error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
      if (code !== 'ENOENT') return undefined;
      const parent = path.dirname(current);
      if (parent === current) return undefined;
      suffix.unshift(path.basename(current));
      current = parent;
      continue;
    }
    try {
      return path.join(fs.realpathSync.native(current), ...suffix);
    } catch {
      // A broken link or inaccessible existing prefix must never be treated
      // as a lexical in-workspace path.
      return undefined;
    }
  }
}

function canonicalizeExistingDirectory(targetPath: string): string | undefined {
  if (!targetPath.trim()) return undefined;
  try {
    const resolved = path.resolve(expandPermissionPath(targetPath));
    if (!fs.statSync(resolved).isDirectory()) return undefined;
    return fs.realpathSync.native(resolved);
  } catch {
    return undefined;
  }
}

function canonicalTempDirectories(): string[] {
  const candidates = [
    os.tmpdir(),
    process.env.TEMP,
    process.env.TMP,
    process.env.TMPDIR,
    process.platform === 'win32'
      ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Temp')
      : '/tmp',
    ...(process.platform === 'win32' ? [] : ['/var/tmp']),
  ];
  const result = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate?.trim()) continue;
    const canonical = canonicalizeExistingDirectory(candidate);
    if (canonical) result.add(canonical);
  }
  return [...result];
}

function hasWindowsDeviceComponent(targetPath: string): boolean {
  if (process.platform !== 'win32') return false;
  return targetPath.split(/[\\/]+/).some((part) => {
    const lower = part.toLowerCase();
    if (!lower || lower === '.' || lower === '..' || /^[a-z]:$/i.test(lower)) return false;
    const streamSeparator = lower.indexOf(':');
    const withoutStream = streamSeparator >= 0 ? lower.slice(0, streamSeparator) : lower;
    const basename = withoutStream.replace(/[ .]+$/g, '').split('.', 1)[0] ?? '';
    return /^(?:con|prn|aux|clock\$|conin\$|conout\$|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])$/i.test(basename);
  });
}

const canonicalizePath = canonicalizeAutoModePath;

function hasSensitiveCredentialLocation(parts: readonly string[]): boolean {
  return parts.some((part, index) => (
    (part === '.m2' && ['settings.xml', 'settings-security.xml'].includes(parts[index + 1] ?? ''))
    || (part === '.gradle' && parts[index + 1] === 'gradle.properties')
    || (part === '.nuget' && parts.slice(index + 1).includes('nuget.config'))
    || (part === '.pip' && parts[index + 1] === 'pip.conf')
    || (part === '.huggingface' && parts[index + 1] === 'token')
    || (part === '.cache' && parts[index + 1] === 'huggingface' && parts[index + 2] === 'token')
    || (part === '.config' && parts[index + 1] === 'pip' && parts[index + 2] === 'pip.conf')
    || (part === '.config' && parts[index + 1] === 'rclone' && parts[index + 2] === 'rclone.conf')
    || (part === '.config' && parts[index + 1] === 'pypoetry'
      && parts[index + 2] === 'auth.toml')
    || (part === '.config' && parts[index + 1] === 'fish'
      && ['config.fish', 'fish_variables'].includes(parts[index + 2] ?? ''))
    || (part === '.local' && parts[index + 1] === 'share' && parts[index + 2] === 'keyrings')
    || (part === 'library' && parts[index + 1] === 'keychains')
    || (part === 'appdata' && ['local', 'roaming'].includes(parts[index + 1] ?? '')
      && parts[index + 2] === 'microsoft'
      && ['credentials', 'protect', 'vault'].includes(parts[index + 3] ?? ''))
  ));
}

function isSensitiveProcProcessData(parts: readonly string[]): boolean {
  if (parts[0] !== '' || parts[1] !== 'proc') return false;
  const processSelector = parts[2] ?? '';
  if (!/^(?:self|thread-self|\d+)$/.test(processSelector)) return false;
  const sensitiveEntry = (index: number): boolean => (
    /^(?:environ|cmdline|mem|auxv|maps|fd|fdinfo)$/.test(parts[index] ?? '')
  );
  if (sensitiveEntry(3)) return true;
  return parts[3] === 'task'
    && /^\d+$/.test(parts[4] ?? '')
    && sensitiveEntry(5);
}

function isSensitivePath(targetPath: string): boolean {
  const parts = targetPath.split(/[\\/]+/).map((part) => {
    const lower = part.toLowerCase();
    if (process.platform !== 'win32' || lower === '.' || lower === '..'
      || /^[a-z]:$/i.test(lower)) return lower;
    const streamSeparator = lower.indexOf(':');
    const basename = streamSeparator >= 0 ? lower.slice(0, streamSeparator) : lower;
    return basename.replace(/[ .]+$/g, '');
  });
  const basename = parts.at(-1) ?? '';
  const sensitiveEnvironmentFile = !ENV_TEMPLATE_FILES.has(basename)
    && (basename === '.env' || basename.startsWith('.env.'));
  const processDataFile = isSensitiveProcProcessData(parts);
  const repositoryGitConfig = parts.some((part, index) => (
    part === '.git'
    && (parts[index + 1] === 'config'
      || parts[index + 1] === 'config.worktree'
      || (parts[index + 1] === 'worktrees' && parts[index + 3] === 'config.worktree'))
  ));
  const userGitConfig = parts.some((part, index) => (
    part === '.config' && parts[index + 1] === 'git' && parts[index + 2] === 'config'
  ));
  const cargoCredentials = parts.some((part, index) => (
    part === '.cargo' && parts[index + 1] === 'credentials.toml'
  ));
  return processDataFile
    || repositoryGitConfig
    || userGitConfig
    || cargoCredentials
    || hasSensitiveCredentialLocation(parts)
    || basename === '.gitconfig'
    || basename === '.gitmodules'
    || parts.some((part) => SENSITIVE_PATH_PARTS.has(part))
    || parts.some((part) => SENSITIVE_FILES.has(part))
    || sensitiveEnvironmentFile
    || parts.some((part) => /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/.test(part))
    || parts.some((part, index) => (
      part === '.config'
      && (parts[index + 1] === 'gcloud'
        || parts[index + 1] === 'gh'
        || parts[index + 1] === 'openai'
        || parts[index + 1] === 'anthropic')
    ));
}

function isProtectedAgentHome(targetPath: string): boolean {
  try {
    const agentHome = canonicalizePath(getAgentConfigHome());
    return agentHome !== undefined && isPathInsideDirectory(targetPath, agentHome);
  } catch {
    return true;
  }
}

/**
 * Credential- and security-control-bearing subset of the user KodaX home
 * (`~/.kodax/`). After the read-side narrowing only these paths remain
 * `protected` for reads; every other `~/.kodax/` path is deterministically
 * readable. Writes use the narrower root/Runtime/credential hard boundary in
 * `checkUserKodaxWrite` independently of this classification.
 *
 * `target` is a resolved absolute path inside `agentHome`.
 */
export function isCredentialBearingKodaxPath(target: string, agentHome: string, forWrite = false): boolean {
  const relNorm = normalizedAgentHomeRelativePath(target, agentHome);
  if (relNorm === undefined) return false;
  // OAuth / daemon credential stores (plaintext tokens / client secrets).
  if (relNorm === 'mcp-tokens' || relNorm.startsWith('mcp-tokens/')) return true;
  if (relNorm === 'mcp-clients' || relNorm.startsWith('mcp-clients/')) return true;
  // Integration declarations may carry literal secrets. ${env:NAME} in
  // env/headers is expanded at transport creation (transport.ts), but other
  // fields + plaintext may still appear - keep protected as defense in depth.
  if (relNorm === 'integrations' || relNorm.startsWith('integrations/')) return true;
  // Core config may carry legacy literal MCP server secrets (env/headers/auth).
  if (relNorm === 'config.json') return true;
  // Authorization / trust control files.
  if (relNorm === 'trusted-project-rules.json') return true;
  if (relNorm === 'runtime/permission-grants.json') return true;
  if (relNorm.startsWith('runtime/daemon/')) return true;
  // custom-providers.json: read-open (apiKeyEnv only), write-protected
  // (adding a provider can point at a malicious endpoint - exfiltration risk).
  if (forWrite && relNorm === 'custom-providers.json') return true;
  // Generic credential filename anywhere under ~/.kodax (defense-in-depth).
  if (path.basename(relNorm) === 'credentials.json') return true;
  return false;
}

function normalizedAgentHomeRelativePath(target: string, agentHome: string): string | undefined {
  const rel = path.relative(agentHome, target);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  return rel.split(/[\\/]+/).map((segment) => {
    const lower = segment.toLowerCase();
    if (process.platform !== 'win32') return lower;
    const streamSeparator = lower.indexOf(':');
    const basename = streamSeparator >= 0 ? lower.slice(0, streamSeparator) : lower;
    return basename.replace(/[ .]+$/g, '');
  }).join('/');
}

/** Agent-home descendants that are safe to read without confirmation. */
export function isAutoReadableKodaxPath(target: string, agentHome: string): boolean {
  return isAutoReadableAgentHomePath(target, agentHome);
}

/**
 * Agent-home descendants that tools may mutate directly. The home root,
 * Runtime control plane, credentials, and generic sensitive files remain
 * protected; ordinary Agent definitions and working artifacts stay writable.
 */
export function isAutoWritableKodaxPath(target: string, agentHome: string): boolean {
  return isAutoWritableAgentHomePath(target, agentHome);
}

/**
 * Read-side narrowing for the user KodaX home. Resolves `targetPath` the same
 * way `classifyTarget` does and, when it confidently lands inside
 * `getAgentConfigHome()`, classifies it by protected subsets. Credential,
 * control, ancestor, and generic sensitive paths stay protected.
 * Returns `undefined` when the path cannot be confidently
 * resolved to the user home, so the caller falls through to the conservative
 * lexical `isSensitivePath` logic -- which still protects project
 * `<root>/.kodax/` and other CLI homes (`.codex` / `.claude` / ...).
 */
function classifyAgentHomeTarget(
  targetPath: string,
  context: AutoModeRulesContext,
  literalWildcards: boolean,
): AutoModePermissionTarget | undefined {
  let agentHome: string | undefined;
  try {
    agentHome = canonicalizePath(getAgentConfigHome());
  } catch {
    return undefined;
  }
  if (!agentHome) return undefined;
  const normalized = literalWildcards
    ? normalizeLiteralShellTarget(targetPath)
    : normalizeShellTarget(targetPath);
  if (!normalized) return undefined;
  const executionCwd = canonicalizeExistingDirectory(context.executionCwd);
  if (!executionCwd) return undefined;
  const target = canonicalizePath(normalized, executionCwd);
  if (!target) return undefined;
  if (!isPathInsideDirectory(target, agentHome)) return undefined;
  if (!isAutoReadableKodaxPath(target, agentHome)) {
    return { path: targetPath, boundary: 'protected' };
  }
  return {
    path: targetPath,
    boundary: isAutoWritableKodaxPath(target, agentHome)
      ? 'agent-home'
      : 'agent-home-readonly',
  };
}

/**
 * Classifies a shell read target flagged as sensitive by `sensitivePathCandidate`.
 * Defers to the agent-home classification so ordinary data paths read without
 * a prompt while credentials and risky ancestors stay protected. Falls back
 * to `protected` when the path is not confidently under the user home
 * (unresolvable, wildcard, or another CLI home).
 */
function classifySensitiveReadTarget(
  targetPath: string,
  context: AutoModeRulesContext,
  literalWildcards = false,
): AutoModePermissionTarget {
  return classifyAgentHomeTarget(targetPath, context, literalWildcards)
    ?? { path: targetPath, boundary: 'protected' };
}

function classifyTarget(
  targetPath: string,
  context: AutoModeRulesContext,
  literalWildcards = false,
): AutoModePermissionTarget {
  if (context.trustProcessEnvironmentPathExpansion === false
    && hasTempEnvironmentPathPrefix(targetPath)) {
    return { path: targetPath, boundary: 'unresolved' };
  }
  if (/^\\\\(?:[?.]\\|[^\\])/i.test(targetPath) || /^\\[?.]\\/i.test(targetPath)) {
    // UNC paths can perform network I/O and disclose Windows credentials;
    // extended/device namespaces can bypass ordinary filesystem boundaries.
    // Their semantics require classifier review instead of lexical path.resolve.
    return { path: targetPath, boundary: 'unresolved' };
  }
  if (hasWindowsDeviceComponent(targetPath)) {
    return { path: targetPath, boundary: 'unresolved' };
  }
  // A path confidently inside the user KodaX home uses the dedicated
  // read/write boundaries above. Ordinary descendants remain usable while
  // credentials, Runtime mutations, and the home root stay protected. Fall
  // through to the lexical rule when the path is not confidently under the
  // user home (project <root>/.kodax/ and other CLI homes stay protected).
  const agentHomeTarget = classifyAgentHomeTarget(targetPath, context, literalWildcards);
  if (agentHomeTarget) return agentHomeTarget;
  if (isSensitivePath(targetPath)) return { path: targetPath, boundary: 'protected' };
  const normalized = literalWildcards
    ? normalizeLiteralShellTarget(targetPath)
    : normalizeShellTarget(targetPath);
  if (!normalized) return { path: targetPath, boundary: 'unresolved' };
  if (isSensitivePath(normalized)) return { path: targetPath, boundary: 'protected' };
  const executionCwd = canonicalizeExistingDirectory(context.executionCwd);
  const projectRoot = canonicalizeExistingDirectory(context.projectRoot);
  const target = executionCwd ? canonicalizePath(normalized, executionCwd) : undefined;
  if (!target || !projectRoot) return { path: targetPath, boundary: 'unresolved' };
  if (isSensitivePath(target) || isProtectedAgentHome(target)) {
    return { path: targetPath, boundary: 'protected' };
  }
  if (isPathInsideDirectory(target, projectRoot)) {
    return { path: targetPath, boundary: 'workspace' };
  }
  if (canonicalTempDirectories().some((tempDir) => isPathInsideDirectory(target, tempDir))) {
    return { path: targetPath, boundary: 'system-temp' };
  }
  return { path: targetPath, boundary: 'outside-workspace' };
}

function isExistingDirectoryTarget(
  targetPath: string,
  context: AutoModeRulesContext,
): boolean {
  const canonical = canonicalizePath(targetPath, context.executionCwd);
  if (!canonical) return false;
  try {
    return fs.statSync(canonical).isDirectory();
  } catch {
    return false;
  }
}

function isAllowedMutationTarget(target: AutoModePermissionTarget): boolean {
  return target.boundary === 'workspace' || target.boundary === 'system-temp' || target.boundary === 'agent-home';
}

function shellExecutable(stage: BashPipelineStage): string {
  return (stage.argv[0] ?? '').replace(/\\/g, '/').split('/').at(-1)?.toLowerCase() ?? '';
}

function hasOnlyModeledShellStages(tree: BashCommandTree): boolean {
  if (tree.unparseable || tree.statements.length === 0) return false;
  return tree.statements.every((statement) => (
    statement.stages.length > 0
    && statement.stages.every((stage) => (
      !hasDynamicPowerShellParameterBinding(stage)
      && (
        TARGETED_WRITE_COMMANDS.has(shellExecutable(stage))
        || isGlobalGitConfigMutationStage(stage)
        || canonicalPowerShellReadExecutable(stage) !== undefined
        || isShellReadOnlyArgv(stage.argv)
      )
    ))
  ));
}

function isModeledShellReadCommand(command: string, tree: BashCommandTree): boolean {
  if (isBashReadCommand(command)) return true;
  return hasOnlyModeledShellStages(tree)
    && tree.statements.some((statement) => statement.stages.some(
      (stage) => canonicalPowerShellReadExecutable(stage) !== undefined,
    ));
}

function hasWriteCapableReadSyntax(tree: BashCommandTree): boolean {
  for (const statement of tree.statements) {
    for (const stage of statement.stages) {
      const argv = stage.argv.map((token) => token.toLowerCase());
      const executable = shellExecutable(stage);
      if (executable === 'find' && argv.some((token) => (
        token === '-delete' || token === '-exec' || token === '-execdir'
        || token === '-ok' || token === '-okdir'
      ))) {
        return true;
      }
      if (executable !== 'git') continue;

      const subcommandIndex = findGitSubcommandIndex(stage.argv);
      if (subcommandIndex === undefined) continue;
      const subcommand = argv[subcommandIndex];
      const args = stage.argv.slice(subcommandIndex + 1);
      if (subcommand === 'grep' && args.some((token) => (
        gitLongOptionMatches(token, '--open-files-in-pager')
        || gitLongOptionMatches(token, '--ext-grep')
      ))) return true;
      if (subcommand === 'remote') {
        const action = args.find((token) => !token.startsWith('-'))?.toLowerCase();
        if (action && GIT_REMOTE_WRITE_ACTIONS.has(action)) return true;
      }
      if (subcommand === 'branch') {
        if (args.some((token) => GIT_BRANCH_WRITE_FLAGS.has(token.toLowerCase()))) return true;
        if (args[0] && !args[0].startsWith('-')) return true;
      }
      if (subcommand === 'tag') {
        if (args.some((token) => GIT_TAG_WRITE_FLAGS.has(token.toLowerCase())
          || token.toLowerCase().startsWith('--message=')
          || token.toLowerCase().startsWith('--file='))) return true;
        const listsTags = args.some((token) => token === '-l' || token === '--list');
        if (!listsTags && args[0] && !args[0].startsWith('-')) return true;
      }
    }
  }
  return false;
}

function assessFileCall(
  input: Readonly<Record<string, unknown>>,
  context: AutoModeRulesContext,
): AutoModePermissionReview {
  const targetPath = typeof input.path === 'string' ? input.path : '';
  if (!targetPath) {
    return review('incomplete', 'tool', [], ['target_unresolved'], 'file target is missing');
  }
  const operation: AutoModePermissionOperation = {
    kind: 'write', target: classifyTarget(targetPath, context),
  };
  const complete = operation.target.boundary !== 'unresolved';
  return review(
    complete ? 'complete' : 'incomplete',
    'tool',
    [operation],
    collectRisks([operation]),
    complete ? undefined : 'file target could not be resolved safely',
  );
}

function readToolTarget(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
  context: AutoModeRulesContext,
): string {
  const searchFilter = toolName === 'glob' ? input.pattern : input.glob;
  if (typeof searchFilter === 'string') {
    const sensitive = sensitiveSearchSelectorCandidate(searchFilter);
    if (sensitive) return sensitive;
  }
  const targetPath = typeof input.path === 'string' && input.path.trim()
    ? input.path
    : toolName === 'read' ? '' : context.executionCwd;
  return targetPath;
}

function agentHomeSearchHasProtectedDescendant(
  targetPath: string,
  context: AutoModeRulesContext,
  selector?: string,
  traverseSelectedDirectories = false,
): boolean {
  let agentHome: string | undefined;
  try {
    agentHome = canonicalizePath(getAgentConfigHome());
  } catch {
    return true;
  }
  const searchRoot = canonicalizePath(targetPath, context.executionCwd);
  if (agentHome === undefined || searchRoot === undefined) return true;
  if (isPathInsideDirectory(agentHome, searchRoot)) return true;
  if (!isPathInsideDirectory(searchRoot, agentHome)) return false;
  if (!isAutoReadableKodaxPath(searchRoot, agentHome)) return true;

  const pending = [{ directory: searchRoot, selectedByAncestor: false }];
  let visited = 0;
  while (pending.length > 0) {
    const { directory, selectedByAncestor } = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return true;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited > 20_000) return true;
      const candidate = path.join(directory, entry.name);
      const relative = path.relative(searchRoot, candidate).replace(/\\/g, '/');
      const selected = selectedByAncestor || selector === undefined || minimatch(relative, selector, {
        dot: false,
        nocase: process.platform === 'win32',
      });
      if (selected) {
        const canonical = canonicalizePath(candidate);
        if (canonical === undefined
          || !isPathInsideDirectory(canonical, agentHome)
          || !isAutoReadableKodaxPath(canonical, agentHome)) return true;
      }
      if (entry.isDirectory()) {
        pending.push({
          directory: candidate,
          selectedByAncestor: selectedByAncestor
            || (traverseSelectedDirectories && selected),
        });
        continue;
      }
    }
  }
  return false;
}

interface EffectiveGlobSearch {
  readonly root?: string;
  readonly selector?: string;
  readonly unsafe: boolean;
}

function firstGlobSegmentIndex(segments: readonly string[]): number {
  const index = segments.findIndex((segment) => /[*?\[\]{}()!]/.test(segment));
  return index < 0 ? segments.length : index;
}

function resolveEffectiveGlobSearch(
  targetPath: string,
  pattern: string,
  context: AutoModeRulesContext,
): EffectiveGlobSearch {
  const expandedPattern = expandPermissionPath(pattern);
  const segments = expandedPattern.replace(/\\/g, '/').split('/');
  const firstGlob = firstGlobSegmentIndex(segments);
  const parentIndex = segments.indexOf('..');
  const hasAmbiguousParentTraversal = /(^|[/,{(])\.\.(?=$|[/},)])/u.test(expandedPattern);
  if (hasAmbiguousParentTraversal && parentIndex < 0) {
    return { unsafe: true };
  }
  if (parentIndex >= firstGlob) {
    return { unsafe: true };
  }
  if (!path.isAbsolute(expandedPattern) && parentIndex < 0) {
    return { root: targetPath, selector: expandedPattern, unsafe: false };
  }
  const literalPrefix = segments.slice(0, firstGlob);
  const literalRoot = path.isAbsolute(expandedPattern)
    ? literalPrefix.join(path.sep)
    : path.join(targetPath, ...literalPrefix);
  const root = canonicalizePath(literalRoot, context.executionCwd);
  if (root === undefined) return { unsafe: true };
  const selector = segments.slice(firstGlob).join('/') || undefined;
  return { root, selector, unsafe: false };
}

function classifyExpandedReadTarget(
  selectorPath: string,
  context: AutoModeRulesContext,
): AutoModePermissionTarget {
  const effective = resolveEffectiveGlobSearch(context.executionCwd, selectorPath, context);
  const root = effective.root ?? context.executionCwd;
  if (effective.unsafe
    || agentHomeSearchHasProtectedDescendant(root, context, effective.selector)) {
    return { path: selectorPath, boundary: 'protected' };
  }
  return classifyTarget(root, context);
}

function classifyMutationSelectorTarget(
  targetPath: string,
  context: AutoModeRulesContext,
): AutoModePermissionTarget {
  if (!hasShellReadExpansion(targetPath)) return classifyTarget(targetPath, context);
  const effective = resolveEffectiveGlobSearch(context.executionCwd, targetPath, context);
  if (effective.unsafe || effective.root === undefined
    || agentHomeSearchHasProtectedDescendant(
      effective.root,
      context,
      effective.selector,
    )) return { path: targetPath, boundary: 'protected' };
  return classifyTarget(effective.root, context);
}

function assessReadFileCall(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
  context: AutoModeRulesContext,
): AutoModePermissionReview {
  const targetPath = readToolTarget(toolName, input, context);
  if (!targetPath) {
    return review('incomplete', 'tool', [], ['target_unresolved'], 'read target is missing');
  }
  const globPattern = toolName === 'glob' && typeof input.pattern === 'string'
    ? input.pattern
    : toolName === 'grep' && typeof input.glob === 'string'
      ? input.glob
      : undefined;
  const effectiveSearch = globPattern === undefined
    ? { root: targetPath, selector: undefined, unsafe: false }
    : resolveEffectiveGlobSearch(targetPath, globPattern, context);
  const searchRoot = effectiveSearch.root ?? targetPath;
  const directTarget = classifyTarget(searchRoot, context);
  const recursiveSearch = toolName !== 'read' && isExistingDirectoryTarget(searchRoot, context);
  const searchProtected = effectiveSearch.unsafe || (recursiveSearch
    && agentHomeSearchHasProtectedDescendant(
      searchRoot,
      context,
      effectiveSearch.selector,
    ));
  const operation: AutoModePermissionOperation = {
    kind: 'read',
    target: searchProtected
      ? { path: targetPath, boundary: 'protected' }
      : directTarget,
  };
  const complete = operation.target.boundary !== 'unresolved';
  return review(
    complete ? 'complete' : 'incomplete',
    'tool',
    [operation],
    collectRisks([operation]),
    complete ? undefined : 'read target could not be resolved safely',
  );
}

function maskSingleQuotedDollarReferences(command: string): string {
  let singleQuoted = false;
  let doubleQuoted = false;
  return [...command].map((character) => {
    if (character === '"' && !singleQuoted) {
      doubleQuoted = !doubleQuoted;
      return character;
    }
    if (character === "'" && !doubleQuoted) {
      singleQuoted = !singleQuoted;
      return ' ';
    }
    return singleQuoted ? ' ' : character;
  }).join('');
}

function sensitiveEnvironmentRead(command: string, tree: BashCommandTree): boolean {
  const expandableDollarText = maskSingleQuotedDollarReferences(command);
  if (/\$\{!/.test(expandableDollarText)) return true;
  const shellReferences = expandableDollarText.matchAll(
    /\$(?:\{)?(?:(env|variable|global|script|local|private|using):)?([a-z_][a-z0-9_]*)(?:\})?/gi,
  );
  if ([...shellReferences].some((match) => {
    const name = match[2] ?? '';
    return SENSITIVE_ENV_NAME.test(name) || !SAFE_PROCESS_DATA_NAME.test(name);
  })) return true;
  // Bare `Env:NAME` is also ordinary search/output text. Actual PowerShell
  // variable expansion (`$env:NAME`) was handled above, while provider reads
  // are recognized structurally from cmdlet path operands below.
  const environmentReferences = [
    ...command.matchAll(/%([a-z_][a-z0-9_]*)(?::[^%\r\n]*)?%/gi),
  ];
  if (environmentReferences.some((match) => (
    !SAFE_PROCESS_DATA_NAME.test(match[1] ?? '')
  ))) {
    return true;
  }
  if (sensitivePowerShellPipelineProviderRead(tree)) return true;
  return tree.statements.some((statement) => statement.stages.some((stage) => {
    const executable = shellExecutable(stage);
    if (sensitivePowerShellEnvironmentRead(stage)) return true;
    if (sensitivePowerShellVariableRead(stage)) return true;
    if (executable === 'git' && sensitiveGitConfigRead(stage.argv)) return true;
    if (executable === 'git' && sensitiveGitRemoteRead(stage.argv)) return true;
    if (executable !== 'env' && executable !== 'printenv') return false;
    const names = stage.argv.slice(1).filter((token) => !token.startsWith('-'));
    return names.length === 0 || names.some((name) => SENSITIVE_ENV_NAME.test(name));
  }));
}

function sensitiveGitRemoteRead(argv: readonly string[]): boolean {
  const subcommandIndex = findGitSubcommandIndex(argv);
  if (subcommandIndex === undefined || argv[subcommandIndex]?.toLowerCase() !== 'remote') {
    return false;
  }
  const args = argv.slice(subcommandIndex + 1);
  const action = args.find((token) => !token.startsWith('-'))?.toLowerCase();
  if (action === 'get-url' || action === 'show') return true;
  return action === undefined && args.some((token) => (
    token === '-v' || gitLongOptionMatches(token, '--verbose')
  ));
}

function sensitiveProcessDataRead(tree: BashCommandTree): boolean {
  return tree.statements.some((statement) => statement.stages.some(
    (stage) => sensitivePowerShellProcessDataRead(stage),
  ));
}

function looksLikePowerShell(command: string, tree: BashCommandTree): boolean {
  if (/^\s*&\s+|\$env:|\b(?:where-object|select-object)\b/i.test(command)) return true;
  return tree.statements.some((statement) => statement.stages.some((stage) => (
    (canonicalPowerShellReadExecutable(stage) === 'get-variable')
    || (canonicalPowerShellReadExecutable(stage) !== undefined
      && powerShellReadPathOperands(stage).some(({ value }) => (
        value.split(',').some((selector) => (
          environmentProviderName(selector) !== undefined
          || variableProviderName(selector) !== undefined
        ))
      )))
    ||
    /^(?:get|set|new|remove|copy|move|rename|select|where)-[a-z]+$/i.test(
      shellExecutable(stage),
    )
  )));
}

function sensitiveGitConfigRead(argv: readonly string[]): boolean {
  const subcommandIndex = findGitSubcommandIndex(argv);
  if (subcommandIndex === undefined || argv[subcommandIndex]?.toLowerCase() !== 'config') {
    return false;
  }
  const args = argv.slice(subcommandIndex + 1);
  const normalized = args.map((token) => token.toLowerCase());
  let namesOnly = false;
  for (const token of args) {
    if (gitLongOptionMatches(token, '--no-name-only')) namesOnly = false;
    else if (gitLongOptionMatches(token, '--name-only')) namesOnly = true;
  }
  const listsValues = normalized.some((token) => token === '--list' || token === '-l' || token === 'list')
    && !namesOnly;
  if (listsValues) return true;
  const readModeIndex = args.findIndex((token) => {
    const lower = token.toLowerCase();
    return ['--get', '--get-all', '--get-regexp', '--get-urlmatch', 'get'].includes(lower)
      || (lower !== '--get' && [
        '--get-all', '--get-regexp', '--get-urlmatch',
      ].some((option) => gitLongOptionMatches(token, option)));
  });
  if (readModeIndex < 0) return false;
  const readMode = normalized[readModeIndex];
  const readModeToken = args[readModeIndex] ?? '';
  const getArgs = args.slice(readModeIndex + 1);
  if (namesOnly) return false;
  const selector = args[readModeIndex + 1] ?? '';
  const regexpSelector = (readMode === '--get-regexp'
    || (readMode !== '--get' && gitLongOptionMatches(readModeToken, '--get-regexp')))
    ? selector
    : readMode === 'get' && getArgs.some((token) => gitLongOptionMatches(token, '--regexp'))
      ? gitConfigGetSelector(getArgs)
      : undefined;
  if (regexpSelector !== undefined
    && !SAFE_GIT_CONFIG_REGEXP_SELECTOR.test(regexpSelector)) return true;
  if ((readMode === '--get-urlmatch'
    || (readMode !== '--get' && gitLongOptionMatches(readModeToken, '--get-urlmatch')))
    && !selector.includes('.')) return true;
  if (readMode === 'get'
    && getArgs.some((token) => gitLongOptionMatches(token, '--url'))
    && !gitConfigGetSelector(getArgs).includes('.')) return true;
  return args.slice(readModeIndex + 1)
    .some((token) => (
      SENSITIVE_GIT_CONFIG_SELECTOR.test(token)
      || SENSITIVE_GIT_URL_SELECTOR.test(token)
    ));
}

function gitReadEmitsUnscopedContent(
  subcommand: string | undefined,
  args: readonly string[],
): boolean {
  if (subcommand !== 'diff' && subcommand !== 'log' && subcommand !== 'show') return false;
  let explicitPatch: boolean | undefined;
  let metadataOnly = false;
  let remergeDiff = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] ?? '';
    const lower = token.toLowerCase();
    if (/^-[^-]/.test(token)) {
      for (let index = 1; index < token.length; index += 1) {
        const option = token[index] ?? '';
        if (option === 's') explicitPatch = false;
        else if (option === 'p' || option === 'u' || option === 'c') explicitPatch = true;
        else if (option === 'U') {
          explicitPatch = true;
          break;
        } else if (option === 'L') {
          explicitPatch = true;
          break;
        } else if (option === 'S' || option === 'G'
          || option === 'B' || option === 'M' || option === 'C') break;
      }
    }
    if (lower === '-s' || gitLongOptionMatches(token, '--no-patch')) {
      explicitPatch = false;
      continue;
    }
    if (lower === '-p' || lower === '-u' || /^-u\d+$/.test(lower)
      || lower === '-c' || lower === '--cc'
      || [
        '--patch', '--patch-with-stat', '--patch-with-raw', '--word-diff',
        '--color-words', '--full-diff', '--binary', '--unified',
      ].some((option) => gitLongOptionMatches(token, option))) {
      explicitPatch = true;
      continue;
    }
    if (gitLongOptionMatches(token, '--remerge-diff')) {
      remergeDiff = true;
      continue;
    }
    if (gitLongOptionMatches(token, '--diff-merges')) {
      const separator = token.indexOf('=');
      const mode = separator >= 0 ? token.slice(separator + 1) : args[index + 1];
      remergeDiff = !mode || !/^(?:off|none)$/i.test(mode);
      if (separator < 0 && mode) index += 1;
      continue;
    }
    if (lower === '--stat' || lower === '--shortstat' || lower === '--numstat'
      || lower === '--name-only' || lower === '--name-status' || lower === '--summary'
      || lower === '--raw' || lower === '--compact-summary' || lower === '--quiet'
      || lower.startsWith('--dirstat')) {
      metadataOnly = true;
      remergeDiff = false;
    }
  }
  if (explicitPatch !== undefined) return explicitPatch;
  if (remergeDiff) return true;
  if (metadataOnly) return false;
  return subcommand === 'diff' || subcommand === 'show';
}

function gitStashShowEmitsContent(args: readonly string[]): boolean {
  if (args[0]?.toLowerCase() !== 'show') return false;
  const showArgs = args.slice(1);
  if (showArgs.some((token) => {
    const lower = token.toLowerCase();
    return lower === '-p'
      || lower === '-u'
      || /^-[^-]*[pu]/i.test(token)
      || gitLongOptionMatches(token, '--patch')
      || gitLongOptionMatches(token, '--include-untracked')
      || gitLongOptionMatches(token, '--only-untracked');
  })) return true;
  if (showArgs.some((token) => (
    token.toLowerCase() === '-s'
    || gitLongOptionMatches(token, '--no-patch')
    || gitLongOptionMatches(token, '--stat')
    || gitLongOptionMatches(token, '--shortstat')
    || gitLongOptionMatches(token, '--numstat')
    || gitLongOptionMatches(token, '--name-only')
    || gitLongOptionMatches(token, '--name-status')
    || gitLongOptionMatches(token, '--summary')
  ))) return false;
  // stash.showPatch and stash.showIncludeUntracked can change the default.
  // Only an explicit metadata-only flag proves that no file content is shown.
  return true;
}

function gitReadEmitsContent(
  subcommand: string | undefined,
  args: readonly string[],
): boolean {
  return subcommand === 'stash'
    ? gitStashShowEmitsContent(args)
    : gitReadEmitsUnscopedContent(subcommand, args);
}

function gitObjectPath(value: string): string | undefined {
  if (value.startsWith(':(') || value.startsWith(':/')) return undefined;
  const indexPath = /^:(?:[0-3]:)?(.+)$/.exec(value)?.[1];
  if (indexPath) return indexPath;
  const separator = value.indexOf(':');
  if (separator <= 0 || /^[a-z]:[\\/]/i.test(value)) return undefined;
  return value.slice(separator + 1) || undefined;
}

function normalizedGitPathspec(value: string): string | undefined {
  if (isExcludingGitPathspec(value)) return undefined;
  if (value.startsWith(':/')) return value.slice(2) || undefined;
  const magic = /^:\(([^)]*)\)(.*)$/s.exec(value);
  if (!magic) return value;
  const kinds = (magic[1] ?? '').split(',').map((kind) => kind.trim().toLowerCase());
  if (kinds.some((kind) => kind === 'exclude' || kind === '!')) return undefined;
  if (kinds.some((kind) => kind.startsWith('attr:'))) {
    return unresolvedSearchFilterTarget(`Git attribute pathspec ${value}`);
  }
  if (kinds.some((kind) => !['top', 'literal', 'glob', 'icase'].includes(kind))) {
    return unresolvedSearchFilterTarget(`Git pathspec magic ${value}`);
  }
  return magic[2] || undefined;
}

function gitContentReadPathOperands(
  stage: BashPipelineStage,
): readonly PowerShellReadPathOperand[] {
  if (shellExecutable(stage) !== 'git') return [];
  const subcommandIndex = findGitSubcommandIndex(stage.argv);
  if (subcommandIndex === undefined) return [];
  const subcommand = stage.argv[subcommandIndex]?.toLowerCase();
  const args = stage.argv.slice(subcommandIndex + 1);
  const emitsContent = subcommand === 'grep' || gitReadEmitsContent(subcommand, args);
  const operands: PowerShellReadPathOperand[] = [];
  let pathsOnly = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] ?? '';
    if (token === '--') {
      pathsOnly = true;
      continue;
    }
    if (pathsOnly) {
      if (emitsContent && !isExcludingGitPathspec(token)) {
        const pathspec = normalizedGitPathspec(token);
        if (pathspec) operands.push({ value: pathspec, literal: false });
      }
      continue;
    }
    if (subcommand === 'show') {
      const objectPath = gitObjectPath(token);
      if (objectPath) operands.push({ value: objectPath, literal: false });
    }
    if (subcommand === 'log' && (token === '-L' || token.startsWith('-L'))) {
      const range = token === '-L' ? args[++index] : token.slice(2);
      const lineTarget = range ? gitLineLogTarget(range) : undefined;
      if (lineTarget) operands.push({ value: lineTarget, literal: false });
    }
  }
  return operands;
}

function gitLineLogTarget(value: string): string | undefined {
  let inPattern = false;
  let escaped = false;
  const firstCandidate = value.startsWith(':') ? 1 : 0;
  for (let index = firstCandidate; index < value.length; index += 1) {
    const character = value[index] ?? '';
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '/') {
      inPattern = !inPattern;
      continue;
    }
    if (character === ':' && !inPattern) return value.slice(index + 1) || undefined;
  }
  return undefined;
}

function gitLongOptionMatches(token: string, fullName: string): boolean {
  const separator = token.indexOf('=');
  const option = (separator >= 0 ? token.slice(0, separator) : token).toLowerCase();
  return option.startsWith('--') && option.length >= 3 && fullName.startsWith(option);
}

function gitConfigGetSelector(args: readonly string[]): string {
  const exactValueOptions = new Set(['-f', '-t']);
  const longValueOptions = [
    '--file', '--blob', '--value', '--url', '--type', '--default',
  ] as const;
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] ?? '';
    const lower = token.toLowerCase();
    if (exactValueOptions.has(lower)
      || longValueOptions.some((option) => gitLongOptionMatches(token, option))) {
      if (token.includes('=')) continue;
      index += 1;
      continue;
    }
    if (token.startsWith('-')) continue;
    positionals.push(token);
  }
  return positionals.length === 1 ? positionals[0]! : '';
}

function isExcludingGitPathspec(value: string): boolean {
  return /^:\((?:[^,)]*,)*(?:exclude|!)(?:[,)]|$)/i.test(value) || /^:!/.test(value);
}

function sensitivePathCandidate(value: string): string | undefined {
  if (isExcludingGitPathspec(value)) {
    return undefined;
  }
  if (isSensitivePath(value)) return value;
  const gitMagic = value.match(/^:\([^)]*\)(.+)$/)?.[1];
  if (gitMagic && isSensitivePath(gitMagic)) return gitMagic;
  for (let index = value.indexOf(':'); index >= 0; index = value.indexOf(':', index + 1)) {
    const suffix = value.slice(index + 1);
    if (suffix && isSensitivePath(suffix)) return suffix;
  }
  return undefined;
}

function collectSensitiveReadTargets(
  command: string,
  tree: BashCommandTree,
  context: AutoModeRulesContext,
): string[] {
  const targets = new Set<string>();
  const extractedPaths = extractPathsFromCommand(command);
  const literalTargets = collectLiteralReadTargets(tree);
  const addCandidate = (
    value: string | undefined,
    literal = false,
    pathArray = false,
  ): void => {
    if (!value) return;
    if (pathArray && value.includes(',')) {
      for (const element of value.split(',')) addCandidate(element.trim(), literal);
      return;
    }
    const canonical = canonicalizePath(value, context.executionCwd);
    const candidate = (literal
      ? sensitivePathCandidate(value)
      : sensitiveSearchSelectorCandidate(value))
      ?? (canonical && isSensitivePath(canonical) ? canonical : undefined);
    if (candidate) {
      targets.add(candidate);
      return;
    }
    // Dynamic bindings remain unresolved. Ordinary wildcard selectors are
    // search-set evidence, not a concrete sensitive target; explicit
    // credential-like selectors were handled above.
    if (!literal && hasDynamicShellReadExpansion(value)) targets.add(value);
  };
  const addSearchFilter = (value: string | undefined): void => {
    if (!value) return;
    // ripgrep's leading ! is an exclusion selector, not an input target.
    if (value.startsWith('!')) return;
    const sensitive = sensitiveSearchSelectorCandidate(value);
    if (sensitive) targets.add(sensitive);
  };
  for (const target of extractedPaths) {
    addCandidate(target, literalTargets.has(target));
  }

  for (const statement of tree.statements) {
    const powerShellReadStatement = statement.stages.some(isUnambiguousPowerShellReadStage);
    for (const stage of statement.stages) {
      const rawExecutable = shellExecutable(stage);
      const executable = powerShellReadStatement
        ? canonicalPowerShellReadExecutable(stage) ?? rawExecutable
        : rawExecutable;
      const recursiveSensitiveDescendant = sensitiveRecursiveListingDescendant(
        stage,
        context,
        extractedPaths,
      );
      if (recursiveSensitiveDescendant) targets.add(recursiveSensitiveDescendant);
      if (executable === 'git') {
        const subcommandIndex = findGitSubcommandIndex(stage.argv);
        if (subcommandIndex === undefined) continue;
        const subcommand = stage.argv[subcommandIndex]?.toLowerCase();
        let pathsOnly = false;
        let grepPatternSeen = false;
        for (let index = subcommandIndex + 1; index < stage.argv.length; index += 1) {
          const token = stage.argv[index] ?? '';
          const lower = token.toLowerCase();
          if (token === '--') {
            pathsOnly = true;
            continue;
          }
          if (!pathsOnly && subcommand === 'grep') {
            if (lower === '-f' || lower === '--file') {
              addCandidate(stage.argv[index + 1]);
              grepPatternSeen = true;
              index += 1;
              continue;
            }
            if (lower.startsWith('--file=')) {
              addCandidate(token.slice(token.indexOf('=') + 1));
              grepPatternSeen = true;
              continue;
            }
            if (lower === '-e' || lower === '--regexp') {
              grepPatternSeen = true;
              index += 1;
              continue;
            }
            if (lower.startsWith('--regexp=')) {
              grepPatternSeen = true;
              continue;
            }
            const shortOption = parseGitGrepShortOption(token);
            if (shortOption.valueKind === 'pattern-file') {
              addCandidate(shortOption.attachedValue ?? stage.argv[index + 1]);
              grepPatternSeen = true;
              if (shortOption.consumesNext) index += 1;
              continue;
            }
            if (shortOption.valueKind === 'pattern') {
              grepPatternSeen = true;
              if (shortOption.consumesNext) index += 1;
              continue;
            }
            if (shortOption.valueKind === 'other') {
              if (shortOption.consumesNext) index += 1;
              continue;
            }
          }
          if (!pathsOnly && subcommand === 'log' && (token === '-L' || token.startsWith('-L'))) {
            const range = token === '-L' ? stage.argv[++index] : token.slice(2);
            const lineTarget = range ? gitLineLogTarget(range) : undefined;
            if (!lineTarget) {
              targets.add(unresolvedSearchFilterTarget('Git line-log target'));
              continue;
            }
            addCandidate(lineTarget);
            if (isExistingDirectoryTarget(lineTarget, context)) {
              targets.add(unresolvedSearchFilterTarget('Git line-log directory target'));
            }
            continue;
          }
          if (!pathsOnly && GIT_NON_PATH_VALUE_OPTIONS.has(token.toLowerCase())) {
            index += 1;
            continue;
          }
          if (!pathsOnly && token.startsWith('-')) continue;
          if (subcommand === 'grep' && !pathsOnly && !grepPatternSeen) {
            grepPatternSeen = true;
            continue;
          }
          if (subcommand === 'grep' && !pathsOnly) {
            // Before `--`, Git also accepts tree-ish operands. A path-like
            // spelling can still be sensitive, but it cannot prove that grep
            // is scoped to that path rather than a historical tree.
            addCandidate(token);
            continue;
          }
          const objectPath = subcommand === 'show' ? gitObjectPath(token) : undefined;
          if (pathsOnly
            || subcommand === 'diff'
            || subcommand === 'log'
            || subcommand === 'show'
            || objectPath !== undefined) {
            addCandidate(objectPath ?? token);
          }
        }
        continue;
      }
      const enumerationConsumerNames = powerShellReadStatement
        ? statement.stages
          .map((candidate) => canonicalPowerShellReadExecutable(candidate) ?? shellExecutable(candidate))
          .filter((name) => name === 'get-content' || name === 'select-string')
        : [];
      const consumesEnumeration = enumerationConsumerNames.length > 0;
      const consumesEnumerationAsStringOnly = consumesEnumeration
        && enumerationConsumerNames.every((name) => name === 'select-string');
      if (executable === 'get-childitem' && consumesEnumeration) {
        let positiveFilterSeen = false;
        let nameOutput = false;
        for (let index = 1; index < stage.argv.length; index += 1) {
          const token = stage.argv[index] ?? '';
          const attached = parseAttachedPowerShellReadParameter(executable, token);
          if (attached) {
            if (attached.name === 'name' && attached.value.toLowerCase() !== '$false') nameOutput = true;
            else if (attached.name === 'literalpath') addCandidate(attached.value, true, true);
            else if (attached.name === 'path') addCandidate(attached.value, false, true);
            else if (attached.name === 'filter' || attached.name === 'include') {
              positiveFilterSeen = true;
              addSearchFilter(attached.value);
            }
            continue;
          }
          const parameter = resolvePowerShellReadParameter(executable, token);
          if (parameter) {
            if (parameter === 'name') nameOutput = true;
            const consumesValue = [
              'path', 'literalpath', 'filter', 'include', 'exclude', 'depth', 'attributes',
            ].includes(parameter);
            const value = consumesValue ? stage.argv[index + 1] : undefined;
            if (parameter === 'literalpath') addCandidate(value, true, true);
            else if (parameter === 'path') addCandidate(value, false, true);
            else if (parameter === 'filter' || parameter === 'include') {
              positiveFilterSeen = true;
              addSearchFilter(value);
            }
            if (consumesValue) index += 1;
            continue;
          }
          if (!token.startsWith('-')) addCandidate(token, false, true);
        }
        // Without an inclusive selector, the pipeline can feed any enumerated
        // file to the content reader, including a protected one. With -Name the
        // enumeration emits filenames as strings; a downstream Select-String
        // binds those to -InputObject (searching the strings, not file
        // contents), so no file is read and the sentinel does not apply.
        // Get-Content still treats piped strings as paths and reads files, so
        // the sentinel is retained whenever it is among the consumers.
        if (!positiveFilterSeen && !(nameOutput && consumesEnumerationAsStringOnly)) {
          targets.add('.env');
        }
        continue;
      }
      if (REGEX_READ_COMMANDS.has(executable)) {
        if (executable === 'rg' || executable === 'ripgrep') {
          const customTypes = new Map<string, string>();
          const selectedTypes = new Set<string>();
          for (let index = 1; index < stage.argv.length; index += 1) {
            const token = stage.argv[index] ?? '';
            const lower = token.toLowerCase();
            if (['-g', '--glob', '--iglob'].includes(lower)) {
              addSearchFilter(stage.argv[index + 1]);
              index += 1;
              continue;
            }
            if (lower.startsWith('--glob=') || lower.startsWith('--iglob=')) {
              addSearchFilter(token.slice(token.indexOf('=') + 1));
              continue;
            }
            if (/^-g.+/s.test(token)) {
              addSearchFilter(token.slice(2));
              continue;
            }
            const typeDefinition = lower === '--type-add'
              ? stage.argv[++index]
              : lower.startsWith('--type-add=')
                ? token.slice(token.indexOf('=') + 1)
                : undefined;
            if (typeDefinition) {
              const separator = typeDefinition.indexOf(':');
              if (separator > 0) {
                customTypes.set(
                  typeDefinition.slice(0, separator).toLowerCase(),
                  typeDefinition.slice(separator + 1),
                );
              }
              continue;
            }
            if (lower === '--type' || lower === '-t') {
              const selected = stage.argv[++index];
              if (selected) selectedTypes.add(selected.toLowerCase());
              continue;
            }
            if (lower.startsWith('--type=')) {
              selectedTypes.add(token.slice(token.indexOf('=') + 1).toLowerCase());
              continue;
            }
            if (/^-t[^-].+/s.test(token)) selectedTypes.add(token.slice(2).toLowerCase());
          }
          for (const type of selectedTypes) addSearchFilter(customTypes.get(type));
        }
        if (executable === 'grep' || executable === 'egrep' || executable === 'fgrep') {
          for (let index = 1; index < stage.argv.length; index += 1) {
            const token = stage.argv[index] ?? '';
            const lower = token.toLowerCase();
            if (lower === '--include') {
              addSearchFilter(stage.argv[index + 1]);
              index += 1;
            } else if (lower.startsWith('--include=')) {
              addSearchFilter(token.slice(token.indexOf('=') + 1));
            }
          }
        }
        if (executable === 'select-string') {
          for (const operand of powerShellReadPathOperands(stage)) {
            addCandidate(operand.value, operand.literal, true);
          }
          for (let index = 1; index < stage.argv.length; index += 1) {
            const token = stage.argv[index] ?? '';
            const attached = parseAttachedPowerShellReadParameter(executable, token);
            if (attached) {
              if (attached.name === 'include') addSearchFilter(attached.value);
              continue;
            }
            const parameter = resolvePowerShellReadParameter(executable, token);
            if (!parameter) continue;
            const consumesValue = [
              'path', 'literalpath', 'include', 'exclude', 'pattern', 'encoding',
              'context', 'culture',
            ].includes(parameter);
            const value = consumesValue ? stage.argv[index + 1] : undefined;
            if (parameter === 'include') addSearchFilter(value);
            if (consumesValue) index += 1;
          }
        }
        continue;
      }
      if (!POSITIONAL_READ_COMMANDS.has(executable)) continue;

      for (let index = 1; index < stage.argv.length; index += 1) {
        const token = stage.argv[index] ?? '';
        const lower = token.toLowerCase();
        if (executable === 'less') {
          if (token === '-T' || lower === '--tag-file') {
            addCandidate(stage.argv[index + 1]);
            index += 1;
            continue;
          }
          if (token.startsWith('-T') && token.length > 2) {
            addCandidate(token.slice(2));
            continue;
          }
          if (lower.startsWith('--tag-file=')) {
            addCandidate(token.slice(token.indexOf('=') + 1));
            continue;
          }
        }
        if (executable === 'get-content') {
          const attached = parseAttachedPowerShellReadParameter(executable, token);
          if (attached) {
            if (attached.name === 'literalpath') addCandidate(attached.value, true, true);
            else if (attached.name === 'path') addCandidate(attached.value, false, true);
            else if (attached.name === 'filter' || attached.name === 'include') {
              addSearchFilter(attached.value);
            } else if (attached.name === undefined) addCandidate(attached.value);
            continue;
          }
          const parameter = resolvePowerShellReadParameter(executable, token);
          if (parameter) {
            const consumesValue = [
              'path', 'literalpath', 'filter', 'include', 'exclude', 'delimiter',
              'encoding', 'readcount', 'totalcount', 'tail', 'stream', 'credential',
            ].includes(parameter);
            const value = consumesValue ? stage.argv[index + 1] : undefined;
            if (parameter === 'literalpath') addCandidate(value, true, true);
            else if (parameter === 'path') addCandidate(value, false, true);
            else if (parameter === 'filter' || parameter === 'include') {
              addSearchFilter(value);
            }
            if (consumesValue) index += 1;
            continue;
          }
        }
        if (token.startsWith('-')) continue;
        addCandidate(token, false, executable === 'get-content');
      }
    }
  }
  return [...targets];
}

function assessBashCall(
  input: Readonly<Record<string, unknown>>,
  context: AutoModeRulesContext,
): AutoModePermissionReview {
  const command = typeof input.command === 'string' ? input.command : '';
  if (!command.trim()) {
    return review('incomplete', 'shell', [], ['command_unresolved'], 'shell command is missing');
  }
  if (hasAmbiguousQuotedWindowsDirectory(command)) {
    return review(
      'incomplete',
      'shell',
      [{ kind: 'unknown', summary: 'ambiguous quoted Windows directory command' }],
      ['command_unresolved'],
      'a trailing backslash may escape the closing quote',
    );
  }

  const tree = parseBashCommand(command);
  const shell = hasPowerShellMutationStage(tree) || looksLikePowerShell(command, tree)
    ? 'powershell'
    : 'shell';
  const operationResult = collectShellOperations(command, tree, context);
  const protectedTraversalTarget = protectedAgentHomeMutationSelection(
    tree,
    operationResult.operations,
    context,
  );
  const operations: readonly AutoModePermissionOperation[] = protectedTraversalTarget === undefined
    ? operationResult.operations
    : [
        ...operationResult.operations,
        {
          kind: 'write',
          target: { path: protectedTraversalTarget, boundary: 'protected' },
          options: { recursive: true },
        },
      ];
  const highRisk = context.signals.some((signal) => (
    signal.kind === 'dangerous_pattern' && signal.severity === 'high'
  ));
  const modeled = !tree.unparseable
    && !hasWriteCapableReadSyntax(tree)
    && hasOnlyModeledShellStages(tree);
  const hasKnownWrite = isBashWriteCommand(command)
    || operations.some((operation) => operation.kind !== 'execute');
  const complete = operationResult.complete && modeled
    && (isModeledShellReadCommand(command, tree) || hasKnownWrite)
    && operations.length > 0
    && operations.every((operation) => (
      operationPaths(operation).every((target) => target.boundary !== 'unresolved')
    ));
  const risks = collectRisks(operations);
  if (highRisk) risks.push('high_risk_pattern');
  if (operationResult.reason?.includes('repository-configured')) {
    risks.push('indirect_execution');
  }
  if (tree.statements.some((statement) => (
    statement.stages.some(hasDynamicPowerShellParameterBinding)
  ))) risks.push('target_unresolved');
  if (sensitiveEnvironmentRead(command, tree)) risks.push('sensitive_environment_read');
  if (sensitiveProcessDataRead(tree)) risks.push('sensitive_process_data_read');
  const permissionReview = review(
    complete ? 'complete' : 'incomplete',
    shell,
    operations,
    risks,
    complete ? undefined : operationResult.reason ?? 'shell effects are not fully modeled',
  );

  return permissionReview;
}

function protectedAgentHomeMutationSelection(
  tree: BashCommandTree,
  operations: readonly AutoModePermissionOperation[],
  context: AutoModeRulesContext,
): string | undefined {
  for (const operation of operations) {
    if ('target' in operation) {
      const traverses = operation.kind === 'delete' && operation.options?.recursive === true;
      if ((traverses || hasShellReadExpansion(operation.target.path))
        && mutationSelectionHasProtectedPath(operation.target.path, traverses, context)) {
        return operation.target.path;
      }
      continue;
    }
    if (!('source' in operation)) continue;
    const traverses = operation.kind === 'move'
      || operation.kind === 'rename'
      || (operation.kind === 'copy' && operation.options?.recursive === true);
    if ((traverses || hasShellReadExpansion(operation.source.path))
      && mutationSelectionHasProtectedPath(operation.source.path, traverses, context)) {
      return operation.source.path;
    }
  }
  for (const statement of tree.statements) {
    for (const stage of statement.stages) {
      const executable = shellExecutable(stage);
      if (!['chmod', 'chown'].includes(executable)) continue;
      const recursive = stage.argv.slice(1).some((token) => (
        token === '--recursive' || /^-[^-]*R/.test(token)
      ));
      const positionals = directPositionals(executable, stage.argv.slice(1)).slice(1);
      for (const target of positionals) {
        if ((recursive || hasShellReadExpansion(target))
          && mutationSelectionHasProtectedPath(target, recursive, context)) return target;
      }
    }
  }
  return undefined;
}

function mutationSelectionHasProtectedPath(
  targetPath: string,
  traverseDescendants: boolean,
  context: AutoModeRulesContext,
): boolean {
  if (hasShellReadExpansion(targetPath)) {
    const effective = resolveEffectiveGlobSearch(context.executionCwd, targetPath, context);
    if (effective.unsafe || effective.root === undefined) return true;
    return agentHomeSearchHasProtectedDescendant(
      effective.root,
      context,
      effective.selector,
      traverseDescendants,
    );
  }
  return traverseDescendants
    && isExistingDirectoryTarget(targetPath, context)
    && agentHomeSearchHasProtectedDescendant(targetPath, context);
}

interface RecursiveContentSearch {
  readonly roots: readonly string[];
  readonly unsafe?: string;
}

function recursiveContentSearch(
  executable: string,
  args: readonly string[],
): RecursiveContentSearch | undefined {
  if (executable === 'rg' || executable === 'ripgrep') {
    if (args.some((token) => token === '--help' || token === '--version')) return undefined;
    const valueOptions = new Set([
      '-g', '--glob', '-t', '--type', '-T', '--type-not', '-e', '--regexp',
      '-f', '--file', '--iglob', '--ignore-file', '--max-depth', '-m', '--max-count',
      '-A', '--after-context', '-B', '--before-context', '-C', '--context',
    ]);
    const switchOptions = new Set([
      '--hidden', '--no-hidden', '-i', '--ignore-case', '-s', '--case-sensitive',
      '-S', '--smart-case', '-w', '--word-regexp', '-x', '--line-regexp', '-v',
      '--invert-match', '-l', '--files-with-matches', '-L', '--files-without-match',
      '--no-ignore', '--no-ignore-vcs', '--follow', '--multiline', '--crlf', '--text',
      '-n', '--line-number', '-H', '--with-filename', '-c', '--count', '--json',
      '--heading', '--no-heading', '--column', '--stats',
    ]);
    const positionals: string[] = [];
    let patternProvidedByOption = false;
    for (let index = 0; index < args.length; index += 1) {
      const token = args[index]!;
      if (token === '--') {
        positionals.push(...args.slice(index + 1));
        break;
      }
      const equals = token.indexOf('=');
      const option = equals >= 0 ? token.slice(0, equals) : token;
      if (valueOptions.has(option)) {
        if (option === '-e' || option === '--regexp' || option === '-f' || option === '--file') {
          patternProvidedByOption = true;
        }
        if (equals < 0) index += 1;
        if (index >= args.length) return { roots: ['.'], unsafe: token };
        continue;
      }
      if (/^-(?:g|t|T|e|f|m|A|B|C).+/.test(token) || switchOptions.has(token)) {
        if (/^-(?:e|f).+/.test(token)) patternProvidedByOption = true;
        continue;
      }
      if (token.startsWith('-')) {
        return {
          roots: ['.', ...positionals, ...args.slice(index + 1).filter((value) => !value.startsWith('-'))],
          unsafe: token,
        };
      }
      positionals.push(token);
    }
    const roots = patternProvidedByOption ? positionals : positionals.slice(1);
    return { roots: roots.length > 0 ? roots : ['.'] };
  }
  if (!['grep', 'egrep', 'fgrep'].includes(executable)) return undefined;
  const recursive = args.some((token, index) => (
    token === '--recursive'
    || /^-[^-]*[rR]/.test(token)
    || token === '--directories=recurse'
    || ((token === '--directories' || token === '-d') && args[index + 1] === 'recurse')
    || token === '-drecurse'
  ));
  if (!recursive) return undefined;
  const patternOptions = new Set(['-e', '--regexp', '-f', '--file']);
  const valueOptions = new Set([
    ...patternOptions,
    '--include', '--exclude', '--exclude-from', '--exclude-dir', '--label',
    '--binary-files', '--color', '-A', '--after-context', '-B', '--before-context',
    '-C', '--context', '-m', '--max-count', '-d', '--directories',
  ]);
  const positionals: string[] = [];
  let patternProvidedByOption = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === '--') {
      positionals.push(...args.slice(index + 1));
      break;
    }
    const equals = token.indexOf('=');
    const option = equals >= 0 ? token.slice(0, equals) : token;
    if (valueOptions.has(option)) {
      if (patternOptions.has(option)) patternProvidedByOption = true;
      if (equals < 0) index += 1;
      if (index >= args.length) return { roots: ['.'], unsafe: token };
      continue;
    }
    if (/^-(?:e|f).+/.test(token)) {
      patternProvidedByOption = true;
      continue;
    }
    if (/^-(?:d|m|A|B|C).+/.test(token) || token === '--recursive'
      || /^-[^-]*[rR]/.test(token)) continue;
    if (token.startsWith('-')) {
      return {
        roots: ['.', ...positionals, ...args.slice(index + 1).filter((value) => !value.startsWith('-'))],
        unsafe: token,
      };
    }
    positionals.push(token);
  }
  const roots = patternProvidedByOption ? positionals : positionals.slice(1);
  return { roots: roots.length > 0 ? roots : ['.'] };
}

function sensitiveRecursiveListingDescendant(
  stage: BashPipelineStage,
  context: AutoModeRulesContext,
  extractedPaths: readonly string[],
): string | undefined {
  const rawExecutable = shellExecutable(stage);
  const executable = canonicalPowerShellReadExecutable(stage) ?? rawExecutable;
  const args = stage.argv.slice(1);
  let listingRoots: readonly string[];
  if (rawExecutable === 'dir' && process.platform === 'win32'
    && args.some((token) => /^\/s(?::.*)?$/i.test(token))) {
    const roots = args.filter((token) => !/^\/[a-z]/i.test(token));
    listingRoots = roots.length > 0 ? roots : ['.'];
  } else if (rawExecutable === 'ls'
    && args.some((token) => token === '--recursive' || /^-[^-]*R/.test(token))) {
    const roots = args.filter((token) => !token.startsWith('-'));
    listingRoots = roots.length > 0 ? roots : ['.'];
  } else if (executable === 'get-childitem') {
    const recursive = args.some((token) => {
      const attached = parseAttachedPowerShellReadParameter('get-childitem', token);
      return attached?.name === 'recurse' || attached?.name === 'depth'
        || ['recurse', 'depth'].includes(resolvePowerShellReadParameter('get-childitem', token) ?? '');
    });
    if (!recursive) return undefined;
    if (args.some((token) => (
      parseAttachedPowerShellReadParameter('get-childitem', token)?.name === 'followsymlink'
      || resolvePowerShellReadParameter('get-childitem', token) === 'followsymlink'
    ))) {
      return unresolvedSearchFilterTarget('recursive listing follows symbolic links');
    }
    const roots = powerShellReadPathOperands(stage);
    listingRoots = roots.length > 0 ? roots.map((operand) => operand.value) : ['.'];
  } else if (executable === 'tree') {
    const roots = args.filter((token) => !token.startsWith('-') && !/^\/[fa]$/i.test(token));
    listingRoots = roots.length > 0 ? roots.slice(0, 1) : ['.'];
  } else if (executable === 'find') {
    if (args.some((token) => token === '-L' || token === '-follow')) {
      return unresolvedSearchFilterTarget('recursive listing follows symbolic links');
    }
    const roots = args.filter((token) => !token.startsWith('-') && !/^[()!,]$/.test(token));
    listingRoots = roots.length > 0 ? roots.slice(0, 1) : ['.'];
  } else if (executable === 'ls') {
    if (!args.some((token) => token === '--recursive' || /^-[^-]*R/.test(token))) return undefined;
    const roots = args.filter((token) => !token.startsWith('-'));
    listingRoots = roots.length > 0 ? roots : ['.'];
  } else {
    const contentSearch = recursiveContentSearch(rawExecutable, args);
    if (contentSearch === undefined) return undefined;
    listingRoots = contentSearch.roots;
  }
  const sensitiveDescendants = [
    ...[...SENSITIVE_PATH_PARTS].map((part) => path.join(os.homedir(), part)),
    path.join(os.homedir(), '.config', 'gcloud'),
    path.join(os.homedir(), '.config', 'gh'),
    path.join(os.homedir(), '.config', 'openai'),
    path.join(os.homedir(), '.config', 'anthropic'),
  ];
  for (const listingRoot of listingRoots) {
    const restoredRoot = restoreMangledShellPath(listingRoot, extractedPaths);
    const canonicalRoot = canonicalizePath(restoredRoot, context.executionCwd);
    if (!canonicalRoot) continue;
    if (isExistingDirectoryTarget(canonicalRoot, context)
      && agentHomeSearchHasProtectedDescendant(canonicalRoot, context)) {
      try {
        return getAgentConfigHome();
      } catch {
        return unresolvedSearchFilterTarget('recursive search reaches protected Agent Home state');
      }
    }
    const descendant = sensitiveDescendants.find((candidate) => {
      const canonicalCandidate = canonicalizePath(candidate);
      return canonicalCandidate !== undefined
        && isPathInsideDirectory(canonicalCandidate, canonicalRoot);
    });
    if (descendant) return descendant;
  }
  return undefined;
}

function hasAmbiguousQuotedWindowsDirectory(command: string): boolean {
  if (process.platform !== 'win32') return false;
  return /"[A-Za-z]:\\[^"\r\n]*\\"(?=\s*(?:&&|\|\||[;|]|$))/.test(command);
}

const POWERSHELL_ALIAS_PARAMETER_NAMES = [
  'path', 'literalpath', 'destination', 'newname', 'filter', 'include', 'exclude',
  'recurse', 'force', 'passthru', 'credential', 'fromsession', 'tosession',
  'container', 'verbose', 'debug', 'erroraction', 'warningaction',
  'informationaction', 'progressaction', 'errorvariable', 'warningvariable',
  'informationvariable', 'outvariable', 'outbuffer', 'pipelinevariable',
  'whatif', 'confirm', 'usetransaction',
] as const;
const POWERSHELL_ALIAS_PARAMETER_ALIASES = new Set([
  'ea', 'ev', 'wa', 'wv', 'ia', 'infa', 'iv', 'ov', 'ob', 'pv', 'vb', 'db',
  'wi', 'cf', 'usetx', 'pspath',
]);
const AMBIGUOUS_SHELL_ALIASES = new Set(['cp', 'copy', 'mv', 'move', 'rm', 'del', 'ren']);
const POWERSHELL_ALIAS_EQUIVALENT_SINGLE_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  cp: new Set(['f', 'p', 'r', 'v']),
  copy: new Set(['f', 'p', 'r', 'v']),
  mv: new Set(['f', 'v']),
  move: new Set(['f', 'v']),
  rm: new Set(['f', 'r', 'v']),
  del: new Set(['f', 'r', 'v']),
  ren: new Set(),
};

function hasPowerShellNamedParameterOnShellAlias(stage: BashPipelineStage): boolean {
  const executable = shellExecutable(stage);
  if (!AMBIGUOUS_SHELL_ALIASES.has(executable)) return false;
  return stage.argv.slice(1).some((token) => {
    if (!/^-[^-]/.test(token)) return false;
    const name = token.slice(1).split(':', 1)[0]?.toLowerCase() ?? '';
    // PowerShell accepts unique one-letter parameter abbreviations: for
    // example cp -D binds Destination, cp -L binds LiteralPath, and ren -N
    // binds NewName. Only flags whose POSIX and PowerShell alias meanings are
    // equivalent may keep deterministic modeling; every other abbreviation
    // needs the classifier to interpret the active shell's binding.
    if (name.length === 1) {
      return !POWERSHELL_ALIAS_EQUIVALENT_SINGLE_FLAGS[executable]?.has(name);
    }
    if (name.length === 0) return false;
    if (POWERSHELL_ALIAS_PARAMETER_ALIASES.has(name)) return true;
    return POWERSHELL_ALIAS_PARAMETER_NAMES.some((candidate) => candidate.startsWith(name));
  });
}

function recursiveSymlinkFollowReason(stage: BashPipelineStage): string | undefined {
  const executable = shellExecutable(stage);
  const delimiter = stage.argv.indexOf('--');
  const args = stage.argv.slice(1, delimiter < 0 ? undefined : delimiter);
  const hasShort = (flag: string): boolean => args.some((token) => (
    /^-[^-]/.test(token) && token.slice(1).includes(flag)
  ));
  const follows = hasShort('L') || args.includes('--dereference');
  if (executable === 'tree' && hasShort('l')) {
    return 'recursive listing explicitly follows symbolic links';
  }
  if (!follows) return undefined;
  const recursive = executable === 'ls'
    ? hasShort('R') || args.includes('--recursive')
    : executable === 'cp'
      ? hasShort('R') || hasShort('r') || hasShort('a') || args.includes('--recursive')
      : (executable === 'chmod' || executable === 'chown')
        && (hasShort('R') || args.includes('--recursive'));
  return recursive ? 'recursive operation explicitly follows symbolic links' : undefined;
}

function indirectReadReason(tree: BashCommandTree): string | undefined {
  for (const statement of tree.statements) {
    for (const stage of statement.stages) {
      const executable = shellExecutable(stage);
      if (hasPowerShellNamedParameterOnShellAlias(stage)) {
        return 'shell alias uses PowerShell named-parameter semantics that require PowerShell binding';
      }
      const symlinkReason = recursiveSymlinkFollowReason(stage);
      if (symlinkReason) return symlinkReason;
      if (executable === 'findstr'
        && stage.argv.slice(1).some((token) => /^\/f:/i.test(token))) {
        return 'findstr file-list targets cannot be resolved before reading the list';
      }
      if (executable === 'wc' && stage.argv.slice(1).some((token) => (
        token.toLowerCase() === '--files0-from'
        || token.toLowerCase().startsWith('--files0-from=')
      ))) {
        return 'wc file-list targets cannot be resolved before reading the list';
      }
      if (executable === 'find' && stage.argv.slice(1).some((token) => (
        /^--?files0-from(?:=|$)/i.test(token)
      ))) {
        return 'find file-list targets cannot be resolved before reading the list';
      }
    }
  }
  return undefined;
}

function collectShellOperations(
  command: string,
  tree: BashCommandTree,
  context: AutoModeRulesContext,
): { readonly complete: boolean; readonly operations: AutoModePermissionOperation[]; readonly reason?: string } {
  if (tree.unparseable) {
    return {
      complete: false,
      operations: [{ kind: 'unknown', summary: `opaque shell payload (${Buffer.byteLength(command, 'utf8')} bytes)` }],
      reason: 'shell syntax could not be parsed',
    };
  }

  const operations: AutoModePermissionOperation[] = [];
  const modeledTargets = new Set<string>();
  const cmdCopyTimestampArtifacts = new Set(
    tree.statements.flatMap((statement) => statement.stages.flatMap((stage) => (
      cmdCopyTimestampSyntax(stage)?.artifacts ?? []
    ))),
  );
  const extractedPaths = [...new Set([
    ...extractPathsFromCommand(command),
    ...tokenizeRawCommandStages(command)
      .flatMap((words) => words.map((word) => word.value))
      .filter(hasTempEnvironmentPathPrefix),
  ])].filter((target) => !isNullDevice(target));
  const inlineInputReason = tree.statements.some((statement) => statement.stages.some((stage) => (
    stage.redirections.some((redirection) => redirection.input && redirection.op !== '<')
  ))) ? 'inline shell input syntax cannot be bound to a filesystem target' : undefined;
  const indirectReason = indirectReadReason(tree) ?? inlineInputReason;
  let complete = indirectReason === undefined;
  let reason = indirectReason;
  for (const statement of tree.statements) {
    for (const stage of statement.stages) {
      if (!isPowerShellMutationCommand(shellExecutable(stage))) continue;
      const analysis = analyzePowerShellMutation(stage.argv.map((token, index) => (
        index === 0 ? token : restoreMangledShellPath(token, extractedPaths)
      )));
      if (analysis.status === 'incomplete') {
        complete = false;
        reason ??= analysis.reason;
      }
      for (const operation of analysis.operations) {
        const mapped = mapPowerShellOperation(operation, context, extractedPaths);
        operations.push(mapped);
        for (const target of operationPaths(mapped)) modeledTargets.add(target.path);
      }
    }
  }

  for (const statement of tree.statements) {
    for (const stage of statement.stages) {
      for (const operation of collectDirectShellOperations(stage, context, extractedPaths)) {
        operations.push(operation);
        for (const target of operationPaths(operation)) modeledTargets.add(target.path);
      }
    }
  }

  for (const target of collectCmdCopyConcatenationSources(command)) {
    if (modeledTargets.has(target)) continue;
    const sensitive = sensitivePathCandidate(target);
    operations.push({
      kind: 'read',
      target: sensitive
        ? classifySensitiveReadTarget(target, context)
        : hasShellReadExpansion(target)
          ? { path: target, boundary: 'unresolved' }
          : classifyTarget(target, context),
    });
    modeledTargets.add(target);
  }

  for (const target of collectDeterministicBashWriteTargets(command)) {
    const restoredTarget = restoreMangledShellPath(target, extractedPaths);
    if (isNullDevice(restoredTarget)
      || modeledTargets.has(restoredTarget)
      || modeledTargetCoversSelector(modeledTargets, restoredTarget, context)
      || cmdCopyTimestampArtifacts.has(restoredTarget)
      || modeledRenameCoversTarget(tree, target)) continue;
    operations.push({ kind: 'write', target: classifyTarget(restoredTarget, context) });
  }
  for (const target of collectShellInputReadTargets(tree)) {
    const sensitive = sensitivePathCandidate(target);
    operations.push({
      kind: 'read',
      target: sensitive
        ? classifySensitiveReadTarget(target, context)
        : hasShellReadExpansion(target)
          ? { path: target, boundary: 'unresolved' }
          : classifyTarget(target, context),
    });
    modeledTargets.add(target);
  }
  const sensitiveReadTargets = collectSensitiveReadTargets(command, tree, context);
  const modeledContentReadTargets = [
    ...modeledContentReadPathOperands(tree),
    ...tree.statements.flatMap((statement) => statement.stages.flatMap((stage) => (
      canonicalPowerShellReadExecutable(stage) === undefined
        ? []
        : powerShellReadPathOperands(stage)
    ))),
  ].map((operand) => ({
    ...operand,
    value: restoreMangledShellPath(operand.value, extractedPaths),
  })).filter((operand, index, operands) => (
    operands.findIndex((candidate) => (
      candidate.value === operand.value && candidate.literal === operand.literal
    )) === index
  ));
  if (isBashReadCommand(command)
    || sensitiveReadTargets.length > 0
    || modeledContentReadTargets.length > 0) {
    const readTargets = new Set(sensitiveReadTargets);
    const literalReadTargets = collectLiteralReadTargets(tree);
    for (const operand of modeledContentReadTargets) readTargets.add(operand.value);
    if (isBashReadCommand(command) || modeledContentReadTargets.length > 0) {
      for (const target of extractedPaths) readTargets.add(target);
    }
    for (const target of readTargets) {
      if (modeledTargets.has(target)) continue;
      const literal = literalReadTargets.has(target);
      const sensitive = literal
        ? sensitivePathCandidate(target)
        : sensitiveSearchSelectorCandidate(target);
      const ordinarySelector = !literal && hasShellReadExpansion(target)
        && !hasDynamicShellReadExpansion(target);
      operations.push({
        kind: 'read',
        target: ordinarySelector
          ? classifyExpandedReadTarget(target, context)
          : sensitive
          ? classifySensitiveReadTarget(target, context, literal)
          : !literal && hasDynamicShellReadExpansion(target)
          ? { path: target, boundary: 'unresolved' }
          : classifyTarget(target, context, literal),
      });
      modeledTargets.add(target);
    }
  }
  if (operations.length === 0 && tree.statements.length > 0) {
    const readOnly = isModeledShellReadCommand(command, tree);
    operations.push({
      kind: 'execute',
      summary: readOnly ? 'read-only shell command' : 'shell command with unmodelled effects',
      options: { readOnly },
    });
  }
  return reason === undefined ? { complete, operations } : { complete, operations, reason };
}

function modeledTargetCoversSelector(
  modeledTargets: ReadonlySet<string>,
  selectorPath: string,
  context: AutoModeRulesContext,
): boolean {
  if (!hasShellReadExpansion(selectorPath)) return false;
  const effective = resolveEffectiveGlobSearch(context.executionCwd, selectorPath, context);
  if (effective.unsafe || effective.root === undefined) return false;
  const comparableRoot = process.platform === 'win32'
    ? effective.root.toLowerCase()
    : effective.root;
  return [...modeledTargets].some((target) => {
    const canonical = canonicalizePath(target, context.executionCwd);
    if (canonical === undefined) return false;
    return (process.platform === 'win32' ? canonical.toLowerCase() : canonical) === comparableRoot;
  });
}

function collectDirectShellOperations(
  stage: BashPipelineStage,
  context: AutoModeRulesContext,
  rawPaths: readonly string[],
): AutoModePermissionOperation[] {
  const command = shellExecutable(stage);
  const restorePath = (value: string): string => restoreMangledShellPath(value, rawPaths);
  const globalGitConfigWrite = gitGlobalConfigWrite(stage, context);
  if (globalGitConfigWrite) return [globalGitConfigWrite];
  const timestampSyntax = cmdCopyTimestampSyntax(stage);
  if (timestampSyntax) {
    return [{ kind: 'write', target: classifyTarget(restorePath(timestampSyntax.target), context) }];
  }
  const outputTargets = readCommandOutputTargets(stage).map(restorePath).filter((target) => (
    !isNullDevice(target)
  ));
  if (outputTargets.length > 0) {
    return outputTargets.map((target) => ({
      kind: 'write', target: classifyTarget(target, context),
    }));
  }
  const args = directPositionals(command, stage.argv.slice(1)).map(restorePath);
  if (['rm', 'rmdir', 'del', 'erase', 'rd'].includes(command)) {
    return args.map((target) => ({
      kind: 'delete', target: classifyMutationSelectorTarget(target, context),
      options: {
        recursive: stage.argv.some((token) => (
          token === '--recursive'
          || /^-[^-]*[rR]/.test(token)
          || (['del', 'erase', 'rd', 'rmdir'].includes(command) && /^\/s$/i.test(token))
        )),
      },
    }));
  }
  if (command === 'mkdir' || command === 'touch') {
    return args.map((target) => ({
      kind: 'create', target: classifyTarget(target, context),
    }));
  }
  if (command === 'mv' || command === 'move' || command === 'cp' || command === 'copy') {
    const targetDirectoryValue = directTargetDirectory(stage.argv);
    const targetDirectory = targetDirectoryValue === undefined
      ? undefined
      : restorePath(targetDirectoryValue);
    const sources = targetDirectory ? args : args.slice(0, -1);
    const destination = targetDirectory ?? args.at(-1);
    if (!destination || sources.length === 0) return [];
    return sources.map((source) => ({
      kind: command === 'cp' || command === 'copy' ? 'copy' : 'move',
      source: classifyMutationSelectorTarget(source, context),
      destination: classifyTarget(destination, context),
      options: {
        force: stage.argv.some((token) => /^(?:-f|--force|\/y)$/i.test(token)),
        recursive: (command === 'cp' || command === 'copy')
          && stage.argv.some((token) => token === '--recursive' || /^-[^-]*[rRa]/.test(token)),
        destinationIsDirectory: targetDirectory !== undefined || sources.length > 1,
        overwritePossible: true,
      },
    }));
  }
  if (command === 'ren' && args.length === 2) {
    const source = args[0]!;
    return [{
      kind: 'rename',
      source: classifyTarget(source, context),
      destination: classifyTarget(joinSourceParent(source, args[1]!), context),
    }];
  }
  if (command === 'chmod' || command === 'chown') {
    return args.slice(1).map((target) => ({
      kind: 'write',
      target: classifyMutationSelectorTarget(target, context),
      options: {
        recursive: stage.argv.some((token) => (
          token === '--recursive' || /^-[^-]*R/.test(token)
        )),
      },
    }));
  }
  return [];
}

function gitGlobalConfigWrite(
  stage: BashPipelineStage,
  context: AutoModeRulesContext,
): AutoModePermissionOperation | undefined {
  if (!isGlobalGitConfigMutationStage(stage)) return undefined;
  const configured = process.env.GIT_CONFIG_GLOBAL?.trim();
  const target = configured && configured.toLowerCase() !== 'nul' && configured !== '/dev/null'
    ? configured
    : path.join(os.homedir(), '.gitconfig');
  return { kind: 'write', target: classifyTarget(target, context) };
}

function isGlobalGitConfigMutationStage(stage: BashPipelineStage): boolean {
  if (shellExecutable(stage) !== 'git') return false;
  const subcommandIndex = findGitSubcommandIndex(stage.argv);
  if (subcommandIndex === undefined
    || stage.argv[subcommandIndex]?.toLowerCase() !== 'config') return false;
  const args = stage.argv.slice(subcommandIndex + 1);
  return args.some((token) => token.toLowerCase() === '--global')
    && isGitConfigMutation(args);
}

function isGitConfigMutation(args: readonly string[]): boolean {
  const normalized = args.map((token) => token.toLowerCase());
  if (normalized.some((token) => [
    '--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l',
    '--get-color', '--get-colorbool', 'get', 'list',
  ].includes(token))) return false;
  if (normalized.some((token) => [
    '--add', '--replace-all', '--unset', '--unset-all', '--rename-section',
    '--remove-section', '--edit', '-e', 'set', 'unset', 'unset-all',
    'rename-section', 'remove-section',
  ].includes(token))) return true;
  return args.filter((token) => !token.startsWith('-')).length >= 2;
}

function cmdCopyTimestampSyntax(
  stage: BashPipelineStage,
): { readonly target: string; readonly artifacts: readonly string[] } | undefined {
  if (shellExecutable(stage) !== 'copy') return undefined;
  const positionals = stage.argv.slice(1).filter((token) => (
    !isDirectWindowsSwitch('copy', token) && !token.startsWith('-')
  ));
  const expression = positionals.join(' ').trim();
  const separator = expression.lastIndexOf('+');
  if (separator <= 0 || !/^\s*,\s*,\s*$/.test(expression.slice(separator + 1))) {
    return undefined;
  }
  const target = expression.slice(0, separator).trim().replace(/^["']|["']$/g, '');
  if (!target) return undefined;
  return { target, artifacts: positionals };
}

function collectCmdCopyConcatenationSources(command: string): string[] {
  const sources = new Set<string>();
  for (const words of tokenizeRawCommandStages(command)) {
    const executable = (words[0]?.value ?? '')
      .replace(/\\/g, '/')
      .split('/')
      .at(-1)
      ?.toLowerCase();
    if (executable !== 'copy') continue;
    const positionals = words.slice(1).filter((word) => (
      !isDirectWindowsSwitch('copy', word.value)
      && !word.value.startsWith('-')
    ));
    for (const word of positionals.slice(0, -1)) {
      const raw = command.slice(word.start, word.end);
      for (const component of splitCmdCopySource(raw)) sources.add(component);
    }
  }
  return [...sources];
}

function splitCmdCopySource(raw: string): string[] {
  const components: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!;
    if (char === '^' && quote === undefined && index + 1 < raw.length) {
      current += raw[index + 1];
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = quote === char ? undefined : quote ?? char;
      continue;
    }
    if (char === '+' && quote === undefined) {
      if (current.length === 0) return [];
      components.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (components.length === 0 || current.length === 0) return [];
  components.push(current);
  return components;
}

function collectShellInputReadTargets(tree: BashCommandTree): string[] {
  const targets = new Set<string>();
  for (const statement of tree.statements) {
    for (const stage of statement.stages) {
      for (const redirection of stage.redirections) {
        if (redirection.input && !redirection.descriptorDuplication
          && redirection.op !== '<<' && redirection.op !== '<<<'
          && !isNullDevice(redirection.target)) {
          targets.add(redirection.target);
        }
      }
      if (shellExecutable(stage) !== 'dd') continue;
      for (const token of stage.argv.slice(1)) {
        const match = /^if=(.+)$/i.exec(token);
        if (match?.[1] && match[1] !== '-') targets.add(match[1]);
      }
      continue;
    }
  }
  for (const statement of tree.statements) {
    for (const stage of statement.stages) {
      const executable = shellExecutable(stage);
      if (!['touch', 'date', 'chmod', 'chown'].includes(executable)) continue;
      const supportsShortReference = executable === 'touch' || executable === 'date';
      for (let index = 1; index < stage.argv.length; index += 1) {
        const token = stage.argv[index] ?? '';
        if ((supportsShortReference && token === '-r') || token === '--reference') {
          const reference = stage.argv[index + 1];
          if (reference) targets.add(reference);
          index += 1;
          continue;
        }
        const reference = /^--reference=(.+)$/.exec(token)?.[1]
          ?? (supportsShortReference ? /^-r(.+)$/.exec(token)?.[1] : undefined);
        if (reference) targets.add(reference);
      }
    }
  }
  return [...targets];
}

function modeledRenameCoversTarget(tree: BashCommandTree, target: string): boolean {
  return tree.statements.some((statement) => statement.stages.some((stage) => {
    if (shellExecutable(stage) !== 'ren') return false;
    const args = directPositionals('ren', stage.argv.slice(1));
    return args.length === 2 && args.includes(target);
  }));
}

function restoreMangledShellPath(
  value: string,
  rawPaths: readonly string[],
): string {
  if (process.platform !== 'win32') return value;
  const mangledDrivePath = /^[a-z]:[^\\/]/i.test(value);
  const mangledTempPath = /^(?:%temp%|%tmp%|\$env:(?:temp|tmp)|\$\{env:(?:temp|tmp)\}|\$\{(?:tmpdir|temp|tmp)\}|\$(?:tmpdir|temp|tmp))[^\\/]/i
    .test(value);
  if (!mangledDrivePath && !mangledTempPath) return value;
  const compact = value.replace(/[\\/]/g, '').toLowerCase();
  return rawPaths.find((candidate) => (
    (/^[a-z]:[\\/]/i.test(candidate) || hasTempEnvironmentPathPrefix(candidate))
    && candidate.replace(/[\\/]/g, '').toLowerCase() === compact
  )) ?? value;
}

function readCommandOutputTargets(stage: BashPipelineStage): string[] {
  const command = shellExecutable(stage);
  if (command !== 'less' && command !== 'tree') return [];
  const targets: string[] = [];
  for (let index = 1; index < stage.argv.length; index += 1) {
    const token = stage.argv[index] ?? '';
    if (command === 'less') {
      const shortOutput = shortOptionValue(token, LESS_OUTPUT_OPTIONS, LESS_SHORT_VALUE_OPTIONS);
      if (shortOutput.matched) {
        const target = shortOutput.attachedValue ?? stage.argv[index + 1];
        if (target) targets.push(target);
        if (shortOutput.attachedValue === undefined) index += 1;
        continue;
      }
      if (gitLongOptionMatches(token, '--log-file')) {
        const separator = token.indexOf('=');
        const target = separator >= 0 ? token.slice(separator + 1) : stage.argv[index + 1];
        if (target) targets.push(target);
        if (separator < 0) index += 1;
      }
      continue;
    }
    const shortOutput = shortOptionValue(token, TREE_OUTPUT_OPTIONS, TREE_SHORT_VALUE_OPTIONS);
    if (shortOutput.matched) {
      const target = shortOutput.attachedValue ?? stage.argv[index + 1];
      if (target) targets.push(target);
      if (shortOutput.attachedValue === undefined) index += 1;
      continue;
    }
    if (gitLongOptionMatches(token, '--output')) {
      const separator = token.indexOf('=');
      const target = separator >= 0 ? token.slice(separator + 1) : stage.argv[index + 1];
      if (target) targets.push(target);
      if (separator < 0) index += 1;
    }
  }
  return targets;
}

function directPositionals(command: string, argv: readonly string[]): string[] {
  const result: string[] = [];
  let skipNext = false;
  for (const token of argv) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (directOptionTakesValue(command, token)) {
      skipNext = true;
      continue;
    }
    if (token === '--') continue;
    if (token.startsWith('-') || isDirectWindowsSwitch(command, token)) continue;
    result.push(token);
  }
  return result;
}

const DIRECT_WINDOWS_SWITCHES: Readonly<Record<string, ReadonlySet<string>>> = {
  copy: new Set(['/a', '/b', '/d', '/j', '/l', '/n', '/v', '/y', '/-y', '/z']),
  del: new Set(['/p', '/f', '/s', '/q', '/a']),
  erase: new Set(['/p', '/f', '/s', '/q', '/a']),
  move: new Set(['/y', '/-y']),
  rd: new Set(['/s', '/q']),
  rmdir: new Set(['/s', '/q']),
};

function isDirectWindowsSwitch(command: string, token: string): boolean {
  const normalized = token.toLowerCase();
  const separator = normalized.indexOf(':');
  const base = separator >= 0 ? normalized.slice(0, separator) : normalized;
  return DIRECT_WINDOWS_SWITCHES[command]?.has(base) === true;
}

function directOptionTakesValue(command: string, token: string): boolean {
  if ((command === 'cp' || command === 'copy' || command === 'mv' || command === 'move')
    && ['-t', '--target-directory', '-S', '--suffix'].includes(token)) return true;
  if (command === 'mkdir' && ['-m', '--mode'].includes(token)) return true;
  return command === 'touch'
    && ['-d', '--date', '-r', '--reference', '-t', '--time'].includes(token);
}

function directTargetDirectory(argv: readonly string[]): string | undefined {
  const index = argv.findIndex((token) => token === '-t' || token === '--target-directory');
  if (index >= 0) return argv[index + 1];
  const attached = argv.find((token) => token.startsWith('--target-directory='));
  return attached?.slice('--target-directory='.length);
}

function joinSourceParent(source: string, newName: string): string {
  const flavor = /^[a-z]:|\\/i.test(source) ? path.win32 : path.posix;
  return flavor.join(flavor.dirname(source), newName);
}

function mapPowerShellOperation(
  operation: ReturnType<typeof analyzePowerShellMutation>['operations'][number],
  context: AutoModeRulesContext,
  rawPaths: readonly string[],
): AutoModePermissionOperation {
  const restorePath = (value: string): string => restoreMangledShellPath(value, rawPaths);
  if ('target' in operation) {
    return {
      kind: operation.kind,
      target: classifyTarget(restorePath(operation.target), context),
      options: operation.options,
    };
  }
  return {
    kind: operation.kind,
    source: classifyTarget(restorePath(operation.source), context),
    destination: classifyTarget(restorePath(operation.destination), context),
    options: operation.options,
  };
}

function hasPowerShellMutationStage(tree: BashCommandTree): boolean {
  return tree.statements.some((statement) => statement.stages.some((stage) => (
    isPowerShellMutationCommand(shellExecutable(stage))
  )));
}

function operationPaths(operation: AutoModePermissionOperation): readonly AutoModePermissionTarget[] {
  if ('target' in operation) return [operation.target];
  if ('source' in operation) return [operation.source, operation.destination];
  return [];
}

function collectRisks(operations: readonly AutoModePermissionOperation[]): string[] {
  const risks = new Set<string>();
  for (const operation of operations) {
    if (operation.options?.whatIf === true) continue;
    const targets = operationPaths(operation);
    if (mutationTargets(operation).some((target) => target.boundary === 'outside-workspace')) {
      risks.add('outside_workspace_mutation');
    }
    if (operation.kind === 'read'
      && targets.some((target) => target.boundary === 'protected')) risks.add('sensitive_read');
    if (targets.some((target) => target.boundary === 'protected')) risks.add('protected_path');
    if (targets.some((target) => target.boundary === 'unresolved')) risks.add('target_unresolved');
    if (operation.kind === 'move' || operation.kind === 'rename') {
      risks.add('source_removed');
      if (operation.source.boundary !== operation.destination.boundary) {
        risks.add('cross_boundary_mutation');
      }
    }
    if (operation.kind === 'copy' && operation.source.boundary !== operation.destination.boundary) {
      risks.add('cross_boundary_copy');
      if (operation.destination.boundary === 'outside-workspace') risks.add('data_export_possible');
    }
    if (operation.kind === 'delete') {
      risks.add('source_removed');
      if (operation.options?.recursive === true) risks.add('recursive_delete');
    }
    if ((operation.kind === 'move' || operation.kind === 'copy')
      && operation.options?.overwritePossible) risks.add('destination_overwrite_possible');
  }
  return [...risks];
}

function mutationTargets(
  operation: AutoModePermissionOperation,
): readonly AutoModePermissionTarget[] {
  if ('target' in operation) return operation.kind === 'read' ? [] : [operation.target];
  if (!('source' in operation)) return [];
  return operation.kind === 'copy'
    ? [operation.destination]
    : [operation.source, operation.destination];
}

function review(
  status: 'complete' | 'incomplete',
  shell: AutoModePermissionReview['analysis']['shell'],
  operations: readonly AutoModePermissionOperation[],
  risks: readonly string[],
  reason?: string,
): AutoModePermissionReview {
  return {
    schemaVersion: 1,
    analysis: {
      status,
      shell,
      binding: status === 'complete' ? 'exact' : 'partial',
      ...(reason ? { reason } : {}),
    },
    operations,
    risks,
  };
}

const DECLARED_TOOL_PATH_FIELDS = [
  'path', 'file_path', 'filePath', 'target_path', 'targetPath',
  'source_path', 'sourcePath', 'input_path', 'inputPath',
  'cwd', 'directory', 'root', 'worktree_path', 'worktreePath',
] as const;
const DECLARED_TOOL_PATH_ARRAY_FIELDS = [
  'paths', 'file_paths', 'filePaths', 'target_paths', 'targetPaths',
  'input_paths', 'inputPaths',
] as const;

function declaredToolPaths(input: Readonly<Record<string, unknown>>): readonly string[] {
  const paths = DECLARED_TOOL_PATH_FIELDS.flatMap((field) => (
    typeof input[field] === 'string' && input[field].trim() ? [input[field]] : []
  ));
  for (const field of DECLARED_TOOL_PATH_ARRAY_FIELDS) {
    const values = input[field];
    if (Array.isArray(values)) {
      paths.push(...values.filter((value): value is string => (
        typeof value === 'string' && value.trim().length > 0
      )));
    }
  }
  return [...new Set(paths)];
}

function assessDeclaredToolEffect(
  call: RunnerToolCall,
  context: AutoModeRulesContext,
): AutoModePermissionReview | undefined {
  const paths = declaredToolPaths(call.input);
  const filesystemEffect = context.toolSideEffect === 'readonly'
    ? 'read'
    : context.toolSideEffect === 'mutates-fs' ? 'write' : undefined;
  if (filesystemEffect && paths.length > 0) {
    const operations: AutoModePermissionOperation[] = paths.map((targetPath) => ({
      kind: filesystemEffect,
      target: classifyTarget(targetPath, context),
    }));
    const complete = operations.every((operation) => (
      operation.kind !== 'read' && operation.kind !== 'write'
        ? true
        : operation.target.boundary !== 'unresolved'
    ));
    const worktreeRemovalNeedsReview = call.name === 'worktree_remove'
      && call.input.action === 'remove'
      && paths.some((targetPath) => (
        isProtectedAgentHomeRemovalTarget(targetPath, context.executionCwd)
      ));
    return review(
      complete ? 'complete' : 'incomplete',
      'tool',
      operations,
      [
        ...collectRisks(operations),
        ...(worktreeRemovalNeedsReview ? ['protected_descendant'] : []),
      ],
    );
  }
  const contained = context.toolSideEffect === 'mutates-state';
  const readOnly = context.toolSideEffect === 'readonly'
    || context.toolSideEffect === 'reads-network';
  if (!contained && !readOnly) return undefined;
  const operation: AutoModePermissionOperation = {
    kind: 'execute',
    summary: `${context.toolSideEffect} tool ${call.name}`,
    options: contained ? { contained: true } : { readOnly: true },
  };
  return review('complete', 'tool', [operation], []);
}

export function analyzeAutoModeCall(
  call: RunnerToolCall,
  context: AutoModeRulesContext,
): AutoModePermissionReview {
  if (FILE_TOOLS.has(call.name)) return assessFileCall(call.input, context);
  if (READ_FILE_TOOLS.has(call.name)) return assessReadFileCall(call.name, call.input, context);
  if (call.name === 'bash') return assessBashCall(call.input, context);
  const declared = assessDeclaredToolEffect(call, context);
  if (declared) return declared;
  return review(
    'incomplete',
    'tool',
    [{ kind: 'unknown', summary: `tool ${call.name}` }],
    ['tool_effects_unresolved'],
    'tool has no deterministic effect analyzer',
  );
}
