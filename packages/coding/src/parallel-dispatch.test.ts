import { describe, it, expect } from 'vitest';
import {
  isParallelDispatchDirective,
  formatParallelDispatchResult,
  validateSubtaskIndependence,
} from './parallel-dispatch.js';
import type { ParallelSubtask, ParallelDispatchDirective, ParallelDispatchResult } from './parallel-dispatch.js';

describe('isParallelDispatchDirective', () => {
  it('returns true for valid directive with 2+ subtasks', () => {
    const directive: ParallelDispatchDirective = {
      type: 'parallel_dispatch',
      subtasks: [
        { id: 't1', description: 'Fix auth', prompt: 'Fix auth module' },
        { id: 't2', description: 'Update docs', prompt: 'Update README' },
      ],
      reason: 'Independent tasks',
    };
    expect(isParallelDispatchDirective(directive)).toBe(true);
  });

  it('returns false for non-object', () => {
    expect(isParallelDispatchDirective(null)).toBe(false);
    expect(isParallelDispatchDirective('string')).toBe(false);
    expect(isParallelDispatchDirective(42)).toBe(false);
  });

  it('returns false for wrong type field', () => {
    expect(isParallelDispatchDirective({ type: 'h0', subtasks: [] })).toBe(false);
  });

  it('returns false for single subtask', () => {
    expect(
      isParallelDispatchDirective({
        type: 'parallel_dispatch',
        subtasks: [{ id: 't1', description: 'Only one', prompt: 'Only one task' }],
        reason: 'test',
      })
    ).toBe(false);
  });

  it('returns false for empty subtasks array', () => {
    expect(
      isParallelDispatchDirective({
        type: 'parallel_dispatch',
        subtasks: [],
        reason: 'test',
      })
    ).toBe(false);
  });

  it('returns false for non-array subtasks', () => {
    expect(
      isParallelDispatchDirective({
        type: 'parallel_dispatch',
        subtasks: 'not-an-array',
        reason: 'test',
      })
    ).toBe(false);
  });
});

describe('validateSubtaskIndependence', () => {
  it('returns null for valid subtasks', () => {
    const subtasks: ParallelSubtask[] = [
      { id: 't1', description: 'Task 1', prompt: 'Do task 1' },
      { id: 't2', description: 'Task 2', prompt: 'Do task 2' },
    ];
    expect(validateSubtaskIndependence(subtasks)).toBeNull();
  });

  it('returns null for 10 subtasks (at limit)', () => {
    const subtasks = Array.from({ length: 10 }, (_, i) => ({
      id: `t${i}`,
      description: `Task ${i}`,
      prompt: `Do task ${i}`,
    }));
    expect(validateSubtaskIndependence(subtasks)).toBeNull();
  });

  it('rejects fewer than 2 subtasks', () => {
    expect(validateSubtaskIndependence([{ id: 't1', description: 'One', prompt: 'One' }])).toContain('at least 2');
  });

  it('rejects more than 10 subtasks', () => {
    const subtasks = Array.from({ length: 11 }, (_, i) => ({
      id: `t${i}`,
      description: `Task ${i}`,
      prompt: `Do task ${i}`,
    }));
    expect(validateSubtaskIndependence(subtasks)).toContain('10 subtasks');
  });

  it('rejects duplicate IDs', () => {
    const subtasks: ParallelSubtask[] = [
      { id: 't1', description: 'First', prompt: 'First' },
      { id: 't1', description: 'Duplicate', prompt: 'Duplicate' },
    ];
    expect(validateSubtaskIndependence(subtasks)).toContain('Duplicate');
  });

  it('rejects empty array', () => {
    expect(validateSubtaskIndependence([])).toContain('at least 2');
  });
});

describe('formatParallelDispatchResult', () => {
  it('formats completed tasks', () => {
    const result: ParallelDispatchResult = {
      tasks: [
        { id: 't1', description: 'Fix auth', status: 'completed', summary: 'Fixed type errors', durationMs: 5000 },
        { id: 't2', description: 'Update docs', status: 'completed', summary: 'Updated README', durationMs: 3000 },
      ],
      overallSummary: 'All tasks completed successfully',
      totalDurationMs: 5000,
    };
    const output = formatParallelDispatchResult(result);
    expect(output).toContain('2 subtasks');
    expect(output).toContain('[OK] Fix auth');
    expect(output).toContain('[OK] Update docs');
    expect(output).toContain('All tasks completed');
  });

  it('formats failed tasks', () => {
    const result: ParallelDispatchResult = {
      tasks: [
        { id: 't1', description: 'Fix auth', status: 'completed', summary: 'Done', durationMs: 5000 },
        { id: 't2', description: 'Run tests', status: 'failed', summary: 'Test timeout', durationMs: 30000 },
      ],
      overallSummary: '1 of 2 tasks failed',
      totalDurationMs: 30000,
    };
    const output = formatParallelDispatchResult(result);
    expect(output).toContain('[OK] Fix auth');
    expect(output).toContain('[FAIL] Run tests');
  });

  it('formats multi-line summary with truncation', () => {
    const longSummary = Array(10)
      .fill('This is a line of summary text')
      .join('\n');
    const result: ParallelDispatchResult = {
      tasks: [
        { id: 't1', description: 'Task 1', status: 'completed', summary: longSummary, durationMs: 1000 },
      ],
      overallSummary: 'Done',
      totalDurationMs: 1000,
    };
    const output = formatParallelDispatchResult(result);
    // Should include at most 5 lines of summary (plus indentation)
    const summaryLines = output.split('\n').filter((line) => line.startsWith('    '));
    expect(summaryLines.length).toBeLessThanOrEqual(5);
  });

  it('handles empty summary gracefully', () => {
    const result: ParallelDispatchResult = {
      tasks: [{ id: 't1', description: 'Task 1', status: 'completed', summary: '', durationMs: 1000 }],
      overallSummary: '',
      totalDurationMs: 1000,
    };
    const output = formatParallelDispatchResult(result);
    expect(output).toContain('[OK] Task 1');
    expect(output).not.toContain('undefined');
  });

  it('formats duration in seconds', () => {
    const result: ParallelDispatchResult = {
      tasks: [{ id: 't1', description: 'Task 1', status: 'completed', summary: 'Done', durationMs: 2500 }],
      overallSummary: 'Completed',
      totalDurationMs: 2500,
    };
    const output = formatParallelDispatchResult(result);
    expect(output).toContain('2.5s');
  });
});
