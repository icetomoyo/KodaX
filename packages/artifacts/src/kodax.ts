import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { KodaXExtensionAPI, ExtensionExecutionScope, ManagedProcessInput, ToolResult } from '@kodax-ai/kodax/coding';
import type { ArtifactRequest, ArtifactResult } from './types.js';

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
 capabilities: { description: 'Inspect artifact runtime candidates. Readiness is not a visual pass.', properties: {}, required: [] },
 create: { description: 'Create a NEW wide PPTX. Elements: text (text/fontSize/fontFace/color), rectangle (color), image (workspace path), table (rows), chart (categories/values). Each has type,x,y,width,height in inches. Render the exported file before visual review.',
  properties: { output: text, slides: { type: 'array', items: { type: 'object', properties: { elements: { type: 'array', items: { type: 'object', properties: {
   ...box.properties, type: { type: 'string', enum: ['text', 'rectangle', 'image', 'table', 'chart'] }, text, fontSize: { type: 'number' }, fontFace: text, color: text, path: text,
   rows: { type: 'array', items: { type: 'array', items: text } }, categories: { type: 'array', items: text }, values: { type: 'array', items: { type: 'number' } }, name: text,
  }, required: ['type', ...box.required] } } }, required: ['elements'] } } }, required: ['output', 'slides'] },
 open: { description: 'Inspect PPTX source SHA256, page count and object IDs. Structural inspection does not verify appearance.', properties: file, required: ['path'] },
 edit: { description: 'Edit single-run single-paragraph PPTX text shapes or explicit geometry (inches) into a NEW file. Requires current source hash and object IDs from artifact_open. Rich text/table/chart text edits and unsupported preservation are rejected; geometry repair remains available. Render the new file after repair.',
  properties: { ...file, output: text, changes: { type: 'array', items: { type: 'object', properties: { page: { type: 'integer' }, objectId: text, text, box }, required: ['page', 'objectId'] } } }, required: ['path', 'expectedSourceHash', 'output', 'changes'] },
 export: { description: 'Export exact source PPTX to a new exclusive path. Does not convert formats or overwrite.', properties: { ...file, output: text }, required: ['path', 'output'] },
 render: { description: 'Render current exported PPTX pages and return actual PNG images for your visual review. Up to 4 pages per call; use batches for all required pages. Default lightweight browser, no PowerPoint or LibreOffice needed. LibreOffice optional. ready means pixels prepared, never visual approval. Inspect images, repair issues, then render the new revision. Animation/unsupported content/missing resources remain unverified.',
  properties: { ...file, pages: { type: 'array', items: { type: 'integer' }, maxItems: 4 }, backend: { type: 'string', enum: ['lightweight', 'libreoffice'] } }, required: ['path'] },
 capture: { description: 'Visual contract: static image/SVG/diagram regions; paginated PDF/docs/sheets; interactive HTML/apps/terminal/3D target/states/viewport/camera; temporal video/GIF/animation times. This initial runtime has no capture adapters: returns unverified. A screenshot never checks interactions or full playback.',
  properties: { kind: { type: 'string', enum: ['static', 'paginated', 'interactive', 'temporal'] }, target: text, pages: { type: 'array', items: { type: 'integer' } }, states: { type: 'array', items: text }, times: { type: 'array', items: { type: 'number' } }, viewport: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 }, camera: text,
   locators: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string', enum: ['static', 'paginated', 'interactive', 'temporal'] }, region: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 }, page: { type: 'integer' }, sheet: text, range: text, target: text, state: text, viewport: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 }, camera: text, sequence: { type: 'integer' }, time: { type: 'number' }, frame: { type: 'integer' } }, required: ['kind'] } },
  }, required: ['kind', 'target'] },
} as const;

/** Optional bridge: host authority is injected; no independent Session owner. */
export function registerArtifactTools(api: KodaXExtensionAPI, options: KodaXArtifactOptions): () => void {
 if (!path.isAbsolute(options.nodeExecutable)) throw new Error('Artifact Node executable must be absolute.');
 const removers = [api.registerSkillPath(fileURLToPath(new URL('../skills', import.meta.url)))];
 removers.push(api.registerTool({ name: 'artifact_prepare', description: 'Install pinned compatible Chromium when missing, through managed execution. Network and cache writes require normal permission/sandbox admission. Does not install LibreOffice or approve visual results.',
  input_schema: { type: 'object', properties: {}, required: [] }, sideEffect: 'mutates-shell', interruptBehavior: 'cancel',
  toClassifierInput: () => 'Artifact prepare: download Chromium into the managed runtime cache',
  handler: async () => {
   const scope = api.getExecutionScope(); if (!scope) throw new Error('Artifact preparation requires an admitted execution scope.');
   return options.execute(scope, { executable: options.nodeExecutable,
    args: [fileURLToPath(new URL('cli.js', import.meta.resolve('playwright-core/package.json'))), 'install', 'chromium'], timeoutSeconds: 600 });
  },
 }));
 for (const [operation, definition] of Object.entries(operations)) removers.push(api.registerTool({
  name: 'artifact_' + operation, description: definition.description,
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
   const request = { operation, input } as ArtifactRequest;
   const requestPath = path.join(context.sessionScratchDir ?? workspaceRoot, '.artifact-request-' + randomUUID() + '.json');
   const manifest = JSON.stringify({ request, options: { workspaceRoot,
    browserExecutable: options.browserExecutable, libreOfficeExecutable: options.libreOfficeExecutable, maxRenderPages: 4 } });
   const manifestHash = createHash('sha256').update(manifest).digest('hex');
   const staged = await scope.invokeTool('write', { path: requestPath, content: manifest });
   if (typeof staged !== 'string' || /^\[(?:Error|Blocked|Cancelled|Sandbox)/.test(staged)) return staged;
   const output = await options.execute(scope, { executable: options.nodeExecutable,
    args: [fileURLToPath(new URL('./runtime-entry.js', import.meta.url)), requestPath, manifestHash], timeoutSeconds: 120 });
   if (typeof output !== 'string' || !output.includes('\nExit: 0\n')) return output;
   const line = output.split('\n').find(value => value.startsWith('ARTIFACT_RESULT:'));
   if (!line) throw new Error('Artifact worker result missing or truncated.');
   const result = JSON.parse(line.slice('ARTIFACT_RESULT:'.length)) as ArtifactResult;
   const content: Exclude<ToolResult, string>[number][] = [];
   for (const evidence of result.evidence?.evidence ?? []) {
    const read = await scope.invokeTool('read', { path: evidence.path });
    if (typeof read === 'string' || !read.some(item => item.type === 'image')) {
     return JSON.stringify({ ...result, status: 'unverified', diagnostics: [...result.diagnostics, { code: 'image-delivery', message: 'Rendered pixels could not be delivered to the agent.', blocking: true }] });
    }
    content.push(...read);
   }
   return [{ type: 'text', text: JSON.stringify(result) }, ...content];
  },
 }));
 return () => { for (const remove of removers.reverse()) remove(); };
}
