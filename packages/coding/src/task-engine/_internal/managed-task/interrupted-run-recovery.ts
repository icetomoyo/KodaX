import type {
  KodaXInterruptedRunJournal,
  KodaXInterruptedRunOperation,
  KodaXMessage,
} from '../../../types.js';

// The record rides in the transient managed run context, so it must stay
// small next to the real history and never crowd out the role context.
const MAX_RECOVERY_CHARS = 6_000;
const MAX_JOURNALS = 3;
const MAX_RECORDED_LINES = 16;
const MAX_UNKNOWN_LINES = 8;
const MAX_LINE_CHARS = 160;

function boundLine(text: string): string {
  const singleLine = text.replace(/\s+/g, ' ').trim();
  return singleLine.length <= MAX_LINE_CHARS
    ? singleLine
    : `${singleLine.slice(0, MAX_LINE_CHARS - 1)}…`;
}

function formatOperation(operation: KodaXInterruptedRunOperation): string {
  const target = operation.target ? ` ${operation.target}` : '';
  const result = operation.result ? ` → ${operation.result}` : '';
  return `- ${boundLine(`${operation.name}${target}${result}`)}`;
}

/** Turns proven to be on the active path: only real, non-synthetic messages count. */
function collectActiveTurnIds(history: readonly KodaXMessage[]): Set<string> {
  return new Set(history.flatMap((message) =>
    message.turnId !== undefined && message._synthetic !== true ? [message.turnId] : []));
}

function collectRecordedToolResultIds(history: readonly KodaXMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of history) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === 'tool_result') ids.add(block.tool_use_id);
    }
  }
  return ids;
}

function renderOperationSection(
  heading: string,
  operations: readonly KodaXInterruptedRunOperation[],
  maxLines: number,
  omittedLabel: string,
): string[] {
  if (operations.length === 0) return [];
  const shown = operations.slice(-maxLines);
  const omitted = operations.length - shown.length;
  return [
    heading,
    ...(omitted > 0 ? [`(${omitted} ${omittedLabel} omitted)`] : []),
    ...shown.map(formatOperation),
  ];
}

function renderJournal(
  journal: KodaXInterruptedRunJournal,
  recordedIds: ReadonlySet<string>,
): string | undefined {
  const missing = journal.operations.filter((operation) => !recordedIds.has(operation.toolUseId));
  if (missing.length === 0) return undefined;
  const recorded = missing.filter((operation) => operation.result !== undefined);
  const unknown = missing.filter((operation) => operation.result === undefined);
  return [
    `An earlier Run in this Session (${journal.runId}, turn ${journal.turnId}) stopped with ${journal.terminalCode} before its conversation was saved.`,
    "The list below is reconstructed from that Run's event journal; it is not the conversation, and the Run's reasoning and replies are missing.",
    ...renderOperationSection(
      'Recorded operations finished, and each line shows the start of the journaled result:',
      recorded,
      MAX_RECORDED_LINES,
      'earlier recorded operations',
    ),
    ...renderOperationSection(
      'Result unknown: these operations started, but the Run stopped before a result was journaled, so they may or may not have taken effect:',
      unknown,
      MAX_UNKNOWN_LINES,
      'earlier unknown-result operations',
    ),
    ...(unknown.length > 0
      ? ['Check the current files or processes before relying on an operation whose result is unknown, because repeating it blindly can duplicate or overwrite work.']
      : []),
  ].join('\n');
}

/**
 * Render journal evidence that formal history does not already contain.
 * Only journals anchored to a turn on the active path are considered, and
 * operations whose tool results are already recorded are left out, so the
 * record shrinks to nothing once history catches up.
 */
export function renderInterruptedRunRecovery(
  journals: readonly KodaXInterruptedRunJournal[] | undefined,
  history: readonly KodaXMessage[],
): string | undefined {
  if (!journals || journals.length === 0) return undefined;
  const activeTurnIds = collectActiveTurnIds(history);
  const recordedIds = collectRecordedToolResultIds(history);
  const sections: string[] = [];
  let usedChars = 0;
  for (const journal of [...journals].reverse()) {
    if (sections.length >= MAX_JOURNALS) break;
    if (!activeTurnIds.has(journal.turnId)) continue;
    const section = renderJournal(journal, recordedIds);
    if (section === undefined) continue;
    if (sections.length > 0 && usedChars + section.length > MAX_RECOVERY_CHARS) break;
    sections.unshift(section);
    usedChars += section.length;
  }
  if (sections.length === 0) return undefined;
  const header = '=== Interrupted Run Recovery ===\n';
  const trailer = '\n=== End Interrupted Run Recovery ===';
  const bodyLimit = MAX_RECOVERY_CHARS - header.length - trailer.length;
  const body = sections.join('\n\n');
  const bounded = body.length <= bodyLimit
    ? body
    : `${body.slice(0, bodyLimit - 1).trimEnd()}…`;
  return `${header}${bounded}${trailer}`;
}
