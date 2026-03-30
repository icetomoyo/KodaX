import { exec as execCallback } from 'child_process';
import { promisify } from 'util';
import type { KodaXEvents, KodaXOptions } from '@kodax/coding';
import type { CommandHook, CommandHooks, CommandInvocationRequest } from '../commands/types.js';

const execAsync = promisify(execCallback);

const TOOL_NAME_ALIASES: Record<string, string> = {
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
  tool: string | '*';
  patterns?: string[];
}

interface ParsedAllowedTools {
  configured: boolean;
  rules: AllowedToolRule[];
  invalidEntries: string[];
}

interface HookResponse {
  allow?: boolean;
  message?: string;
  additionalContext?: string;
}

type RuntimeEmitter = (text: string) => Promise<void>;

export interface PreparedInvocation {
  mode: 'manual' | 'inline' | 'fork';
  prompt?: string;
  options?: KodaXOptions;
  manualOutput?: string;
  finalize: (error?: Error) => Promise<void>;
}

function splitTopLevelCommaList(value: string): string[] {
  const items: string[] = [];
  let current = '';
  let depth = 0;

  for (const char of value) {
    if (char === ',' && depth === 0) {
      if (current.trim()) {
        items.push(current.trim());
      }
      current = '';
      continue;
    }

    if (char === '(') {
      depth++;
    } else if (char === ')' && depth > 0) {
      depth--;
    }

    current += char;
  }

  if (current.trim()) {
    items.push(current.trim());
  }

  return items;
}

