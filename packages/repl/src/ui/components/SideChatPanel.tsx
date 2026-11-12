import React, { useEffect, useMemo, useRef, useState } from 'react';
import { randomUUID } from 'node:crypto';
import type { ClientSession, ClientSessionView, ClientViewItem } from '@kodax-ai/coding/client-contract';
import { Box, Text, useTerminalSize } from '../tui.js';
import { clientViewToHistoryItems, firstActiveRunId, type InkClientPlane } from '../client-plane.js';
import { getTheme } from '../themes/index.js';
import { buildHistoryItemTranscriptSections, type TranscriptRow } from '../utils/transcript-layout.js';
import { TranscriptRowRenderer } from './MessageList.js';
import { useKeypress } from '../contexts/KeypressContext.js';
import { KeypressHandlerPriority } from '../types.js';
import { InputPrompt } from './InputPrompt.js';

export function sideCommand(text: string): { question: string; end: boolean } | undefined {
  const match = /^\/(?:side|btw)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return undefined;
  const question = match[1] ?? '';
  return { question, end: question.trim().toLowerCase() === 'end' };
}

export function sidePermissionAnswer(text: string): 'allow' | 'deny' | undefined {
  const answer = text.trim();
  return answer === '/allow' ? 'allow' : answer === '/deny' ? 'deny' : undefined;
}

const VISIBLE_SIDE_ITEMS = 16;
const SIDE_ITEM_MAX_LINES = 200;
/** Header, notices, status, error and the input box around the conversation rows. */
const SIDE_CHROME_ROWS = 10;

function firstSideInput(items: readonly ClientViewItem[]): number {
  return items.findIndex(i => i.type === 'user' && i.inputId);
}

/** Inherited parent history stays out of view; the panel starts at the first side user input. */
export function visibleSideItems(items: readonly ClientViewItem[]): readonly ClientViewItem[] {
  const start = firstSideInput(items);
  return start < 0 ? [] : items.slice(start).slice(-VISIBLE_SIDE_ITEMS);
}

/** The send_to_parent call is redundant once its delivery receipt is on screen. */
export function tidySideItems(items: readonly ClientViewItem[]): readonly ClientViewItem[] {
  // A receipt id is 'side-report:' + JSON.stringify([runId, toolCallId]).
  const receipts = items.filter(i => i.id.startsWith('side-report:')).map(i => i.id);
  return items.filter(i => !(i.type === 'tool' && i.tool?.name === 'send_to_parent' &&
    receipts.some(id => id.endsWith(',' + JSON.stringify(i.tool?.callId) + ']'))));
}

/** Rows rendered by the main transcript's row model, limited to the newest `maxRows`. */
export function sideTranscriptRows(items: readonly ClientViewItem[],
  options: { width: number; maxRows: number; activeRunId?: string }): TranscriptRow[] {
  const history = clientViewToHistoryItems(visibleSideItems(tidySideItems(items)),
    options.activeRunId ? { activeRunId: options.activeRunId } : {});
  return buildHistoryItemTranscriptSections(history, options.width, SIDE_ITEM_MAX_LINES)
    .flatMap(section => section.rows).slice(-options.maxRows);
}

/** Items copied from the parent before the side chat's own conversation begins. */
export function inheritedItemCount(items: readonly ClientViewItem[]): number {
  const start = firstSideInput(items);
  return start < 0 ? items.length : start;
}

/** Reports the side chat sent that the parent has not read yet. */
export function undeliveredSideReports(items: readonly ClientViewItem[]): number {
  return items.filter(i => i.id.startsWith('side-report:') && i.text.startsWith('To parent (') &&
    !i.text.startsWith('To parent (delivered')).length;
}

/** Changes whenever the side conversation grows, including text streaming into an existing item. */
export function sideSignature(view: ClientSessionView): string {
  return view.items.length + ':' + view.items.reduce((total, item) => total + item.text.length, 0);
}

/** Parent-footer status for a side chat that is not on screen; never part of the parent transcript. */
export function sideMarker(view: ClientSessionView | undefined, seen: string): string | undefined {
  if (!view) return undefined;
  if (view.interactions.some(i => i.kind === 'permission')) return 'Side chat: needs approval · /side';
  if (firstActiveRunId(view.runs)) return 'Side chat: running · /side';
  const start = firstSideInput(view.items);
  const replied = start >= 0 && view.items.slice(start).some(i => i.type === 'assistant');
  return replied && sideSignature(view) !== seen ? 'Side chat: new reply · /side' : undefined;
}

