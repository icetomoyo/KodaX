import { expect, it } from 'vitest';
import { finalAcceptanceCells } from './final-contract-multiturn.eval.js';

it('dispatches only the single new task across three families for the config acceptance scope', () => {
  const cells = finalAcceptanceCells(true);
  expect(cells).toEqual([
    { id: 'cell-01', route: 'zhipu-coding', caseId: 'config-precedence' },
    { id: 'cell-02', route: 'kimi-code', caseId: 'config-precedence' },
    { id: 'cell-03', route: 'deepseek', caseId: 'config-precedence' },
  ]);
  expect(finalAcceptanceCells(false).map(cell => cell.caseId)).toEqual([
    'output-retention', 'output-retention', 'output-retention',
    'history-child-recovery', 'history-child-recovery', 'history-child-recovery',
  ]);
});
