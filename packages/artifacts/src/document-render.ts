import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import type { Page } from 'playwright-core';
import type { ArtifactRef, ArtifactResult, Diagnostic, RenderInput, RasterEvidence } from './types.js';
import type { ArtifactRuntimeOptions } from './runtime.js';
import { withArtifactPage } from './browser.js';
import { saveEvidence } from './evidence-files.js';
import { decodeArtifactResult } from './contract.js';

type PdfApi = typeof import('pdfjs-dist');
type DocxApi = typeof import('docx-renderer');
declare global { interface Window { kodaxDocx?: DocxApi } }

async function loadPdf(page: Page, bytes: Buffer): Promise<number> {
 const code = await fs.readFile(fileURLToPath(import.meta.resolve('pdfjs-dist/build/pdf.mjs')), 'utf8');
 const worker = await fs.readFile(fileURLToPath(import.meta.resolve('pdfjs-dist/build/pdf.worker.mjs')), 'utf8');
 return page.evaluate(async ({ code, worker, base64 }) => {
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  try {
   const load = new Function('url', 'return import(url)') as (url: string) => Promise<PdfApi>;
   const api = await load(url); api.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([worker], { type: 'text/javascript' }));
   window.kodaxArtifactPdf = await api.getDocument({ data: Uint8Array.from(atob(base64), c => c.charCodeAt(0)), useSystemFonts: true, isEvalSupported: false }).promise;
   return window.kodaxArtifactPdf.numPages;
  } finally { URL.revokeObjectURL(url); }
 }, { code, worker, base64: bytes.toString('base64') });
}
async function loadDocx(page: Page, bytes: Buffer, findings: Diagnostic[]): Promise<number> {
 const zip = await JSZip.loadAsync(bytes);
 // Valid minimal Word files may omit settings. Normalize only the render snapshot.
 if (!zip.file('word/settings.xml')) {
  zip.file('word/settings.xml', '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>');
  const relations = zip.file('word/_rels/document.xml.rels');
  const xml = relations ? await relations.async('string') : '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
  zip.file('word/_rels/document.xml.rels', xml.replace(/<\/Relationships\s*>/, '<Relationship Id="kodaxRenderSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/></Relationships>'));
  findings.push({ code: 'docx-default-settings', message: 'Missing optional settings were supplied only to the lightweight render snapshot.' });
 }
 findings.push({ code: 'docx-preview-fidelity', message: 'docx-renderer is a lightweight candidate. Word/WPS fidelity, fields, floating objects and complex sections remain unverified.', blocking: true });
 await page.setContent('<html><body style="margin:0"><div id="styles"></div><div id="body"></div></body></html>');
 await page.addScriptTag({ content: await fs.readFile(new URL('../dist/docx.browser.js', import.meta.url), 'utf8') });
 const count = await page.evaluate(async base64 => {
  if (!window.kodaxDocx) throw new Error('DOCX renderer missing.');
  await window.kodaxDocx.render(Uint8Array.from(atob(base64), c => c.charCodeAt(0)), document.getElementById('body')!, document.getElementById('styles')!,
   { breakPages: true, ignoreLastRenderedPageBreak: false, renderHeaders: true, renderFooters: true });
  await document.fonts.ready;
  await Promise.all(Array.from(document.images).map(image => image.decode()));
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  return document.querySelectorAll('#body section').length;
 }, (await zip.generateAsync({ type: 'nodebuffer' })).toString('base64'));
 return count;
}
export async function processDocument(bytes: Buffer, file: Omit<ArtifactRef, 'pages'> & { format: 'pdf' | 'docx' }, input: RenderInput | undefined,
 options: ArtifactRuntimeOptions): Promise<ArtifactResult> {
 const findings: Diagnostic[] = [];
 return withArtifactPage(options, async page => {
  await page.context().route('**/*', route => {
   if (/^(?:data:|blob:|about:blank)/.test(route.request().url())) return route.continue();
   findings.push({ code: 'blocked-resource', message: 'External document resource was blocked.', blocking: true }); return route.abort('blockedbyclient');
  });
  const total = file.format === 'pdf' ? await loadPdf(page, bytes) : input ? await loadDocx(page, bytes, findings) : undefined;
  const artifact: ArtifactRef = file.format === 'pdf' ? { path: file.path, sourceHash: file.sourceHash, format: 'pdf', pages: total! } : { path: file.path, sourceHash: file.sourceHash, format: 'docx' };
  if (!input) return { status: 'ready', artifact, diagnostics: [] };
  if (!total || total > 1000) throw new Error('Document page limit exceeded or no pages rendered.');
  const pages = input.pages ?? Array.from({ length: total }, (_, index) => index + 1);
  if (!pages.length || pages.some(n => n < 1 || n > total)) throw new Error('Invalid render pages.');
  if (options.maxRenderPages !== undefined && pages.length > options.maxRenderPages) throw new Error('Specify a render batch of at most ' + options.maxRenderPages + ' pages.');
  const directory = await fs.mkdtemp(path.join(options.workspaceRoot, '.artifact-render-'));
  const source = { kind: 'file' as const, file: artifact }, rasters: RasterEvidence[] = [];
  const layout: { page: number; width: number; height: number; rotation: number; scale: number }[] = [];
  for (const number of pages) {
   options.signal?.throwIfAborted();
   if (file.format === 'pdf') {
    const geometry = await page.evaluate(async number => {
     const pdfPage = await window.kodaxArtifactPdf!.getPage(number), viewport = pdfPage.getViewport({ scale: 4 / 3 });
     const width = Math.ceil(viewport.width), height = Math.ceil(viewport.height);
     if (width <= 0 || height <= 0 || width > 8192 || height > 8192 || width * height > 40_000_000) throw new Error('PDF pixel limit exceeded.');
     document.body.replaceChildren(); document.body.style.margin = '0';
     const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; document.body.append(canvas);
     await pdfPage.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport, annotationMode: 0 }).promise;
     return { width, height, rotation: viewport.rotation, scale: 4 / 3 };
    }, number);
    await page.setViewportSize({ width: geometry.width, height: geometry.height });
    rasters.push(await saveEvidence(directory, 'page-' + number, await page.screenshot(), source, { kind: 'paginated', page: number }));
    layout.push({ page: number, ...geometry });
   } else {
    const section = page.locator('#body section').nth(number - 1), box = await section.boundingBox();
    if (!box || box.width <= 0 || box.height <= 0 || box.width > 8192 || box.height > 8192 || box.width * box.height > 40_000_000) throw new Error('DOCX pixel limit exceeded.');
    const image = await saveEvidence(directory, 'page-' + number, await section.screenshot(), source, { kind: 'paginated', page: number });
    rasters.push(image); layout.push({ page: number, width: image.width, height: image.height, rotation: 0, scale: 1 });
   }
  }
  if (file.format === 'pdf') findings.push({ code: 'pdf-scope', message: 'PDF.js page content at 96 DPI; interactive forms and annotation appearance are outside this capture.' });
  return decodeArtifactResult('render', { status: findings.some(d => d.blocking) ? 'unverified' : 'ready', artifact, diagnostics: findings,
   evidence: { kind: 'paginated', source, engine: { name: file.format === 'pdf' ? 'PDF.js' : 'docx-renderer', version: file.format === 'pdf' ? '5.4.296' : '0.2.2' },
    diagnostics: findings, scope: { pages }, evidence: rasters, layout: { totalPages: total, pages: layout } } });
 });
}
