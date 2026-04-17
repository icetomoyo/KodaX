/**
 * Memory diagnostics utility for KodaX.
 *
 * Enable: KODAX_MEMORY_DIAG=1 npm run dev
 *        (best run with `node --expose-gc` so the tool can trigger a GC
 *         after each snapshot and report how much is genuinely reachable
 *         vs. merely not-yet-collected)
 * Log:    ~/.kodax/memory-diag.log
 *
 * Blind spots (IMPORTANT):
 *   This tool measures first-class data we own (messages, lineage entry
 *   payloads, UI history, streaming buffers).  It does NOT see:
 *     - React/Ink fiber trees and component closures
 *     - Provider/SDK internal buffers (SSE parsers, tokenizer caches)
 *     - WeakMap/Map caches (fingerprint maps, etc.)
 *     - Source-map text kept alive by tsx
 *   When "unaccounted" is large and keeps growing, the leak is in one of
 *   those buckets; use Level-2 heap snapshots + Chrome DevTools to locate it.
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import v8 from 'node:v8';
import type {
  KodaXMessage,
  KodaXSessionEntry,
  KodaXSessionLineage,
} from '@kodax/agent';

const LEVEL = parseInt(process.env.KODAX_MEMORY_DIAG ?? '0', 10);
const ENABLED = LEVEL >= 1;

const LOG_DIR = join(homedir(), '.kodax');
const LOG_PATH = join(LOG_DIR, 'memory-diag.log');

let turnCounter = 0;
let logReady = false;

function ensureLogDir(): void {
  if (logReady) return;
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    logReady = true;
  } catch {
    logReady = true;
  }
}

function writeLog(line: string): void {
  ensureLogDir();
  try {
    appendFileSync(LOG_PATH, line + '\n');
  } catch {
    // silent
  }
}

function formatMB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
}

function tryGC(): boolean {
  if (typeof globalThis.gc === 'function') {
    globalThis.gc();
    return true;
  }
  return false;
}

// ── Byte estimators ──────────────────────────────────────────────────

/** UTF-16 string bytes (V8 string storage is ~2B/char for BMP). */
function strBytes(s: string | undefined): number {
  return s ? s.length * 2 : 0;
}

/**
 * Recursive estimator for arbitrary JSON-ish values. Used for
 * `tool_use.input`, compaction.details, memorySeed, etc. — any field that
 * can carry unbounded payload.
 *
 * Depth-limited to guard against cyclic references.
 */
function estimateJsonBytes(value: unknown, depth = 0): number {
  if (depth > 8) return 0;
  if (value === null || value === undefined) return 8;
  if (typeof value === 'string') return value.length * 2;
  if (typeof value === 'number' || typeof value === 'boolean') return 8;
  if (Array.isArray(value)) {
    let total = 32; // array header overhead
    for (const item of value) total += estimateJsonBytes(item, depth + 1);
    return total;
  }
  if (typeof value === 'object') {
    let total = 64; // object header overhead
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      total += k.length * 2;
      total += estimateJsonBytes(v, depth + 1);
    }
    return total;
  }
  return 16;
}

/**
 * Estimate byte size of one content block, covering all known field
 * shapes. Unknown fields are caught by a generic walk to avoid blind spots.
 */
function estimateBlockBytes(block: unknown): number {
  if (!block || typeof block !== 'object') return 64;
  const b = block as Record<string, unknown>;
  // Fast path: accumulate known fields, then residual walk for the rest.
  let total = 64; // block header
  const known = new Set([
    'type', 'text', 'thinking', 'content', 'partial_json',
    'input', 'data', 'signature', 'path', 'mediaType',
    'tool_use_id', 'id', 'name', 'is_error',
  ]);
  if (typeof b.text === 'string') total += b.text.length * 2;
  if (typeof b.thinking === 'string') total += b.thinking.length * 2;
  if (typeof b.content === 'string') total += b.content.length * 2;
  else if (Array.isArray(b.content)) {
    for (const inner of b.content) total += estimateBlockBytes(inner);
  }
  if (typeof b.partial_json === 'string') total += b.partial_json.length * 2;
  if (typeof b.data === 'string') total += b.data.length * 2; // redacted_thinking / base64
  if (typeof b.signature === 'string') total += b.signature.length * 2;
  if (typeof b.path === 'string') total += b.path.length * 2;
  if (b.input !== undefined) total += estimateJsonBytes(b.input);
  // Anything else we didn't enumerate — count conservatively so we don't
  // undercount providers that attach extra metadata.
  for (const [k, v] of Object.entries(b)) {
    if (known.has(k)) continue;
    total += k.length * 2 + estimateJsonBytes(v);
  }
  return total;
}

