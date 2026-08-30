import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseBashCommand } from './bash-ast.js';

export type ExecPolicyDecision = 'allow' | 'prompt' | 'forbidden';
export type ExecPolicySource = 'admin' | 'user' | 'project' | 'bundled';
export type ExecPolicyCriticalEffect =
  | 'rm_rf_root'
  | 'mkfs_or_format'
  | 'dd_disk_write'
  | 'fork_bomb'
  | 'uninspectable_nested_shell';

type NestedShellCommand =
  | { readonly kind: 'command'; readonly command: string; readonly hostExecutable: string }
  | { readonly kind: 'opaque'; readonly reason: string }
  | { readonly kind: 'invalid'; readonly reason: string }
  | { readonly kind: 'none' };

const MAX_POWERSHELL_ENCODED_COMMAND_CHARS = 128 * 1024;

export interface ExecPolicyRule {
  readonly prefix: readonly (string | readonly string[])[];
  readonly decision: ExecPolicyDecision;
  readonly justification: string;
  readonly source: ExecPolicySource;
  readonly sourcePath: string;
  readonly match?: readonly string[];
  readonly notMatch?: readonly string[];
  readonly hostExecutable?: readonly string[];
  readonly network?: readonly string[];
  readonly compound?: boolean;
}

/** Host/config input before KodaX assigns trusted provenance. */
export type ExecPolicyRuleInput = Omit<
  ExecPolicyRule,
  'source' | 'sourcePath'
>;

export interface ExecPolicyOperation {
  readonly tokens: readonly string[];
  readonly hostExecutable?: string;
  readonly network?: readonly string[];
  readonly compound?: boolean;
}

export interface ExecPolicyEvaluation {
  readonly decision: ExecPolicyDecision | 'unmatched';
  readonly justification?: string;
  readonly matched: readonly ExecPolicyRule[];
  readonly criticalFallback: boolean;
}

export type ParseExecPolicyResult =
  | { readonly ok: true; readonly rules: readonly ExecPolicyRule[] }
  | { readonly ok: false; readonly error: string };

export interface LoadExecPolicyOptions {
  readonly userConfigDir: string;
  readonly projectRoot?: string;
  readonly trustProjectPolicy?: boolean;
  readonly adminRules?: readonly ExecPolicyRuleInput[];
}

export interface LoadExecPolicyResult {
  readonly rules: readonly ExecPolicyRule[];
  readonly errors: readonly { readonly path: string; readonly message: string }[];
}

const DECISION_RANK: Readonly<Record<ExecPolicyDecision, number>> = {
  allow: 1,
  prompt: 2,
  forbidden: 3,
};
const SOURCE_RANK: Readonly<Record<ExecPolicySource, number>> = {
  admin: 4,
  user: 3,
  project: 2,
  bundled: 1,
};
const RULE_FIELDS = new Set([
  'prefix',
  'decision',
  'justification',
  'match',
  'notMatch',
  'hostExecutable',
  'network',
  'compound',
]);

export function parseExecPolicy(
  source: string,
  sourcePath: string,
  origin: ExecPolicySource = 'user',
): ParseExecPolicyResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(source));
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.rules)) {
    return { ok: false, error: 'exec-policy root must contain a rules array' };
  }

  const rules: ExecPolicyRule[] = [];
  for (let index = 0; index < parsed.rules.length; index += 1) {
    const result = parseRule(parsed.rules[index], sourcePath, origin, index);
    if (!result.ok) return result;
    rules.push(result.rule);
  }
  return { ok: true, rules };
}

export async function loadExecPolicy(
  options: LoadExecPolicyOptions,
): Promise<LoadExecPolicyResult> {
  const rules: ExecPolicyRule[] = [];
  const errors: Array<{ readonly path: string; readonly message: string }> = [];
  for (let index = 0; index < (options.adminRules?.length ?? 0); index += 1) {
    const value: unknown = options.adminRules?.[index];
    const sourcePath = 'host:admin';
    const parsed = parseRule(adminRuleValue(value), sourcePath, 'admin', index);
    if (parsed.ok) rules.push(parsed.rule);
    else errors.push({ path: sourcePath, message: parsed.error });
  }
  await loadOne(join(options.userConfigDir, 'exec-policy.jsonc'), 'user', rules, errors);
  if (options.trustProjectPolicy === true && options.projectRoot !== undefined) {
    await loadOne(
      join(options.projectRoot, '.kodax', 'exec-policy.jsonc'),
      'project',
      rules,
      errors,
    );
  }
  return { rules, errors };
}

