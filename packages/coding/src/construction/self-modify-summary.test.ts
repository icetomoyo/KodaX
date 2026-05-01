import { describe, expect, it } from 'vitest';

import {
  buildSelfModifyDiffPrompt,
  parseSelfModifyDiffSummary,
  runSelfModifyDiffSummary,
} from './self-modify-summary.js';
import type { AgentContent } from './types.js';

const prev: AgentContent = { instructions: 'You are alpha.' };
const next: AgentContent = { instructions: 'You are alpha. Be thorough.' };

describe('buildSelfModifyDiffPrompt', () => {
  it('embeds prev/next manifests and the version pair into the prompt', () => {
    const prompt = buildSelfModifyDiffPrompt({
      agentName: 'alpha',
      fromVersion: '1.0.0',
      toVersion: '1.1.0',
      prev,
      next,
    });
    expect(prompt).toContain("named 'alpha'");
    expect(prompt).toContain('active version 1.0.0');
    expect(prompt).toContain('1.1.0');
    expect(prompt).toContain('You are alpha.');
    expect(prompt).toContain('You are alpha. Be thorough.');
    expect(prompt).toContain('"summary"');
    expect(prompt).toContain('"severity"');
    expect(prompt).toContain('"flaggedConcerns"');
  });
});

describe('parseSelfModifyDiffSummary', () => {
  it('parses a clean single-line JSON response', () => {
    const raw =
      '{"summary":"Tightened wording.","severity":"minor","flaggedConcerns":[]}';
    const out = parseSelfModifyDiffSummary(raw);
    expect(out.summary).toBe('Tightened wording.');
    expect(out.severity).toBe('minor');
    expect(out.flaggedConcerns).toEqual([]);
    expect(out.raw).toBe(raw);
  });

  it('parses a response wrapped in code fences', () => {
    const raw = '```json\n{"summary":"x","severity":"moderate","flaggedConcerns":["a"]}\n```';
    const out = parseSelfModifyDiffSummary(raw);
    expect(out.severity).toBe('moderate');
    expect(out.flaggedConcerns).toEqual(['a']);
  });

  it('parses a response with leading prose', () => {
    const raw =
      'Sure, here is the summary you asked for:\n{"summary":"x","severity":"major","flaggedConcerns":["y","z"]}\nLet me know if you need more detail.';
    const out = parseSelfModifyDiffSummary(raw);
    expect(out.severity).toBe('major');
    expect(out.flaggedConcerns).toEqual(['y', 'z']);
  });

  it('treats braces inside string values correctly when extracting the JSON block', () => {
    const raw =
      '{"summary":"agent now uses {key} placeholders","severity":"minor","flaggedConcerns":[]}';
    const out = parseSelfModifyDiffSummary(raw);
    expect(out.summary).toBe('agent now uses {key} placeholders');
  });

  it('falls back to a major-severity record when JSON cannot be parsed', () => {
    const out = parseSelfModifyDiffSummary('not json at all');
    expect(out.severity).toBe('major');
    expect(out.summary).toMatch(/LLM summary unavailable/);
    expect(out.flaggedConcerns.length).toBeGreaterThan(0);
  });

  it('falls back when the JSON shape is missing required fields', () => {
    const out = parseSelfModifyDiffSummary('{"summary":"x"}');
    expect(out.severity).toBe('major');
    expect(out.summary).toMatch(/LLM summary unavailable/);
  });

  it('falls back when severity has an unrecognised value', () => {
    const out = parseSelfModifyDiffSummary(
      '{"summary":"x","severity":"catastrophic","flaggedConcerns":[]}',
    );
    expect(out.severity).toBe('major');
  });

  it('coerces non-string entries out of flaggedConcerns', () => {
    const out = parseSelfModifyDiffSummary(
      '{"summary":"x","severity":"minor","flaggedConcerns":["good",1,null,"also good"]}',
    );
    expect(out.flaggedConcerns).toEqual(['good', 'also good']);
  });
});

describe('runSelfModifyDiffSummary', () => {
  const promptInput = {
    agentName: 'alpha',
    fromVersion: '1.0.0',
    toVersion: '1.1.0',
    prev,
    next,
  };

  it('returns the parsed summary when the client returns valid JSON', async () => {
    const client = async () =>
      '{"summary":"clean change","severity":"minor","flaggedConcerns":[]}';
    const out = await runSelfModifyDiffSummary(promptInput, client);
    expect(out.severity).toBe('minor');
    expect(out.summary).toBe('clean change');
  });

  it('returns the fallback record when the client throws', async () => {
    const client = async () => {
      throw new Error('network down');
    };
    const out = await runSelfModifyDiffSummary(promptInput, client);
    expect(out.severity).toBe('major');
    expect(out.summary).toContain('network down');
  });

  it('returns the fallback when the client returns garbage', async () => {
    const client = async () => '<<not json>>';
    const out = await runSelfModifyDiffSummary(promptInput, client);
    expect(out.severity).toBe('major');
    expect(out.summary).toMatch(/unavailable/);
  });
});
