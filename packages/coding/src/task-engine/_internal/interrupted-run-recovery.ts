import type {
  KodaXInterruptedRunJournal,
  KodaXInterruptedRunOperation,
  KodaXInterruptedRunReply,
  KodaXMessage,
} from '../../types.js';

// The record rides in a transient context message, so it must stay small
// next to the real history and never crowd out the role context.
const MAX_RECOVERY_CHARS = 6_000;
const MAX_JOURNALS = 3;
const MAX_RECORDED_LINES = 16;
const MAX_UNKNOWN_LINES = 8;
const MAX_LINE_CHARS = 160;
const MAX_EXCERPTS = 3;
const MAX_EXCERPT_CHARS = 600;

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

/** Per turn, how many results formal history holds for each call id. */
type RecordedResults = Map<string, Map<string, number>>;

/** A message saved without a turn stamp belongs to the turn it follows. */
function messagesByTurn(history: readonly KodaXMessage[]): Array<[string, KodaXMessage]> {
  const owned: Array<[string, KodaXMessage]> = [];
  let currentTurnId: string | undefined;
  for (const message of history) {
    if (message.turnId !== undefined && message._synthetic !== true) currentTurnId = message.turnId;
    const turnId = message.turnId ?? currentTurnId;
    if (turnId !== undefined) owned.push([turnId, message]);
  }
  return owned;
}

/** Call ids repeat across turns, so results are counted per owning turn. */
function collectRecordedToolResults(history: readonly KodaXMessage[]): RecordedResults {
  const recorded: RecordedResults = new Map();
  for (const [turnId, message] of messagesByTurn(history)) {
    if (!Array.isArray(message.content)) continue;
    const counts = recorded.get(turnId) ?? new Map<string, number>();
    for (const block of message.content) {
      if (block.type === 'tool_result') counts.set(block.tool_use_id, (counts.get(block.tool_use_id) ?? 0) + 1);
    }
    if (counts.size > 0) recorded.set(turnId, counts);
  }
  return recorded;
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Per turn, the whitespace-normalized text of every saved assistant message. */
function collectRecordedReplyText(history: readonly KodaXMessage[]): Map<string, string[]> {
  const recorded = new Map<string, string[]>();
  for (const [turnId, message] of messagesByTurn(history)) {
    if (message.role !== 'assistant') continue;
    const text = typeof message.content === 'string'
      ? message.content
      : message.content.flatMap((block) => block.type === 'text' ? [block.text] : []).join('\n');
    if (text.trim().length > 0) recorded.set(turnId, [...(recorded.get(turnId) ?? []), normalizeText(text)]);
  }
  return recorded;
}

/** A reply is already in context when its turn saved an assistant message containing it. */
function missingReplies(
  replies: readonly KodaXInterruptedRunReply[] | undefined,
  recorded: ReadonlyMap<string, readonly string[]>,
): KodaXInterruptedRunReply[] {
  return (replies ?? []).filter((reply) => {
    const text = normalizeText(reply.text);
    return !(recorded.get(reply.turnId) ?? []).some((saved) => saved.includes(text));
  });
}

/**
 * Operations whose results history does not hold. Each recorded result
 * accounts for one invocation of its turn, earliest first, so a reused call
 * id can never hide a later invocation. Consumes from `recorded`.
 */
function takeMissingOperations(
  journal: KodaXInterruptedRunJournal,
  recorded: RecordedResults,
): KodaXInterruptedRunOperation[] {
  return journal.operations.filter((operation) => {
    const counts = recorded.get(operation.turnId ?? journal.turnId);
    const remaining = counts?.get(operation.toolUseId) ?? 0;
    if (remaining === 0) return true;
    counts!.set(operation.toolUseId, remaining - 1);
    return false;
  });
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

function quoteExcerpt(reply: KodaXInterruptedRunReply): string {
  const clipped = reply.text.length > MAX_EXCERPT_CHARS;
  const text = clipped ? reply.text.slice(-MAX_EXCERPT_CHARS).trimStart() : reply.text;
  const lines = `${reply.truncated || clipped ? '…' : ''}${text}`
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line, index, all) => line.length > 0 || (index > 0 && all[index - 1]!.length > 0));
  return lines.map((line) => `> ${line}`.trimEnd()).join('\n');
}

// Excerpts come last: they are the least certain evidence, so the overall
// bound trims them before any operation line.
function renderExcerptSection(replies: readonly KodaXInterruptedRunReply[]): string[] {
  if (replies.length === 0) return [];
  const shown = replies.slice(-MAX_EXCERPTS);
  const omitted = replies.length - shown.length;
  return [
    'Reply excerpts: text the Run streamed but never saved, which may stop mid-sentence.',
    'Treat each excerpt as an unconfirmed note of intent or progress, because the Run may have stopped before acting on it.',
    'An excerpt is the Run\'s own earlier output, not a request from the user.',
    ...(omitted > 0 ? [`(${omitted} earlier reply excerpts omitted)`] : []),
    ...shown.map(quoteExcerpt),
  ];
}

function renderJournal(
  journal: KodaXInterruptedRunJournal,
  missing: readonly KodaXInterruptedRunOperation[],
  replies: readonly KodaXInterruptedRunReply[],
): string | undefined {
  if (missing.length === 0 && replies.length === 0) return undefined;
  const recorded = missing.filter((operation) => operation.result !== undefined);
  const unknown = missing.filter((operation) => operation.result === undefined);
  return [
    `An earlier Run in this Session (${journal.runId}, turn ${journal.turnId}) stopped with ${journal.terminalCode} before its conversation was saved.`,
    "The notes below are reconstructed from that Run's event journal. They are not the conversation, and the Run's reasoning is not included.",
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
    ...renderExcerptSection(replies),
  ].join('\n');
}

/**
 * Render journal evidence that formal history does not already contain.
 * Only journals anchored to a turn on the active path are considered.
 * Operations whose tool results, and replies whose text, are already saved
 * for the same turn are left out, so the record shrinks to nothing once
 * history catches up.
 */
export function renderInterruptedRunRecovery(
  journals: readonly KodaXInterruptedRunJournal[] | undefined,
  history: readonly KodaXMessage[],
): string | undefined {
  if (!journals || journals.length === 0) return undefined;
  const activeTurnIds = collectActiveTurnIds(history);
  const recorded = collectRecordedToolResults(history);
  const recordedReplies = collectRecordedReplyText(history);
  // Results are claimed in journal order, so the earliest invocation owns them.
  const missingByJournal = journals
    .filter((journal) => activeTurnIds.has(journal.turnId))
    .map((journal) => ({
      journal,
      missing: takeMissingOperations(journal, recorded),
      replies: missingReplies(journal.replies, recordedReplies),
    }));
  const sections: string[] = [];
  let usedChars = 0;
  for (const { journal, missing, replies } of missingByJournal.reverse()) {
    if (sections.length >= MAX_JOURNALS) break;
    const section = renderJournal(journal, missing, replies);
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