export function SideChatPanel({ plane, session, parentNeedsInput, draft, saveDraft, close, end }: {
  plane: InkClientPlane; session: ClientSession; parentNeedsInput: boolean;
  draft: string; saveDraft(value: string): void; close(): void;
  /** Ends the side chat; resolves with a reason when it is still open. */
  end(): Promise<string | undefined>;
}) {
  const [view, setView] = useState<ClientSessionView>();
  const [error, setError] = useState('');
  const [editor, resetEditor] = useState(0);
  const submitting = useRef(false);
  // The editor restarts from this value; the parent's draft prop is only read when the panel opens.
  const editorStart = useRef(draft);
  const ready = view !== undefined;
  const active = firstActiveRunId(view?.runs ?? []);
  const permission = view?.interactions.find(i => i.kind === 'permission');
  useEffect(() => {
    let mounted = true;
    let unsubscribe: (() => void) | undefined;
    void plane.observe(session.id, next => { if (mounted) setView(next); })
      .then(done => { if (mounted) unsubscribe = done; else done(); },
        reason => { if (mounted) setError(String(reason)); });
    return () => { mounted = false; unsubscribe?.(); };
  }, [plane, session.id]);
  const { columns, rows: terminalRows } = useTerminalSize();
  const theme = useMemo(() => getTheme('dark'), []);
  const lines = useMemo(() => sideTranscriptRows(view?.items ?? [], { width: columns,
    maxRows: Math.max(5, terminalRows - SIDE_CHROME_ROWS), ...(active ? { activeRunId: active } : {}) }),
  [view, columns, terminalRows, active]);
  useKeypress(KeypressHandlerPriority.Critical, key => {
    if (key.name !== 'escape') return false;
    if (active) void plane.stop(active).catch(reason => setError(String(reason)));
    else close();
    return true;
  }, [active, close, plane]);
  const submit = async (text: string) => {
    const command = sideCommand(text);
    if (command) {
      if (command.end) { setError(await end() ?? ''); return; }
      if (command.question) { setError('Return to the parent with /side before opening another side chat.'); return; }
      saveDraft(''); close(); return;
    }
    if (!text.trim() || submitting.current || !ready) return;
    const answer = sidePermissionAnswer(text);
    if (permission && !answer) {
      setError('Answer the side tool request with /allow or /deny.'); return;
    }
    submitting.current = true;
    try {
      if (permission) {
        const accepted = await plane.respondInteraction(permission.requestId, { kind: 'permission',
          decision: answer === 'allow' ? { type: 'allow_once' } : { type: 'reject' } });
        if (!accepted) throw new Error('This request has already been resolved.');
      } else {
        await plane.submit({ sessionId: session.id, inputId: randomUUID(), text,
          delivery: active ? 'after_turn' : 'immediate' });
      }
      editorStart.current = ''; saveDraft(''); setError(''); resetEditor(n => n + 1);
    } catch (reason) { editorStart.current = text; saveDraft(text); setError(String(reason)); resetEditor(n => n + 1); }
    finally { submitting.current = false; }
  };
  return <Box flexDirection="column">
    <Text bold>Side chat · {session.sideChat?.parentSessionId} · /side to return</Text>
    <Text dimColor>{session.sideChat?.boundary
      ? 'Inherits ' + inheritedItemCount(view?.items ?? []) + ' parent items as reference · /side end discards this chat'
      : 'No committed parent history · /side end discards this chat'}</Text>
    {parentNeedsInput && <Text color="yellow">The parent needs your attention. Return with /side to respond.</Text>}
    {lines.map(row => <TranscriptRowRenderer key={row.key} row={row} theme={theme} />)}
    {permission && <>
      <Text color="yellow" wrap="truncate">Approve {permission.options.toolName} {permission.options.inputPreview}</Text>
      <Text color="yellow">/allow once or /deny</Text>
    </>}
    {active && <Text dimColor>Side agent running · Esc to stop{
      visibleSideItems(view?.items ?? []).some(i => i.type === 'assistant') ? '' : ' · the first answer reads the parent history and is slower'}</Text>}
    {error && <Text color="red">{error}</Text>}
    <InputPrompt key={editor} sessionId={session.id} initialValue={editorStart.current} prompt="side ›"
      autocompleteEnabled={false} onInputChange={saveDraft} onSubmit={payload => { void submit(payload.fullText); }} />
  </Box>;
}