function adminRuleValue(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return {
    prefix: value.prefix,
    decision: value.decision,
    justification: value.justification,
    match: value.match,
    notMatch: value.notMatch,
    hostExecutable: value.hostExecutable,
    network: value.network,
    compound: value.compound,
  };
}

export function evaluateExecPolicy(
  operation: ExecPolicyOperation,
  rules: readonly ExecPolicyRule[],
): ExecPolicyEvaluation {
  return evaluateOperation(operation, rules, criticalEffect(operation.tokens));
}

export function createExecPolicyOperation(
  tokens: readonly string[],
  facts: Pick<ExecPolicyOperation, 'hostExecutable' | 'network' | 'compound'> = {},
): ExecPolicyOperation {
  const network = facts.network ?? literalNetworkDestinations(tokens);
  return {
    tokens,
    compound: facts.compound ?? false,
    ...(facts.hostExecutable === undefined
      ? {}
      : { hostExecutable: facts.hostExecutable }),
    ...(network === undefined ? {} : { network }),
  };
}

function evaluateOperation(
  operation: ExecPolicyOperation,
  rules: readonly ExecPolicyRule[],
  critical: ExecPolicyCriticalEffect | undefined,
): ExecPolicyEvaluation {
  const matched = rules
    .filter((rule) => ruleMatches(rule, operation))
    .sort(compareRules);
  const adminForbidden = matched.find(
    (rule) => rule.source === 'admin' && rule.decision === 'forbidden',
  );
  if (adminForbidden !== undefined) {
    return decisionResult(adminForbidden, matched, false);
  }

  if (critical !== undefined) {
    const exactAllow = critical === 'uninspectable_nested_shell'
      ? undefined
      : matched.find(
        (rule) => rule.decision === 'allow' && rule.prefix.length === operation.tokens.length,
      );
    const stricter = matched.find((rule) => rule.decision !== 'allow');
    if (stricter !== undefined) return decisionResult(stricter, matched, true);
    if (exactAllow !== undefined) return decisionResult(exactAllow, matched, false);
    const fallback = criticalFallbackRule(critical);
    return decisionResult(fallback, [fallback, ...matched], true);
  }

  const strictest = matched[0];
  return strictest === undefined
    ? { decision: 'unmatched', matched: [], criticalFallback: false }
    : decisionResult(strictest, matched, false);
}

export function evaluateShellExecPolicy(
  command: string,
  rules: readonly ExecPolicyRule[],
  facts: Pick<ExecPolicyOperation, 'hostExecutable' | 'network'> = {},
): ExecPolicyEvaluation {
  const tree = parseBashCommand(command);
  if (tree.unparseable) {
    if (isForkBomb(command)) {
      const tokenized = tokenizeShellCommand(command);
      return evaluateOperation({
        tokens: tokenized.tokens,
        compound: true,
        ...facts,
      }, rules, 'fork_bomb');
    }
    return evaluateUnparseableShellCommand(command, rules, facts);
  }
  const stages = tree.statements.flatMap((statement) => statement.stages);
  const compound = tree.statements.length > 1 || stages.length > 1;
  const evaluations = stages.flatMap((stage) => {
    const tokens = normalizeHostShellTokens(stage.argv, facts.hostExecutable);
    const operation = createExecPolicyOperation(tokens, { ...facts, compound });
    const direct = evaluateExecPolicy(operation, rules);
    return [
      direct,
      ...evaluateNestedAdministratorForbidden(tokens, rules, facts, compound),
    ];
  });
  return evaluations.reduce(strictestEvaluation, {
    decision: 'unmatched',
    matched: [],
    criticalFallback: false,
  });
}

function normalizeHostShellTokens(
  tokens: readonly string[],
  hostExecutable: string | undefined,
): readonly string[] {
  if (!['cmd', 'cmd.exe'].includes(executableName(hostExecutable ?? ''))) return tokens;
  return tokens.map(unescapeCmdCarets);
}

function unescapeCmdCarets(token: string): string {
  let normalized = '';
  for (let index = 0; index < token.length; index += 1) {
    const character = token[index]!;
    if (character === '^' && index + 1 < token.length) {
      normalized += token[index + 1]!;
      index += 1;
    } else {
      normalized += character;
    }
  }
  return normalized;
}

function evaluateAdministratorForbidden(
  operation: ExecPolicyOperation,
  rules: readonly ExecPolicyRule[],
): ExecPolicyEvaluation | undefined {
  const matched = rules
    .filter((rule) => (
      rule.source === 'admin'
      && rule.decision === 'forbidden'
      && ruleMatches(rule, operation)
    ))
    .sort(compareRules);
  return matched[0] === undefined
    ? undefined
    : decisionResult(matched[0], matched, false);
}

