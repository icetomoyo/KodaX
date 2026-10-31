import type { KodaXOptions, KodaXWorkMode } from './types.js';

/** Resolve the effective mode from the final run options, without replacing host authority. */
export function resolveWorkMode(options: Pick<KodaXOptions, 'workMode' | 'context'>): KodaXWorkMode {
  if (options.workMode !== undefined && !['coding', 'agent', 'script'].includes(options.workMode)) {
    throw new Error(`Unsupported work mode: ${String(options.workMode)}. Supported modes: agent, coding, script.`);
  }
  const context = options.context;
  if (context?.workModePolicy !== undefined && context.workModePolicy !== 'intersect') {
    throw new Error(`Unsupported work mode policy: ${String(context.workModePolicy)}. Supported policy: intersect.`);
  }
  // Specialist children own their declaration even if a host copies its root context.
  if (context?.currentAgentId) return 'coding';
  if (context?.workModePolicy !== 'intersect'
    && (context?.agentProfile || context?.systemPromptOverride || context?.toolVisibilityPolicy)) {
    return 'coding';
  }
  return options.workMode ?? 'coding';
}

/** Local admission check, with no tools, effects or model requests. Never changes the selected mode. */
export async function assertWorkModeAvailable(options: Pick<KodaXOptions, 'workMode' | 'context'>): Promise<void> {
  if (resolveWorkMode(options) !== 'script') return;
  const { runScriptCell } = await import('./agent-runtime/script/cell.js');
  const { SCRIPT_MODEL_LIMITS } = await import('./agent-runtime/script/model.js');
  try {
    const result = await runScriptCell({ code: 'return true;', toolNames: [],
      limits: { ...SCRIPT_MODEL_LIMITS, timeoutMs: 5_000 },
      invoke: async () => { throw new Error('Script readiness check has no tool authority.'); } });
    if (result.status !== 'completed' || result.value !== true) throw new Error(result.error ?? result.status);
  } catch (error) {
    throw new Error(`Script executor unavailable: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}
