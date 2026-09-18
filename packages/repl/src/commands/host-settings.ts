import type { CommandCallbacks, CommandResultData, CurrentConfig } from './types.js';
import { normalizeReasoningEffortValue } from '@kodax-ai/coding';

type ConfigPatch = Parameters<NonNullable<CommandCallbacks['config']>['patch']>[0];

export async function hostExecutionConfigCommand(
  field: 'verifierLog' | 'stallLog' | 'fallbackProviders', args: string[],
  config: NonNullable<CommandCallbacks['config']>,
): Promise<CommandResultData> {
  const raw = args[0]?.toLowerCase();
  const status = !raw || raw === 'status';
  let value: boolean | string[] | null = null;
  if (!status && field === 'fallbackProviders') {
    value = ['off', 'clear', 'none'].includes(raw!) ? null : args.join(',').split(',').map(item => item.trim()).filter(Boolean);
    if (Array.isArray(value) && !value.length) return { success: false, message: 'No fallback provider ids given' };
  } else if (!status) {
    if (['on', 'true', '1'].includes(raw!)) value = true;
    else if (['off', 'false', '0'].includes(raw!)) value = false;
    else if (!['clear', 'reset'].includes(raw!)) return { success: false, message: 'Expected on, off or clear' };
  }
  let saved = false;
  let saveError: string | undefined;
  if (!status) {
    try { await config.patch({ [field]: value }); saved = true; }
    catch (error) { saveError = String(error); }
  }
  try {
    const [defaults, effective] = await Promise.all([config.read(), config.readEffective()]);
    saved = JSON.stringify(defaults[field] ?? null) === JSON.stringify(value);
    const fact = effective[field];
    const desired = value ?? (field === 'fallbackProviders' ? [] : false);
    const applied = fact.applied && (status || JSON.stringify(fact.value) === JSON.stringify(desired));
    return { success: status || (saved && applied), message: [
      `${field}: effective=${JSON.stringify(fact.value)}; source=${fact.source}; applied=${fact.applied}`,
      `Host default=${JSON.stringify(defaults[field] ?? null)}`,
      ...(!status ? [saved ? 'Host default saved' : `Host default save failed: ${saveError}`, applied ? 'Host applied' : 'Host desired value not applied'] : []),
      ...(saveError && saved ? [`Update reported an error: ${saveError}; state confirmed by Host queries`] : []),
    ].join('\n') };
  } catch (error) {
    return { success: false, message: `${saved ? 'Host default saved; ' : saveError ? `Update failed: ${saveError}; saved state unconfirmed; ` : ''}Effective state unavailable: ${String(error)}` };
  }
}

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
    try {
      const saved = await callbacks.config!.read();
      const confirmed = Object.entries(patch).every(([key, value]) =>
        JSON.stringify(saved[key as keyof typeof saved] ?? null) === JSON.stringify(value));
      if (confirmed) facts.push(`Host default saved (confirmed by Host query after error: ${String(error)})`);
      else { success = false; facts.push(`Host default save failed: ${String(error)}`); }
    } catch (readError) {
      success = false;
      facts.push(`Host default saved state unconfirmed: ${String(error)}; read failed: ${String(readError)}`);
    }
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
