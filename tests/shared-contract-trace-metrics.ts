import type { KodaXStreamResult, KodaXToolUseBlock } from '../packages/llm/src/types.js';

interface ModelTraceCall {
  readonly index: number;
  readonly kind: 'root' | 'child' | 'auxiliary';
  readonly result?: Pick<KodaXStreamResult, 'toolBlocks'>;
}

/** Provider proposals, not UI-visible events or proof of execution. History
 * repeats earlier messages; count each response's tool blocks exactly once.
 * Script/bridge inner execution must be inspected separately in its receipts. */
export function collectModelToolCalls(calls: readonly ModelTraceCall[]): {
  requestIndex: number;
  kind: ModelTraceCall['kind'];
  tool: KodaXToolUseBlock;
}[] {
  return calls.flatMap(call => (call.result?.toolBlocks ?? []).map(tool => ({
    requestIndex: call.index, kind: call.kind, tool,
  })));
}
