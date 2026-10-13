import fs from 'node:fs/promises';
import path from 'node:path';
import type { ArtifactCapability, ArtifactOperation, ArtifactRef, ArtifactRequest, ArtifactResult, ArtifactResults, ArtifactExecutionPort } from './types.js';
import { artifactPath, hashBytes, readPresentation, writePresentation } from './files.js';
import { decodeArtifactRequest, decodeArtifactResult } from './contract.js';
import { assertCurrentSource, readEvidenceFile, saveEvidence } from './evidence-files.js';
import { inspectPng } from './pixels.js';
import { browserAvailable, prepareBrowser } from './prepare.js';
import { detectFormat } from './formats.js';

export interface ArtifactRuntimeOptions { readonly workspaceRoot: string; readonly browserExecutable?: string; readonly libreOfficeExecutable?: string; readonly maxRenderPages?: number; readonly signal?: AbortSignal }
/** Explicit local authority for independent, trusted Node hosts. Product UIs use the Host port. */
export function createNodeArtifactPort(options: ArtifactRuntimeOptions): ArtifactExecutionPort {
 return { execute: (request, signal) => executeArtifactRequest(request, { ...options,
  signal: signal && options.signal ? AbortSignal.any([signal, options.signal]) : signal ?? options.signal }) };
}
export async function executeArtifactRequest<O extends ArtifactOperation>(request: ArtifactRequest<O>, options: ArtifactRuntimeOptions): Promise<ArtifactResults[O]> {
 const checked = decodeArtifactRequest(request); options.signal?.throwIfAborted();
 const result = await execute(checked, options); options.signal?.throwIfAborted();
 return decodeArtifactResult(request.operation, result);
}
async function execute(request: ArtifactRequest, options: ArtifactRuntimeOptions): Promise<ArtifactResult> {
 if (request.operation === 'capture' && request.input.expectedSource?.kind === 'surface') return { status: 'unverified', diagnostics: [{ code: 'surface-owner-required', message: 'Capture a live surface through its existing authorized owner port.', blocking: true }] };
 if (request.operation === 'prepare') return prepareBrowser(options);
 if (request.operation === 'readEvidence') return { status: 'ready', diagnostics: [], image: await readEvidenceFile(options.workspaceRoot, request.input, options.signal) };
 if (request.operation === 'capabilities') {
  const available = await browserAvailable(options), capabilities: ArtifactCapability[] = [];
  for (const format of ['pptx', 'pdf', 'docx', 'png', 'jpeg', 'webp', 'svg', 'html'] as const) {
   const engine = format === 'pptx' ? { name: '@aiden0z/pptx-renderer', version: '1.3.0' } : format === 'pdf' ? { name: 'PDF.js', version: '5.4.296' }
    : format === 'docx' ? { name: 'docx-renderer', version: '0.2.2' } : format === 'png' ? { name: 'pngjs/exact-bytes', version: '7.0.0' } : { name: 'Chromium', version: 'not-observed' };
   const diagnostics = format === 'docx' ? [{ code: 'docx-preview-fidelity', message: 'Lightweight candidate pixels; Word/WPS fidelity remains unverified.', blocking: true }]
    : format === 'png' ? [{ code: 'png-capture-scope', message: 'Exact whole-image PNG needs no browser; regions/backgrounds require prepared Chromium.' }]
    : [{ code: 'browser-candidate', message: 'Browser file presence is checked; actual executable compatibility/version is observed during explicit prepare/render/capture.' }];
   capabilities.push({ operation: 'open', input: format, availability: format === 'pdf' && !available ? 'not-prepared' : 'available',
    engine: format === 'pdf' ? engine : { name: 'source-content-inspection', version: '1' }, diagnostics: [] });
   capabilities.push({ operation: format === 'html' ? 'capture' : 'render', input: format, ...(format === 'html' ? {} : { backend: 'lightweight' as const }), availability: format === 'png' || available ? 'available' : 'not-prepared', engine, diagnostics });
   if (format !== 'pptx' && format !== 'html') capabilities.push({ operation: 'capture', input: format, availability: format === 'png' || available ? 'available' : 'not-prepared', engine, diagnostics });
  }
  let converterAvailable = false;
  if (options.libreOfficeExecutable && path.isAbsolute(options.libreOfficeExecutable)) {
   try { converterAvailable = (await fs.stat(options.libreOfficeExecutable)).isFile(); }
   catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  capabilities.push({ operation: 'render', input: 'pptx', backend: 'libreoffice', availability: converterAvailable && available ? 'available' : 'not-prepared',
   engine: { name: 'LibreOffice/PDF.js', version: 'not-observed' }, diagnostics: [{ code: 'converter-candidate', message: 'Requires trusted absolute LibreOffice and prepared Chromium paths. File presence is checked here; converter identity/version is verified during render.' }] });
  for (const operation of ['create', 'edit', 'export'] as const) capabilities.push({ operation, input: 'pptx', availability: 'available', diagnostics: [] });
  capabilities.push({ operation: 'prepare', input: 'runtime', availability: options.browserExecutable && !available ? 'unsupported' : 'available', diagnostics: [] },
   { operation: 'readEvidence', input: 'raster', availability: 'available', diagnostics: [] },
   { operation: 'capture', input: 'surface', availability: 'unsupported', diagnostics: [{ code: 'owner-required', message: 'A live surface requires its existing authorized owner adapter.' }] });
  return { status: 'ready', diagnostics: [], capabilities };
 }
 if (request.operation === 'create') {
  const { createPresentation } = await import('./presentation.js');
  const bytes = await createPresentation(request.input, options.workspaceRoot); options.signal?.throwIfAborted();
  const file = await writePresentation(options.workspaceRoot, request.input.output, bytes);
  return { status: 'ready', artifact: { path: file, sourceHash: hashBytes(bytes), format: 'pptx', pages: request.input.slides.length }, diagnostics: [] };
 }
 const source = await readPresentation(options.workspaceRoot, request.operation === 'capture' ? request.input.target : request.input.path,
  request.operation === 'capture' ? request.input.expectedSource?.kind === 'file' ? request.input.expectedSource.file.sourceHash : undefined : request.input.expectedSourceHash);
 const format = await detectFormat(source.bytes, source.path), base = { path: source.path, sourceHash: source.sourceHash };
 if (request.operation === 'capture' && request.input.expectedSource?.kind === 'file') {
  const expected = request.input.expectedSource;
  if (await artifactPath(options.workspaceRoot, expected.file.path) !== source.path || expected.file.format !== format) throw new Error('Capture source identity differs from the requested file.');
  await assertCurrentSource(options.workspaceRoot, expected);
 }
 let result: ArtifactResult;
 if (format === 'pptx') {
  const { inspectPresentation, editPresentation } = await import('./presentation.js');
  const inspected = await inspectPresentation(source.bytes), artifact = { ...base, format, pages: inspected.pages.length };
  if (request.operation === 'open') return decodeArtifactResult('open', { status: inspected.diagnostics.length ? 'unverified' : 'ready', artifact, objects: inspected.objects, diagnostics: inspected.diagnostics });
  if (request.operation === 'edit' || request.operation === 'export') {
   const bytes = request.operation === 'edit' ? await editPresentation(source.bytes, request.input) : source.bytes; options.signal?.throwIfAborted();
   const file = await writePresentation(options.workspaceRoot, request.input.output, bytes);
   return decodeArtifactResult(request.operation, { status: inspected.diagnostics.length ? 'unverified' : 'ready', artifact: { ...artifact, path: file, sourceHash: hashBytes(bytes) }, diagnostics: inspected.diagnostics });
  }
  if (request.operation === 'capture') return { status: 'unverified', diagnostics: [{ code: 'capture-unavailable', message: 'Use render for PPTX pages.', blocking: true }] };
  const { renderPresentation } = await import('./render.js'); result = await renderPresentation(source.bytes, artifact, request.input, inspected.diagnostics, options);
 } else {
  if (request.operation === 'edit' || request.operation === 'export') throw new Error('Edit/export are available only for PPTX.');
  if (request.operation === 'render' && request.input.backend === 'libreoffice') throw new Error('LibreOffice conversion is available only for PPTX; native formats use their declared renderer.');
  if (request.operation === 'open' && format !== 'pdf') { if (format === 'png') inspectPng(source.bytes); return { status: 'ready', artifact: { ...base, format }, diagnostics: [] }; }
  if (format === 'pdf' || format === 'docx') {
   if (!(await browserAvailable(options))) return missingBrowser();
   if (request.operation === 'capture' && (request.input.kind !== 'paginated' || request.input.locators.some(l => l.kind !== 'paginated' || l.sheet !== undefined || l.range !== undefined))) return { status: 'unverified', diagnostics: [{ code: 'capture-unavailable', message: 'Document capture requires page locators without sheet/range.', blocking: true }] };
   const { processDocument } = await import('./document-render.js');
   const renderInput = request.operation === 'open' ? undefined : request.operation === 'capture' ? { path: source.path, pages: request.input.locators.map(l => l.kind === 'paginated' ? l.page : 0) } : request.input;
   result = await processDocument(source.bytes, { ...base, format }, renderInput, options);
  } else {
   const artifact: ArtifactRef = { ...base, format };
   if (request.operation === 'render' && request.input.pages !== undefined) throw new Error('Image render does not accept page numbers.');
   if (request.operation === 'render' && format === 'html') return { status: 'unverified', diagnostics: [{ code: 'html-capture-required', message: 'Capture HTML with explicit loaded state and viewport.', blocking: true }] };
   if (format === 'png' && (request.operation === 'render' || (request.operation === 'capture' && request.input.background === undefined && request.input.kind === 'static' && request.input.locators.length === 1 && request.input.locators[0]?.kind === 'static' && !request.input.locators[0].region))) {
    const directory = await fs.mkdtemp(path.join(options.workspaceRoot, '.artifact-render-')), identity = { kind: 'file' as const, file: artifact };
    const raster = await saveEvidence(directory, 'image', source.bytes, identity, { kind: 'static' });
    result = { status: 'ready', artifact, diagnostics: [], evidence: { kind: 'static', source: identity, engine: { name: 'PNG/exact-bytes', version: '1' }, diagnostics: [], evidence: [raster], scope: { locators: [raster.locator] } } };
   } else {
    if (!(await browserAvailable(options))) return missingBrowser();
    const { renderWeb } = await import('./web-render.js'); result = await renderWeb(source.bytes, artifact, request.operation === 'capture' ? request.input : undefined, options);
   }
  }
 }
 if (result.evidence) {
  try { await assertCurrentSource(options.workspaceRoot, result.evidence.source); }
  catch (error) { if (!(error instanceof Error) || !/Stale artifact source hash/.test(error.message)) throw error;
   const diagnostic = { code: 'stale-source', message: 'Source or dependency changed during capture. Capture the current revision again.', blocking: true };
   return { ...result, status: 'unverified', diagnostics: [...result.diagnostics, diagnostic], evidence: { ...result.evidence, diagnostics: [...result.evidence.diagnostics, diagnostic] } };
  }
 }
 return result;
}
function missingBrowser(): ArtifactResult { return { status: 'unverified', diagnostics: [{ code: 'missing-browser', message: 'Prepare a compatible browser explicitly before this operation.', blocking: true }] }; }