function evaluateNestedAdministratorForbidden(
  tokens: readonly string[],
  rules: readonly ExecPolicyRule[],
  facts: Pick<ExecPolicyOperation, 'hostExecutable' | 'network'>,
  compound: boolean,
): ExecPolicyEvaluation[] {
  const evaluations: ExecPolicyEvaluation[] = [];
  const appendTokens = (effectiveTokens: readonly string[], nestedCompound: boolean): void => {
    const operation = createExecPolicyOperation(effectiveTokens, {
      ...facts,
      compound: nestedCompound,
    });
    const administratorForbidden = evaluateAdministratorForbidden(operation, rules);
    if (administratorForbidden !== undefined) evaluations.push(administratorForbidden);
    evaluations.push(...evaluateNestedAdministratorForbidden(
      effectiveTokens,
      rules,
      facts,
      nestedCompound,
    ));
  };

  const wrapped = wrappedCommandTokens(tokens);
  if (wrapped !== undefined) appendTokens(wrapped, compound);

  const executable = executableName(tokens[0] ?? '');
  const nested = nestedShellCommand(executable, tokens.slice(1));
  if (nested.kind === 'command') {
    const tree = parseBashCommand(nested.command);
    if (!tree.unparseable) {
      const stages = tree.statements.flatMap((statement) => statement.stages);
      const nestedCompound = compound || tree.statements.length > 1 || stages.length > 1;
      for (const stage of stages) {
        appendTokens(normalizeHostShellTokens(stage.argv, nested.hostExecutable), nestedCompound);
      }
    } else if (
      rules.some((rule) => rule.source === 'admin' && rule.decision === 'forbidden')
    ) {
      const fallback = opaqueNestedShellFallbackRule(
        `${executable} command syntax is not inspectable.`,
      );
      evaluations.push(decisionResult(fallback, [fallback], true));
    }
  } else if (
    nested.kind === 'opaque'
    && rules.some((rule) => rule.source === 'admin' && rule.decision === 'forbidden')
  ) {
    const fallback = opaqueNestedShellFallbackRule(nested.reason);
    evaluations.push(decisionResult(fallback, [fallback], true));
  }
  return evaluations;
}

function wrappedCommandTokens(tokens: readonly string[]): readonly string[] | undefined {
  const assignmentEnd = leadingAssignmentEnd(tokens);
  if (assignmentEnd > 0 && assignmentEnd < tokens.length) {
    return tokens.slice(assignmentEnd);
  }
  const executable = executableName(tokens[0] ?? '');
  const args = tokens.slice(1);
  if (executable === 'call') return args.length === 0 ? undefined : args;
  if (executable === 'start') return windowsStartWrappedTokens(args);
  if (executable === 'env') return envWrappedTokens(args);
  if (executable === 'timeout') return timeoutWrappedTokens(args);
  if (['nice', 'nohup', 'time', 'setsid', 'stdbuf'].includes(executable)) {
    const commandIndex = transparentWrapperCommandIndex(executable, args);
    return commandIndex < 0 ? undefined : args.slice(commandIndex);
  }
  if (['busybox', 'toybox'].includes(executable)) {
    return args.length === 0 ? undefined : args;
  }
  if (!['sudo', 'doas', 'command'].includes(executable)) return undefined;
  const commandIndex = wrapperCommandIndex(executable, args);
  return commandIndex < 0 ? undefined : args.slice(commandIndex);
}

function windowsStartWrappedTokens(args: readonly string[]): readonly string[] | undefined {
  const optionsWithValues = new Set(['/d', '/node', '/affinity', '/machine']);
  let index = 0;
  while (index < args.length) {
    const token = args[index]!;
    const lower = token.toLowerCase();
    if (token === '' || token === '""' || token === "''") {
      index += 1;
      continue;
    }
    if (!token.startsWith('/')) break;
    index += optionsWithValues.has(lower) ? 2 : 1;
  }
  return index < args.length ? args.slice(index) : undefined;
}

function leadingAssignmentEnd(tokens: readonly string[], start = 0): number {
  let index = start;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[index] ?? '')) index += 1;
  return index;
}

