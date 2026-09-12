import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { KodaXTrustedTextToolCall } from '@kodax-ai/coding';

const TEXT_TARGET_TOOLS = new Set(['write', 'edit', 'multi_edit', 'insert_after_anchor']);
interface ApprovedTextCall {
  readonly call: KodaXTrustedTextToolCall;
  readonly target: string;
  phase: 'snapshot' | 'commit';
}

/** Per-Run receipts: one approved call can snapshot and commit exactly its target once. */
export function createTrustedTextApprovals(executionCwd: string, isAuto: () => boolean) {
  const approvals = new Map<string, ApprovedTextCall>();
  const normalize = (target: string) => {
    const resolved = path.resolve(executionCwd, target);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return {
    grant(call: KodaXTrustedTextToolCall) {
      if (!isAuto() || !TEXT_TARGET_TOOLS.has(call.name) || typeof call.input.path !== 'string') return;
      approvals.set(call.id, { call: structuredClone(call), target: normalize(call.input.path), phase: 'snapshot' });
    },
    authorize(call: KodaXTrustedTextToolCall | undefined, target: string, phase: 'snapshot' | 'commit'): boolean {
      if (!isAuto()) { approvals.clear(); return false; }
      const approval = call === undefined ? undefined : approvals.get(call.id);
      if (!approval || approval.phase !== phase || normalize(target) !== approval.target
        || !isDeepStrictEqual(call, approval.call)) return false;
      if (phase === 'snapshot') approval.phase = 'commit';
      else approvals.delete(approval.call.id);
      return true;
    },
    revoke(id: string) { approvals.delete(id); },
    clear() { approvals.clear(); },
  };
}
