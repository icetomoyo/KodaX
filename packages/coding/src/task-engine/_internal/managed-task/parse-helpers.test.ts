

import { describe, expect, it } from 'vitest';
import { findLastFencedBlock } from './parse-helpers.js';

// FEATURE_193 v0.7.43: findLastFencedBlock tests migrated from kodax-task-scout/handoff to kodax-task-verdict (V1 chain retired)
describe('findLastFencedBlock — FEATURE_060 Track 1: tail-only scan for large texts', () => {
  it('matches a fenced block at the very end of a large text without scanning the leading portion', () => {
    // Build a 200KB filler that contains lookalike syntax — the scanner
    // must still find ONLY the trailing legitimate block.
    const filler = '`'.repeat(200_000);
    const tail = '\n```kodax-task-verdict\n{"status":"accept"}\n```\n';
    const text = filler + tail;

    const block = findLastFencedBlock(text, 'kodax-task-verdict');
    expect(block).toBeDefined();
    expect(block!.body).toBe('{"status":"accept"}');
    // index points into the original full-text coordinate space.
    expect(block!.index).toBeGreaterThanOrEqual(filler.length);
    expect(text.slice(0, block!.index)).toMatch(/`{1,}/);
  });

  it('returns undefined when no fenced block exists in the tail window of a huge text', () => {
    // 200KB of unrelated text, then a block well before the tail window —
    // the tail-only scan should not see it.
    const earlyBlock = '```kodax-task-verdict\n{"status":"accept"}\n```\n';
    const tailFiller = 'x'.repeat(200_000);
    const text = earlyBlock + tailFiller;

    const block = findLastFencedBlock(text, 'kodax-task-verdict');
    expect(block).toBeUndefined();
  });

  it('full-text scan path: small text below the threshold scans the entire payload', () => {
    // Threshold is 128KB; this test stays well under to exercise the
    // non-tail path explicitly.
    const text = [
      'lots of preamble',
      '',
      '```kodax-task-verdict',
      '{"status":"accept"}',
      '```',
      '',
      'trailing content',
    ].join('\n');

    const block = findLastFencedBlock(text, 'kodax-task-verdict');
    expect(block).toBeDefined();
    expect(block!.body).toBe('{"status":"accept"}');
  });

  it('with a fenced block straddling the tail boundary, the tail scan still finds it (block is in the tail window)', () => {
    // Build a 130KB prefix + a small tail with the block — the entire
    // block is inside the tail window so it gets matched.
    const prefix = 'a'.repeat(130_000);
    const tail = '```kodax-task-verdict\n{"status":"blocked"}\n```\n';
    const text = prefix + '\n' + tail;

    const block = findLastFencedBlock(text, 'kodax-task-verdict');
    expect(block).toBeDefined();
    expect(block!.body).toBe('{"status":"blocked"}');
    // index in full-text coordinates.
    expect(text.slice(block!.index, block!.index + 4)).toBe('```k');
  });
});
