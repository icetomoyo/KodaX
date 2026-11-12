import { describe, expect, it } from 'vitest';
import type { MemoryNote, SessionEvidence } from '@kodax-ai/agent';

import {
  buildReflectionRequest,
  parseReflectionCall,
  REFLECT_TOOL,
  REFLECT_TOOL_NAME,
  reflectionSystemPrompt,
} from './note-reflection.js';

const evidence: SessionEvidence = {
  segments: [{ source: 'user', label: 'user', text: 'Always run the unit tests with --run.', isError: false }],
  userText: 'Always run the unit tests with --run.',
  omitted: 0,
};

const note: MemoryNote = {
  id: 'test-flag',
  scope: 'project',
  type: 'feedback',
  description: 'Unit tests need --run',
  body: 'Watch mode hangs the shell.',
  status: 'candidate',
  source: 'inferred',
  session: 's_1',
  why: 'Observed a hang',
  check: 'Run the test script once',
} as MemoryNote;

describe('note reflection request', () => {
  it('exposes exactly one tool whose required fields are operation and id', () => {
    expect(REFLECT_TOOL.name).toBe(REFLECT_TOOL_NAME);
    expect(REFLECT_TOOL.input_schema.required).toEqual(['operation', 'id']);
    expect(REFLECT_TOOL.description.length).toBeGreaterThan(0);
  });

  it('renders existing notes with status, source and session, then the evidence', () => {
    const { userMessage, tools, systemPrompt } = buildReflectionRequest(evidence, [note]);
    expect(tools).toHaveLength(1);
    expect(systemPrompt).toBe(reflectionSystemPrompt());
    expect(userMessage).toContain('## test-flag (project, feedback, candidate, inferred, session s_1)');
    expect(userMessage).toContain('check: Run the test script once');
    expect(userMessage.indexOf('# Current notes')).toBeLessThan(userMessage.indexOf('# Session evidence'));
    expect(userMessage).toContain('Always run the unit tests with --run.');
  });

  it('says so when there are no notes', () => {
    expect(buildReflectionRequest(evidence, []).userMessage).toContain('(no notes yet)');
  });
});

describe('parseReflectionCall', () => {
  it('keeps valid fields and drops unknown enum values', () => {
    const parsed = parseReflectionCall({ operation: 'write', id: 'a', scope: 'galaxy', type: 'feedback', quote: 'q' });
    expect(parsed).toMatchObject({ operation: 'write', id: 'a', type: 'feedback', quote: 'q' });
    expect(parsed?.scope).toBeUndefined();
  });

  it('treats a call that omits the operation as a write, since only a write carries a note body', () => {
    expect(parseReflectionCall({ id: 'a', body: 'text', description: 'd' })).toMatchObject({ operation: 'write', id: 'a' });
    expect(parseReflectionCall({ operation: 'delete', id: 'a', body: 'text' })).toBeUndefined();
  });

  it('rejects unknown operations and missing ids', () => {
    expect(parseReflectionCall({ operation: 'delete', id: 'a' })).toBeUndefined();
    expect(parseReflectionCall({ operation: 'write' })).toBeUndefined();
    expect(parseReflectionCall({ operation: 'write', id: '' })).toBeUndefined();
  });
});