function parseAllowedTools(value?: string): ParsedAllowedTools {
  if (!value?.trim()) {
    return {
      configured: false,
      rules: [],
      invalidEntries: [],
    };
  }

  const invalidEntries: string[] = [];
  const rules = splitTopLevelCommaList(value)
    .map((entry) => {
      if (entry === '*') {
        return { tool: '*' } satisfies AllowedToolRule;
      }

      if (entry.includes('(') && !entry.endsWith(')')) {
        invalidEntries.push(entry);
        return undefined;
      }

      const match = entry.match(/^([^(]+?)(?:\((.*)\))?$/);
      if (!match) {
        invalidEntries.push(entry);
        return undefined;
      }

      const normalizedTool = TOOL_NAME_ALIASES[match[1]!.replace(/[^a-z]/gi, '').toLowerCase()];
      if (!normalizedTool) {
        invalidEntries.push(entry);
        return undefined;
      }

      const patterns = match[2]
        ? splitTopLevelCommaList(match[2]).map((item) => item.trim()).filter(Boolean)
        : undefined;

      return {
        tool: normalizedTool,
        patterns: patterns && patterns.length > 0 ? patterns : undefined,
      } satisfies AllowedToolRule;
    })
    .filter((rule): rule is AllowedToolRule => rule !== undefined);

  return {
    configured: true,
    rules,
    invalidEntries,
  };
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

function matchesPattern(pattern: string, value: string): boolean {
  return wildcardToRegExp(pattern).test(value);
}

function isToolAllowed(parsed: ParsedAllowedTools, tool: string, input: Record<string, unknown>): boolean {
  if (!parsed.configured) {
    return true;
  }

  if (parsed.rules.length === 0) {
    return false;
  }

  const normalizedTool = tool.toLowerCase();
  const bashCommand = normalizedTool === 'bash'
    ? String(input.command ?? '').trim()
    : '';

  return parsed.rules.some((rule) => {
    if (rule.tool !== '*' && rule.tool !== normalizedTool) {
      return false;
    }

    if (!rule.patterns || rule.patterns.length === 0) {
      return true;
    }

    if (normalizedTool !== 'bash') {
      return true;
    }

    return rule.patterns.some((pattern) => matchesPattern(pattern, bashCommand));
  });
}

function hookMatches(hook: CommandHook, target: string): boolean {
  if (!hook.matcher) {
    return true;
  }
  return matchesPattern(hook.matcher, target);
}

function formatManualOutput(request: CommandInvocationRequest): string {
  const label = request.source === 'skill'
    ? 'skill'
    : request.source === 'extension'
      ? 'extension command'
      : 'command';
  return [
    `Note: ${request.displayName} has model invocation disabled.`,
    `The ${label} content is shown below for manual use:`,
    '',
    `--- ${request.displayName} ---`,
    request.prompt,
    `--- end ${request.displayName} ---`,
  ].join('\n');
}

function resolveModelOverride(provider: string, model?: string): string | undefined {
  if (!model) {
    return undefined;
  }

  const normalizedModel = model.trim();
  if (!normalizedModel) {
    return undefined;
  }

  if (!['haiku', 'sonnet', 'opus'].includes(normalizedModel)) {
    return normalizedModel;
  }

  if (provider !== 'anthropic') {
    return undefined;
  }

  switch (normalizedModel) {
    case 'haiku':
      return 'claude-3-5-haiku-latest';
    case 'opus':
      return 'claude-opus-4-1';
    case 'sonnet':
    default:
      return 'claude-sonnet-4-6';
  }
}

async function executeHookCommand(
  event: string,
  hook: CommandHook,
  payload: Record<string, unknown>,
  emit: RuntimeEmitter,
  baseEvents: KodaXEvents,
  allowedToolPolicy: ParsedAllowedTools
): Promise<HookResponse> {
  const displayName = typeof payload.displayName === 'string' ? payload.displayName : 'frontmatter invocation';
  const hookInput = {
    command: hook.command,
    _reason: `Frontmatter hook ${event} for ${displayName}`,
    _frontmatterHook: true,
    _hookEvent: event,
    _hookMatcher: hook.matcher,
  } satisfies Record<string, unknown>;

  if (!isToolAllowed(allowedToolPolicy, 'bash', hookInput)) {
    return {
      allow: false,
      message: `Hook ${event} for ${displayName} is blocked by allowed-tools policy.`,
    };
  }

  if (baseEvents.beforeToolExecute) {
    const allowed = await baseEvents.beforeToolExecute('bash', hookInput);
    if (!allowed) {
      return {
        allow: false,
        message: `Hook ${event} for ${displayName} was blocked by the current permission policy.`,
      };
    }
  }

  try {
    const { stdout, stderr } = await execAsync(hook.command, {
      env: {
        ...process.env,
        KODAX_HOOK_EVENT: event,
        KODAX_HOOK_PAYLOAD: JSON.stringify(payload),
      },
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });

    const toolContent = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
    if (toolContent) {
      baseEvents.onToolResult?.({
        id: `frontmatter-hook:${event}`,
        name: 'bash',
        content: toolContent,
      });
    }

    if (stderr.trim()) {
      await emit(`[Hook ${event} stderr] ${stderr.trim()}`);
    }

    const trimmedStdout = stdout.trim();
    if (!trimmedStdout) {
      return {};
    }

    try {
      const parsed = JSON.parse(trimmedStdout) as Record<string, unknown>;
      return {
        allow: typeof parsed.allow === 'boolean'
          ? parsed.allow
          : typeof parsed.continue === 'boolean'
            ? parsed.continue
            : undefined,
        message: typeof parsed.message === 'string' ? parsed.message : undefined,
        additionalContext: typeof parsed.additionalContext === 'string'
          ? parsed.additionalContext
          : typeof parsed.additional_context === 'string'
            ? parsed.additional_context
            : undefined,
      };
    } catch {
      return { message: trimmedStdout, additionalContext: trimmedStdout };
    }
  } catch (error) {
    await emit(`[Hook ${event} failed] ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}

async function runHooks(
  hooks: CommandHooks | undefined,
  event: keyof CommandHooks,
  target: string,
  payload: Record<string, unknown>,
  emit: RuntimeEmitter,
  baseEvents: KodaXEvents,
  allowedToolPolicy: ParsedAllowedTools
): Promise<HookResponse> {
  const list = hooks?.[event];
  if (!list || list.length === 0) {
    return {};
  }

  const merged: HookResponse = {};

  for (const hook of list) {
    if (!hookMatches(hook, target)) {
      continue;
    }

    const response = await executeHookCommand(event, hook, payload, emit, baseEvents, allowedToolPolicy);
    if (response.message) {
      await emit(`[Hook ${event}] ${response.message}`);
    }
    if (response.additionalContext) {
      merged.additionalContext = merged.additionalContext
        ? `${merged.additionalContext}\n${response.additionalContext}`
        : response.additionalContext;
    }
    if (response.allow === false) {
      merged.allow = false;
      break;
    }
  }

  return merged;
}

export async function prepareInvocationExecution(
  baseOptions: KodaXOptions,
  request: CommandInvocationRequest,
  rawUserInput: string,
  emit: (text: string) => void
): Promise<PreparedInvocation> {
  if (request.disableModelInvocation) {
    return {
      mode: 'manual',
      manualOutput: formatManualOutput(request),
      finalize: async () => {},
    };
  }

  const baseEvents = baseOptions.events ?? {};
  const allowedToolPolicy = parseAllowedTools(request.allowedTools);
  const modelOverride = resolveModelOverride(baseOptions.provider, request.model);
  let isDispatchingNotification = false;

  const emitWithNotifications: RuntimeEmitter = async (text) => {
    emit(text);

    if (isDispatchingNotification || !request.hooks?.Notification?.length) {
      return;
    }

    isDispatchingNotification = true;
    try {
      await runHooks(
        request.hooks,
        'Notification',
        text,
        {
          displayName: request.displayName,
          source: request.source,
          path: request.path,
          message: text,
        },
        async (notificationText) => {
          emit(notificationText);
        },
        baseEvents,
        allowedToolPolicy
      );
    } finally {
      isDispatchingNotification = false;
    }
  };

  if (request.model && !modelOverride) {
    await emitWithNotifications(`[Info] Model preference '${request.model}' is not supported by provider '${baseOptions.provider}', using the current model.`);
  }
  if (allowedToolPolicy.invalidEntries.length > 0) {
    await emitWithNotifications(
      `[Warning] ${request.displayName} has invalid allowed-tools entries: ${allowedToolPolicy.invalidEntries.join(', ')}`
    );
  }
  if (allowedToolPolicy.configured && allowedToolPolicy.rules.length === 0) {
    await emitWithNotifications(`[Warning] ${request.displayName} has no valid allowed-tools entries, so all tool execution will be blocked.`);
  }

  const sessionStart = await runHooks(
    request.hooks,
    'SessionStart',
    request.displayName,
    { displayName: request.displayName, source: request.source, path: request.path },
    emitWithNotifications,
    baseEvents,
    allowedToolPolicy
  );
  if (sessionStart.allow === false) {
    return {
      mode: 'manual',
      manualOutput: `[Blocked] ${request.displayName} was stopped before execution.`,
      finalize: async () => {},
    };
  }

  const userPromptSubmit = await runHooks(
    request.hooks,
    'UserPromptSubmit',
    rawUserInput,
    { displayName: request.displayName, source: request.source, prompt: rawUserInput, path: request.path },
    emitWithNotifications,
    baseEvents,
    allowedToolPolicy
  );

  if (userPromptSubmit.allow === false) {
    return {
      mode: 'manual',
      manualOutput: `[Blocked] ${request.displayName} was stopped by a UserPromptSubmit hook.`,
      finalize: async () => {},
    };
  }

  const contextBlocks = [
    request.agent ? `Preferred agent: ${request.agent}` : undefined,
    sessionStart.additionalContext,
    userPromptSubmit.additionalContext,
  ].filter((item): item is string => typeof item === 'string' && item.trim().length > 0);

  const promptParts = [
    contextBlocks.length > 0 ? contextBlocks.join('\n\n') : undefined,
    request.prompt,
    `User request: ${rawUserInput}`,
  ].filter((item): item is string => typeof item === 'string' && item.trim().length > 0);

  const wrappedEvents: KodaXEvents = {
    ...baseEvents,
    beforeToolExecute: async (tool, input) => {
      if (!isToolAllowed(allowedToolPolicy, tool, input)) {
        await emitWithNotifications(`[Blocked] Tool '${tool}' is not allowed by ${request.displayName}`);
        return false;
      }

      const preToolUse = await runHooks(
        request.hooks,
        'PreToolUse',
        tool,
        { tool, input, displayName: request.displayName, source: request.source, path: request.path },
        emitWithNotifications,
        baseEvents,
        allowedToolPolicy
      );
      if (preToolUse.allow === false) {
        await emitWithNotifications(`[Blocked] PreToolUse hook blocked '${tool}' for ${request.displayName}`);
        return false;
      }

      // Propagate the result from baseEvents.beforeToolExecute (may be true, false, or a string message)
      return baseEvents.beforeToolExecute
        ? await baseEvents.beforeToolExecute(tool, input)
        : true;
    },
    onToolResult: (result) => {
      baseEvents.onToolResult?.(result);
      void runHooks(
        request.hooks,
        'PostToolUse',
        result.name,
        { ...result, displayName: request.displayName, source: request.source, path: request.path },
        emitWithNotifications,
        baseEvents,
        allowedToolPolicy
      );
    },
  };

  let finalized = false;
  const finalize = async (error?: Error) => {
    if (finalized) {
      return;
    }
    finalized = true;

    await runHooks(
      request.hooks,
      request.context === 'fork' ? 'SubagentStop' : 'Stop',
      request.displayName,
      {
        displayName: request.displayName,
        source: request.source,
        path: request.path,
        error: error?.message,
      },
      emitWithNotifications,
      baseEvents,
      allowedToolPolicy
    );
  };

  return {
    mode: request.context === 'fork' ? 'fork' : 'inline',
    prompt: promptParts.join('\n\n'),
    options: {
      ...baseOptions,
      modelOverride,
      context: {
        ...baseOptions.context,
        rawUserInput,
        skillInvocation: request.source === 'skill'
          ? request.skillInvocation
          : baseOptions.context?.skillInvocation,
      },
      events: wrappedEvents,
    },
    finalize,
  };
}
