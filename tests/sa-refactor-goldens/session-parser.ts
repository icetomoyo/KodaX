/**
 * SA Refactor Goldens — Session Log Parser
 *
 * Companion: `tests/sa-refactor-goldens/record.ts`
 *
 * KodaX has two on-disk session formats in user `.kodax/sessions/`:
 *
 *   1. Legacy flat format (typical filename: `YYYYMMDD_HHMMSS.jsonl`)
 *      Line 1: `{"_type":"meta", title, id, gitRoot, createdAt}`
 *      Line N: `{role, content}` (KodaXMessage shape, possibly with _synthetic)
 *
 *   2. Lineage tree format (typical filename: `runner-<epochMs>.jsonl`,
 *      introduced with FEATURE_072 session-lineage)
 *      Line 1: meta line with extra `lineageVersion`/`activeEntryId`/etc.
 *      Line N: `{"_type":"lineage_entry", entry: {type:"message", id,
 *                parentId, timestamp, message: {role, content}}}`
 *      Forms a parented tree; the chronological "active path" is the chain
 *      from the entry whose `id === meta.activeEntryId` back to the root.
 *
 * For golden-trace selection purposes we need a shape that is easy to
 * classify (turn count, image presence, rate-limit retry signal, error
 * terminal, etc.) — not the full provenance of the lineage tree. So we
 * collapse both formats into a unified `RawSession` with a chronological
 * `messages` array.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { KodaXMessage } from '@kodax/ai';

export interface RawSession {
  /** Stable session id (from meta.id, falling back to filename stem). */
  sessionId: string;
  /** Absolute path to the source jsonl. */
  filePath: string;
  /** Original meta line (raw — useful for inspection, do not depend on shape). */
  meta: Record<string, unknown>;
  /** Chronological messages — collapsed across both formats. */
  messages: KodaXMessage[];
  /** Quick-classify metadata derived during parse. */
  metadata: {
    /** First user-message text — drives task-family classification. */
    initialPromptText: string;
    /** Total user/assistant turn pairs (rough — counts user-role messages). */
    turnCount: number;
    /** True if any message has a structured content block of type "image". */
    hasImageBlock: boolean;
    /** True if any tool_result block has `is_error: true`. */
    hasToolError: boolean;
    /** True if a synthesized recovery user-message was injected (CAP-015 evidence). */
    hasEditRecoveryMessage: boolean;
    /**
     * True if the session log ends with assistant-followed-by-user where
     * the user message has _synthetic=true (extension queue drain — CAP-020
     * evidence) — best-effort heuristic.
     */
    hasSyntheticTail: boolean;
    /** Format detected. */
    format: 'legacy-flat' | 'lineage-tree' | 'unknown';
  };
}

/** Parse a single jsonl session file from disk. */
export async function parseSessionFile(filePath: string): Promise<RawSession> {
  const raw = await fs.readFile(filePath, 'utf-8');
  return parseSessionContent(raw, filePath);
}

export function parseSessionContent(raw: string, filePath: string): RawSession {
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return emptySession(filePath);
  }

  let meta: Record<string, unknown> = {};
  let format: RawSession['metadata']['format'] = 'unknown';
  const collected: KodaXMessage[] = [];

  // First line is always the meta line (in both formats).
  const firstParsed = safeParse(lines[0]!);
  if (firstParsed && typeof firstParsed === 'object' && (firstParsed as Record<string, unknown>)._type === 'meta') {
    meta = firstParsed as Record<string, unknown>;
  }

  // Detect format from the second line.
  const probe = lines[1] ? safeParse(lines[1]!) : undefined;
  if (probe && typeof probe === 'object') {
    if ((probe as Record<string, unknown>)._type === 'lineage_entry') {
      format = 'lineage-tree';
    } else if ((probe as Record<string, unknown>).role !== undefined) {
      format = 'legacy-flat';
    }
  }

  if (format === 'legacy-flat') {
    for (let i = 1; i < lines.length; i++) {
      const parsed = safeParse(lines[i]!);
      if (isMessageLike(parsed)) {
        collected.push(parsed);
      }
    }
  } else if (format === 'lineage-tree') {
    // Collect all lineage_entry message nodes, then walk the active path.
    type LineageNode = {
      id: string;
      parentId: string | null;
      timestamp?: string;
      message: KodaXMessage;
    };
    const nodesById = new Map<string, LineageNode>();
    for (let i = 1; i < lines.length; i++) {
      const parsed = safeParse(lines[i]!);
      if (!parsed || typeof parsed !== 'object') continue;
      if ((parsed as Record<string, unknown>)._type !== 'lineage_entry') continue;
      const entry = (parsed as { entry?: Record<string, unknown> }).entry;
      if (!entry || entry.type !== 'message') continue;
      const id = entry.id as string | undefined;
      const message = entry.message as KodaXMessage | undefined;
      if (!id || !isMessageLike(message)) continue;
      nodesById.set(id, {
        id,
        parentId: (entry.parentId as string | null) ?? null,
        timestamp: entry.timestamp as string | undefined,
        message,
      });
    }
    // Walk from activeEntryId back to root, then reverse for chronological order.
    const activeEntryId = meta.activeEntryId as string | undefined;
    const startId = activeEntryId && nodesById.has(activeEntryId)
      ? activeEntryId
      : pickLatestLeaf(nodesById);
    const chain: LineageNode[] = [];
    let cursor: string | null | undefined = startId;
    const seen = new Set<string>();
    while (cursor && nodesById.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor);
      const node: LineageNode = nodesById.get(cursor)!;
      chain.push(node);
      cursor = node.parentId;
    }
    chain.reverse();
    for (const node of chain) collected.push(node.message);
  }

  return {
    sessionId: (meta.id as string | undefined) ?? path.basename(filePath, '.jsonl'),
    filePath,
    meta,
    messages: collected,
    metadata: deriveMetadata(collected, format),
  };
}