function envWrappedTokens(args: readonly string[]): readonly string[] | undefined {
  const optionsWithValues = new Set(['-u', '--unset', '-C', '--chdir', '--argv0']);
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === '--') {
      const commandIndex = leadingAssignmentEnd(args, index + 1);
      return commandIndex < args.length ? args.slice(commandIndex) : undefined;
    }
    if (token === '-S' || token === '--split-string') {
      const split = args[index + 1];
      return split === undefined
        ? undefined
        : [...tokenizeShellCommand(split).tokens, ...args.slice(index + 2)];
    }
    if (token.startsWith('--split-string=')) {
      return [
        ...tokenizeShellCommand(token.slice('--split-string='.length)).tokens,
        ...args.slice(index + 1),
      ];
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(token)) continue;
    if (!token.startsWith('-') || token === '-') return args.slice(index);
    if (token.startsWith('--') && token.includes('=')) continue;
    if (optionsWithValues.has(token)) index += 1;
  }
  return undefined;
}

function timeoutWrappedTokens(args: readonly string[]): readonly string[] | undefined {
  const durationIndex = optionPayloadEnd(
    args,
    new Set(['-k', '--kill-after', '-s', '--signal']),
  );
  return durationIndex < 0 || durationIndex + 1 >= args.length
    ? undefined
    : args.slice(durationIndex + 1);
}

function transparentWrapperCommandIndex(executable: string, args: readonly string[]): number {
  const optionsWithValues: Readonly<Record<string, ReadonlySet<string>>> = {
    nice: new Set(['-n', '--adjustment']),
    nohup: new Set(),
    time: new Set(['-f', '--format', '-o', '--output']),
    setsid: new Set(),
    stdbuf: new Set(['-i', '--input', '-o', '--output', '-e', '--error']),
  };
  return optionPayloadEnd(args, optionsWithValues[executable] ?? new Set());
}

function optionPayloadEnd(
  args: readonly string[],
  optionsWithValues: ReadonlySet<string>,
): number {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === '--') return index + 1 < args.length ? index + 1 : -1;
    if (!token.startsWith('-') || token === '-') return index;
    if (/^-[0-9]+$/u.test(token)) continue;
    if (token.startsWith('--') && token.includes('=')) continue;
    if (optionsWithValues.has(token)) index += 1;
  }
  return -1;
}

function wrapperCommandIndex(executable: string, args: readonly string[]): number {
  const optionsWithValues: Readonly<Record<string, ReadonlySet<string>>> = {
    sudo: new Set([
      '-C', '-D', '-g', '-h', '-p', '-R', '-r', '-T', '-t', '-U', '-u',
      '--chdir', '--close-from', '--command-timeout', '--group', '--host',
      '--other-user', '--prompt', '--role', '--type', '--user',
    ]),
    doas: new Set(['-a', '-u']),
    command: new Set(),
  };
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === '--') return index + 1;
    if (!token.startsWith('-') || token === '-') return index;
    if (executable === 'command' && /^-[vV]/u.test(token)) return -1;
    if (executable === 'doas' && (token === '-C' || token.startsWith('-C'))) return -1;
    if (token.startsWith('--') && token.includes('=')) continue;
    if (optionsWithValues[executable]?.has(token)) index += 1;
  }
  return -1;
}

function evaluateUnparseableShellCommand(
  command: string,
  rules: readonly ExecPolicyRule[],
  facts: Pick<ExecPolicyOperation, 'hostExecutable' | 'network'>,
): ExecPolicyEvaluation {
  const tokenized = tokenizeShellCommand(command);
  const normalizedTokens = normalizeHostShellTokens(
    tokenized.tokens.map((token) => (
      token.replace(/^[`$(]+/u, '').replace(/[`)]+$/u, '')
    )).filter((token) => token.length > 0),
    facts.hostExecutable,
  );
  const operation = createExecPolicyOperation(normalizedTokens, {
    ...facts,
    compound: true,
  });
  const evaluations: ExecPolicyEvaluation[] = [
    evaluateExecPolicy(operation, rules),
    ...evaluateNestedAdministratorForbidden(normalizedTokens, rules, facts, true),
  ];

  // Unsupported shell syntax must not make nested administrator forbids or
  // the narrow critical-effect fallback disappear. Inspect each possible
  // command start, but only retain absolute administrator denials and
  // critical effects from suffixes to avoid broadening ordinary user rules.
  for (let index = 1; index < normalizedTokens.length; index += 1) {
    const suffix = normalizedTokens.slice(index);
    const evaluation = evaluateExecPolicy({ ...operation, tokens: suffix }, rules);
    if (
      evaluation.criticalFallback
      || evaluation.matched.some((rule) => (
        rule.source === 'admin' && rule.decision === 'forbidden'
      ))
    ) {
      evaluations.push(evaluation);
    }
  }
  return evaluations.reduce(strictestEvaluation, {
    decision: 'unmatched',
    matched: [],
    criticalFallback: false,
  });
}

