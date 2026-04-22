/**
 * Parity tests for the sanitize pipeline restored from v0.7.22.
 * Covers control-plane marker stripping, complete/incomplete fence
 * detection, and evaluator process-framing removal.
 */

import { describe, expect, it } from 'vitest';

import {
  MANAGED_CONTROL_PLANE_MARKERS,
  MANAGED_FENCE_NAMES,
  findIncompleteManagedFenceIndex,
  isManagedFencePrefix,
  sanitizeEvaluatorPublicAnswer,
  sanitizeManagedStreamingText,
  sanitizeManagedUserFacingText,
} from './sanitize.js';

describe('sanitize constants', () => {
  it('exports 10 control-plane markers', () => {
    expect(MANAGED_CONTROL_PLANE_MARKERS.length).toBe(10);
    expect(MANAGED_CONTROL_PLANE_MARKERS).toContain('[Managed Task Protocol Retry]');
  });

  it('exports all 9 managed fence names', () => {
    expect(MANAGED_FENCE_NAMES.length).toBe(9);
    expect(MANAGED_FENCE_NAMES).toContain('kodax-task-scout');
    expect(MANAGED_FENCE_NAMES).toContain('kodax-task-contract');
    expect(MANAGED_FENCE_NAMES).toContain('kodax-task-handoff');
    expect(MANAGED_FENCE_NAMES).toContain('kodax-task-verdict');
  });
});

describe('isManagedFencePrefix', () => {
  it('matches exact fence names', () => {
    expect(isManagedFencePrefix('kodax-task-scout')).toBe(true);
    expect(isManagedFencePrefix('kodax-task-verdict')).toBe(true);
  });

  it('matches truncated prefixes', () => {
    expect(isManagedFencePrefix('k')).toBe(true);
    expect(isManagedFencePrefix('ko')).toBe(true);
    expect(isManagedFencePrefix('kodax')).toBe(true);
    expect(isManagedFencePrefix('kodax-task-sc')).toBe(true);
  });

  it('rejects unrelated strings', () => {
    expect(isManagedFencePrefix('python')).toBe(false);
    expect(isManagedFencePrefix('kotlin')).toBe(false);
    expect(isManagedFencePrefix('ksh')).toBe(false);
  });
});

describe('findIncompleteManagedFenceIndex', () => {
  it('returns -1 when no unclosed fence is present', () => {
    expect(findIncompleteManagedFenceIndex('no fences here')).toBe(-1);
    expect(findIncompleteManagedFenceIndex('```python\nprint(1)\n```\n')).toBe(-1);
  });

  it('locates a truncated kodax-* fence at the tail', () => {
    const text = 'Answer text.\n```kodax-task-verdict\nstatus: accept';
    const idx = findIncompleteManagedFenceIndex(text);
    expect(idx).toBeGreaterThan(0);
    expect(text.slice(idx)).toMatch(/```kodax-task-verdict/);
  });

  it('locates a fence truncated mid-name', () => {
    const text = 'Answer.\n```kodax-task-sc';
    const idx = findIncompleteManagedFenceIndex(text);
    expect(idx).toBeGreaterThan(0);
  });

  it('does not mis-cut legitimate kotlin/ksh code blocks', () => {
    // ```kotlin with actual content followed by more text should NOT be stripped.
    const text = 'See snippet:\n```kotlin\nfun main() { println("hi") }\n```\nMore text.';
    expect(findIncompleteManagedFenceIndex(text)).toBe(-1);
  });
});

describe('sanitizeManagedUserFacingText', () => {
  it('returns empty string on empty input', () => {
    expect(sanitizeManagedUserFacingText('')).toBe('');
    expect(sanitizeManagedUserFacingText('   ')).toBe('');
  });

  it('strips text after a control-plane marker', () => {
    const text = 'Real answer text\n[Managed Task Protocol Retry]\ninternal info';
    expect(sanitizeManagedUserFacingText(text)).toBe('Real answer text');
  });

  it('returns empty when the whole text starts with a marker', () => {
    expect(sanitizeManagedUserFacingText('Assigned native agent identity: foo')).toBe('');
  });

  it('strips a complete kodax fence at the tail', () => {
    const text = 'Here is the answer.\n```kodax-task-verdict\nstatus: accept\n```';
    expect(sanitizeManagedUserFacingText(text)).toBe('Here is the answer.');
  });

  it('strips an incomplete (truncated) kodax fence at the tail', () => {
    const text = 'Partial answer.\n```kodax-task-verdict\nstatus: accept';
    expect(sanitizeManagedUserFacingText(text)).toBe('Partial answer.');
  });

  it('leaves unrelated code fences intact', () => {
    const text = 'Example:\n```js\nconsole.log(1)\n```\nEnd.';
    expect(sanitizeManagedUserFacingText(text)).toBe(text.trim());
  });
});

describe('sanitizeManagedStreamingText', () => {
  it('cuts at the first control-plane marker encountered', () => {
    const text = 'answer\nTool policy: foo';
    expect(sanitizeManagedStreamingText(text)).toBe('answer');
  });

  it('cuts at an incomplete managed fence mid-stream', () => {
    const text = 'answer\n```kodax-task-verdict\nstatus: accept';
    expect(sanitizeManagedStreamingText(text)).toBe('answer');
  });
});

describe('sanitizeEvaluatorPublicAnswer', () => {
  it('returns sanitized fence-stripped text when no process framing is present', () => {
    expect(sanitizeEvaluatorPublicAnswer('Direct answer text.')).toBe('Direct answer text.');
  });

  it('strips leading process-framing paragraphs', () => {
    const text = [
      'Confirmed: all checks pass.',
      '',
      'The actual review finding: bug in line 42.',
    ].join('\n');
    const result = sanitizeEvaluatorPublicAnswer(text);
    expect(result).toBe('The actual review finding: bug in line 42.');
  });

  it('strips "Let me verify" leads', () => {
    const text = [
      'Let me verify the Generator\'s claims.',
      '',
      'Finding 1: typo in README.',
    ].join('\n');
    expect(sanitizeEvaluatorPublicAnswer(text)).toBe('Finding 1: typo in README.');
  });

  it('keeps text that does not match any process-framing pattern', () => {
    const text = 'Finding: N+1 query in user list.';
    expect(sanitizeEvaluatorPublicAnswer(text)).toBe(text);
  });

  it('falls back to the full sanitized text if removing would leave nothing', () => {
    const text = 'Confirmed: done.';
    // Everything removed → fall back.
    expect(sanitizeEvaluatorPublicAnswer(text)).toBe(text);
  });
});