/** Enumerate jsonl session files in a directory. */
export async function listSessionFiles(sessionsDir: string): Promise<string[]> {
  const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
    .map((e) => path.join(sessionsDir, e.name));
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function safeParse(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function isMessageLike(value: unknown): value is KodaXMessage {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.role !== 'user' && v.role !== 'assistant' && v.role !== 'system') return false;
  if (typeof v.content !== 'string' && !Array.isArray(v.content)) return false;
  return true;
}

function pickLatestLeaf(nodes: Map<string, { id: string; parentId: string | null; timestamp?: string }>): string | undefined {
  // Children = nodes whose parentId points to this id. Leaves have no children.
  const hasChild = new Set<string>();
  for (const node of nodes.values()) {
    if (node.parentId) hasChild.add(node.parentId);
  }
  const leaves = [...nodes.values()].filter((n) => !hasChild.has(n.id));
  if (leaves.length === 0) return undefined;
  // Latest by timestamp (string sort works for ISO-8601).
  leaves.sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''));
  return leaves[0]!.id;
}

function emptySession(filePath: string): RawSession {
  return {
    sessionId: path.basename(filePath, '.jsonl'),
    filePath,
    meta: {},
    messages: [],
    metadata: {
      initialPromptText: '',
      turnCount: 0,
      hasImageBlock: false,
      hasToolError: false,
      hasEditRecoveryMessage: false,
      hasSyntheticTail: false,
      format: 'unknown',
    },
  };
}

function deriveMetadata(
  messages: KodaXMessage[],
  format: RawSession['metadata']['format'],
): RawSession['metadata'] {
  let initialPromptText = '';
  let turnCount = 0;
  let hasImageBlock = false;
  let hasToolError = false;
  let hasEditRecoveryMessage = false;
  let hasSyntheticTail = false;

  for (const msg of messages) {
    if (msg.role === 'user') {
      turnCount += 1;
      if (!initialPromptText) {
        initialPromptText = extractText(msg.content).slice(0, 500);
      }
    }
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if ((block as { type?: string }).type === 'image') hasImageBlock = true;
        if ((block as { type?: string }).type === 'tool_result') {
          const isErr = (block as { is_error?: boolean }).is_error;
          if (isErr) hasToolError = true;
        }
      }
    }
    if (msg.role === 'user' && containsEditRecoveryMarker(msg)) {
      hasEditRecoveryMessage = true;
    }
  }

  // Synthetic tail: last user message has _synthetic flag (legacy format only —
  // lineage format flattens this).
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user' && m._synthetic) {
      hasSyntheticTail = true;
      break;
    }
    if (m.role === 'user') break;
  }

  return {
    initialPromptText,
    turnCount,
    hasImageBlock,
    hasToolError,
    hasEditRecoveryMessage,
    hasSyntheticTail,
    format,
  };
}

function extractText(content: KodaXMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((b) => (b as { type?: string }).type === 'text')
    .map((b) => (b as { text?: string }).text ?? '')
    .join('\n');
}

function containsEditRecoveryMarker(msg: KodaXMessage): boolean {
  // CAP-015 recovery messages contain a stable instruction phrase; this is a
  // best-effort heuristic. Update if the recovery template changes.
  const text = extractText(msg.content);
  return /re-?read.*before.*edit|edit anchor|file changed since/i.test(text);
}
