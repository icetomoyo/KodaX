import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { KodaXExtensionAPI, ExtensionExecutionScope, ManagedProcessInput, ToolResult } from '@kodax-ai/kodax/coding';
import { artifactToolName, decodeArtifactRequest, decodeArtifactWireResult } from './contract.js';

export interface KodaXArtifactOptions {
 readonly execute: (scope: ExtensionExecutionScope, input: ManagedProcessInput) => Promise<ToolResult>;
 readonly nodeExecutable: string;
 readonly browserExecutable?: string;
 readonly libreOfficeExecutable?: string;
}
const text = { type: 'string' };
const file = { path: text, expectedSourceHash: text };
const box = { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } }, required: ['x', 'y', 'width', 'height'] };
const operations = {
 prepare: { description: 'Explicitly prepare compatible Chromium through the admitted runtime. Network/cache writes use normal permission and sandbox gates. Never implies visual approval.', properties: {}, required: [] },
 readEvidence: { description: 'Read a returned raster with source/dependency, provenance, SHA256 and geometry checks. Delivers actual PNG through the image channel.',
  properties: { source: { type: 'object' }, raster: { type: 'object' } }, required: ['source', 'raster'] },
 capabilities: { description: 'Inspect artifact runtime candidates. Readiness is not a visual pass.', properties: {}, required: [] },
 create: { description: 'Create a NEW wide PPTX. Elements: text (text/fontSize/fontFace/color), rectangle (color), image (workspace path), table (rows), chart (categories/values). Each has type,x,y,width,height in inches. Render the exported file before visual review.',
  properties: { output: text, slides: { type: 'array', items: { type: 'object', properties: { elements: { type: 'array', items: { type: 'object', properties: {
   ...box.properties, type: { type: 'string', enum: ['text', 'rectangle', 'image', 'table', 'chart'] }, text, fontSize: { type: 'number' }, fontFace: text, color: text, path: text,
   rows: { type: 'array', items: { type: 'array', items: text } }, categories: { type: 'array', items: text }, values: { type: 'array', items: { type: 'number' } }, name: text,
  }, required: ['type', ...box.required] } } }, required: ['elements'] } } }, required: ['output', 'slides'] },
 open: { description: 'Inspect actual PPTX/PDF/DOCX/image/SVG/HTML format and source SHA256. PPTX/PDF have intrinsic pages; DOCX pagination belongs to render output. Structure is not a visual pass.', properties: file, required: ['path'] },
 edit: { description: 'Edit single-run single-paragraph PPTX text shapes or explicit geometry (inches) into a NEW file. Requires current source hash and object IDs from artifact_open. Rich text/table/chart text edits and unsupported preservation are rejected; geometry repair remains available. Render the new file after repair.',
  properties: { ...file, output: text, changes: { type: 'array', items: { type: 'object', properties: { page: { type: 'integer' }, objectId: text, text, box }, required: ['page', 'objectId'] } } }, required: ['path', 'expectedSourceHash', 'output', 'changes'] },
 export: { description: 'Export exact source PPTX to a new exclusive path. Does not convert formats or overwrite.', properties: { ...file, output: text }, required: ['path', 'output'] },
 render: { description: 'Render actual PPTX/PDF/DOCX pages or static PNG/JPEG/WebP/SVG into PNG evidence. Up to 4 pages per call; use batches. DOCX is a lightweight candidate with Word/WPS fidelity unverified. Optional LibreOffice applies only to PPTX. ready means pixels prepared, never approval. Inspect delivered images and recapture after repair.',
  properties: { ...file, pages: { type: 'array', items: { type: 'integer' }, maxItems: 4 }, backend: { type: 'string', enum: ['lightweight', 'libreoffice'] } }, required: ['path'] },
 capture: { description: 'Capture image/SVG regions, PDF/DOCX pages, local HTML loaded state at explicit viewport (sequence 0), or SVG SMIL samples at actual seconds. Live surfaces need their existing authorized owner. GIF/video/3D/native apps unsupported. A screenshot never checks interactions or continuous playback.',
  properties: { kind: { type: 'string', enum: ['static', 'paginated', 'interactive', 'temporal'] }, target: text, expectedSource: { type: 'object' }, background: text,
   locators: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string', enum: ['static', 'paginated', 'interactive', 'temporal'] }, region: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 }, page: { type: 'integer' }, sheet: text, range: text, target: text, state: text, viewport: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 }, camera: text, sequence: { type: 'integer' }, time: { type: 'number' }, frame: { type: 'integer' } }, required: ['kind'] } },
  }, required: ['kind', 'target', 'locators'] },
} as const;

