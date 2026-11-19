/**
 * v0.7.35.1 FEATURE_142 (B-R1) — byte-equivalence regression test.
 *
 * The coding path's compaction summary prompt MUST stay byte-identical
 * to the v0.7.35 prompt — that's the whole point of preserving the
 * "another coding agent" / "## Files & Changes" / file-path-flavored
 * wording in @kodax-ai/coding instead of @kodax-ai/agent. The eval
 * (`tests/compaction-prompt.eval.ts`) was scored against this exact
 * prompt and it shipped to v0.7.35 users; any drift is a behavior
 * regression, not a refactor.
 *
 * The snapshot files below hold the verbatim v0.7.35 SUMMARY_PROMPT and
 * UPDATE_SUMMARY_PROMPT (commit 3788c51 chore: release v0.7.35, file
 * `packages/agent/src/compaction/summary-generator.ts`). If a future
 * change intends to evolve the coding-side prompt, the snapshots must be
 * updated together with a new prompt eval pass that justifies the recall
 * change.
 */

import { describe, expect, it } from 'vitest';

import {
  buildCompactionPromptSnapshot,
  DEFAULT_SUMMARY_PROMPT,
  DEFAULT_UPDATE_SUMMARY_PROMPT,
} from '@kodax-ai/agent';

import {
  CODING_SUMMARY_PROMPT,
  CODING_UPDATE_SUMMARY_PROMPT,
} from './coding-compaction-prompts.js';

describe('CODING_SUMMARY_PROMPT byte-equivalence', () => {
  it('matches the v0.7.35 SUMMARY_PROMPT', async () => {
    await expect(CODING_SUMMARY_PROMPT).toMatchFileSnapshot('../prompts/expected/compaction.summary.md');
  });

  it('matches the v0.7.35 UPDATE_SUMMARY_PROMPT', async () => {
    await expect(CODING_UPDATE_SUMMARY_PROMPT).toMatchFileSnapshot('../prompts/expected/compaction.update-summary.md');
  });

  it('contains the coding-specific phrases (sanity)', () => {
    expect(CODING_SUMMARY_PROMPT).toContain('another coding agent');
    expect(CODING_SUMMARY_PROMPT).toContain(
      'EXACT file paths, function names, and line numbers',
    );
    expect(CODING_SUMMARY_PROMPT).toContain('HTTP status codes');
    expect(CODING_SUMMARY_PROMPT).toContain('## Files & Changes');
    expect(CODING_SUMMARY_PROMPT).toContain('/api/auth/login');
    expect(CODING_UPDATE_SUMMARY_PROMPT).toContain('another coding agent');
    expect(CODING_UPDATE_SUMMARY_PROMPT).toContain('## Files & Changes');
  });

  it('differs from the neutral DEFAULT_SUMMARY_PROMPT', () => {
    expect(CODING_SUMMARY_PROMPT).not.toBe(DEFAULT_SUMMARY_PROMPT);
    expect(CODING_UPDATE_SUMMARY_PROMPT).not.toBe(DEFAULT_UPDATE_SUMMARY_PROMPT);
    // The neutral default must NOT contain coding-flavored phrases.
    expect(DEFAULT_SUMMARY_PROMPT).not.toContain('another coding agent');
    expect(DEFAULT_SUMMARY_PROMPT).not.toContain('## Files & Changes');
    expect(DEFAULT_SUMMARY_PROMPT).not.toContain('/api/auth/login');
  });
});

describe('buildCompactionPromptSnapshot — coding path byte-equivalence', () => {
  it('initial-summary path: passing CODING_SUMMARY_PROMPT embeds it verbatim into userPrompt', () => {
    const snapshot = buildCompactionPromptSnapshot({
      messages: [{ role: 'user', content: 'continue the work' }],
      details: { readFiles: ['a.ts'], modifiedFiles: ['b.ts'] },
      summaryPrompt: CODING_SUMMARY_PROMPT,
      updateSummaryPrompt: CODING_UPDATE_SUMMARY_PROMPT,
    });

    expect(snapshot.variant).toBe('initial-summary');
    // The full coding prompt must appear verbatim — no rewriting,
    // re-wrapping, or whitespace manipulation in the assembly path.
    expect(snapshot.userPrompt).toContain(CODING_SUMMARY_PROMPT.trim());
    // Coding-flavored phrases survive the section assembly.
    expect(snapshot.userPrompt).toContain('another coding agent');
    expect(snapshot.userPrompt).toContain('## Files & Changes');
  });

  it('update-summary path: passing CODING_UPDATE_SUMMARY_PROMPT embeds it verbatim', () => {
    const snapshot = buildCompactionPromptSnapshot({
      messages: [{ role: 'user', content: 'continue the work' }],
      details: { readFiles: [], modifiedFiles: [] },
      previousSummary: '## Goal\nPrior task',
      summaryPrompt: CODING_SUMMARY_PROMPT,
      updateSummaryPrompt: CODING_UPDATE_SUMMARY_PROMPT,
    });

    expect(snapshot.variant).toBe('update-summary');
    expect(snapshot.userPrompt).toContain(
      CODING_UPDATE_SUMMARY_PROMPT.trim(),
    );
    expect(snapshot.userPrompt).toContain('another coding agent');
    expect(snapshot.userPrompt).toContain('<previous-summary>');
  });

  it('without overrides: userPrompt uses neutral DEFAULT_SUMMARY_PROMPT (no coding-flavor)', () => {
    const snapshot = buildCompactionPromptSnapshot({
      messages: [{ role: 'user', content: 'continue the work' }],
      details: { readFiles: [], modifiedFiles: [] },
    });

    expect(snapshot.userPrompt).toContain(DEFAULT_SUMMARY_PROMPT.trim());
    expect(snapshot.userPrompt).not.toContain('another coding agent');
    expect(snapshot.userPrompt).not.toContain('## Files & Changes');
    expect(snapshot.userPrompt).not.toContain('/api/auth/login');
  });
});
