/**
 * KodaX Hook Registry
 *
 * Loads, validates, and indexes hook configurations from settings.
 */
import type { HookConfig, HookDefinition, HookEventType, HookEventContext, HookResult } from './types.js';
import { executeHook } from './executor.js';

const VALID_EVENT_TYPES: readonly HookEventType[] = [
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'SessionStart', 'SessionEnd', 'Compact', 'PromptSubmit', 'Stop',
];

const VALID_HOOK_TYPES = ['command', 'http', 'prompt'] as const;

export interface HookRegistryEntry {
  readonly eventType: HookEventType;
  readonly definition: HookDefinition;
  readonly matcher?: RegExp;
}

export interface HookRegistry {
  readonly entries: readonly HookRegistryEntry[];
}

export function createHookRegistry(config: HookConfig): HookRegistry {
  const entries: HookRegistryEntry[] = [];

  for (const [eventType, hooks] of Object.entries(config.hooks)) {
    if (!VALID_EVENT_TYPES.includes(eventType as HookEventType)) continue;
    if (!Array.isArray(hooks)) continue;

    for (const hook of hooks) {
      if (!isValidHookDefinition(hook)) continue;

      const matcher = 'matcher' in hook && typeof hook.matcher === 'string'
        ? new RegExp(hook.matcher)
        : undefined;

      entries.push({
        eventType: eventType as HookEventType,
        definition: hook,
        matcher,
      });
    }
  }

  return { entries };
}

function isValidHookDefinition(hook: unknown): hook is HookDefinition {
  if (typeof hook !== 'object' || hook === null) return false;
  const h = hook as Record<string, unknown>;
  return typeof h.type === 'string' && (VALID_HOOK_TYPES as readonly string[]).includes(h.type);
}

/**
 * Get hooks matching an event type and optional tool name.
 */
export function getMatchingHooks(
  registry: HookRegistry,
  eventType: HookEventType,
  toolName?: string,
): readonly HookRegistryEntry[] {
  return registry.entries.filter(entry => {
    if (entry.eventType !== eventType) return false;
    if (entry.matcher && toolName) {
      return entry.matcher.test(toolName);
    }
    // No matcher = matches all tools
    return !entry.matcher || !toolName;
  });
}

/**
 * Run all matching hooks for an event.
 * For PreToolUse: first 'deny' wins. If no deny, return 'allow' or 'pass'.
 * For other events: fire-and-forget (results collected but don't affect flow).
 */
export async function runHooks(
  registry: HookRegistry,
  context: HookEventContext,
): Promise<HookResult> {
  const matching = getMatchingHooks(registry, context.eventType, context.toolName);
  if (matching.length === 0) {
    return { action: 'pass' };
  }

  const results = await Promise.all(
    matching.map(entry => executeHook(entry.definition, context)),
  );

  // For PreToolUse, check for deny
  if (context.eventType === 'PreToolUse') {
    const denied = results.find(r => r.action === 'deny');
    if (denied) return denied;
  }

  // Return first non-pass result, or pass
  const meaningful = results.find(r => r.action !== 'pass');
  return meaningful ?? { action: 'pass' };
}
