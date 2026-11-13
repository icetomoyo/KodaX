/**
 * FEATURE_306 — bounded raw evidence from one session, for the reflection job.
 *
 * Every segment carries a provenance the HOST assigns (never the model):
 *   user      what the user typed; the only source that can state a preference
 *   local     output of a tool that reads or changes this machine (read, bash, ...);
 *             a shell command that fetches from the network counts as external
 *   external  anything else (web, MCP, unknown tools); shown to the model as
 *             untrusted data and never accepted as proof for a note
 *   assistant what the agent said; context only, never proof
 */
import type { KodaXContentBlock, KodaXMessage } from '@kodax-ai/llm';

import { normalizeQuote, quoteWeight } from './quote.js';

export type EvidenceSource = 'user' | 'local' | 'external' | 'assistant';

export interface EvidenceSegment {
  readonly source: EvidenceSource;
  readonly label: string;
  /** Tool name for tool results. */
  readonly tool?: string;
  readonly text: string;
  readonly isError: boolean;
}

export interface SessionEvidence {
  readonly segments: readonly EvidenceSegment[];
  /** User segments joined so that no quote can span two messages. */
  readonly userText: string;
  readonly omitted: number;
}

/**
 * The KodaX coding tools whose output is this machine's own. A host with other
 * tool names gets every result classified external, which only makes evidence
 * weaker (an external result can never prove a note), so these names stay here
 * until a second tool set needs them passed in.
 */
const LOCAL_TOOLS: ReadonlySet<string> = new Set([
  'bash', 'read', 'grep', 'glob', 'edit', 'multi_edit', 'write', 'undo', 'code_search',
  'changed_diff', 'changed_diff_bundle', 'changed_scope', 'repo_overview',
]);

const USER_MESSAGE_CHARS = 4000;
const TOOL_HEAD_CHARS = 1200;
const TOOL_TAIL_CHARS = 600;
const ASSISTANT_CHARS = 400;
export const EVIDENCE_BUDGET_CHARS = 60_000;
const SEGMENT_SEPARATOR = '\n\u0000\n';

/** Shell commands whose output is someone else's text: downloads, URLs, GitHub issues and PRs. */
const FETCHES_NETWORK = /\b(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod|gh)\b|[a-z][a-z0-9+.-]*:\/\//i;

export function toolSource(toolName: string, command = ''): EvidenceSource {
  if (toolName === 'bash' && FETCHES_NETWORK.test(command)) return 'external';
  return LOCAL_TOOLS.has(toolName) || toolName.startsWith('lsp_') ? 'local' : 'external';
}

function clip(text: string, head: number, tail: number): string {
  return text.length <= head + tail ? text : `${text.slice(0, head)}\n[... ${text.length - head - tail} characters omitted ...]\n${text.slice(-tail)}`;
}

function textOf(content: string | readonly KodaXContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .filter((part) => part.length > 0)
    .join('\n');
}

function resultText(block: Extract<KodaXContentBlock, { type: 'tool_result' }>): string {
  return typeof block.content === 'string'
    ? block.content
    : block.content.map((item) => (item.type === 'text' ? item.text : '[image]')).join('\n');
}

function commandOf(input: Record<string, unknown>): string {
  const value = input.command ?? input.path ?? input.file_path ?? input.pattern ?? input.url ?? input.query;
  return typeof value === 'string' ? value : '';
}

export function collectSegments(messages: readonly KodaXMessage[]): EvidenceSegment[] {
  const calls = new Map<string, { name: string; arg: string }>();
  const segments: EvidenceSegment[] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'user' && typeof message.content === 'string') {
      if (message._synthetic !== true) segments.push({ source: 'user', label: 'user', text: message.content.slice(0, USER_MESSAGE_CHARS), isError: false });
      continue;
    }
    const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content } as KodaXContentBlock] : message.content;
    for (const block of blocks) {
      if (block.type === 'text' && block.text.trim().length > 0) {
        if (message.role === 'user') {
          if (message._synthetic !== true) segments.push({ source: 'user', label: 'user', text: block.text.slice(0, USER_MESSAGE_CHARS), isError: false });
        } else {
          segments.push({ source: 'assistant', label: 'assistant', text: block.text.slice(0, ASSISTANT_CHARS), isError: false });
        }
      } else if (block.type === 'tool_use') {
        calls.set(block.id, { name: block.name, arg: commandOf(block.input) });
      } else if (block.type === 'tool_result') {
        const call = calls.get(block.tool_use_id) ?? { name: 'unknown', arg: '' };
        segments.push({
          source: toolSource(call.name, call.arg),
          label: `${call.name}${call.arg.length > 0 ? `: ${call.arg.slice(0, 200)}` : ''}`,
          tool: call.name,
          text: clip(resultText(block), TOOL_HEAD_CHARS, TOOL_TAIL_CHARS),
          isError: block.is_error === true,
        });
      }
    }
  }
  return segments;
}

