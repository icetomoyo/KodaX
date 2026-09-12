import {
  SkillRegistry,
  emitKodaXDiagnostic,
  type Skill,
  type SkillHook,
  type SkillHooks,
} from '@kodax-ai/agent';
import type { KodaXOptions, KodaXShellExecutionContract } from './types.js';
import { toolBash } from './tools/bash.js';

const TOOL_NAME_ALIASES: Readonly<Record<string, string>> = {
  read: 'read',
  grep: 'grep',
  glob: 'glob',
  write: 'write',
  edit: 'edit',
  bash: 'bash',
  undo: 'undo',
  askuserquestion: 'ask-user-question',
  askuser: 'ask-user-question',
};

interface AllowedToolRule {
  readonly tool: string;
  readonly patterns?: readonly string[];
}

interface AllowedToolPolicy {
  readonly configured: boolean;
  readonly rules: readonly AllowedToolRule[];
  readonly invalidEntries: readonly string[];
}

function splitTopLevelCommaList(value: string): string[] {
  const items: string[] = [];
  let current = '';
  let depth = 0;
  for (const char of value) {
    if (char === ',' && depth === 0) {
      if (current.trim()) items.push(current.trim());
      current = '';
      continue;
    }
    if (char === '(') depth++;
    else if (char === ')' && depth > 0) depth--;
    current += char;
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

function parseAllowedTools(value?: string): AllowedToolPolicy {
  if (!value?.trim()) return { configured: false, rules: [], invalidEntries: [] };
  const rules: AllowedToolRule[] = [];
  const invalidEntries: string[] = [];
  for (const entry of splitTopLevelCommaList(value)) {
    if (entry === '*') {
      rules.push({ tool: '*' });
      continue;
    }
    if (entry.includes('(') && !entry.endsWith(')')) {
      invalidEntries.push(entry);
      continue;
    }
    const match = entry.match(/^([^(]+?)(?:\((.*)\))?$/);
    if (!match) {
      invalidEntries.push(entry);
      continue;
    }
    const tool = TOOL_NAME_ALIASES[match[1]!.replace(/[^a-z]/gi, '').toLowerCase()];
    if (!tool) {
      invalidEntries.push(entry);
      continue;
    }
    const patterns = match[2]
      ? splitTopLevelCommaList(match[2]).map((item) => item.trim()).filter(Boolean)
      : undefined;
    rules.push({ tool, ...(patterns?.length ? { patterns } : {}) });
  }
  return { configured: true, rules, invalidEntries };
}

function matchesPattern(pattern: string, value: string): boolean {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i').test(value);
}

function isToolAllowed(
  policy: AllowedToolPolicy,
  tool: string,
  input: Record<string, unknown>,
): boolean {
  if (!policy.configured) return true;
  if (policy.rules.length === 0) return false;
  const normalizedTool = tool.toLowerCase();
  const command = normalizedTool === 'bash' ? String(input.command ?? '').trim() : '';
  return policy.rules.some((rule) => {
    if (rule.tool !== '*' && rule.tool !== normalizedTool) return false;
    if (!rule.patterns?.length || normalizedTool !== 'bash') return true;
    return rule.patterns.some((pattern) => matchesPattern(pattern, command));
  });
}

function hookMatches(hook: SkillHook, target: string): boolean {
  return hook.matcher === undefined || matchesPattern(hook.matcher, target);
}

interface HookResponse {
  readonly allow?: boolean;
  readonly message?: string;
  readonly additionalContext?: string;
}

function hookToolInput(event: keyof SkillHooks, hook: SkillHook): Record<string, unknown> {
  return {
    command: hook.command,
    _reason: `Frontmatter hook ${event}`,
    _frontmatterHook: true,
    _hookEvent: event,
    _hookMatcher: hook.matcher,
  };
}

async function executeHookCommand(
  event: keyof SkillHooks, hook: SkillHook, payload: Record<string, unknown>,
  cwd: string, options: KodaXOptions,
): Promise<{ stdout: string; stderr: string }> {
  const shell: KodaXShellExecutionContract = options.context?.shellExecution ?? {
    version: 1,
    shell: { kind: process.platform === 'win32' ? 'cmd' : 'bash', profile: 'none',
      ...(process.platform === 'win32' ? {} : { executable: '/bin/sh' }) },
  };
  const result = await toolBash(hookToolInput(event, hook), {
    backups: new Map(),
    executionCwd: cwd,
    gitRoot: options.context?.gitRoot ?? undefined,
    abortSignal: options.abortSignal,
    shellSandbox: options.context?.shellSandbox,
    resolveShellPermissionMode: options.context?.resolveShellPermissionMode,
    authorizeShellHostExecution: options.context?.authorizeShellHostExecution,
    sandbox: options.sandbox,
    shellExecution: { ...shell, environment: { ...shell.environment, set: {
      ...shell.environment?.set,
      KODAX_HOOK_EVENT: event,
      KODAX_HOOK_PAYLOAD: JSON.stringify(payload),
    } } },
  });
  const prefix = `Command: ${hook.command}\nExit: 0\n`;
  if (!result.startsWith(prefix)) throw new Error(result);
  const body = result.slice(prefix.length);
  const stderrOffset = body.indexOf('\n[stderr]\n');
  const stdout = stderrOffset < 0 ? body : body.slice(0, stderrOffset);
  const stderr = stderrOffset < 0 ? '' : body.slice(stderrOffset + '\n[stderr]\n'.length);
  return { stdout, stderr };
}

async function runHook(
  event: keyof SkillHooks,
  hook: SkillHook,
  payload: Record<string, unknown>,
  cwd: string,
  options: KodaXOptions,
  notify?: (message: string) => Promise<void>,
): Promise<HookResponse> {
  try {
    const { stdout, stderr } = await executeHookCommand(event, hook, payload, cwd, options);
    if (stderr.trim()) {
      emitKodaXDiagnostic({
        source: 'coding:skill-invocation',
        level: 'warn',
        message: `Skill ${event} hook wrote to stderr.`,
        detail: stderr.trim(),
      });
      await notify?.(`[Hook ${event} stderr] ${stderr.trim()}`);
    }
    const output = stdout.trim();
    if (!output) return {};
    try {
      const parsed = JSON.parse(output) as Record<string, unknown>;
      return {
        allow: typeof parsed.allow === 'boolean' ? parsed.allow
          : typeof parsed.continue === 'boolean' ? parsed.continue : undefined,
        message: typeof parsed.message === 'string' ? parsed.message : undefined,
        additionalContext: typeof parsed.additionalContext === 'string' ? parsed.additionalContext
          : typeof parsed.additional_context === 'string' ? parsed.additional_context : undefined,
      };
    } catch (error: unknown) {
      if (event !== 'PreToolUse') return { message: output, additionalContext: output };
      emitKodaXDiagnostic({
        source: 'coding:skill-invocation',
        level: 'warn',
        message: `Skill ${event} hook returned invalid JSON.`,
        detail: error,
      });
      return { allow: false, message: `Skill ${event} hook returned invalid JSON.` };
    }
  } catch (error) {
    emitKodaXDiagnostic({
      source: 'coding:skill-invocation',
      level: 'error',
      message: `Skill ${event} hook failed.`,
      detail: error,
    });
    return { allow: false, message: `Skill ${event} hook failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function runHooks(
  event: keyof SkillHooks,
  hooks: readonly SkillHook[] | undefined,
  target: string,
  payload: Record<string, unknown>,
  cwd: string,
  allowedTools: AllowedToolPolicy,
  admitHook: NonNullable<KodaXOptions['events']>['beforeToolExecute'],
  options: KodaXOptions,
  notify?: (message: string) => Promise<void>,
): Promise<HookResponse> {
  const additionalContext: string[] = [];
  for (const hook of hooks ?? []) {
    if (!hookMatches(hook, target)) continue;
    const hookInput = hookToolInput(event, hook);
    if (!isToolAllowed(allowedTools, 'bash', hookInput)) {
      emitKodaXDiagnostic({
        source: 'coding:skill-invocation',
        level: 'warn',
        message: `Skill ${event} hook is blocked by allowed-tools policy.`,
      });
      return { allow: false, message: `Skill ${event} hook is blocked by allowed-tools policy.` };
    }
    const admitted = await admitHook?.('bash', hookInput);
    if (admitted !== true) {
      emitKodaXDiagnostic({
        source: 'coding:skill-invocation',
        level: 'warn',
        message: `Skill ${event} hook was denied by runtime permission policy.`,
      });
      return { allow: false, message: typeof admitted === 'string'
        ? admitted : `Skill ${event} hook was denied by runtime permission policy.` };
    }
    const result = await runHook(event, hook, payload, cwd, options, notify);
    if (result.message) {
      emitKodaXDiagnostic({ source: 'coding:skill-invocation', level: 'info',
        message: `Skill ${event}: ${result.message}` });
      await notify?.(result.message);
    }
    if (result.additionalContext) additionalContext.push(result.additionalContext);
    if (result.allow === false) return result;
  }
  return { additionalContext: additionalContext.join('\n') || undefined };
}

async function loadTrustedInvokedSkill(options: KodaXOptions, name: string): Promise<Skill> {
  const boundRegistry = options.context?.skillRegistry;
  if (boundRegistry) {
    if (!boundRegistry.has(name)) {
      throw new Error(`Cannot rehydrate runtime policy: Skill "${name}" is absent from the bound Skill registry.`);
    }
    return boundRegistry.loadFull(name);
  }
  const projectRoot = options.context?.gitRoot ?? options.context?.executionCwd ?? process.cwd();
  const registry = new SkillRegistry(projectRoot);
  await registry.discover();
  if (!registry.has(name)) {
    throw new Error(`Cannot rehydrate runtime policy for unknown Skill "${name}".`);
  }
  return registry.loadFull(name);
}

export function resolveSkillModelOverride(provider: string, model: string | undefined): string | undefined {
  const value = model?.trim();
  if (!value) return undefined;
  const aliases: Readonly<Record<string, string>> = {
    haiku: 'claude-3-5-haiku-latest',
    sonnet: 'claude-sonnet-4-6',
    opus: 'claude-opus-4-1',
  };
  return aliases[value] === undefined ? value : provider === 'anthropic' ? aliases[value] : undefined;
}

const invocationWork = new WeakMap<KodaXOptions, {
  readonly pending: Set<Promise<void>>;
  readonly finalize: (error?: unknown) => Promise<void>;
}>();

function trackPostHook(options: KodaXOptions, task: Promise<HookResponse>): void {
  const pending = invocationWork.get(options)?.pending;
  if (!pending) return;
  const tracked = task.then(
    () => undefined,
    (error: unknown) => {
      emitKodaXDiagnostic({
        source: 'coding:skill-invocation',
        level: 'error',
        message: 'Skill PostToolUse hook failed unexpectedly.',
        detail: error,
      });
    },
  );
  pending.add(tracked);
  void tracked.finally(() => pending.delete(tracked));
}

/** Settle PostToolUse work, then run the invocation's one completion hook. */
export async function awaitRuntimeSkillInvocationPolicy(options: KodaXOptions, error?: unknown): Promise<void> {
  const work = invocationWork.get(options);
  const pending = work?.pending;
  while (pending && pending.size > 0) {
    await Promise.all([...pending]);
  }
  await work?.finalize(error);
}

export async function applyRuntimeSkillInvocationPolicy(options: KodaXOptions, prompt?: string): Promise<KodaXOptions> {
  const skillInvocation = options.context?.skillInvocation;
  const commandInvocation = options.context?.commandInvocation;
  if (!skillInvocation?.runtimePolicy?.enforceAtRuntime && !commandInvocation?.runtimePolicy?.enforceAtRuntime) return options;
  const invocation = commandInvocation?.runtimePolicy?.enforceAtRuntime ? commandInvocation : skillInvocation!;
  const trustedSkill = invocation === skillInvocation ? await loadTrustedInvokedSkill(options, invocation.name) : undefined;
  const policy = trustedSkill ? {
    source: 'skill', path: trustedSkill.skillFilePath, allowedTools: trustedSkill.allowedTools,
    hooks: trustedSkill.hooks, model: trustedSkill.model, context: trustedSkill.context, agent: trustedSkill.agent,
  } : commandInvocation!;
  const allowedTools = parseAllowedTools(policy.allowedTools);
  const baseEvents = options.events ?? {};
  const cwd = options.context?.executionCwd ?? options.context?.gitRoot ?? process.cwd();
  let dispatchingNotification = false;
  const notify = async (message: string): Promise<void> => {
    if (dispatchingNotification || !policy.hooks?.Notification?.length) return;
    dispatchingNotification = true;
    try {
      await runHooks('Notification', policy.hooks.Notification, message,
        { displayName: invocation.name, source: policy.source, path: policy.path, message },
        cwd, allowedTools, baseEvents.beforeToolExecute, options, notify);
    } catch (error: unknown) {
      emitKodaXDiagnostic({ source: 'coding:skill-invocation', level: 'error',
        message: 'Skill Notification hook failed unexpectedly.', detail: error });
    } finally {
      dispatchingNotification = false;
    }
  };
  if (allowedTools.invalidEntries.length > 0) {
    emitKodaXDiagnostic({
      source: 'coding:skill-invocation',
      level: 'warn',
      message: `Skill ${invocation.name} has invalid allowed-tools entries.`,
      detail: allowedTools.invalidEntries,
    });
    await notify(`Skill ${invocation.name} has invalid allowed-tools entries: ${allowedTools.invalidEntries.join(', ')}`);
  }
  const started = await runHooks(
    'SessionStart', policy.hooks?.SessionStart, invocation.name,
    { displayName: invocation.name, source: policy.source, path: policy.path },
    cwd, allowedTools, baseEvents.beforeToolExecute, options, notify,
  );
  if (started.allow === false) {
    throw Object.assign(new Error(`[Blocked] ${started.message ?? 'Skill SessionStart hook refused execution.'}`), {
      code: 'skill_invocation_blocked' as const,
    });
  }
  const rawUserInput = options.context?.rawUserInput ?? prompt ?? '';
  const submitted = await runHooks(
    'UserPromptSubmit', policy.hooks?.UserPromptSubmit, rawUserInput,
    { displayName: invocation.name, source: policy.source, path: policy.path, prompt: rawUserInput },
    cwd, allowedTools, baseEvents.beforeToolExecute, options, notify,
  );
  if (submitted.allow === false) {
    throw Object.assign(new Error(`[Blocked] ${submitted.message ?? 'Skill UserPromptSubmit hook refused execution.'}`), {
      code: 'skill_invocation_blocked' as const,
    });
  }
  const promptOverlay = [options.context?.promptOverlay,
    policy.agent ? `Preferred agent: ${policy.agent}` : undefined,
    started.additionalContext, submitted.additionalContext]
    .filter((value): value is string => Boolean(value)).join('\n\n');
  const pending = new Set<Promise<void>>();
  let terminalNotification: (() => void) | undefined;
  const modelOverride = resolveSkillModelOverride(options.provider, policy.model);
  if (policy.model?.trim() && modelOverride === undefined) {
    emitKodaXDiagnostic({ source: 'coding:skill-invocation', level: 'info',
      message: `Skill model preference '${policy.model}' is unsupported by '${options.provider}'; using the current model.` });
    await notify(`Skill model preference '${policy.model}' is unsupported by '${options.provider}'; using the current model.`);
  }
  const runtimeOptions: KodaXOptions = {
    ...options,
    ...(modelOverride !== undefined ? { modelOverride } : {}),
    context: {
      ...options.context,
      rawUserInput,
      ...(promptOverlay ? { promptOverlay } : {}),
      ...(trustedSkill && skillInvocation ? { skillInvocation: {
        ...skillInvocation, path: trustedSkill.skillFilePath, allowedTools: policy.allowedTools,
        model: policy.model, context: policy.context, agent: policy.agent,
        runtimePolicy: { enforceAtRuntime: false },
      } } : { commandInvocation: { ...commandInvocation!, runtimePolicy: { enforceAtRuntime: false } } }),
    },
    events: {
      ...baseEvents,
      // A terminal notification cannot precede the invocation's asynchronous hooks.
      onComplete: (meta) => { terminalNotification = () => baseEvents.onComplete?.(meta); },
      onError: (error, meta) => { terminalNotification = () => baseEvents.onError?.(error, meta); },
      beforeToolExecute: async (tool, input, meta) => {
        if (!isToolAllowed(allowedTools, tool, input)) {
          return `[Blocked] Tool '${tool}' is not allowed by ${invocation.name}`;
        }
        if ((await runHooks(
          'PreToolUse',
          policy.hooks?.PreToolUse,
          tool,
          { tool, input, displayName: invocation.name, source: policy.source, path: policy.path },
          cwd,
          allowedTools,
          baseEvents.beforeToolExecute,
          options, notify,
        )).allow === false) {
          return `[Blocked] PreToolUse hook blocked '${tool}' for ${invocation.name}`;
        }
        return baseEvents.beforeToolExecute
          ? baseEvents.beforeToolExecute(tool, input, meta)
          : true;
      },
      onToolResult: (result, meta) => {
        try {
          baseEvents.onToolResult?.(result, meta);
        } finally {
          trackPostHook(runtimeOptions, runHooks(
            'PostToolUse',
            policy.hooks?.PostToolUse,
            result.name,
            { ...result, displayName: invocation.name, source: policy.source, path: policy.path },
            cwd,
            allowedTools,
            baseEvents.beforeToolExecute,
            options, notify,
          ));
        }
      },
    },
  };
  let finalization: Promise<void> | undefined;
  invocationWork.set(runtimeOptions, { pending, finalize: (error) => {
    const event = policy.context === 'fork' ? 'SubagentStop' : 'Stop';
    finalization ??= runHooks(
      event, policy.hooks?.[event], invocation.name,
      { displayName: invocation.name, source: policy.source, path: policy.path,
        ...(error === undefined ? {} : { error: error instanceof Error ? error.message : String(error) }) },
      cwd, allowedTools, baseEvents.beforeToolExecute, options, notify,
    ).then(() => undefined, (failure: unknown) => {
      emitKodaXDiagnostic({ source: 'coding:skill-invocation', level: 'error',
        message: `Skill ${event} hook failed unexpectedly.`, detail: failure });
    });
    return finalization.then(() => {
      const notifyTerminal = terminalNotification;
      terminalNotification = undefined;
      try { notifyTerminal?.(); }
      catch (error: unknown) {
        emitKodaXDiagnostic({ source: 'coding:skill-invocation', level: 'error',
          message: 'Invocation terminal observer failed after hook settlement.', detail: error });
      }
    });
  } });
  return runtimeOptions;
}
