/** FEATURE_306 — new note store (public surface; the old memory-control path is untouched). */
export { createNoteStore, INDEX_FILE } from './store.js';
export type { NewNote, NotePatch, NoteResult, NoteStore } from './store.js';
export { applyMemoryOperation } from './memory-op.js';
export type { MemoryOpContext, MemoryOpInput, MemoryOpResult } from './memory-op.js';
export { convertLegacyMemdir } from './converter.js';
export type { ConversionReport } from './converter.js';
export { INDEX_TOKEN_BUDGET } from './index-builder.js';
export type { MemoryNote, NoteScope, NoteStatus, NoteType } from './record.js';
export { resolveNoteRoot } from './paths.js';
