/**
 * `/provider probe` — proactive reasoning-effort probing.
 *
 * Sends a bounded request per candidate effort and records the ones
 * the provider HARD-rejects into the capability cache, so a fast-changing model
 * (GLM / Kimi / MiniMax) can be validated up front instead of waiting for the
 * passive path to learn it from real traffic. Reuses the exact same
 * `onReasoningEffortRejected` signal as passive learning — a rejection here is
 * recorded identically, just with `source: 'probed'`.
 *
 * Note: this issues real requests (output capped at 16 tokens, or 1025 for manual Anthropic thinking) — it is an
 * explicit, user-invoked command, never automatic.
 */

import { runInSessionScope, type KodaXBaseProvider } from '@kodax-ai/coding';
import { getRunScopedConfig, withProviderRequestCredential } from '@kodax-ai/llm';
import { generateSessionIdSync, recordRejectedEffort } from '@kodax-ai/agent';

export type ProbeStatus = 'accepted' | 'rejected' | 'error';

export interface ProbeResult {
  readonly effort: string;
  readonly status: ProbeStatus;
  readonly error?: string;
}

interface ProbeInput {
  provider: string;
  model?: string;
  efforts: readonly string[];
  resolve: (provider: string) => KodaXBaseProvider;
  now: () => string;
  signal?: AbortSignal;
  configHome?: string;
}

/**
 * Probe one provider/model across the given efforts. `resolve` returns the
 * provider instance (injected so the orchestration is unit-testable without a
 * live provider). Rejections are persisted via `recordRejectedEffort`.
 *
 * A probe runs outside any conversation, so it names its own short one:
 * some gateways (opencode Go) reject requests that carry no session id.
 */
export function probeProviderReasoningEfforts(input: ProbeInput): Promise<ProbeResult[]> {
  return runInSessionScope(getRunScopedConfig()?.sessionId ?? generateSessionIdSync(), () => probeEfforts(input));
}

async function probeEfforts(input: ProbeInput): Promise<ProbeResult[]> {
  const provider = input.resolve(input.provider);
  const model = input.model ?? provider.getModel();
  const results: ProbeResult[] = [];

  for (const effort of input.efforts) {
    if (input.signal?.aborted) {
      break;
    }
    let rejected = false;
    try {
      await withProviderRequestCredential(provider, 'utility', input.signal, activeSignal => provider.stream(
        [{ role: 'user', content: 'ping' }],
        [],
        '',
        { effort },
        {
          modelOverride: model,
          maxOutputTokensOverride: provider.getReasoningProfile?.(model)?.supportsManualThinkingBudget && effort !== 'none' ? 1025 : 16,
          singleAttempt: true,
          onReasoningEffortRejected: event => {
            if (event.cacheScope) recordRejectedEffort(input.provider, model, event.effort, 'probed', input.now(), input.configHome, event.cacheScope);
            else recordRejectedEffort(input.provider, model, event.effort, 'probed', input.now(), input.configHome);
            rejected = true;
          },
          onTextDelta: () => {},
        },
        activeSignal,
      ));
    } catch (e) {
      results.push({
        effort,
        status: rejected ? 'rejected' : 'error',
        error: e instanceof Error ? e.message : String(e),
      });
      continue;
    }
    if (rejected) {
      results.push({ effort, status: 'rejected' });
    } else {
      results.push({ effort, status: 'accepted' });
    }
  }

  return results;
}
