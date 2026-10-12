import type { ArtifactRequest, ArtifactResult } from './types.js';
import { hashBytes, readPresentation, writePresentation } from './files.js';
import { createPresentation, editPresentation, inspectPresentation } from './presentation.js';
import fs from 'node:fs/promises';
import { defaultBrowserExecutable, renderPresentation } from './render.js';

export interface ArtifactRuntimeOptions { readonly workspaceRoot: string; readonly browserExecutable?: string; readonly libreOfficeExecutable?: string; readonly maxRenderPages?: number; readonly signal?: AbortSignal }
export async function executeArtifactRequest(request: ArtifactRequest, options: ArtifactRuntimeOptions): Promise<ArtifactResult> {
 if (options.signal?.aborted) throw new DOMException('Artifact operation cancelled.', 'AbortError');
 if (request.operation === 'capture') return { status: 'unverified', diagnostics: [{ code: 'capture-unavailable', message: 'No adapter for ' + request.input.kind, blocking: true }] };
 if (!['create', 'open', 'edit', 'export', 'render', 'capture', 'capabilities'].includes(request.operation)) throw new Error('Unknown artifact operation.');
 if (request.operation === 'capabilities') {
  let browser = 'lightweight-candidate';
  try { await fs.access(options.browserExecutable ?? defaultBrowserExecutable()); } catch (error) {
   if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
   browser = 'missing-browser';
  }
  return { status: 'ready', diagnostics: [], capabilities: {
   create: 'PPTX text/rectangle/image/table/column-chart', open: 'PPTX structural inspection',
   edit: 'explicit text and ungrouped geometry', render: browser,
   capture: 'unavailable', libreoffice: options.libreOfficeExecutable ? 'available-unverified' : 'not-prepared',
 } }; }
 if (request.operation === 'create') {
   const bytes = await createPresentation(request.input, options.workspaceRoot);
   if (options.signal?.aborted) throw new DOMException('Artifact operation cancelled.', 'AbortError');
   const file = await writePresentation(options.workspaceRoot, request.input.output, bytes);
   return { status: 'ready', artifact: { path: file, sourceHash: hashBytes(bytes), kind: 'presentation', pages: request.input.slides.length }, diagnostics: [] };
 }
 const source = await readPresentation(options.workspaceRoot, request.input.path, request.input.expectedSourceHash);
 const inspected = await inspectPresentation(source.bytes);
 const artifact = { path: source.path, sourceHash: source.sourceHash, kind: 'presentation' as const, pages: inspected.pages.length };
 if (request.operation === 'open') return { status: inspected.diagnostics.length ? 'unverified' : 'ready', artifact, objects: inspected.objects, diagnostics: inspected.diagnostics };
 if (request.operation === 'edit' || request.operation === 'export') {
   const bytes = request.operation === 'edit' ? await editPresentation(source.bytes, request.input) : source.bytes;
   if (options.signal?.aborted) throw new DOMException('Artifact operation cancelled.', 'AbortError');
   const file = await writePresentation(options.workspaceRoot, request.input.output, bytes);
   return { status: inspected.diagnostics.length ? 'unverified' : 'ready', artifact: { ...artifact, path: file, sourceHash: hashBytes(bytes) }, diagnostics: inspected.diagnostics };
 }
 const result = await renderPresentation(source.bytes, artifact, request.input, inspected.diagnostics, options);
 const current = await readPresentation(options.workspaceRoot, source.path);
 if (current.sourceHash !== source.sourceHash) {
  const diagnostic = { code: 'stale-source', message: 'Source file changed during rendering. Capture the current revision again.', blocking: true };
  return { ...result, status: 'unverified', diagnostics: [...result.diagnostics, diagnostic],
   evidence: result.evidence && { ...result.evidence, diagnostics: [...result.evidence.diagnostics, diagnostic] } };
 }
 return result;
}