function literalNetworkDestinations(tokens: readonly string[]): readonly string[] | undefined {
  const destinations = new Set<string>();
  for (const token of tokens) {
    try {
      const url = new URL(token);
      if (url.hostname.length > 0) destinations.add(url.hostname);
    } catch {
      const scp = /^(?:[^@\s]+@)?([^:/\s]+):[^\s]+$/u.exec(token);
      if (scp?.[1] !== undefined) destinations.add(scp[1]);
    }
  }
  return destinations.size === 0 ? undefined : [...destinations];
}

export function tokenizeShellCommand(command: string): {
  readonly tokens: readonly string[];
  readonly compound: boolean;
} {
  const tokens: string[] = [];
  let token = '';
  let quote: '"' | "'" | undefined;
  let compound = false;
  const push = (): void => {
    if (token.length === 0) return;
    tokens.push(token);
    token = '';
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    const next = command[index + 1];
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      } else if (char === '\\' && next === quote) {
        token += next;
        index += 1;
      } else {
        token += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/u.test(char)) {
      push();
      continue;
    }
    if (char === ';' || char === '|' || char === '&' || char === '\n') {
      push();
      compound = true;
      if ((char === '|' || char === '&') && next === char) index += 1;
      continue;
    }
    token += char;
  }
  push();
  return { tokens, compound };
}

function parseRule(
  value: unknown,
  sourcePath: string,
  source: ExecPolicySource,
  index: number,
): { readonly ok: true; readonly rule: ExecPolicyRule } | { readonly ok: false; readonly error: string } {
  const label = `exec-policy.rules[${index}]`;
  if (!isRecord(value)) return { ok: false, error: `${label} must be an object` };
  const unknownField = Object.keys(value).find((field) => !RULE_FIELDS.has(field));
  if (unknownField !== undefined) {
    return { ok: false, error: `${label}.${unknownField} is not supported` };
  }
  const prefix = parsePrefix(value.prefix);
  if (typeof prefix === 'string') return { ok: false, error: `${label}.${prefix}` };
  if (!isDecision(value.decision)) {
    return { ok: false, error: `${label}.decision must be allow, prompt, or forbidden` };
  }
  const justification = nonEmptyString(value.justification);
  if (justification === undefined) {
    return { ok: false, error: `${label}.justification must be a non-empty string` };
  }
  const match = stringArray(value.match, `${label}.match`);
  if (!match.ok) return match;
  const notMatch = stringArray(value.notMatch, `${label}.notMatch`);
  if (!notMatch.ok) return notMatch;
  const hostExecutable = stringArray(value.hostExecutable, `${label}.hostExecutable`);
  if (!hostExecutable.ok) return hostExecutable;
  const network = stringArray(value.network, `${label}.network`);
  if (!network.ok) return network;
  if (value.compound !== undefined && typeof value.compound !== 'boolean') {
    return { ok: false, error: `${label}.compound must be boolean` };
  }

  for (const example of match.value ?? []) {
    if (!prefixMatches(prefix, tokenizeShellCommand(example).tokens)) {
      return { ok: false, error: `${label}.match example does not match prefix: ${example}` };
    }
  }
  for (const example of notMatch.value ?? []) {
    if (prefixMatches(prefix, tokenizeShellCommand(example).tokens)) {
      return { ok: false, error: `${label}.notMatch example matches prefix: ${example}` };
    }
  }

  return {
    ok: true,
    rule: {
      prefix,
      decision: value.decision,
      justification,
      source,
      sourcePath,
      ...(match.value === undefined ? {} : { match: match.value }),
      ...(notMatch.value === undefined ? {} : { notMatch: notMatch.value }),
      ...(hostExecutable.value === undefined ? {} : { hostExecutable: hostExecutable.value }),
      ...(network.value === undefined ? {} : { network: network.value }),
      ...(typeof value.compound === 'boolean' ? { compound: value.compound } : {}),
    },
  };
}

function parsePrefix(value: unknown): readonly (string | readonly string[])[] | string {
  if (!Array.isArray(value) || value.length === 0) return 'prefix must be a non-empty array';
  const prefix: Array<string | readonly string[]> = [];
  for (const token of value) {
    if (typeof token === 'string' && token.length > 0) {
      prefix.push(token);
      continue;
    }
    if (
      Array.isArray(token)
      && token.length > 0
      && token.every((choice) => typeof choice === 'string' && choice.length > 0)
    ) {
      prefix.push(token as string[]);
      continue;
    }
    return 'prefix entries must be non-empty strings or non-empty string arrays';
  }
  return prefix;
}

