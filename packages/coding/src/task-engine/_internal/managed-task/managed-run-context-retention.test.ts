import { describe, expect, it } from 'vitest';

import type { KodaXMessage } from '../../../types.js';
import {
  createManagedRunContextMessage,
  createManagedRuntimeContextMessage,
} from './managed-run-context.js';
import {
  diffRetainedSessionSections,
  isRetainedSessionSection,
  recordManagedRunContext,
  restoreManagedRunContext,
  type ManagedRunContextEffectiveState,
} from './managed-run-context-retention.js';

const user = (content: string): KodaXMessage => ({ role: 'user', content });
const assistant = (content: string): KodaXMessage => ({ role: 'assistant', content });
const effective: ManagedRunContextEffectiveState = {
  runtimeFingerprint: '{"scratchDir":"s1"}',
  sessionSections: [{ id: 'skills-addendum', content: '## Skills\n- alpha' }],
};

describe('managed run context retention', () => {
  it('restores retained envelopes at their original positions in the same history', () => {
    const envelope = createManagedRunContextMessage('=== Managed Run Context ===\nA\n=== End Managed Run Context ===');
    const delta = createManagedRuntimeContextMessage('=== Managed Run Context ===\nRuntime state refresh:\nB\n=== End Managed Run Context ===');
    const record = recordManagedRunContext([
      envelope,
      user('first task'),
      assistant('working'),
      delta,
      assistant('done'),
    ], effective);

    const restored = restoreManagedRunContext(record, [
      user('first task'),
      assistant('working'),
      assistant('done'),
    ]);

    expect(restored?.messages).toEqual([
      envelope,
      user('first task'),
      assistant('working'),
      delta,
      assistant('done'),
    ]);
    expect(restored?.effective).toEqual(effective);
  });

  it('keeps later host messages after the retained transcript', () => {
    const envelope = createManagedRunContextMessage('=== Managed Run Context ===\nA\n=== End Managed Run Context ===');
    const record = recordManagedRunContext([envelope, user('first task'), assistant('done')], effective);

    const restored = restoreManagedRunContext(record, [
      user('first task'),
      assistant('done'),
      user('<agent-completed path="/root/a">late result</agent-completed>'),
    ]);

    expect(restored?.messages).toEqual([
      envelope,
      user('first task'),
      assistant('done'),
      user('<agent-completed path="/root/a">late result</agent-completed>'),
    ]);
  });

  it.each([
    ['an edited message', [user('first task (edited)'), assistant('done')]],
    ['a shorter history', [user('first task')]],
    ['a changed role', [user('first task'), user('done')]],
  ])('does not restore over %s', (_label, history) => {
    const envelope = createManagedRunContextMessage('=== Managed Run Context ===\nA\n=== End Managed Run Context ===');
    const record = recordManagedRunContext([envelope, user('first task'), assistant('done')], effective);

    expect(restoreManagedRunContext(record, history)).toBeUndefined();
  });

  it('does not share message objects or section arrays with the caller', () => {
    const envelope = createManagedRunContextMessage('=== Managed Run Context ===\nA\n=== End Managed Run Context ===');
    const sections = [{ id: 'skills-addendum', content: '## Skills\n- alpha' }];
    const record = recordManagedRunContext(
      [envelope, user('first task')],
      { runtimeFingerprint: undefined, sessionSections: sections },
    );
    (envelope as { content: string }).content = 'MUTATED';
    sections.push({ id: 'mcp-capability-context', content: 'MUTATED' });

    const restored = restoreManagedRunContext(record, [user('first task')]);

    expect(JSON.stringify(restored)).not.toContain('MUTATED');
  });
});

describe('retained session section diff', () => {
  it('repeats only new or changed session facts', () => {
    const diff = diffRetainedSessionSections(
      [
        { id: 'skills-addendum', content: '## Skills\n- alpha' },
        { id: 'git-context', content: 'Git Status: clean' },
      ],
      [
        { id: 'skills-addendum', content: '## Skills\n- alpha' },
        { id: 'git-context', content: 'Git Status: 1 modified' },
        { id: 'mcp-capability-context', content: '## MCP\n- docs' },
      ],
    );

    expect(diff.restated.map((section) => section.id)).toEqual(['git-context', 'mcp-capability-context']);
    expect(diff.retiredLabels).toEqual([]);
    expect(diff.effective.map((section) => section.id))
      .toEqual(['skills-addendum', 'git-context', 'mcp-capability-context']);
  });

  it('restates the current project snapshot even when it is unchanged', () => {
    const sections = [
      { id: 'git-context', content: 'Git Status: clean' },
      { id: 'project-snapshot', content: 'Project: workspace\n  README.md' },
    ];
    const diff = diffRetainedSessionSections(sections, sections.map((section) => ({ ...section })));

    expect(diff.restated).toEqual([{ id: 'project-snapshot', content: 'Project: workspace\n  README.md' }]);
    expect(diff.retiredLabels).toEqual([]);
    expect(diff.effective).toEqual(sections);
  });

  it('reports a retired capability catalog once', () => {
    const first = diffRetainedSessionSections(
      [{ id: 'skills-addendum', content: '## Skills\n- alpha' }],
      [],
    );

    expect(first.restated).toEqual([]);
    expect(first.retiredLabels).toEqual(['Skills catalog']);
    expect(first.effective).toEqual([]);
    expect(diffRetainedSessionSections(first.effective, []).retiredLabels).toEqual([]);
  });

  it('keeps earlier repository evidence when a Run does not recompute it', () => {
    const diff = diffRetainedSessionSections(
      [
        { id: 'git-context', content: 'Git Status: clean' },
        { id: 'project-snapshot', content: 'Project: workspace\n  README.md' },
        { id: 'repo-intelligence-context', content: 'Repository overview' },
      ],
      [],
    );

    expect(diff.restated).toEqual([]);
    expect(diff.retiredLabels).toEqual([]);
    expect(diff.effective.map((section) => section.id))
      .toEqual(['git-context', 'project-snapshot', 'repo-intelligence-context']);
  });

  it('treats task-specific capability sections as not retained', () => {
    expect(isRetainedSessionSection('skills-addendum')).toBe(true);
    expect(isRetainedSessionSection('repo-intelligence-context')).toBe(true);
    expect(isRetainedSessionSection('project-memory')).toBe(false);
    expect(isRetainedSessionSection('prompt-overlay')).toBe(false);
  });
});
