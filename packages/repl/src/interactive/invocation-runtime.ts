import { exec as execCallback } from 'child_process';
import { promisify } from 'util';
import type { KodaXEvents, KodaXOptions } from '@kodax-ai/coding';
import { resolveSkillModelOverride } from '@kodax-ai/coding';
import type { CommandHook, CommandHooks, CommandInvocationRequest } from '../commands/types.js';

const execAsync = promisify(execCallback);

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

// Claude Code reads `allowed-tools` as preapproval for the invoking turn, not
// as a restriction. KodaX leaves every tool and hook to the permission policy
// the user chose.

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

function matchesPattern(pattern: string, value: string): boolean {
  return wildcardToRegExp(pattern).test(value);
}

function hookMatches(hook: CommandHook, target: string): boolean {
  if (!hook.matcher) {
    return true;
  }
  return matchesPattern(hook.matcher, target);
}

function buildModelUserInput(
  rawUserInput: string,
  skillInvocation: CommandInvocationRequest['skillInvocation'],
): string {
  if (!skillInvocation) return rawUserInput;
  const escapedName = skillInvocation.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const withoutSlashToken = rawUserInput.replace(
    new RegExp(`/(?:skill:)?${escapedName}(?![\\w/-])`, 'i'),
    `the active Skill "${skillInvocation.name}"`,
  ).trim();
  return withoutSlashToken || `Execute the active Skill "${skillInvocation.name}".`;
}

async function executeHookCommand(
  event: string,
  hook: CommandHook,
  payload: Record<string, unknown>,
  emit: RuntimeEmitter,
  baseEvents: KodaXEvents,
  cwd: string,
): Promise<HookResponse> {
  const displayName = typeof payload.displayName === 'string' ? payload.displayName : 'frontmatter invocation';
  const hookInput = {
    command: hook.command,
    _reason: `Frontmatter hook ${event} for ${displayName}`,
    _frontmatterHook: true,
    _hookEvent: event,
    _hookMatcher: hook.matcher,
  } satisfies Record<string, unknown>;

  const allowed = await baseEvents.beforeToolExecute?.('bash', hookInput);
  if (allowed !== true) {
    return {
      allow: false,
      message: typeof allowed === 'string'
        ? allowed
        : `Hook ${event} for ${displayName} was blocked by the current permission policy.`,
    };
  }

  try {
    const { stdout, stderr } = await execAsync(hook.command, {
      cwd,
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
      if (event === 'PreToolUse') {
        return {
          allow: false,
          message: `Hook ${event} for ${displayName} returned invalid JSON.`,
        };
      }
      return { message: trimmedStdout, additionalContext: trimmedStdout };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await emit(`[Hook ${event} failed] ${message}`);
    return event === 'PreToolUse'
      ? { allow: false, message: `Hook ${event} for ${displayName} failed.` }
      : {};
  }
}

async function runHooks(
  hooks: CommandHooks | undefined,
  event: keyof CommandHooks,
  target: string,
  payload: Record<string, unknown>,
  emit: RuntimeEmitter,
  baseEvents: KodaXEvents,
  cwd: string,
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

    const response = await executeHookCommand(
      event,
      hook,
      payload,
      emit,
      baseEvents,
      cwd,
    );
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
  emit: (text: string) => void,
  hostOwnsSkill = false,
): Promise<PreparedInvocation> {
  if (hostOwnsSkill && request.source === 'skill') {
    return { mode: 'inline', prompt: rawUserInput, options: baseOptions, finalize: async () => {} };
  }
  const baseEvents = baseOptions.events ?? {};
  const runtimeOwnsSkillToolPolicy = request.source === 'skill' && request.skillInvocation !== undefined;
  const activeSkillInvocation = runtimeOwnsSkillToolPolicy ? request.skillInvocation : undefined;
  const hookCwd = baseOptions.context?.executionCwd
    ?? baseOptions.context?.gitRoot
    ?? process.cwd();
  const modelOverride = resolveSkillModelOverride(baseOptions.provider, request.model);
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
        hookCwd,
      );
    } finally {
      isDispatchingNotification = false;
    }
  };

  if (request.model && !modelOverride) {
    await emitWithNotifications(`[Info] Model preference '${request.model}' is not supported by provider '${baseOptions.provider}', using the current model.`);
  }

  const sessionStart = await runHooks(
    request.hooks,
    'SessionStart',
    request.displayName,
    { displayName: request.displayName, source: request.source, path: request.path },
    emitWithNotifications,
    baseEvents,
    hookCwd,
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
    hookCwd,
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

  const modelUserInput = buildModelUserInput(rawUserInput, activeSkillInvocation);
  const invocationOverlay = [
    baseOptions.context?.promptOverlay,
    ...contextBlocks,
    activeSkillInvocation ? undefined : request.prompt,
  ].filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  const promptParts = [
    contextBlocks.length > 0 ? contextBlocks.join('\n\n') : undefined,
    activeSkillInvocation ? undefined : request.prompt,
    `User request: ${modelUserInput}`,
  ].filter((item): item is string => typeof item === 'string' && item.trim().length > 0);

  const wrappedEvents: KodaXEvents = {
    ...baseEvents,
    beforeToolExecute: async (tool, input, meta) => {
      const preToolUse = await runHooks(
        request.hooks,
        'PreToolUse',
        tool,
        { tool, input, displayName: request.displayName, source: request.source, path: request.path },
        emitWithNotifications,
        baseEvents,
        hookCwd,
      );
      if (preToolUse.allow === false) {
        await emitWithNotifications(`[Blocked] PreToolUse hook blocked '${tool}' for ${request.displayName}`);
        return false;
      }

      // Propagate the result from baseEvents.beforeToolExecute (may be true, false, or a string message)
      return baseEvents.beforeToolExecute
        ? await baseEvents.beforeToolExecute(tool, input, meta)
        : true;
    },
    onToolResult: (result, meta) => {
      baseEvents.onToolResult?.(result, meta);
      void runHooks(
        request.hooks,
        'PostToolUse',
        result.name,
        { ...result, displayName: request.displayName, source: request.source, path: request.path },
        emitWithNotifications,
        baseEvents,
        hookCwd,
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
      hookCwd,
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
        ...(request.workflowIntent ? { workflowIntent: request.workflowIntent } : {}),
        rawUserInput,
        ...(invocationOverlay.length > 0 ? { promptOverlay: invocationOverlay.join('\n\n') } : {}),
        skillInvocation: request.source === 'skill'
          ? request.skillInvocation && {
              ...request.skillInvocation,
              // Transport owners rehydrate policy from their trusted Skill
              // registry; hook command strings never cross the wire.
              runtimePolicy: { enforceAtRuntime: true },
            }
          : baseOptions.context?.skillInvocation,
      },
      events: runtimeOwnsSkillToolPolicy ? baseEvents : wrappedEvents,
    },
    finalize,
  };
}
