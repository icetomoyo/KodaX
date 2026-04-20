/**
 * @kodax/session-lineage — LineageExtension + LineageCompaction.
 *
 * Populated in FEATURE_082 Slice 3 by moving the lineage implementation out
 * of `@kodax/coding/src/extensions/lineage`. Depends on `@kodax/core` for
 * `Session` / `SessionEntry` / `SessionExtension` / `CompactionPolicy`.
 *
 * `@kodax/coding` retains a barrel re-export as a convenience for
 * batteries-included consumers; that is not a deprecation shim.
 */

export type {
  LineageArtifactLedgerPayload,
  LineageEntryType,
  LineageLabelPayload,
  LineageTreeNode,
} from './lineage.js';
export { LINEAGE_ENTRY_TYPES, LineageExtension } from './lineage.js';

export type { LineageCompactionDelegates } from './compaction.js';
export { LineageCompaction } from './compaction.js';