/** Estimate byte size of one message (content strings + all block fields). */
function estimateMessageBytes(message: KodaXMessage): number {
  if (typeof message.content === 'string') {
    return message.content.length * 2 + 64;
  }
  if (Array.isArray(message.content)) {
    let total = 64;
    for (const block of message.content) {
      total += estimateBlockBytes(block);
    }
    return total;
  }
  return 200;
}

/**
 * Estimate payload bytes of a non-message lineage entry (compaction,
 * branch_summary, label, archive_marker).  Message entries are tracked
 * separately via the messages array (they share references after the
 * lineage cloning fix).
 */
function estimateEntryBytes(entry: KodaXSessionEntry): number {
  let total = 128; // base wrapper: id, parentId, timestamp, type
  total += strBytes(entry.id) + strBytes(entry.parentId ?? undefined) + strBytes(entry.timestamp);
  switch (entry.type) {
    case 'message':
      return total + estimateMessageBytes(entry.message);
    case 'compaction':
      total += strBytes(entry.summary);
      total += strBytes(entry.firstKeptEntryId);
      total += strBytes(entry.reason);
      total += strBytes(entry.artifactLedgerId);
      if (entry.details !== undefined) total += estimateJsonBytes(entry.details);
      if (entry.memorySeed !== undefined) total += estimateJsonBytes(entry.memorySeed);
      return total;
    case 'branch_summary':
      total += strBytes(entry.summary);
      total += strBytes(entry.fromId);
      if (entry.details !== undefined) total += estimateJsonBytes(entry.details);
      return total;
    case 'label':
      total += strBytes(entry.targetId);
      total += strBytes(entry.label);
      return total;
    case 'archive_marker':
      total += strBytes(entry.archiveBatchId);
      total += strBytes(entry.summary);
      total += 8; // archivedEntryCount
      return total;
    default:
      return total;
  }
}

// ── Breakdown types ──────────────────────────────────────────────────

export interface MemDiagBreakdown {
  // context.messages
  messageCount: number;
  messageBytes: number;
  biggestMessages: Array<{ index: number; role: string; bytes: number }>;
  // context.lineage — broken out by entry type
  lineageEntryCount: number;
  lineageMessageEntryCount: number;
  lineageCompactionCount: number;
  lineageBranchSummaryCount: number;
  lineageLabelCount: number;
  lineageArchiveMarkerCount: number;
  /** Bytes of non-message entries (compaction/branch/label/archive). */
  lineageNonMessageBytes: number;
  /** Bytes of lineage message entries whose message reference is NOT in
   *  context.messages (orphaned or branched). Measures duplication that
   *  survives the shared-reference optimization. */
  lineageOrphanMessageBytes: number;
  lineageOrphanMessageCount: number;
  // UI history (committed rounds)
  historyItemCount: number;
  historyTextBytes: number;
  // Foreground turn items (current round, cleared each turn)
  foregroundItemCount: number;
  foregroundTextBytes: number;
  // StreamingContext live state
  streamingResponseBytes: number;
  streamingThinkingBytes: number;
  // Persisted UI history snapshot
  persistedUiHistoryCount: number;
  persistedUiHistoryBytes: number;
}

function buildMessageBreakdown(messages: readonly KodaXMessage[]): {
  totalBytes: number;
  biggest: Array<{ index: number; role: string; bytes: number }>;
  byRole: Record<string, { count: number; bytes: number }>;
} {
  const byRole: Record<string, { count: number; bytes: number }> = {};
  const sized: Array<{ index: number; role: string; bytes: number }> = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    const bytes = estimateMessageBytes(msg);
    sized.push({ index: i, role: msg.role, bytes });
    const bucket = byRole[msg.role] ?? { count: 0, bytes: 0 };
    bucket.count++;
    bucket.bytes += bytes;
    byRole[msg.role] = bucket;
  }

  sized.sort((a, b) => b.bytes - a.bytes);
  const totalBytes = sized.reduce((sum, m) => sum + m.bytes, 0);

  return { totalBytes, biggest: sized.slice(0, 5), byRole };
}

// ── Public API ──

export function memDiagEnabled(): boolean {
  return ENABLED;
}

