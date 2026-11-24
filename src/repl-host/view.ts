/**
 * A v2 Session view in the v1 shapes the REPL renders. The REPL was written
 * against v1, and v2 carries the same facts under other names, so this is the
 * inverse of `runtime-daemon/host-view.ts`. What v2 leaves out on purpose
 * (`outputId`, `sidecar`, `compactText`, `historyBoundary`) stays out.
 */
import type {
  ClientInteraction,
  ClientSession,
  ClientSessionActivity,
  ClientSessionSettings,
  ClientSessionView,
  ClientViewItem,
} from '@kodax-ai/coding/client-contract';

import type { HostCallResult } from '../host-protocol/host-client.js';
import type { LocalSessionView, LocalViewItem } from '../host-protocol/view.js';
import { NOTICE_ICONS, type NoticeKind } from '../session-view-notices.js';

type LocalSession = LocalSessionView['session'];
type LocalInteraction = LocalSessionView['interactions'][number];
type LocalSessionListItem = HostCallResult<'session.list', 'local'>['items'][number];
type ClientFileChange = NonNullable<NonNullable<ClientViewItem['tool']>['fileChange']>;

/** Where the text an item holds starts, and what it was the last time. */
interface SeenText {
  readonly start: number;
  readonly text: string;
  readonly revision: number;
}

function isoTime(milliseconds: number | undefined): string | undefined {
  return milliseconds === undefined ? undefined : new Date(milliseconds).toISOString();
}

export function toClientSession(session: LocalSession | LocalSessionListItem): ClientSession {
  const { messageCount, revision, createdAt, lastMessageAt, recovery, project: _project, ...facts } = session;
  return {
    ...facts,
    ...(messageCount !== undefined ? { msgCount: messageCount } : {}),
    ...(revision !== undefined ? { metadataRevision: revision } : {}),
    ...(createdAt !== undefined ? { createdAt: isoTime(createdAt) } : {}),
    ...(lastMessageAt !== undefined ? { lastMessageAt: isoTime(lastMessageAt) } : {}),
    ...(recovery !== undefined ? { recovery: { ...recovery, since: isoTime(recovery.since)! } as ClientSession['recovery'] } : {}),
  };
}

/** v1 named a changed file by its path on the Host; v2 gives that to a local client as `hostPath`. */
function toClientFileChange(change: { readonly path?: string; readonly hostPath: string }): ClientFileChange {
  const { path: _workspacePath, hostPath, ...facts } = change;
  return { ...facts, path: hostPath } as ClientFileChange;
}

export function toClientInteraction(interaction: LocalInteraction): ClientInteraction {
  const { id, request, createdAt, expiresAt, ...facts } = interaction;
  const diff = 'diff' in request ? request.diff : undefined;
  // The Host builds the request from the same v1 options, so only the names differ.
  return {
    ...facts,
    requestId: id,
    options: diff === undefined ? request : { ...request, diff: toClientFileChange(diff) },
    createdAt: isoTime(createdAt)!,
    ...(expiresAt !== undefined ? { expiresAt: isoTime(expiresAt) } : {}),
  } as ClientInteraction;
}

/** v2 names an item's state; v1 marked generated output as a draft until it was saved. */
function outputState(item: LocalViewItem): ClientViewItem['outputState'] {
  if (item.type !== 'assistant' && item.type !== 'thinking') return undefined;
  return item.state === 'live' ? 'draft' : 'committed';
}

