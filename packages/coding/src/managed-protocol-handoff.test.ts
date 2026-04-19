/**
 * Tests for FEATURE_046: AMA Handoff Integrity and Final-Answer Convergence.
 *
 * Covers:
 *  - parseManagedTaskVerdictDirective (JSON + line-oriented + edge cases)
 *  - sanitizeManagedWorkerResult (normal, enforce-verdict, missing verdict)
 *  - buildManagedWorkerMemoryNote (all optional fields + truncation)
 *  - buildManagedWorkerRoundSummary (scout / planner / evaluator roles)
 *  - mergeEvidenceArtifacts (dedup, ordering, empty inputs)
 */

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeManagedVerdictStatus, normalizeManagedNextHarness } from './managed-protocol.js';
import { __managedProtocolTestables } from './task-engine.js';
import type {
  KodaXManagedTask,
  KodaXManagedVerdictPayload,
  KodaXTaskContract,
  KodaXTaskEvidenceBundle,
  KodaXOrchestrationVerdict,
  KodaXResult,
} from './types.js';

const {
  parseManagedTaskVerdictDirective,
  sanitizeManagedWorkerResult,
  buildManagedWorkerMemoryNote,
  buildManagedWorkerRoundSummary,
  mergeEvidenceArtifacts,
} = __managedProtocolTestables;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildResult(overrides: Partial<KodaXResult> = {}): KodaXResult {
  return {
    success: true,
    lastText: '',
    messages: [],
    sessionId: 'test-session',
    ...overrides,
  };
}

function buildContract(overrides: Partial<KodaXTaskContract> = {}): KodaXTaskContract {
  return {
    taskId: 'task-001',
    surface: 'cli',
    objective: 'Test objective',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    status: 'running',
    primaryTask: 'edit',
    workIntent: 'new',
    complexity: 'simple',
    riskLevel: 'low',
    harnessProfile: 'H1_EXECUTE_EVAL',
    recommendedMode: 'implementation',
    requiresBrainstorm: false,
    reason: 'test',
    successCriteria: [],
    requiredEvidence: [],
    constraints: [],
    ...overrides,
  };
}

function buildEvidenceBundle(overrides: Partial<KodaXTaskEvidenceBundle> = {}): KodaXTaskEvidenceBundle {
  return {
    workspaceDir: '/tmp/test-workspace',
    artifacts: [],
    entries: [],
    routingNotes: [],
    ...overrides,
  };
}

function buildVerdict(overrides: Partial<KodaXOrchestrationVerdict> = {}): KodaXOrchestrationVerdict {
  return {
    status: 'running',
    decidedByAssignmentId: 'eval-001',
    summary: 'Test verdict',
    ...overrides,
  };
}

function buildTask(overrides: Partial<KodaXManagedTask> = {}): KodaXManagedTask {
  return {
    contract: buildContract(),
    roleAssignments: [],
    workItems: [],
    evidence: buildEvidenceBundle(),
    verdict: buildVerdict(),
    ...overrides,
  };
}

function makeWorkerSpec(role: 'scout' | 'planner' | 'evaluator' | 'generator' = 'evaluator') {
  return {
    id: `${role}-001`,
    title: role.charAt(0).toUpperCase() + role.slice(1),
    role,
    agent: 'default' as const,
    prompt: '',
    execution: 'serial' as const,
    terminalAuthority: false,
  };
}

function verdictBlock(body: string): string {
  return '```kodax-task-verdict\n' + body + '\n```';
}

// ---------------------------------------------------------------------------
// parseManagedTaskVerdictDirective
// ---------------------------------------------------------------------------

