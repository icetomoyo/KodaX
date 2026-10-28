// Explicit preload for one natural-eval cell process; never imported by production.
import os from 'node:os';
import path from 'node:path';

const root = process.env.KODAX_ORIGINAL_SMOKE_ROOT;
const cell = process.env.KODAX_ORIGINAL_SMOKE_CELL;
if (!root || !path.isAbsolute(root) || !cell || !/^cell-\d{2}$/.test(cell)) {
  throw new Error('An absolute evaluation root and opaque cell id are required');
}
const relative = path.relative(os.tmpdir(), root);
if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
  throw new Error('Evaluation root must be a child of OS temporary storage');
}
process.env.KODAX_TOOL_OUTPUT_DIR = path.join(root, cell, 'workspace', '.agent', 'tmp', 'tool-results');
