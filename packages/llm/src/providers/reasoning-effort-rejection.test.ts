import { describe, expect, it } from 'vitest';
import { classifyReasoningEffortRejection } from './reasoning-effort-rejection.js';

function err(message: string, status?: number): Error & { status?: number } {
  const e = new Error(message) as Error & { status?: number };
  if (status !== undefined) {
    e.status = status;
  }
  return e;
}

describe('classifyReasoningEffortRejection', () => {
  it('does not confuse an unrelated validation error mentioning the current effort with a rejection', () => {
    expect(classifyReasoningEffortRejection(err('Invalid messages; current reasoning_effort is high', 400), 'high')).toBeNull();
  });

  it('recognizes an explicitly unsupported parameter without guessing a rejected level', () => {
    expect(classifyReasoningEffortRejection(err('This model does not support the reasoning_effort parameter', 400), 'max'))
      .toMatchObject({ parameterRejected: true, parameter: 'reasoning_effort' });
  });

  it('recognizes explicit disable rejection through thinking.type', () => {
    expect(classifyReasoningEffortRejection(err("Unsupported value 'disabled' for thinking.type", 400), 'none'))
      .toEqual({ rejectedEffort: 'none' });
  });
  it('detects an OpenAI-style unsupported reasoning_effort value and extracts it', () => {
    const r = classifyReasoningEffortRejection(
      err("Unsupported value: 'reasoning_effort' does not support 'max'.", 400),
      'max',
    );
    expect(r).toEqual({ rejectedEffort: 'max' });
  });

  it('falls back to the sent effort when the message names the param but not the value', () => {
    const r = classifyReasoningEffortRejection(
      err('Invalid reasoning_effort parameter for this model', 400),
      'xhigh',
    );
    expect(r).toEqual({ rejectedEffort: 'xhigh' });
  });

  it('does not trip "high" on "xhigh" in the message', () => {
    const r = classifyReasoningEffortRejection(
      err("reasoning_effort 'xhigh' is not supported", 400),
      undefined,
    );
    expect(r).toEqual({ rejectedEffort: 'xhigh' });
  });

  it('ignores non-400/422 statuses (auth / rate-limit / server)', () => {
    expect(classifyReasoningEffortRejection(err('reasoning_effort unsupported', 401), 'max')).toBeNull();
    expect(classifyReasoningEffortRejection(err('reasoning_effort unsupported', 429), 'max')).toBeNull();
    expect(classifyReasoningEffortRejection(err('reasoning_effort unsupported', 500), 'max')).toBeNull();
  });

  it('ignores a generic 400 that does not name the reasoning-effort param', () => {
    expect(classifyReasoningEffortRejection(err('Invalid request: messages required', 400), 'max')).toBeNull();
    expect(classifyReasoningEffortRejection(err('content too long', 400), 'max')).toBeNull();
  });

  it('ignores a 400 that mentions the param but shows no rejection wording', () => {
    expect(
      classifyReasoningEffortRejection(err('reasoning_effort accepted: high', 400), 'high'),
    ).toBeNull();
  });

  it('returns null when neither the message names a value nor a sent effort is known', () => {
    expect(
      classifyReasoningEffortRejection(err('reasoning_effort is invalid', 400), undefined),
    ).toBeNull();
  });

  it('ignores a LOCAL validation throw (no HTTP status) so explicit rejections surface as-is', () => {
    // e.g. validateExplicitReasoningEffort on an always-on model rejecting "none".
    expect(
      classifyReasoningEffortRejection(err('does not support reasoning effort "none".'), 'none'),
    ).toBeNull();
  });

  it('reads the status from a nested cause', () => {
    const wrapped = new Error('reasoning_effort not supported') as Error & { cause?: unknown };
    wrapped.cause = { status: 400 };
    expect(classifyReasoningEffortRejection(wrapped, 'max')).toEqual({ rejectedEffort: 'max' });
  });
});