function stringArray(
  value: unknown,
  label: string,
): { readonly ok: true; readonly value?: readonly string[] } | { readonly ok: false; readonly error: string } {
  if (value === undefined) return { ok: true };
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    return { ok: false, error: `${label} must be an array of strings` };
  }
  return { ok: true, value };
}

function ruleMatches(rule: ExecPolicyRule, operation: ExecPolicyOperation): boolean {
  if (!prefixMatches(rule.prefix, operation.tokens)) return false;
  if (
    rule.hostExecutable !== undefined
    && (operation.hostExecutable === undefined
      || !rule.hostExecutable.some((value) => sameToken(value, operation.hostExecutable!)))
  ) return false;
  if (
    rule.network !== undefined
    && (operation.network === undefined
      || operation.network.length === 0
      || !operation.network.every((actual) => rule.network?.some(
        (allowed) => sameNetworkDestination(allowed, actual),
      ) === true))
  ) return false;
  return rule.compound === undefined || rule.compound === (operation.compound ?? false);
}

function prefixMatches(
  prefix: readonly (string | readonly string[])[],
  tokens: readonly string[],
): boolean {
  if (prefix.length > tokens.length) return false;
  return prefix.every((pattern, index) => {
    const actual = tokens[index]!;
    return typeof pattern === 'string'
      ? sameToken(pattern, actual)
      : pattern.some((choice) => sameToken(choice, actual));
  });
}