export function memDiagSnapshot(
  phase: string,
  breakdown: MemDiagBreakdown,
): void {
  if (!ENABLED) return;

  if (phase === 'turn-start') {
    turnCounter++;
  }

  const mem = process.memoryUsage();
  const ts = new Date().toISOString();
  const msgBreak = breakdown.biggestMessages;

  const lines: string[] = [
    '',
    `═══ [MEMDIAG] turn=${turnCounter} phase=${phase} @${ts} ═══`,
    `  V8 heap:  used=${formatMB(mem.heapUsed)}  total=${formatMB(mem.heapTotal)}  rss=${formatMB(mem.rss)}  ext=${formatMB(mem.external)}`,
    `  ── Data breakdown ──`,
    `  context.messages:        ${breakdown.messageCount} msgs, ${formatMB(breakdown.messageBytes)}`,
    `  lineage.entries:         ${breakdown.lineageEntryCount} total`
      + ` (msg=${breakdown.lineageMessageEntryCount}`
      + `, compact=${breakdown.lineageCompactionCount}`
      + `, branch=${breakdown.lineageBranchSummaryCount}`
      + `, label=${breakdown.lineageLabelCount}`
      + `, archive=${breakdown.lineageArchiveMarkerCount})`,
    `  lineage non-message:     ${formatMB(breakdown.lineageNonMessageBytes)}`
      + ` (compaction.details/memorySeed + branch_summary payloads)`,
    `  lineage orphan messages: ${breakdown.lineageOrphanMessageCount} msgs, ${formatMB(breakdown.lineageOrphanMessageBytes)}`
      + ` (in lineage but not in context.messages — branches/pruned)`,
    `  UI history:              ${breakdown.historyItemCount} items, ${formatMB(breakdown.historyTextBytes)}`,
    `  foreground turn:         ${breakdown.foregroundItemCount} items, ${formatMB(breakdown.foregroundTextBytes)}`,
    `  streaming response:      ${formatMB(breakdown.streamingResponseBytes)}`,
    `  streaming thinking:      ${formatMB(breakdown.streamingThinkingBytes)}`,
    `  persisted UI history:    ${breakdown.persistedUiHistoryCount} items, ${formatMB(breakdown.persistedUiHistoryBytes)}`,
  ];

  if (msgBreak.length > 0) {
    lines.push(`  ── Top 5 biggest messages ──`);
    for (const m of msgBreak) {
      lines.push(`    [${m.index}] role=${m.role} ${formatMB(m.bytes)}`);
    }
  }

  // Sum of tracked data vs heap — the gap is "unaccounted"
  const trackedBytes =
    breakdown.messageBytes
    + breakdown.lineageNonMessageBytes
    + breakdown.lineageOrphanMessageBytes
    + breakdown.historyTextBytes
    + breakdown.foregroundTextBytes
    + breakdown.streamingResponseBytes
    + breakdown.streamingThinkingBytes
    + breakdown.persistedUiHistoryBytes;

  // V8 heap space breakdown — shows WHERE the memory lives
  lines.push(`  ── V8 heap spaces ──`);
  const spaces = v8.getHeapSpaceStatistics();
  for (const space of spaces) {
    if (space.space_used_size > 1024 * 1024) { // Only show spaces > 1MB
      lines.push(`    ${space.space_name.padEnd(25)} used=${formatMB(space.space_used_size)}  allocated=${formatMB(space.space_size)}`);
    }
  }

  lines.push(`  ── Summary ──`);
  lines.push(`  tracked data total:      ${formatMB(trackedBytes)}`);
  lines.push(`  V8 heap used:            ${formatMB(mem.heapUsed)}`);
  lines.push(`  unaccounted (overhead):   ${formatMB(mem.heapUsed - trackedBytes)}`);
  lines.push(`                           (React/Ink tree, provider SDK buffers, module metadata,`);
  lines.push(`                            tokenizer caches, source maps — see "Blind spots" note)`);
  const gcWorked = tryGC();
  if (gcWorked) {
    const afterGC = process.memoryUsage();
    lines.push(`  after forced GC:         heap=${formatMB(afterGC.heapUsed)}  (freed ${formatMB(mem.heapUsed - afterGC.heapUsed)})`);
  } else {
    lines.push(`  after forced GC:         UNAVAILABLE — re-run with \`node --expose-gc\` to distinguish`);
    lines.push(`                           "real leak" from "GC hasn't run yet".`);
  }

  // Level 2: write V8 heap snapshot for Chrome DevTools analysis
  if (LEVEL >= 2) {
    try {
      const snapshotPath = join(LOG_DIR, `heap-turn${turnCounter}-${phase}.heapsnapshot`);
      v8.writeHeapSnapshot(snapshotPath);
      lines.push(`  heap snapshot:           ${snapshotPath}`);
    } catch {
      lines.push(`  heap snapshot:           FAILED`);
    }
  }

  writeLog(lines.join('\n'));
}

