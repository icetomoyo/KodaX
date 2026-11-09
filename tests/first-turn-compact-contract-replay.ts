/** Frozen-cell and registered-receipt helpers kept from the retired compact-contract eval. */
import type { KodaXMessage, KodaXStreamResult } from '../packages/llm/src/types.js';
import { inputHash } from './first-turn-eval-support.js';
import { controlledActionKind } from './first-turn-compact-contract-cases.js';
import type { prepareContractFixture } from './first-turn-compact-contract-fixture.js';

type ContractFixture = Awaited<ReturnType<typeof prepareContractFixture>>;

export interface ContinuationState {
  caseId: string;
  completed?: boolean;
  read?: boolean;
  edited?: boolean;
}

export function assertFrozenCell(frozen: unknown, current: unknown): void {
  if (inputHash(frozen) !== inputHash(current)) throw new Error('Frozen cell changed before dispatch');
}

export const emptyResponse = (row: { text: string; toolCalls: readonly unknown[] }): boolean => !row.text.trim() && row.toolCalls.length === 0;

/** Only preregistered paths receive frozen real handler receipts; no invocation or argument rewrite. */
export function continuation(cell: ContinuationState, calls: KodaXStreamResult['toolBlocks'], fixture: ContractFixture): KodaXMessage {
  const content = calls.map(call => {
    const kind = controlledActionKind(cell.caseId, call);
    let result: string;
    if (kind === 'todo-complete') { cell.completed = true; result = fixture.receipts.complete; }
    else if (kind === 'todo-list') result = (cell.completed ? fixture.receipts.listAfter : fixture.receipts.listBefore)[call.input.id ? 'item' : 'all'];
    else if (kind === 'read' && !cell.edited) { cell.read = true; result = fixture.receipts.read; }
    else if (kind === 'edit' && cell.read && !cell.edited) { cell.edited = true; result = fixture.receipts.edit; }
    else if (kind === 'test' && cell.edited) result = fixture.receipts.test;
    else throw new Error(`Unregistered continuation: ${call.name}; preserved for task-validity review`);
    return { type: 'tool_result' as const, tool_use_id: call.id, content: result };
  });
  return { role: 'user', content };
}
