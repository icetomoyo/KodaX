import type { KodaXSessionData } from '@kodax-ai/agent';
import { getSessionLineagePath } from '@kodax-ai/agent';
import type { KodaXInterruptedRunEvidence, KodaXInterruptedRunOperation } from '@kodax-ai/coding';

export interface InterruptedRunCandidate {
  readonly runId: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly productInput?: { readonly inputId: string };
  readonly sessionOrder?: number;
  readonly terminal?: { readonly kind: string; readonly code: string };
}

export function selectInterruptedRunCandidates<T extends InterruptedRunCandidate>(
  runs: Iterable<T>, current: { readonly runId: string; readonly sessionId: string },
): Array<T & { readonly terminal: NonNullable<T['terminal']> }> {
  return [...runs].filter((run): run is T & { readonly terminal: NonNullable<T['terminal']> } =>
    run.sessionId === current.sessionId && run.runId !== current.runId
    && run.terminal !== undefined && run.terminal.kind !== 'completed')
    .sort((left, right) => (left.sessionOrder ?? 0) - (right.sessionOrder ?? 0)).slice(-5);
}

function bound(text: string): string {
  const line = text.trim().split('\n', 1)[0]?.trim() ?? '';
  return line.length <= 120 ? line : `${line.slice(0, 119)}…`;
}

function target(preview: string | undefined): string | undefined {
  if (!preview) return undefined;
  try {
    const input: unknown = JSON.parse(preview);
    if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
      const fields = input as Record<string, unknown>;
      for (const key of ['path', 'file_path', 'command', 'url', 'query', 'pattern']) {
        if (typeof fields[key] === 'string') return bound(fields[key]);
      }
    }
  } catch {
    // Legacy previews are display strings rather than serialized tool inputs.
  }
  return bound(preview);
}

/** Read only saved Session facts. Telemetry and Stop receipts cannot prove tool effects. */
export function deriveInterruptedRunEvidence(
  data: KodaXSessionData, run: InterruptedRunCandidate & { readonly terminal: NonNullable<InterruptedRunCandidate['terminal']> },
): KodaXInterruptedRunEvidence | undefined {
  const messages = data.lineage ? getSessionLineagePath(data.lineage).flatMap(entry =>
    entry.type === 'message' ? [entry.message] : []) : data.messages;
  const inputId = run.productInput?.inputId;
  const active = inputId ? messages.some(message => message._synthetic !== true && message.inputId === inputId)
    : run.turnId !== undefined && messages.some(message => message._synthetic !== true && message.turnId === run.turnId);
  if (!active) return undefined;
  const committed = new Set(messages.flatMap(message => message.outputId ? [message.outputId] : []));
  const operations: KodaXInterruptedRunOperation[] = [];
  const replies: NonNullable<KodaXInterruptedRunEvidence['replies']>[number][] = [];
  for (const item of data.uiHistory ?? []) {
    if (item.sourceRunId !== run.runId) continue;
    if (item.afterInputId && !messages.some(message => message.inputId === item.afterInputId && message._synthetic !== true)) continue;
    const turnId = item.sourceTurnId ?? run.turnId;
    if (item.type === 'tool_group') {
      for (const tool of item.tools) {
        if (!tool.executionBegan && !tool.resultRecorded) continue;
        operations.push({ toolUseId: tool.id, turnId, assistantOutputId: tool.assistantOutputId, name: tool.name, target: target(tool.preview),
          ...(tool.resultRecorded ? { result: bound(tool.output ?? tool.error ?? '') || '(empty result)' } : {}) });
      }
    } else if (item.type === 'assistant' && item.outputId && !committed.has(item.outputId) && item.text.trim()) {
      const text = item.text.trim();
      replies.push({ turnId, outputId: item.outputId, text: text.slice(-1_200), truncated: text.length > 1_200 });
    }
  }
  if (!operations.length && !replies.length) return undefined;
  return { runId: run.runId, inputId, turnId: run.turnId, terminalCode: run.terminal.code, operations, replies: replies.slice(-6) };
}
