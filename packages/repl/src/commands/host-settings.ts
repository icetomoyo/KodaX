import type { CommandCallbacks, CommandResultData, CurrentConfig } from './types.js';
import { normalizeReasoningEffortValue } from '@kodax-ai/coding';

type ConfigPatch = Parameters<NonNullable<CommandCallbacks['config']>['patch']>[0];

/** Saving a default and applying a Session choice are separate operations. */
export async function saveAndApplyHostSetting(
  callbacks: Pick<CommandCallbacks, 'config'>,
  patch: ConfigPatch,
  apply: () => Promise<void>,
  label: string,
): Promise<CommandResultData> {
  const facts: string[] = [];
  let success = true;
  try {
    await callbacks.config!.patch(patch);
    facts.push('Host default saved');
  } catch (error) {
    success = false;
    facts.push(`Host default save failed: ${String(error)}`);
  }
  try {
    await apply();
    facts.push('Session applied');
  } catch (error) {
    success = false;
    facts.push(`Session apply failed: ${String(error)}`);
  }
  return { success, message: `[${label}] ${facts.join('; ')}` };
}

export async function hostEffortCommand(
  args: string[], callbacks: Pick<CommandCallbacks, 'config' | 'catalog' | 'setEffort' | 'setReasoningMode'>, current: CurrentConfig,
): Promise<CommandResultData> {
  try {
    const candidates = await callbacks.catalog!.reasoningEfforts({ provider: current.provider, model: current.model });
    if (!args.length) return { success: true, message: `Reasoning effort: ${current.hostSettings?.effort ?? current.effort ?? 'auto'}\nAvailable: ${candidates.join(', ')}` };
    if (args.length !== 1) return { success: false, message: 'Reasoning effort accepts exactly one value' };
    const aliases: Readonly<Record<string, string>> = { on: 'auto', off: 'none', quick: 'low', balanced: 'medium', deep: 'high', med: 'medium' };
    const raw = args[0]!.toLowerCase();
    const value = normalizeReasoningEffortValue(aliases[raw] ?? raw);
    const effort = ['auto', 'unset', 'clear', 'reset'].includes(value) ? undefined : value;
    if (effort === 'none' && !candidates.includes('off')) {
      return { success: false, message: `${current.provider}/${current.model ?? '(default)'} does not support disabling reasoning` };
    }
    const reasoningMode = effort === 'none' ? 'off' : 'auto';
    return await saveAndApplyHostSetting(callbacks,
      { effort: effort ?? null, reasoningMode, thinking: reasoningMode !== 'off' },
      async () => {
        if (!callbacks.setEffort || !callbacks.setReasoningMode) throw new Error('Session effort control unavailable');
        await callbacks.setEffort(effort);
        await callbacks.setReasoningMode(reasoningMode);
      }, `Reasoning effort: ${effort ?? 'auto'}`);
  } catch (error) {
    return { success: false, message: `Reasoning effort failed: ${String(error)}` };
  }
}

export async function hostModelCommand(
  args: string[], callbacks: CommandCallbacks, current: CurrentConfig,
): Promise<CommandResultData> {
  try {
    const providers = await callbacks.catalog!.providers();
    if (!args.length) return { success: true, message: providers.map(provider =>
      `${provider.name}${provider.name === current.provider ? ' *' : ''} [${provider.configured ? 'configured' : 'not configured'}]\n  ${provider.models.join('\n  ')}`,
    ).join('\n') };
    const input = args[0]!.trim();
    const slash = input.indexOf('/');
    const provider = slash === 0 ? current.provider : slash < 0 ? input : input.slice(0, slash);
    const model = slash < 0 ? undefined : input.slice(slash + 1);
    const known = providers.find(item => item.name === provider);
    if (!known) return { success: false, message: `Unknown Host provider: ${provider}` };
    if (slash >= 0 && (!model || !known.models.includes(model))) {
      return { success: false, message: `Unknown Host model: ${model}. Available: ${known.models.join(', ')}` };
    }
    return await saveAndApplyHostSetting(callbacks,
      { ...(slash === 0 ? {} : { provider }), model: model ?? null },
      async () => {
        if (!callbacks.switchProvider) throw new Error('Session model control unavailable');
        await callbacks.switchProvider(provider, model);
      }, `Model: ${provider}${model ? `/${model}` : ''}`);
  } catch (error) {
    return { success: false, message: `Host model query failed: ${String(error)}` };
  }
}