/** Convenience: build breakdown from messages array. */
export function buildMemDiagBreakdown(
  messages: readonly KodaXMessage[],
  lineage: KodaXSessionLineage | undefined,
  extras: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  historyItems: readonly any[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  foregroundItems: readonly any[];
    streamingResponse: string;
    streamingThinking: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  persistedUiHistory: readonly any[];
  },
): MemDiagBreakdown {
  const msgBreak = buildMessageBreakdown(messages);

  // Reference set of messages that are accounted for via context.messages.
  // Lineage message entries that point to these are NOT counted again
  // (reference-shared per the cloneMessage-returns-ref fix).
  const contextMessageRefs = new Set<KodaXMessage>(messages);

  let lineageNonMessageBytes = 0;
  let lineageOrphanMessageBytes = 0;
  let lineageOrphanMessageCount = 0;
  let lineageCompactionCount = 0;
  let lineageBranchSummaryCount = 0;
  let lineageLabelCount = 0;
  let lineageArchiveMarkerCount = 0;
  let lineageMessageEntryCount = 0;

  const entries = lineage?.entries ?? [];
  for (const entry of entries) {
    switch (entry.type) {
      case 'message':
        lineageMessageEntryCount++;
        if (!contextMessageRefs.has(entry.message)) {
          lineageOrphanMessageCount++;
          lineageOrphanMessageBytes += estimateMessageBytes(entry.message);
        }
        break;
      case 'compaction':
        lineageCompactionCount++;
        lineageNonMessageBytes += estimateEntryBytes(entry);
        break;
      case 'branch_summary':
        lineageBranchSummaryCount++;
        lineageNonMessageBytes += estimateEntryBytes(entry);
        break;
      case 'label':
        lineageLabelCount++;
        lineageNonMessageBytes += estimateEntryBytes(entry);
        break;
      case 'archive_marker':
        lineageArchiveMarkerCount++;
        lineageNonMessageBytes += estimateEntryBytes(entry);
        break;
    }
  }

  let historyTextBytes = 0;
  for (const item of extras.historyItems) {
    historyTextBytes += strBytes(item.text);
  }

  let foregroundTextBytes = 0;
  for (const item of extras.foregroundItems) {
    foregroundTextBytes += strBytes(item.text);
  }

  let persistedUiHistoryBytes = 0;
  for (const item of extras.persistedUiHistory) {
    persistedUiHistoryBytes += strBytes(item.text);
  }

  return {
    messageCount: messages.length,
    messageBytes: msgBreak.totalBytes,
    biggestMessages: msgBreak.biggest,
    lineageEntryCount: entries.length,
    lineageMessageEntryCount,
    lineageCompactionCount,
    lineageBranchSummaryCount,
    lineageLabelCount,
    lineageArchiveMarkerCount,
    lineageNonMessageBytes,
    lineageOrphanMessageBytes,
    lineageOrphanMessageCount,
    historyItemCount: extras.historyItems.length,
    historyTextBytes,
    foregroundItemCount: extras.foregroundItems.length,
    foregroundTextBytes,
    streamingResponseBytes: strBytes(extras.streamingResponse),
    streamingThinkingBytes: strBytes(extras.streamingThinking),
    persistedUiHistoryCount: extras.persistedUiHistory.length,
    persistedUiHistoryBytes,
  };
}

/** Reset the log file (called on session start). */
export function memDiagReset(): void {
  if (!ENABLED) return;
  ensureLogDir();
  try {
    const gcAvailable = typeof globalThis.gc === 'function';
    const header = [
      `[MEMDIAG] Session started at ${new Date().toISOString()}`,
      `[MEMDIAG] Level=${LEVEL}  gc=${gcAvailable ? 'available' : 'UNAVAILABLE (run with node --expose-gc)'}`,
      `[MEMDIAG] Blind spots: React/Ink trees, provider SDK buffers, WeakMap/Map caches,`,
      `[MEMDIAG]              tokenizer internal state, source-map strings, native handles.`,
      `[MEMDIAG]              A large "unaccounted" number living in these buckets is expected;`,
      `[MEMDIAG]              use Level 2 (KODAX_MEMORY_DIAG=2) to dump heap snapshots for DevTools.`,
      '',
    ].join('\n');
    writeFileSync(LOG_PATH, header + '\n');
  } catch {
    // silent
  }
}