function sameToken(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function sameNetworkDestination(left: string, right: string): boolean {
  return left.replace(/\.$/u, '').toLowerCase()
    === right.replace(/\.$/u, '').toLowerCase();
}

function compareRules(left: ExecPolicyRule, right: ExecPolicyRule): number {
  const leftAdminForbid = left.source === 'admin' && left.decision === 'forbidden';
  const rightAdminForbid = right.source === 'admin' && right.decision === 'forbidden';
  if (leftAdminForbid !== rightAdminForbid) return leftAdminForbid ? -1 : 1;
  return DECISION_RANK[right.decision] - DECISION_RANK[left.decision]
    || SOURCE_RANK[right.source] - SOURCE_RANK[left.source]
    || right.prefix.length - left.prefix.length;
}

function decisionResult(
  rule: ExecPolicyRule,
  matched: readonly ExecPolicyRule[],
  criticalFallback: boolean,
): ExecPolicyEvaluation {
  return {
    decision: rule.decision,
    justification: rule.justification,
    matched,
    criticalFallback,
  };
}

function strictestEvaluation(
  left: ExecPolicyEvaluation,
  right: ExecPolicyEvaluation,
): ExecPolicyEvaluation {
  const rank = (decision: ExecPolicyEvaluation['decision']): number => (
    decision === 'unmatched' ? 0 : DECISION_RANK[decision]
  );
  const decisionDifference = rank(right.decision) - rank(left.decision);
  const rightRule = right.matched[0];
  const leftRule = left.matched[0];
  const strictest = decisionDifference > 0
    || (decisionDifference === 0
      && rightRule !== undefined
      && (leftRule === undefined || compareRules(rightRule, leftRule) < 0))
    ? right
    : left;
  return {
    ...strictest,
    matched: [...left.matched, ...right.matched].sort(compareRules),
    criticalFallback: left.criticalFallback || right.criticalFallback,
  };
}

function criticalEffect(
  tokens: readonly string[],
): ExecPolicyCriticalEffect | undefined {
  const executable = executableName(tokens[0] ?? '');
  const args = tokens.slice(1);
  const wrapped = wrappedCommandTokens(tokens);
  if (wrapped !== undefined) return criticalEffect(wrapped);
  const nested = nestedShellCommand(executable, args);
  if (nested.kind === 'command') {
    return criticalEffectInCommand(nested.command, nested.hostExecutable);
  }
  if (nested.kind === 'invalid') return 'uninspectable_nested_shell';
  if (executable === 'rm' && hasRecursiveAndForceFlags(args)) {
    return args.some((token) => isRootRemovalTarget(token)) ? 'rm_rf_root' : undefined;
  }
  if (/^mkfs(?:\.[a-z0-9]+)?$/iu.test(executable) || executable === 'fdisk') {
    return args.some((token) => isBlockDevice(token)) ? 'mkfs_or_format' : undefined;
  }
  if (executable === 'format' || executable === 'format.com') {
    return args.some((token) => /^[a-z]:[\\/]?$/iu.test(token))
      ? 'mkfs_or_format'
      : undefined;
  }
  if (executable === 'dd') {
    return args.some((token) => token.toLowerCase().startsWith('of=')
      && isBlockDevice(token.slice(3)))
      ? 'dd_disk_write'
      : undefined;
  }
  if (executable === 'remove-item' || executable === 'ri') {
    const recursive = args.some((token) => /^-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?$/iu.test(token));
    return recursive && args.some((token) => isRootRemovalTarget(token))
      ? 'rm_rf_root'
      : undefined;
  }
  return executable === 'diskpart' && args.some((token) => token.toLowerCase() === 'clean')
    ? 'mkfs_or_format'
    : undefined;
}

function nestedShellCommand(
  executable: string,
  args: readonly string[],
): NestedShellCommand {
  if (['bash', 'bash.exe', 'sh', 'sh.exe', 'zsh', 'zsh.exe', 'dash'].includes(executable)) {
    const index = args.findIndex((arg) => /^-[^-]*c/u.test(arg.toLowerCase()));
    if (index < 0) return { kind: 'none' };
    const command = args[index + 1];
    return command === undefined || command.length === 0
      ? { kind: 'invalid', reason: `${executable} command selector has no command.` }
      : { kind: 'command', command, hostExecutable: executable };
  }
  if (['cmd', 'cmd.exe'].includes(executable)) return nestedCmdCommand(executable, args);
  if (['powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'].includes(executable)) {
    return nestedPowerShellCommand(executable, args);
  }
  return { kind: 'none' };
}

function nestedCmdCommand(
  executable: string,
  args: readonly string[],
): NestedShellCommand {
  const index = args.findIndex((arg) => /^\/[ck]/iu.test(arg));
  if (index < 0) return { kind: 'none' };
  const attached = args[index]!.slice(2);
  const command = [attached, ...args.slice(index + 1)].filter(Boolean).join(' ');
  return command.length === 0
    ? { kind: 'invalid', reason: `${executable} command selector has no command.` }
    : { kind: 'command', command, hostExecutable: executable };
}

function nestedPowerShellCommand(
  executable: string,
  args: readonly string[],
): NestedShellCommand {
  for (let index = 0; index < args.length; index += 1) {
    const selector = powerShellCommandSelector(args[index]!);
    if (selector === undefined) continue;
    const payload = args[index + 1];
    if (payload === undefined || payload.length === 0) {
      return { kind: 'invalid', reason: `${executable} ${args[index]} has no command.` };
    }
    if (selector === 'file' || payload === '-') {
      return { kind: 'opaque', reason: `${executable} command content is not inspectable.` };
    }
    if (selector === 'encoded') {
      const decoded = decodePowerShellCommand(payload);
      return decoded === undefined
        ? { kind: 'invalid', reason: `${executable} encoded command is invalid.` }
        : { kind: 'command', command: decoded, hostExecutable: executable };
    }
    return {
      kind: 'command',
      command: args.slice(index + 1).join(' '),
      hostExecutable: executable,
    };
  }
  return args.some((arg) => !arg.startsWith('-') && !arg.startsWith('/'))
    ? { kind: 'opaque', reason: `${executable} script content is not inspectable.` }
    : { kind: 'none' };
}

function powerShellCommandSelector(
  token: string,
): 'plain' | 'encoded' | 'file' | undefined {
  if (!token.startsWith('-') && !token.startsWith('/')) return undefined;
  const name = token.slice(1).toLowerCase();
  if (name.length === 0) return undefined;
  if (name === 'cwa' || name === 'commandwithargs') return 'plain';
  if ('command'.startsWith(name)) return 'plain';
  if ('encodedcommand'.startsWith(name)) return 'encoded';
  if ('file'.startsWith(name)) return 'file';
  return undefined;
}

function decodePowerShellCommand(value: string): string | undefined {
  if (
    value.length === 0
    || value.length > MAX_POWERSHELL_ENCODED_COMMAND_CHARS
    || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) return undefined;
  const bytes = Buffer.from(value, 'base64');
  if (
    bytes.length === 0
    || bytes.length % 2 !== 0
    || bytes.toString('base64') !== value
  ) return undefined;
  const command = bytes.toString('utf16le');
  return command.trim().length > 0
    && !command.includes('\0')
    && validUtf16(command)
    && Buffer.from(command, 'utf16le').equals(bytes)
    ? command
    : undefined;
}

function validUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function criticalEffectInCommand(
  command: string,
  hostExecutable: string,
): ExecPolicyCriticalEffect | undefined {
  if (isForkBomb(command)) return 'fork_bomb';
  const tree = parseBashCommand(command);
  if (tree.unparseable) return 'uninspectable_nested_shell';
  for (const statement of tree.statements) {
    for (const stage of statement.stages) {
      const effect = criticalEffect(normalizeHostShellTokens(stage.argv, hostExecutable));
      if (effect !== undefined) return effect;
    }
  }
  return undefined;
}

function executableName(value: string): string {
  return value.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() ?? '';
}

function hasRecursiveAndForceFlags(args: readonly string[]): boolean {
  let recursive = false;
  let force = false;
  for (const arg of args) {
    if (arg === '--recursive' || arg === '-R') recursive = true;
    else if (arg === '--force') force = true;
    else if (/^-[^-]/u.test(arg)) {
      recursive ||= /r/iu.test(arg.slice(1));
      force ||= /f/u.test(arg.slice(1));
    }
  }
  return recursive && force;
}

function isRootRemovalTarget(value: string): boolean {
  const normalized = value.replace(/\/+\*+$/u, '/').replace(/\/+$/u, '/');
  return ['/', '~', '~/', '$HOME', '$HOME/', '${HOME}', '${HOME}/'].includes(value)
    || ['/', '~/', '$HOME/', '${HOME}/'].includes(normalized)
    || /^[a-z]:[\\/]?$/iu.test(value);
}

function isBlockDevice(value: string): boolean {
  return /^\/dev\/(?:sd|nvme|hd|vd)[a-z0-9]*$/iu.test(value)
    || /^\\\\\.\\PhysicalDrive[0-9]+$/iu.test(value);
}

function isForkBomb(command: string): boolean {
  return /:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:\s*&[^}]*\}\s*;\s*:/u.test(command);
}