/**
 * User segments first, newest first, up to two thirds of the budget (a very long
 * session must not turn into an unbounded request); error results next; then the
 * rest, newest first, until the budget is spent.
 */
export function buildEvidence(messages: readonly KodaXMessage[], budgetChars: number = EVIDENCE_BUDGET_CHARS): SessionEvidence {
  const all = collectSegments(messages);
  const keep = new Set<number>();
  let spent = 0;
  const take = (index: number, limit: number): void => {
    const size = all[index]!.text.length + all[index]!.label.length;
    if (keep.has(index) || spent + size > limit) return;
    keep.add(index);
    spent += size;
  };
  const userLimit = Math.floor((budgetChars * 2) / 3);
  for (let index = all.length - 1; index >= 0; index -= 1) if (all[index]!.source === 'user') take(index, userLimit);
  all.forEach((segment, index) => { if (segment.isError) take(index, budgetChars); });
  for (let index = all.length - 1; index >= 0; index -= 1) if (all[index]!.source !== 'user') take(index, budgetChars);
  const segments = all.filter((_, index) => keep.has(index));
  return {
    segments,
    userText: segments.filter((segment) => segment.source === 'user').map((segment) => segment.text).join(SEGMENT_SEPARATOR),
    omitted: all.length - segments.length,
  };
}

/**
 * The reflection job quotes a transcript, not a live user, so the quote must say
 * something: two common words appear in almost every session and would prove any note.
 */
const MIN_PROOF_WEIGHT = 10;

/** True when `quote` appears verbatim (whitespace-insensitive) in a segment whose source is in `allowed`. */
export function quoteInEvidence(evidence: SessionEvidence, quote: string, allowed: readonly EvidenceSource[]): boolean {
  const wanted = normalizeQuote(quote);
  return quoteWeight(wanted) >= MIN_PROOF_WEIGHT
    && evidence.segments.some((segment) => allowed.includes(segment.source) && normalizeQuote(segment.text).includes(wanted));
}

const COPY_WINDOW_CHARS = 40;

/**
 * True when `text` repeats a run of at least 40 characters from external content
 * that no user message or local tool output also contains. A note that copies a
 * web page verbatim (even as a warning) would carry that page into every future session.
 */
export function copiesExternalText(evidence: SessionEvidence, text: string): boolean {
  const flat = (value: string): string => normalizeQuote(value).toLowerCase();
  const external = evidence.segments.filter((segment) => segment.source === 'external').map((segment) => flat(segment.text));
  if (external.length === 0) return false;
  const trusted = evidence.segments.filter((segment) => segment.source === 'user' || segment.source === 'local').map((segment) => flat(segment.text));
  const chars = Array.from(flat(text));
  for (let start = 0; start + COPY_WINDOW_CHARS <= chars.length; start += 1) {
    const window = chars.slice(start, start + COPY_WINDOW_CHARS).join('');
    if (external.some((segment) => segment.includes(window)) && !trusted.some((segment) => segment.includes(window))) return true;
  }
  return false;
}

/** Text for the reflection prompt; external content is fenced and labelled untrusted. */
export function renderEvidence(evidence: SessionEvidence): string {
  const blocks = evidence.segments.map((segment) => {
    if (segment.source === 'external') {
      return `<external-content tool="${segment.label}" trust="untrusted">\n${segment.text}\n</external-content>`;
    }
    const tag = segment.source === 'local' ? `tool ${segment.label}${segment.isError ? ' (error)' : ''}` : segment.label;
    return `[${tag}]\n${segment.text}`;
  });
  if (evidence.omitted > 0) blocks.push(`[${evidence.omitted} lower-priority segments omitted]`);
  return blocks.join('\n\n');
}
