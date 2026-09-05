/**
 * `/provider probe` — proactive reasoning-effort probing.
 *
 * Sends a minimal (≈1-token) request per candidate effort and records the ones
 * the provider HARD-rejects into the capability cache, so a fast-changing model
 * (GLM / Kimi / MiniMax) can be validated up front instead of waiting for the
 * passive path to learn it from real traffic. Reuses the exact same
 * `onReasoningEffortRejected` signal as passive learning — a rejection here is
 * recorded identically, just with `source: 'probed'`.
 *
 * Note: this issues real requests (cost ≈ a few tokens per effort) — it is an
 * explicit, user-invoked command, never automatic.
 */

import type { KodaXBaseProvider } from '@kodax-ai/coding';
import { recordRejectedEffort } from '@kodax-ai/agent';

export type ProbeStatus = 'accepted' | 'rejected' | 'error';

export interface ProbeResult {
  readonly effort: string;
  readonly status: ProbeStatus;
  readonly error?: string;
}

/**
 * Probe one provider/model across the given efforts. `resolve` returns the
 * provider instance (injected so the orchestration is unit-testable without a
 * live provider). Rejections are persisted via `recordRejectedEffort`.
 */
export async function probeProviderReasoningEfforts(input: {
  provider: string;
  model?: string;
  efforts: readonly string[];
  resolve: (provider: string) => KodaXBaseProvider;
  now: () => string;
  signal?: AbortSignal;
  configHome?: string;
}): Promise<ProbeResult[]> {
  const provider = input.resolve(input.provider);
  const model = input.model ?? provider.getModel();
  const results: ProbeResult[] = [];

  for (const effort of input.efforts) {
    if (input.signal?.aborted) {
      break;
    }
    let rejected = false;
    try {
      await provider.stream(
        [{ role: 'user', content: 'ping' }],
        [],
        '',
        { effort },
        {
          modelOverride: model,
          maxOutputTokensOverride: 1,
          onReasoningEffortRejected: () => {
            rejected = true;
          },
          onTextDelta: () => {},
        },
        input.signal,
      );
    } catch (e) {
      results.push({
        effort,
        status: 'error',
        error: e instanceof Error ? e.message : String(e),
      });
      continue;
    }
    if (rejected) {
      recordRejectedEffort(input.provider, model, effort, 'probed', input.now(), input.configHome);
      results.push({ effort, status: 'rejected' });
    } else {
      results.push({ effort, status: 'accepted' });
    }
  }

  return results;
}
