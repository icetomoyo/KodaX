import type { ClientSession } from '@kodax-ai/coding/client-contract';
import type { KodaXSessionRuntimeInfo } from '@kodax-ai/agent';
import type { SessionCommandBinding } from '../commands/types.js';
import type { InteractiveContext } from '../interactive/context.js';
import type { InkClientPlane } from '../ui/client-plane.js';

export async function readClientHistoryPreview(plane: InkClientPlane, id: string) {
  if (!plane.readHistory) throw new Error('Host history unavailable');
  const page = await plane.readHistory(id, { limit: 20 });
  const lines = page.items.map(item => `${item.type}: ${item.text.replace(/\s+/g, ' ').slice(0, 60)}`);
  for (const entry of page.oversized) {
    const content = await plane.readHistoryEntry?.(id, entry.itemId, { offset: 0 });
    lines.push(content ? content.text.replace(/\s+/g, ' ').slice(0, 60) + '...' : '[History entry unavailable]');
  }
  return { success: true, message: lines.length ? 'Conversation History:\n' + lines.join('\n') : '[No conversation history]' };
}

/** Display metadata only; execution workspace decisions stay in the Host. */
export function clientSessionRuntimeInfo(session: ClientSession): KodaXSessionRuntimeInfo {
  return { canonicalRepoRoot: session.gitRoot, workspaceRoot: session.workspaceRoot,
    executionCwd: session.executionCwd ?? session.workspaceRoot ?? session.gitRoot,
    branch: session.branch, workspaceKind: session.workspaceKind, surface: session.surface };
}

export async function readClientSession(binding: SessionCommandBinding, id: string) {
  if (!binding.read || !binding.getSettings) throw new Error('Host Session reads unavailable');
  const session = await binding.read(id);
  if (session.archived) throw new Error(`Session is archived: ${id}`);
  const settings = await binding.getSettings(id);
  return { session, settings };
}

/** Discard the old local presentation caches; observe/history own the new content. */
export function applyClientSessionMetadata(context: InteractiveContext, session: ClientSession): void {
  context.sessionId = session.id;
  context.title = session.title;
  context.messages = [];
  context.uiHistory = [];
  context.lineage = undefined;
  context.artifactLedger = undefined;
  context.extensionState = undefined;
  context.extensionRecords = undefined;
  context.extensionStateDirty = false;
  context.extensionRecordsDirty = false;
  context.sessionSnapshotDirty = false;
  context.contextTokenSnapshot = undefined;
  context.runtimeInfo = clientSessionRuntimeInfo(session);
  context.gitRoot = session.workspaceRoot ?? session.gitRoot;
  context.lastAccessed = new Date().toISOString();
}