/** Optional bridge: host authority is injected; no independent Session owner. */
export function registerArtifactTools(api: KodaXExtensionAPI, options: KodaXArtifactOptions): () => void {
 if (!path.isAbsolute(options.nodeExecutable)) throw new Error('Artifact Node executable must be absolute.');
 const removers = [api.registerSkillPath(fileURLToPath(new URL('../skills', import.meta.url)))];
 for (const [operation, definition] of Object.entries(operations)) removers.push(api.registerTool({
  name: artifactToolName(operation as keyof typeof operations), description: definition.description,
  input_schema: { type: 'object', properties: definition.properties, required: [...definition.required] },
  sideEffect: 'mutates-shell', interruptBehavior: 'cancel',
  toClassifierInput: input => {
   const fields = input as Record<string, unknown>;
   return 'Artifact ' + operation + ' path=' + JSON.stringify(fields.path ?? '') + ' output=' + JSON.stringify(fields.output ?? '');
  },
  handler: async (input, context) => {
   const scope = api.getExecutionScope();
   if (!scope) throw new Error('Artifact operations require an admitted execution scope.');
   if (scope.signal.aborted) return '[Cancelled] Artifact operation was not started.';
   const workspaceRoot = context.executionCwd ?? context.gitRoot;
   if (!workspaceRoot) throw new Error('Artifact workspace is unavailable.');
   if (operation === 'render' && Array.isArray(input.pages) && input.pages.length > 4) throw new Error('Render at most four pages per call.');
   const request = decodeArtifactRequest({ operation, input });
   const requestPath = path.join(context.sessionScratchDir ?? workspaceRoot, '.artifact-request-' + randomUUID() + '.json');
   const manifest = JSON.stringify({ request, options: { workspaceRoot,
    browserExecutable: options.browserExecutable, libreOfficeExecutable: options.libreOfficeExecutable, maxRenderPages: 4 } });
   const manifestHash = createHash('sha256').update(manifest).digest('hex');
   const staged = await scope.invokeTool('write', { path: requestPath, content: manifest });
   if (typeof staged !== 'string' || /^\[(?:Error|Blocked|Cancelled|Sandbox)/.test(staged)) return staged;
   const output = await options.execute(scope, { executable: options.nodeExecutable,
    args: [fileURLToPath(new URL('./runtime-entry.js', import.meta.url)), requestPath, manifestHash], timeoutSeconds: operation === 'prepare' ? 600 : 120 });
   if (typeof output !== 'string') return output;
   if (!output.includes('\nExit: 0\n')) return /^\[(?:Tool Error|Error|Blocked|Cancelled|Sandbox)/.test(output) ? output : '[Tool Error] Artifact worker did not complete.\n' + output;
   const line = output.split('\n').find(value => value.startsWith('ARTIFACT_RESULT:'));
   if (!line) throw new Error('Artifact worker result missing or truncated.');
   const result = decodeArtifactWireResult(request, JSON.parse(line.slice('ARTIFACT_RESULT:'.length)));
   const content: Exclude<ToolResult, string>[number][] = [];
   for (const evidence of result.imageRef ? [result.imageRef] : result.evidence?.evidence ?? []) {
    const read = await scope.invokeTool('read', { path: evidence.path });
    if (typeof read === 'string' || !read.some(item => item.type === 'image')) {
     const diagnostic = { code: 'image-delivery', message: 'Rendered pixels could not be delivered to the agent.', blocking: true };
     return JSON.stringify({ ...result, protocol: 'kodax-artifact/1', operation, status: 'unverified',
      diagnostics: [...result.diagnostics, diagnostic], ...(result.evidence ? { evidence: { ...result.evidence, diagnostics: [...result.evidence.diagnostics, diagnostic] } } : {}) });
    }
    content.push(...read);
   }
   return [{ type: 'text', text: JSON.stringify({ ...result, protocol: 'kodax-artifact/1', operation }) }, ...content];
  },
 }));
 return () => { for (const remove of removers.reverse()) remove(); };
}