export function toClientItem(item: LocalViewItem, textRevision?: number): ClientViewItem {
  const { tool } = item;
  const textOffset = item.textTotal === undefined ? undefined : item.textTotal - item.text.length;
  const state = outputState(item);
  const icon = item.notice === undefined ? undefined : NOTICE_ICONS[item.notice.kind as NoticeKind];
  return {
    id: item.id,
    type: item.type as ClientViewItem['type'],
    text: item.text,
    ...(textOffset !== undefined ? { textOffset, totalTextLength: item.textTotal } : {}),
    ...(item.at !== undefined ? { timestamp: item.at } : {}),
    ...(item.runId !== undefined ? { sourceRunId: item.runId } : {}),
    ...(item.inputIds?.[0] !== undefined ? { inputId: item.inputIds[0] } : {}),
    ...(item.inputIds !== undefined && item.inputIds.length > 1 ? { inputIds: item.inputIds } : {}),
    ...(state !== undefined ? { outputState: state } : {}),
    ...(textRevision !== undefined ? { textRevision } : {}),
    ...(icon !== undefined ? { icon } : {}),
    ...(item.attachments !== undefined ? {
      attachments: item.attachments.map(attachment => ({ ...attachment, kind: 'image' as const })),
    } : {}),
    ...(tool !== undefined ? {
      tool: {
        callId: tool.callId,
        name: tool.name,
        status: tool.status as NonNullable<ClientViewItem['tool']>['status'],
        ...(tool.inputText !== undefined ? { inputText: tool.inputText } : {}),
        ...(tool.inputTotal !== undefined ? { totalInputLength: tool.inputTotal } : {}),
        ...(tool.progress !== undefined ? { progress: tool.progress } : {}),
        ...(tool.startedAt !== undefined ? { startedAt: tool.startedAt } : {}),
        ...(tool.endedAt !== undefined ? { endedAt: tool.endedAt } : {}),
        ...(tool.change !== undefined ? { fileChange: toClientFileChange(tool.change) } : {}),
      },
    } : {}),
  };
}

/**
 * Whether an item's text was replaced rather than extended. Only the part both
 * versions hold can be compared, so a rewrite outside it goes unseen; the REPL
 * then shows the new text, as it would for an extension.
 */
function rewritten(seen: SeenText, start: number, text: string): boolean {
  const seenEnd = seen.start + seen.text.length;
  const end = start + text.length;
  if (end < seenEnd) return true;
  const from = Math.max(seen.start, start);
  const to = Math.min(seenEnd, end);
  return from < to && seen.text.slice(from - seen.start, to - seen.start) !== text.slice(from - start, to - start);
}

export interface ClientViewMapper {
  (view: LocalSessionView): ClientSessionView;
  /** The revision and state the REPL last saw an item's text at, for a read that must not mix two versions. */
  textVersion(itemId: string): Pick<ClientViewItem, 'textRevision' | 'outputState'> | undefined;
}

/**
 * One per observation. v2 does not number rewrites of an item's text, and the
 * REPL redraws an item whose `textRevision` changed, so the mapper counts the
 * rewrites it sees.
 */
export function createClientViewMapper(): ClientViewMapper {
  let seen = new Map<string, SeenText>();
  let states = new Map<string, ClientViewItem['outputState']>();
  const mapItem = (item: LocalViewItem, next: Map<string, SeenText>): ClientViewItem => {
    const start = item.textTotal === undefined ? 0 : item.textTotal - item.text.length;
    const before = seen.get(item.id);
    const revision = before === undefined ? 0 : before.revision + (rewritten(before, start, item.text) ? 1 : 0);
    next.set(item.id, { start, text: item.text, revision });
    return toClientItem(item, revision);
  };
  const map = ((view: LocalSessionView): ClientSessionView => {
    const next = new Map<string, SeenText>();
    const items = view.items.map(item => mapItem(item, next));
    seen = next;
    states = new Map(items.map(item => [item.id, item.outputState]));
    return {
      session: toClientSession(view.session),
      items,
      runs: view.runs.map(({ id, ...run }) => ({ ...run, runId: id })),
      queue: view.queue.map(({ id, admissionError, ...input }) => ({
        ...input, inputId: id,
        ...(admissionError !== undefined ? { admissionError: admissionError as NonNullable<ClientSessionView['queue'][number]['admissionError']> } : {}),
      })),
      interactions: view.interactions.map(toClientInteraction),
      // The Host fills these from the same v1 values, with the open strings v2 sends for display.
      settings: view.settings as ClientSessionSettings,
      ...(view.activity !== undefined ? { activity: view.activity as ClientSessionActivity } : {}),
      ...(view.contextBudget !== undefined ? { contextBudget: view.contextBudget as ClientSessionView['contextBudget'] } : {}),
      ...(view.parentContextTokens !== undefined ? { parentContextTokens: view.parentContextTokens } : {}),
      ...(view.sandbox !== undefined ? { sandbox: view.sandbox as ClientSessionView['sandbox'] } : {}),
    };
  }) as ClientViewMapper;
  map.textVersion = (itemId) => {
    const text = seen.get(itemId);
    return text === undefined ? undefined : { textRevision: text.revision, outputState: states.get(itemId) };
  };
  return map;
}
