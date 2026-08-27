import { describe, expect, it } from 'vitest';
import { KodaXBaseProvider } from './base.js';
import { KodaXReasoningEffortRejectedError } from '../errors.js';

/**
 * End-to-end self-heal test: drives the REAL `withRateLimit` path (not a mocked
 * classifier). The fake provider throws a wire-shaped 400 reasoning-effort
 * error while the effort is on the wire, then succeeds once the suppress flag
 * is set on the retry — exactly the production flow, just with a deterministic
 * provider instead of a live API (the user's real providers don't hard-reject).
 */
class FakeProvider extends KodaXBaseProvider {
  readonly name = 'fake';
  readonly supportsThinking = true;
  protected readonly config = { apiKeyEnv: 'X', model: 'fake-model', supportsThinking: true } as never;

  public attempts = 0;
  public rejectForever = false;

  async stream(): Promise<never> {
    return this.withRateLimit(
      async (retryState) => {
        this.attempts += 1;
        // The reasoning-application layer drops the effort when suppressed, so
        // the retry is "effort-free" and must succeed — unless rejectForever.
        if (!retryState.suppressReasoningEffort || this.rejectForever) {
          const err = new Error(
            "Unsupported value: 'reasoning_effort' does not support 'max'.",
          ) as Error & { status?: number };
          err.status = 400;
          throw err;
        }
        return { text: 'ok' } as never;
      },
      undefined,
      3,
      undefined,
      undefined,
      { model: 'fake-model', effort: 'max', onRejected: (e) => this.events.push(e) },
    );
  }

  public events: Array<{ provider: string; model: string; effort: string }> = [];
}

describe('reasoning-effort self-heal (real withRateLimit path)', () => {
  it('drops the rejected effort and completes the turn on the retry', async () => {
    const p = new FakeProvider();
    const result = (await p.stream()) as unknown as { text: string };

    expect(result.text).toBe('ok'); // turn completed — no thrown error, no re-send
    expect(p.attempts).toBe(2); // first attempt rejected, second (effort dropped) succeeded
    expect(p.events).toEqual([{ provider: 'fake', model: 'fake-model', effort: 'max' }]);
  });

  it('surfaces a typed error if it is STILL rejected after dropping the effort', async () => {
    const p = new FakeProvider();
    p.rejectForever = true;
    await expect(p.stream()).rejects.toBeInstanceOf(KodaXReasoningEffortRejectedError);
    expect(p.attempts).toBe(2); // tried, retried, then gave up
  });
});
