import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DISCOVERY_OPEN_QUESTIONS,
  createProjectAlignment,
  createProjectWorkflowState,
  parseProjectAlignmentMarkdown,
} from './project-state.js';

describe('project-state helpers', () => {
  it('derives unresolved discovery count from the default question set', () => {
    const state = createProjectWorkflowState('discovering', '2026-03-19T00:00:00.000Z');
    const alignment = createProjectAlignment('Need a scoped first release', '2026-03-19T00:00:00.000Z');

    expect(DEFAULT_DISCOVERY_OPEN_QUESTIONS.length).toBeGreaterThan(0);
    expect(state.unresolvedQuestionCount).toBe(DEFAULT_DISCOVERY_OPEN_QUESTIONS.length);
    expect(alignment.openQuestions).toHaveLength(DEFAULT_DISCOVERY_OPEN_QUESTIONS.length);
  });

  it('parses multiple markdown bullet styles when reading alignment truth', () => {
    const parsed = parseProjectAlignmentMarkdown(`# Project Alignment

Updated: 2026-03-19T00:00:00.000Z

## Source Prompt
Ship a first release

## Confirmed Requirements
* Support a single production workflow
1. Keep onboarding under five minutes

## Constraints
- Preserve the current API surface

## Non-goals
1. Rebuild the entire admin console

## Accepted Tradeoffs
* Prefer clarity over configurability

## Success Criteria
1. Operators can complete setup without docs

## Open Questions
* Do we need audit export in v1?
`);

    expect(parsed.confirmedRequirements).toEqual([
      'Support a single production workflow',
      'Keep onboarding under five minutes',
    ]);
    expect(parsed.constraints).toEqual(['Preserve the current API surface']);
    expect(parsed.nonGoals).toEqual(['Rebuild the entire admin console']);
    expect(parsed.acceptedTradeoffs).toEqual(['Prefer clarity over configurability']);
    expect(parsed.successCriteria).toEqual(['Operators can complete setup without docs']);
    expect(parsed.openQuestions).toEqual(['Do we need audit export in v1?']);
  });
});