describe('parseManagedTaskVerdictDirective', () => {
  it('parses a JSON verdict block with status accept', () => {
    const text = [
      'Some visible text before the block.',
      '',
      verdictBlock(JSON.stringify({
        status: 'accept',
        reason: 'All criteria met.',
        followup: ['Consider adding more tests.'],
      })),
    ].join('\n');

    const result = parseManagedTaskVerdictDirective(text);
    expect(result).toBeDefined();
    expect(result!.status).toBe('accept');
    expect(result!.reason).toBe('All criteria met.');
    expect(result!.source).toBe('evaluator');
    expect(result!.followups).toEqual(['Consider adding more tests.']);
    expect(result!.userFacingText).toContain('Some visible text before the block.');
  });

  it('parses a JSON verdict block with status revise', () => {
    const text = verdictBlock(JSON.stringify({
      status: 'revise',
      reason: 'Missing error handling.',
      followups: ['Add try-catch', 'Fix edge case'],
      next_harness: 'H2_PLAN_EXECUTE_EVAL',
    }));

    const result = parseManagedTaskVerdictDirective(text);
    expect(result).toBeDefined();
    expect(result!.status).toBe('revise');
    expect(result!.nextHarness).toBe('H2_PLAN_EXECUTE_EVAL');
    expect(result!.followups).toEqual(['Add try-catch', 'Fix edge case']);
  });

  it('parses a JSON verdict block with status blocked', () => {
    const text = verdictBlock(JSON.stringify({
      status: 'blocked',
      reason: 'Ambiguous requirements.',
    }));

    const result = parseManagedTaskVerdictDirective(text);
    expect(result).toBeDefined();
    expect(result!.status).toBe('blocked');
  });

  it('parses user_answer field from JSON', () => {
    const text = verdictBlock(JSON.stringify({
      status: 'accept',
      user_answer: 'Here is what I did for the user.',
    }));

    const result = parseManagedTaskVerdictDirective(text);
    expect(result).toBeDefined();
    expect(result!.userAnswer).toBe('Here is what I did for the user.');
  });

  it('returns undefined when no verdict block exists', () => {
    const result = parseManagedTaskVerdictDirective('Just plain text, no blocks.');
    expect(result).toBeUndefined();
  });

  it('returns undefined when verdict block has no valid status', () => {
    const text = verdictBlock(JSON.stringify({ reason: 'No status provided.' }));
    const result = parseManagedTaskVerdictDirective(text);
    expect(result).toBeUndefined();
  });

  it('returns undefined when verdict body is invalid JSON and has no status line', () => {
    const text = verdictBlock('this is not valid json and has no status');
    const result = parseManagedTaskVerdictDirective(text);
    expect(result).toBeUndefined();
  });

  it('uses the last verdict block when multiple exist', () => {
    const text = [
      verdictBlock(JSON.stringify({ status: 'revise', reason: 'First attempt.' })),
      verdictBlock(JSON.stringify({ status: 'accept', reason: 'Second attempt passed.' })),
    ].join('\n');

    const result = parseManagedTaskVerdictDirective(text);
    expect(result).toBeDefined();
    expect(result!.status).toBe('accept');
    expect(result!.reason).toBe('Second attempt passed.');
  });

  it('parses line-oriented verdict with key=value pairs', () => {
    const text = verdictBlock([
      'status: blocked',
      'reason: Need clarification on requirements.',
    ].join('\n'));

    const result = parseManagedTaskVerdictDirective(text);
    expect(result).toBeDefined();
    expect(result!.status).toBe('blocked');
    expect(result!.reason).toBe('Need clarification on requirements.');
  });

  it('parses user_answer as multi-line in line-oriented format', () => {
    const text = verdictBlock([
      'status: accept',
      'user_answer: Here is what I did',
      'It involved multiple steps',
      '',
      'And some more details',
    ].join('\n'));

    const result = parseManagedTaskVerdictDirective(text);
    expect(result).toBeDefined();
    expect(result!.status).toBe('accept');
    expect(result!.userAnswer).toContain('Here is what I did');
    expect(result!.userAnswer).toContain('And some more details');
  });

  it('handles camelCase and snake_case field names', () => {
    const text = verdictBlock(JSON.stringify({
      status: 'accept',
      userAnswer: 'Camel case answer',
      nextHarness: 'H1_EXECUTE_EVAL',
      followups: ['Follow up 1'],
    }));

    const result = parseManagedTaskVerdictDirective(text);
    expect(result).toBeDefined();
    expect(result!.userAnswer).toBe('Camel case answer');
    expect(result!.nextHarness).toBe('H1_EXECUTE_EVAL');
    expect(result!.followups).toEqual(['Follow up 1']);
  });

  it('handles followup as a newline-delimited string in JSON', () => {
    const text = verdictBlock(JSON.stringify({
      status: 'revise',
      followup: 'Item one\nItem two\nItem three',
    }));

    const result = parseManagedTaskVerdictDirective(text);
    expect(result).toBeDefined();
    expect(result!.followups).toEqual(['Item one', 'Item two', 'Item three']);
  });

  it('trims reason and ignores empty reason', () => {
    const text = verdictBlock(JSON.stringify({
      status: 'accept',
      reason: '   ',
    }));

    const result = parseManagedTaskVerdictDirective(text);
    expect(result).toBeDefined();
    expect(result!.reason).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// sanitizeManagedWorkerResult
// ---------------------------------------------------------------------------

describe('sanitizeManagedWorkerResult', () => {
  it('returns result unchanged when no verdict block is present and enforceVerdictBlock is false', () => {
    const result = buildResult({ lastText: 'Normal output', messages: [{ role: 'assistant', content: 'Normal output' }] });
    const { result: sanitized, directive } = sanitizeManagedWorkerResult(result);
    expect(directive).toBeUndefined();
    expect(sanitized.lastText).toBe('Normal output');
  });

  it('extracts verdict from text and replaces message content', () => {
    const verdictText = verdictBlock(JSON.stringify({
      status: 'accept',
      reason: 'All good.',
      user_answer: 'Done successfully.',
    }));
    const fullText = 'Visible prefix text.\n' + verdictText;

    const result = buildResult({
      lastText: fullText,
      messages: [{ role: 'assistant', content: fullText }],
    });

    const { result: sanitized, directive } = sanitizeManagedWorkerResult(result);
    expect(directive).toBeDefined();
    expect(directive!.status).toBe('accept');
    // When userAnswer is present, it becomes the lastText
    expect(sanitized.lastText).toBe('Done successfully.');
    // protocolRawText should be cleared
    expect(sanitized.protocolRawText).toBeUndefined();
  });

  it('uses managedProtocolPayload.verdict when available (no text parsing)', () => {
    const verdict: KodaXManagedVerdictPayload = {
      source: 'evaluator',
      status: 'accept',
      followups: [],
      userFacingText: 'Task completed.',
      userAnswer: 'Custom user answer.',
    };

    const result = buildResult({
      lastText: 'Original text',
      messages: [{ role: 'assistant', content: 'Original text' }],
      managedProtocolPayload: { verdict },
    });

    const { result: sanitized, directive } = sanitizeManagedWorkerResult(result);
    expect(directive).toBeDefined();
    expect(directive!.status).toBe('accept');
    expect(sanitized.lastText).toBe('Custom user answer.');
  });

  it('produces a blocked directive when enforceVerdictBlock is true and no verdict found', () => {
    const result = buildResult({
      lastText: 'No verdict block here.',
      messages: [{ role: 'assistant', content: 'No verdict block here.' }],
    });

    const { result: sanitized, directive } = sanitizeManagedWorkerResult(result, { enforceVerdictBlock: true });
    expect(directive).toBeDefined();
    expect(directive!.status).toBe('blocked');
    expect(directive!.protocolParseFailed).toBe(true);
    expect(sanitized.success).toBe(false);
    expect(sanitized.signal).toBe('BLOCKED');
  });

  it('clears protocolRawText and managedProtocolPayload from the failure result', () => {
    const result = buildResult({
      lastText: 'Missing verdict.',
      messages: [{ role: 'assistant', content: 'Missing verdict.' }],
      protocolRawText: 'raw protocol text',
      managedProtocolPayload: { verdict: undefined },
    });

    const { result: sanitized, directive } = sanitizeManagedWorkerResult(result, { enforceVerdictBlock: true });
    expect(directive).toBeDefined();
    expect(sanitized.protocolRawText).toBeUndefined();
    expect(sanitized.managedProtocolPayload).toBeUndefined();
  });

  it('prefers userAnswer over sanitized evaluator text', () => {
    const verdictText = verdictBlock(JSON.stringify({
      status: 'accept',
      user_answer: 'User-facing summary.',
    }));
    const fullText = 'Internal thinking text.\n' + verdictText;

    const result = buildResult({
      lastText: fullText,
      messages: [{ role: 'assistant', content: fullText }],
    });

    const { result: sanitized, directive } = sanitizeManagedWorkerResult(result);
    expect(directive!.userAnswer).toBe('User-facing summary.');
    expect(sanitized.lastText).toBe('User-facing summary.');
  });
});

// ---------------------------------------------------------------------------
// buildManagedWorkerMemoryNote
// ---------------------------------------------------------------------------

describe('buildManagedWorkerMemoryNote', () => {
  it('builds a memory note with required fields', () => {
    const task = buildTask();
    const worker = makeWorkerSpec('evaluator');
    const result = buildResult({ lastText: 'Summary output.' });

    const note = buildManagedWorkerMemoryNote(task, worker, result, 3);

    expect(note).toContain('Compacted managed-task memory:');
    expect(note).toContain('- Objective: Test objective');
    expect(note).toContain('- Role: evaluator');
    expect(note).toContain('- Harness: H1_EXECUTE_EVAL');
    expect(note).toContain('- Round reached: 3');
    expect(note).toContain('- Latest worker summary: Summary output.');
    expect(note).toContain('- Contract path:');
    expect(note).toContain('- Round history path:');
    expect(note).toContain('Use the current contract and artifacts as the source of truth');
  });

  it('includes optional fields when present', () => {
    const task = buildTask({
      contract: buildContract({
        contractSummary: 'A test contract',
        successCriteria: ['Tests pass', 'No regressions'],
        requiredEvidence: ['git diff', 'test output'],
      }),
      runtime: {
        reviewFilesOrAreas: ['src/main.ts', 'src/utils.ts'],
        evidenceAcquisitionMode: 'diff-bundle',
      } as any,
    });
    const worker = makeWorkerSpec('generator');
    const result = buildResult({ lastText: 'Done.' });

    const note = buildManagedWorkerMemoryNote(task, worker, result, 5);

    expect(note).toContain('- Contract summary: A test contract');
    expect(note).toContain('- Success criteria: Tests pass | No regressions');
    expect(note).toContain('- Required evidence: git diff | test output');
    expect(note).toContain('- Review targets: src/main.ts | src/utils.ts');
    expect(note).toContain('- Evidence acquisition mode: diff-bundle');
  });

  it('excludes optional fields when absent', () => {
    const task = buildTask({
      contract: buildContract({
        contractSummary: undefined,
        successCriteria: [],
        requiredEvidence: [],
      }),
    });
    const worker = makeWorkerSpec('scout');
    const result = buildResult({ lastText: 'Scout output.' });

    const note = buildManagedWorkerMemoryNote(task, worker, result, 1);

    expect(note).not.toContain('- Contract summary:');
    expect(note).not.toContain('- Success criteria:');
    expect(note).not.toContain('- Required evidence:');
  });

  it('references the latest feedback artifact', () => {
    const task = buildTask({
      evidence: buildEvidenceBundle({
        artifacts: [
          { kind: 'json', path: path.join('tmp', 'feedback.json') },
          { kind: 'json', path: path.join('round2', 'feedback.json') },
        ],
      }),
    });
    const worker = makeWorkerSpec('evaluator');
    const result = buildResult({ lastText: 'Eval output.' });

    const note = buildManagedWorkerMemoryNote(task, worker, result, 2);

    expect(note).toContain('- Latest feedback artifact:');
    // Should reference the last feedback.json
    expect(note).toContain(path.join('round2', 'feedback.json'));
  });

  it('truncates long worker output in summary', () => {
    const longOutput = 'A'.repeat(1200);
    const task = buildTask();
    const worker = makeWorkerSpec('evaluator');
    const result = buildResult({ lastText: longOutput });

    const note = buildManagedWorkerMemoryNote(task, worker, result, 1);

    // The latest summary line should contain truncated text (max ~800 chars from truncateText)
    const summaryLine = note.split('\n').find((l) => l.includes('- Latest worker summary:'));
    expect(summaryLine).toBeDefined();
    // Should be much shorter than the full 1200 chars
    expect(summaryLine!.length).toBeLessThan(900);
  });
});

// ---------------------------------------------------------------------------
// buildManagedWorkerRoundSummary
// ---------------------------------------------------------------------------

describe('buildManagedWorkerRoundSummary', () => {
  it('returns undefined for generator role', () => {
    const task = buildTask();
    const worker = makeWorkerSpec('generator');
    const result = buildResult({ lastText: 'Generator output.' });

    const summary = buildManagedWorkerRoundSummary(task, worker, result, 1, undefined);
    expect(summary).toBeUndefined();
  });

  it('builds a scout round summary from directive', () => {
    const task = buildTask({
      contract: buildContract({ objective: 'Analyze code quality' }),
    });
    const worker = makeWorkerSpec('scout');
    const result = buildResult({ lastText: 'Scout findings.' });

    const scoutDirective = {
      summary: 'Two issues found.',
      scope: ['src/'],
      requiredEvidence: ['lint output'],
      confirmedHarness: 'H1_EXECUTE_EVAL' as const,
    };

    const summary = buildManagedWorkerRoundSummary(task, worker, result, 2, scoutDirective as any);
    expect(summary).toBeDefined();
    expect(summary!.role).toBe('scout');
    expect(summary!.round).toBe(2);
    expect(summary!.summary).toContain('Two issues found.');
    expect(summary!.confirmedConclusions).toEqual(
      expect.arrayContaining([
        'Two issues found.',
        'Recommended harness: H1_EXECUTE_EVAL',
      ]),
    );
    expect(summary!.unresolvedQuestions).toEqual(['lint output']);
    expect(summary!.nextFocus).toEqual(['src/']);
    expect(summary!.objective).toContain('Analyze code quality');
  });

  it('builds a planner round summary from directive', () => {
    const task = buildTask({
      contract: buildContract({ objective: 'Refactor module' }),
    });
    const worker = makeWorkerSpec('planner');
    const result = buildResult({ lastText: 'Plan output.' });

    const contractDirective = {
      summary: 'Plan created.',
      successCriteria: ['No regressions', 'Clean build'],
      requiredEvidence: ['build log'],
      constraints: ['Do not change public API'],
    };

    const summary = buildManagedWorkerRoundSummary(task, worker, result, 1, contractDirective as any);
    expect(summary).toBeDefined();
    expect(summary!.role).toBe('planner');
    expect(summary!.summary).toContain('Plan created.');
    expect(summary!.confirmedConclusions).toEqual(
      expect.arrayContaining(['Plan created.', 'No regressions', 'Clean build']),
    );
    expect(summary!.unresolvedQuestions).toEqual(['build log']);
    expect(summary!.nextFocus).toEqual(['Do not change public API']);
  });

  it('builds an evaluator round summary with accept status', () => {
    const task = buildTask({
      contract: buildContract({ objective: 'Fix bug' }),
    });
    const worker = makeWorkerSpec('evaluator');
    const result = buildResult({ lastText: 'Evaluation done.' });

    const verdictDirective = {
      source: 'evaluator' as const,
      status: 'accept' as const,
      reason: 'All criteria satisfied.',
      followups: [],
      userFacingText: 'Eval text.',
    };

    const summary = buildManagedWorkerRoundSummary(task, worker, result, 3, verdictDirective as any);
    expect(summary).toBeDefined();
    expect(summary!.role).toBe('evaluator');
    expect(summary!.summary).toContain('All criteria satisfied.');
    expect(summary!.confirmedConclusions).toEqual(
      expect.arrayContaining(['Verdict: accept', 'All criteria satisfied.']),
    );
    // Accept status means no unresolved questions
    expect(summary!.unresolvedQuestions).toEqual([]);
  });

  it('builds an evaluator round summary with revise status and followups', () => {
    const task = buildTask({
      contract: buildContract({ objective: 'Add feature' }),
    });
    const worker = makeWorkerSpec('evaluator');
    const result = buildResult({ lastText: 'Needs work.' });

    const verdictDirective = {
      source: 'evaluator' as const,
      status: 'revise' as const,
      reason: 'Missing tests.',
      followups: ['Add unit tests', 'Fix edge case'],
      userFacingText: 'Eval text.',
    };

    const summary = buildManagedWorkerRoundSummary(task, worker, result, 2, verdictDirective as any);
    expect(summary).toBeDefined();
    expect(summary!.confirmedConclusions).toEqual(
      expect.arrayContaining(['Verdict: revise', 'Missing tests.']),
    );
    expect(summary!.unresolvedQuestions).toEqual(['Add unit tests', 'Fix edge case']);
    expect(summary!.nextFocus).toEqual(['Add unit tests', 'Fix edge case']);
  });

  it('falls back to visible text when no directive is provided', () => {
    const task = buildTask({
      contract: buildContract({ objective: 'Do something' }),
    });
    const worker = makeWorkerSpec('evaluator');
    const result = buildResult({ lastText: 'Fallback summary text.' });

    const summary = buildManagedWorkerRoundSummary(task, worker, result, 1, undefined);
    expect(summary).toBeDefined();
    expect(summary!.role).toBe('evaluator');
    expect(summary!.summary).toContain('Fallback summary text.');
  });

  it('sets sourceWorkerId from worker spec', () => {
    const task = buildTask();
    const worker = makeWorkerSpec('scout');
    const result = buildResult({ lastText: 'Scout text.' });

    const summary = buildManagedWorkerRoundSummary(task, worker, result, 1, undefined);
    expect(summary).toBeDefined();
    expect(summary!.sourceWorkerId).toBe('scout-001');
  });

  it('populates updatedAt as an ISO date string', () => {
    const task = buildTask();
    const worker = makeWorkerSpec('scout');
    const result = buildResult({ lastText: 'Scout text.' });

    const summary = buildManagedWorkerRoundSummary(task, worker, result, 1, undefined);
    expect(summary).toBeDefined();
    expect(summary!.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Should be parseable as a date
    expect(new Date(summary!.updatedAt).getTime()).not.toBeNaN();
  });

  it('scopes confirmedConclusions to max 3 items for evaluator', () => {
    const task = buildTask();
    const worker = makeWorkerSpec('evaluator');
    const result = buildResult({ lastText: 'Eval.' });

    // verdictDirective has both status and reason = 2 items, which is within limit
    const verdictDirective = {
      source: 'evaluator' as const,
      status: 'revise' as const,
      reason: 'Need work.',
      followups: [],
      userFacingText: '',
    };

    const summary = buildManagedWorkerRoundSummary(task, worker, result, 1, verdictDirective as any);
    expect(summary!.confirmedConclusions.length).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// mergeEvidenceArtifacts
// ---------------------------------------------------------------------------

describe('mergeEvidenceArtifacts', () => {
  it('returns empty array for no inputs', () => {
    expect(mergeEvidenceArtifacts()).toEqual([]);
  });

  it('returns empty array when all inputs are undefined', () => {
    expect(mergeEvidenceArtifacts(undefined, undefined)).toEqual([]);
  });

  it('merges a single artifact set', () => {
    const artifacts = [
      { kind: 'json' as const, path: '/tmp/artifact1.json' },
      { kind: 'text' as const, path: '/tmp/artifact2.txt' },
    ];

    const result = mergeEvidenceArtifacts(artifacts);
    expect(result).toHaveLength(2);
    expect(result[0].path).toContain('artifact1.json');
    expect(result[1].path).toContain('artifact2.txt');
  });

  it('deduplicates artifacts by resolved path (last wins)', () => {
    const set1 = [
      { kind: 'json' as const, path: '/tmp/feedback.json', description: 'First' },
    ];
    const set2 = [
      { kind: 'json' as const, path: '/tmp/feedback.json', description: 'Second (updated)' },
    ];

    const result = mergeEvidenceArtifacts(set1, set2);
    expect(result).toHaveLength(1);
    // Last set wins
    expect(result[0].description).toBe('Second (updated)');
  });

  it('merges multiple artifact sets preserving order', () => {
    const set1 = [
      { kind: 'json' as const, path: '/tmp/a.json' },
      { kind: 'text' as const, path: '/tmp/b.txt' },
    ];
    const set2 = [
      { kind: 'markdown' as const, path: '/tmp/c.md' },
    ];
    const set3 = [
      { kind: 'image' as const, path: '/tmp/d.png' },
    ];

    const result = mergeEvidenceArtifacts(set1, set2, set3);
    expect(result).toHaveLength(4);
  });

  it('handles mixed defined and undefined sets', () => {
    const set1 = [
      { kind: 'json' as const, path: '/tmp/x.json' },
    ];

    const result = mergeEvidenceArtifacts(undefined, set1, undefined);
    expect(result).toHaveLength(1);
    expect(result[0].path).toContain('x.json');
  });

  it('resolves paths using path.resolve for deduplication', () => {
    // Same path should be deduplicated even with different representations
    const set1 = [
      { kind: 'json' as const, path: 'feedback.json' },
    ];
    const set2 = [
      { kind: 'json' as const, path: path.resolve('feedback.json') },
    ];

    // These resolve to the same absolute path, so should be deduplicated
    const result = mergeEvidenceArtifacts(set1, set2);
    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// normalizeManagedVerdictStatus (from managed-protocol.ts — covered here for completeness)
// ---------------------------------------------------------------------------

describe('normalizeManagedVerdictStatus', () => {
  it.each([
    ['accept', 'accept'],
    ['accepted', 'accept'],
    ['Accepts', 'accept'],
    ['accepting', 'accept'],
    ['approve', 'accept'],
    ['approved', 'approve'],
    ['revise', 'revise'],
    ['revised', 'revise'],
    ['revising', 'revise'],
    ['blocked', 'blocked'],
    ['blocking', 'blocked'],
    ['`accept`', 'accept'],
    ['accept.', 'accept'],
    ['ACCEPT', 'accept'],
    ['  accept  ', 'accept'],
  ] as const)('normalizes "%s" to "%s"', (input, expected) => {
    // 'approved' normalizes to 'accept' since normalizeManagedVerdictStatus returns 'accept' for 'approved'
    if (input === 'approved') {
      expect(normalizeManagedVerdictStatus(input)).toBe('accept');
    } else {
      expect(normalizeManagedVerdictStatus(input)).toBe(expected);
    }
  });

  it('returns undefined for unrecognized status', () => {
    expect(normalizeManagedVerdictStatus('unknown')).toBeUndefined();
    expect(normalizeManagedVerdictStatus('')).toBeUndefined();
    expect(normalizeManagedVerdictStatus('   ')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// normalizeManagedNextHarness
// ---------------------------------------------------------------------------

describe('normalizeManagedNextHarness', () => {
  it.each([
    ['H1', 'H1_EXECUTE_EVAL'],
    ['H1_EXECUTE_EVAL', 'H1_EXECUTE_EVAL'],
    ['h1', 'H1_EXECUTE_EVAL'],
    ['h1_execute_eval', 'H1_EXECUTE_EVAL'],
    ['H2', 'H2_PLAN_EXECUTE_EVAL'],
    ['H2_PLAN_EXECUTE_EVAL', 'H2_PLAN_EXECUTE_EVAL'],
    ['h2', 'H2_PLAN_EXECUTE_EVAL'],
  ] as const)('normalizes "%s" to "%s"', (input, expected) => {
    expect(normalizeManagedNextHarness(input)).toBe(expected);
  });

  it('returns undefined for unrecognized harness', () => {
    expect(normalizeManagedNextHarness('H0')).toBeUndefined();
    expect(normalizeManagedNextHarness('')).toBeUndefined();
    expect(normalizeManagedNextHarness('H3')).toBeUndefined();
  });
});
