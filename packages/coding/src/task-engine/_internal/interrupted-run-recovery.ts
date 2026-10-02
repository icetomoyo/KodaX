import type {
  KodaXInterruptedRunEvidence,
  KodaXInterruptedRunOperation,
  KodaXInterruptedRunReply,
  KodaXMessage,
} from '../../types.js';

// The record rides in a transient context message, so it must stay small
// next to the real history and never crowd out the role context.
const MAX_RECOVERY_CHARS = 6_000;
const MAX_RUNS = 3;
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

function collectOutputToolResults(history: readonly KodaXMessage[]): RecordedResults {
  const recorded: RecordedResults = new Map();
  let outputId: string | undefined;
  for (const message of history) {
    if (message.role === 'assistant') outputId = message.outputId;
    if (!outputId || !Array.isArray(message.content)) continue;
    const counts = recorded.get(outputId) ?? new Map<string, number>();
    for (const block of message.content) {
      if (block.type === 'tool_result') counts.set(block.tool_use_id, (counts.get(block.tool_use_id) ?? 0) + 1);
    }
    if (counts.size) recorded.set(outputId, counts);
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
  committedOutputs: ReadonlySet<string>,
): KodaXInterruptedRunReply[] {
  return (replies ?? []).filter((reply) => {
    if (reply.outputId) return !committedOutputs.has(reply.outputId);
    if (!reply.turnId) return true;
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
  run: KodaXInterruptedRunEvidence,
  recorded: RecordedResults,
  recordedOutputs: RecordedResults,
): KodaXInterruptedRunOperation[] {
  return run.operations.filter((operation) => {
    const turnId = operation.turnId ?? run.turnId;
    const counts = operation.assistantOutputId ? recordedOutputs.get(operation.assistantOutputId)
      : turnId ? recorded.get(turnId) : undefined;
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

/** Shows the newest `shownCount` replies; the budget pass decides the count. */
function renderExcerptSection(replies: readonly KodaXInterruptedRunReply[], shownCount: number): string[] {
  if (shownCount === 0) return [];
  const shown = replies.slice(-shownCount);
  const omitted = replies.length - shown.length;
  return [
    'Reply excerpts: text the Run streamed but never saved, which may stop mid-sentence.',
    'Treat each excerpt as an unconfirmed note of intent or progress, because the Run may have stopped before acting on it.',
    'An excerpt is the Run\'s own earlier output, not a request from the user.',
    ...(omitted > 0 ? [`(${omitted} earlier reply excerpts omitted)`] : []),
    ...shown.map(quoteExcerpt),
  ];
}

interface RunEvidence {
  run: KodaXInterruptedRunEvidence;
  missing: KodaXInterruptedRunOperation[];
  replies: KodaXInterruptedRunReply[];
}

/** One Run chosen for the record, with how many of its newest excerpts fit. */
interface RunPlan {
  evidence: RunEvidence;
  excerptCount: number;
}

function renderRun({ evidence, excerptCount }: RunPlan): string {
  const { run, missing, replies } = evidence;
  const recorded = missing.filter((operation) => operation.result !== undefined);
  const unknown = missing.filter((operation) => operation.result === undefined);
  return [
    `An earlier Run in this Session (${run.runId}, ${run.turnId ? `turn ${run.turnId}` : `input ${run.inputId}`}) stopped with ${run.terminalCode} before its conversation was saved.`,
    "The notes below are reconstructed from that Run's saved Host checkpoint. They are not the conversation, and the Run's reasoning is not included.",
    ...renderOperationSection(
      'Recorded operations finished, and each line shows the start of the recorded result:',
      recorded,
      MAX_RECORDED_LINES,
      'earlier recorded operations',
    ),
    ...renderOperationSection(
      'Result unknown: these operations started, but the Run stopped before a result was recorded, so they may or may not have taken effect:',
      unknown,
      MAX_UNKNOWN_LINES,
      'earlier unknown-result operations',
    ),
    ...(unknown.length > 0
      ? ['Check the current files or processes before relying on an operation whose result is unknown, because repeating it blindly can duplicate or overwrite work.']
      : []),
    ...renderExcerptSection(replies, excerptCount),
  ].join('\n');
}

const RECORD_HEADER = '=== Interrupted Run Recovery ===\n';
const RECORD_TRAILER = '\n=== End Interrupted Run Recovery ===';
const BODY_LIMIT = MAX_RECOVERY_CHARS - RECORD_HEADER.length - RECORD_TRAILER.length;

/** Plans stay in saved operation order, so the record reads oldest Run first. */
function renderBody(plans: ReadonlyMap<number, RunPlan>): string {
  return [...plans.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, plan]) => renderRun(plan))
    .join('\n\n');
}

function fits(plans: ReadonlyMap<number, RunPlan>): boolean {
  return renderBody(plans).length <= BODY_LIMIT;
}

/**
 * Operations are the firmer evidence, so every Run's operations claim the
 * budget, newest Run first, before any Run's reply excerpts. Excerpts then
 * fill what is left, newest first, and never displace an operation.
 */
function planRecovery(evidence: readonly RunEvidence[]): Map<number, RunPlan> {
  const plans = new Map<number, RunPlan>();
  const newestFirst = evidence.map((item, index) => ({ item, index })).reverse();
  for (const { item, index } of newestFirst) {
    if (plans.size >= MAX_RUNS || item.missing.length === 0) continue;
    plans.set(index, { evidence: item, excerptCount: 0 });
    if (plans.size > 1 && !fits(plans)) plans.delete(index);
  }
  for (const { item, index } of newestFirst) {
    const existing = plans.get(index);
    if (existing === undefined && plans.size >= MAX_RUNS) continue;
    const maxCount = Math.min(item.replies.length, MAX_EXCERPTS);
    let fitted = 0;
    for (let count = 1; count <= maxCount; count += 1) {
      plans.set(index, { evidence: item, excerptCount: count });
      if (!fits(plans)) break;
      fitted = count;
    }
    if (fitted > 0) plans.set(index, { evidence: item, excerptCount: fitted });
    else if (existing !== undefined) plans.set(index, existing);
    else plans.delete(index);
  }
  return plans;
}

/**
 * Render saved Host evidence that formal history does not already contain.
 * Only runs anchored to a turn on the active path are considered.
 * Operations whose tool results, and replies whose text, are already saved
 * for the same turn are left out, so the record shrinks to nothing once
 * history catches up.
 */
export function renderInterruptedRunRecovery(
  runs: readonly KodaXInterruptedRunEvidence[] | undefined,
  history: readonly KodaXMessage[],
): string | undefined {
  if (!runs || runs.length === 0) return undefined;
  const activeTurnIds = collectActiveTurnIds(history);
  const activeInputIds = new Set(history.flatMap(message => message._synthetic !== true && message.inputId ? [message.inputId] : []));
  const committedOutputs = new Set(history.flatMap(message => message.outputId ? [message.outputId] : []));
  const recorded = collectRecordedToolResults(history);
  const recordedOutputs = collectOutputToolResults(history);
  const recordedReplies = collectRecordedReplyText(history);
  // Results are claimed in run order, so the earliest invocation owns them.
  const evidence: RunEvidence[] = runs
    .filter((run) => run.inputId ? activeInputIds.has(run.inputId) : run.turnId !== undefined && activeTurnIds.has(run.turnId))
    .map((run) => ({
      run,
      missing: takeMissingOperations(run, recorded, recordedOutputs),
      replies: missingReplies(run.replies, recordedReplies, committedOutputs),
    }));
  const plans = planRecovery(evidence);
  if (plans.size === 0) return undefined;
  const body = renderBody(plans);
  // Only a single Run whose operations alone overflow reaches this cut.
  const bounded = body.length <= BODY_LIMIT
    ? body
    : `${body.slice(0, BODY_LIMIT - 1).trimEnd()}…`;
  return `${RECORD_HEADER}${bounded}${RECORD_TRAILER}`;
}
