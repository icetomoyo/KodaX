/**
 * Zero-LLM self-tests for plan-intent-fidelity parser. Mirrors the
 * FEATURE_104 convention: lock parser shape with deterministic inputs so
 * the API-cost portion is only the live judge round itself.
 */

import { describe, expect, it } from 'vitest';

import { parsePlanIntentFidelityResponse } from './plan-intent-fidelity.js';

describe('parsePlanIntentFidelityResponse', () => {
  it('parses a clean JSON response with all fields', () => {
    const raw = '{"score": 92, "rationale": "Faithful to plan intent.", "drift_flags": []}';
    const result = parsePlanIntentFidelityResponse(raw);
    expect(result.score).toBe(92);
    expect(result.rationale).toBe('Faithful to plan intent.');
    expect(result.driftFlags).toEqual([]);
    expect(result.rawResponse).toBe(raw);
  });

  it('tolerates fenced ```json``` markdown wrapping', () => {
    const raw = '```json\n{"score": 75, "rationale": "Mostly there.", "drift_flags": ["scope-shrink"]}\n```';
    const result = parsePlanIntentFidelityResponse(raw);
    expect(result.score).toBe(75);
    expect(result.driftFlags).toEqual(['scope-shrink']);
  });

  it('tolerates leading prose before the JSON object', () => {
    const raw = 'Here is the verdict:\n{"score": 40, "rationale": "Drifted.", "drift_flags": ["wrong-direction"]}';
    const result = parsePlanIntentFidelityResponse(raw);
    expect(result.score).toBe(40);
  });

  it('clamps score to [0, 100]', () => {
    const high = parsePlanIntentFidelityResponse('{"score": 150, "rationale": "ok"}');
    expect(high.score).toBe(100);
    const low = parsePlanIntentFidelityResponse('{"score": -20, "rationale": "ok"}');
    expect(low.score).toBe(0);
  });

  it('rounds non-integer scores', () => {
    const result = parsePlanIntentFidelityResponse('{"score": 87.6, "rationale": "ok"}');
    expect(result.score).toBe(88);
  });

  it('drops drift_flags not in the fixed vocabulary', () => {
    const raw = '{"score": 60, "rationale": "ok", "drift_flags": ["scope-creep", "INVENTED-FLAG", "wrong-direction"]}';
    const result = parsePlanIntentFidelityResponse(raw);
    expect(result.driftFlags).toEqual(['scope-creep', 'wrong-direction']);
  });

  it('throws when score is missing', () => {
    expect(() =>
      parsePlanIntentFidelityResponse('{"rationale": "no score"}'),
    ).toThrow(/score missing/);
  });

  it('throws when score is non-numeric', () => {
    expect(() =>
      parsePlanIntentFidelityResponse('{"score": "high", "rationale": "x"}'),
    ).toThrow(/score missing or non-numeric/);
  });

  it('throws when no JSON object is present', () => {
    expect(() => parsePlanIntentFidelityResponse('just prose')).toThrow(
      /no JSON object/,
    );
  });

  it('treats missing rationale as empty string (not error)', () => {
    const result = parsePlanIntentFidelityResponse('{"score": 50}');
    expect(result.rationale).toBe('');
  });

  it('treats missing drift_flags as empty array', () => {
    const result = parsePlanIntentFidelityResponse('{"score": 95, "rationale": "ok"}');
    expect(result.driftFlags).toEqual([]);
  });
});