function criticalFallbackRule(effect: ExecPolicyCriticalEffect): ExecPolicyRule {
  const justification: Readonly<Record<ExecPolicyCriticalEffect, string>> = {
    rm_rf_root: 'Unmatched command recursively and forcibly deletes a filesystem root.',
    mkfs_or_format: 'Unmatched command formats or repartitions a block device.',
    dd_disk_write: 'Unmatched command writes raw bytes directly to a block device.',
    fork_bomb: 'Unmatched command can exhaust host process and CPU resources.',
    uninspectable_nested_shell: 'Nested shell command syntax cannot be inspected safely.',
  };
  return {
    prefix: [],
    decision: 'forbidden',
    justification: justification[effect],
    source: 'bundled',
    sourcePath: `builtin:critical-effects/${effect}`,
  };
}

function opaqueNestedShellFallbackRule(reason: string): ExecPolicyRule {
  return {
    prefix: [],
    decision: 'forbidden',
    justification: `Administrator forbidden policy cannot inspect this nested shell: ${reason}`,
    source: 'bundled',
    sourcePath: 'builtin:admin-forbidden/opaque-nested-shell',
  };
}

async function loadOne(
  path: string,
  source: ExecPolicySource,
  rules: ExecPolicyRule[],
  errors: Array<{ readonly path: string; readonly message: string }>,
): Promise<void> {
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return;
    errors.push({ path, message: errorMessage(error) });
    return;
  }
  const parsed = parseExecPolicy(content, path, source);
  if (parsed.ok) rules.push(...parsed.rules);
  else errors.push({ path, message: parsed.error });
}

function stripJsonComments(source: string): string {
  let output = '';
  let index = 0;
  let inString = false;
  let escaped = false;
  while (index < source.length) {
    const char = source[index]!;
    const next = source[index + 1];
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      index += 1;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      index += 1;
      continue;
    }
    if (char === '/' && next === '/') {
      index += 2;
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        index += 1;
      }
      if (index >= source.length) throw new Error('Unterminated JSONC block comment');
      index += 2;
      continue;
    }
    if (char === ',') {
      let lookahead = index + 1;
      while (/\s/u.test(source[lookahead] ?? '')) lookahead += 1;
      if (source[lookahead] === ']' || source[lookahead] === '}') {
        index += 1;
        continue;
      }
    }
    output += char;
    index += 1;
  }
  return output;
}

function isDecision(value: unknown): value is ExecPolicyDecision {
  return value === 'allow' || value === 'prompt' || value === 'forbidden';
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
