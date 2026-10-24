import type { KodaXOptions, KodaXWorkMode } from './types.js';

/** Product presets never replace an explicit SDK profile or a specialist child declaration. */
export function resolveWorkMode(options: Pick<KodaXOptions, 'workMode' | 'context'>): KodaXWorkMode {
  if (options.workMode !== undefined && options.workMode !== 'coding' && options.workMode !== 'agent') {
    throw new Error(`Unsupported work mode: ${String(options.workMode)}. Supported modes: agent, coding.`);
  }
  const context = options.context;
  if (context?.agentProfile || context?.currentAgentId || context?.systemPromptOverride || context?.toolVisibilityPolicy) {
    return 'coding';
  }
  return options.workMode ?? 'coding';
}
