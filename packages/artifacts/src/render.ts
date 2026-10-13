import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import type { PresentationData, SlideHandle } from '@aiden0z/pptx-renderer';
import type { PresentationRef, ArtifactResult, Diagnostic, RasterEvidence, RenderInput } from './types.js';
import type { ArtifactRuntimeOptions } from './runtime.js';
import { hashBytes } from './files.js';
import { convertWithLibreOffice } from './libreoffice.js';
import { saveEvidence } from './evidence-files.js';
import { decodeArtifactResult } from './contract.js';

type RendererApi = typeof import('@aiden0z/pptx-renderer');
declare global { interface Window { kodaxArtifactRender?: { kit: RendererApi; presentation: PresentationData; handle?: SlideHandle } } }
type PdfApi = typeof import('pdfjs-dist');
declare global { interface Window { kodaxArtifactPdf?: Awaited<ReturnType<PdfApi['getDocument']>['promise']> } }
export function defaultBrowserExecutable(): string { return process.env.KODAX_ARTIFACT_BROWSER_EXECUTABLE ?? chromium.executablePath(); }
export async function renderPresentation(bytes: Buffer, artifact: PresentationRef, input: RenderInput,
 diagnostics: readonly Diagnostic[], options: ArtifactRuntimeOptions): Promise<ArtifactResult> {
 const findings = [...diagnostics];
 if (input.backend === 'libreoffice' && !options.libreOfficeExecutable) return { status: 'unverified', artifact, diagnostics: [...findings,
   { code: 'libreoffice-unavailable', message: 'Prepare LibreOffice only when this conversion backend is needed.', blocking: true }] };
 const executable = options.browserExecutable ?? defaultBrowserExecutable();
 try { await fs.access(executable); }
 catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  return { status: 'unverified', artifact, diagnostics: [...findings, { code: 'missing-browser', message: 'Prepare a compatible browser runtime before rendering.', blocking: true }] }; }
 const pages = input.pages ?? Array.from({ length: artifact.pages }, (_, index) => index + 1);
 if (options.maxRenderPages !== undefined && pages.length > options.maxRenderPages) throw new Error('Specify a render batch of at most ' + options.maxRenderPages + ' pages.');
 if (!pages.length || pages.some(page => !Number.isInteger(page) || page < 1 || page > artifact.pages)) throw new Error('Invalid render pages.');
 const directory = await fs.mkdtemp(path.join(options.workspaceRoot, '.artifact-render-'));
 const converted = input.backend === 'libreoffice' ? await convertWithLibreOffice(bytes, directory, options) : undefined;
 const engineFile = fileURLToPath(import.meta.resolve(converted ? 'pdfjs-dist/build/pdf.mjs' : '@aiden0z/pptx-renderer/browser'));
 const engine = await fs.readFile(engineFile, 'utf8');
 const worker = converted ? await fs.readFile(fileURLToPath(import.meta.resolve('pdfjs-dist/build/pdf.worker.mjs')), 'utf8') : '';
 const packageInfo: unknown = JSON.parse(await fs.readFile(path.resolve(path.dirname(engineFile), '../package.json'), 'utf8'));
 const version = typeof packageInfo === 'object' && packageInfo !== null && 'version' in packageInfo && typeof packageInfo.version === 'string' ? packageInfo.version : 'unknown';
 const browser = await chromium.launch({ executablePath: executable, headless: true });
 let cancelledClose: Promise<void> | undefined;
 let closeFailure: unknown;
 const cancel = () => { cancelledClose = browser.close(); void cancelledClose.catch(error => { closeFailure = error; }); };
 options.signal?.addEventListener('abort', cancel, { once: true });
 if (options.signal?.aborted) cancel();
 const evidence: RasterEvidence[] = [];
 const layout: { page: number; width: number; height: number; rotation: number; scale: number }[] = [];
 const source = { kind: 'file' as const, file: artifact };
 try {
   const context = await browser.newContext({ deviceScaleFactor: 1 });
   await context.route('**/*', route => {
     const url = route.request().url();
     if (url.startsWith('data:') || url.startsWith('blob:') || url === 'about:blank') return route.continue();
     findings.push({ code: 'blocked-resource', message: 'External resource was blocked by the render policy.', blocking: true });
     return route.abort('blockedbyclient');
   });
   const page = await context.newPage();
   page.setDefaultTimeout(30_000);
   const dimensions = await page.evaluate(async ({ code, base64, pdfWorker }) => {
     const moduleUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
     try {
       // 浏览器内导入不能经过宿主 SSR/bundler 的动态 import 重写。
       const load = new Function('url', 'return import(url)') as (url: string) => Promise<RendererApi>;
       const data = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
       if (pdfWorker) {
        const pdfKit = await load(moduleUrl) as unknown as PdfApi;
        pdfKit.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([pdfWorker], { type: 'text/javascript' }));
        const document = await pdfKit.getDocument({ data, useSystemFonts: true, isEvalSupported: false }).promise;
        window.kodaxArtifactPdf = document;
        const viewport = (await document.getPage(1)).getViewport({ scale: 4 / 3 });
        return { width: viewport.width, height: viewport.height, pages: document.numPages };
       }
       const kit = await load(moduleUrl);
       const files = await kit.parseZipLazyMedia(data.buffer, kit.RECOMMENDED_ZIP_LIMITS);
       const presentation = kit.buildPresentation(files, { lazySlides: true });
       window.kodaxArtifactRender = { kit, presentation };
       document.body.style.margin = '0'; document.body.style.background = 'white';
       return { width: presentation.width, height: presentation.height, pages: presentation.slides.length };
     } finally { URL.revokeObjectURL(moduleUrl); }
   }, { code: engine, base64: (converted?.bytes ?? bytes).toString('base64'), pdfWorker: worker });
   if (dimensions.pages !== artifact.pages) findings.push({ code: 'page-count-mismatch', message: 'Rendered page count differs from the current PPTX.', blocking: true });
   if (dimensions.width <= 0 || dimensions.height <= 0 || dimensions.width > 8192 || dimensions.height > 8192) throw new Error('Invalid rendered slide size.');
   await page.setViewportSize({ width: Math.ceil(dimensions.width), height: Math.ceil(dimensions.height) });
   for (const number of pages) {
     if (options.signal?.aborted) throw new DOMException('Artifact rendering cancelled.', 'AbortError');
     const result = await page.evaluate(async index => {
       if (window.kodaxArtifactPdf) {
        document.body.replaceChildren();
        const pdfPage = await window.kodaxArtifactPdf.getPage(index + 1), viewport = pdfPage.getViewport({ scale: 4 / 3 });
        const canvas = document.createElement('canvas'); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
        document.body.append(canvas);
        await pdfPage.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise;
        return { errors: [] as string[], width: canvas.width, height: canvas.height, rotation: viewport.rotation, scale: 4 / 3 };
       }
       const state = window.kodaxArtifactRender;
       if (!state) throw new Error('Renderer state missing.');
       state.handle?.dispose(); document.body.replaceChildren();
       const errors: string[] = [];
       const handle = state.kit.renderSlide(state.presentation, state.presentation.slides[index]!, {
         onNodeError: (id: string, error: unknown) => errors.push(id + ': ' + String(error)), onNavigate: () => undefined, pdfjs: false,
       });
       state.handle = handle; document.body.append(handle.element);
       const checkFonts = () => {
       const canvas = document.createElement('canvas'), probe = canvas.getContext('2d')!;
       const families = new Set([...handle.element.querySelectorAll('*')].map(element => getComputedStyle(element).fontFamily.split(',')[0]!.replace(/["']/g, '').trim()));
       const sample = 'mmmmmmmmWWWW1234567890';
       for (const family of families) {
        if (!family || ['serif', 'sans-serif', 'monospace', 'system-ui'].includes(family)) continue;
        const available = ['monospace', 'serif'].some(fallback => {
         probe.font = '32px ' + fallback; const baseline = probe.measureText(sample).width;
         probe.font = '32px "' + family.replace(/"/g, '') + '",' + fallback;
         return probe.measureText(sample).width !== baseline;
        });
        if (!available) errors.push('Font unavailable: ' + family);
       }
       };
       let timeout: ReturnType<typeof setTimeout> | undefined;
       try {
         await Promise.race([Promise.resolve().then(async () => {
           await handle.ready; await document.fonts.ready; checkFonts();
           await Promise.all([...handle.element.querySelectorAll('img')].map(async image => {
             try { await image.decode(); if (!image.naturalWidth || !image.naturalHeight) errors.push('Empty image.'); }
             catch { errors.push('Image decoding failed.'); }
           }));
           let previous = '', stable = 0;
           for (let frame = 0; frame < 20; frame++) {
             await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
             const signature = [...handle.element.querySelectorAll('div,span,svg,canvas,img')].slice(0, 2000)
               .map(element => { const rect = element.getBoundingClientRect(); return [rect.x, rect.y, rect.width, rect.height].join(','); }).join(';');
             stable = signature === previous ? stable + 1 : 0; previous = signature;
             if (stable >= 3) break;
           }
           if (stable < 3) errors.push('Layout did not stabilize.');
         }), new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Render resources timed out.')), 20_000); })]);
       } finally { if (timeout) clearTimeout(timeout); }
       return { errors, width: state.presentation.width, height: state.presentation.height, rotation: 0, scale: 1 };
     }, number - 1);
     for (const message of result.errors) findings.push({ code: 'render-resource', message, page: number, blocking: true });
     if (result.width <= 0 || result.height <= 0 || result.width > 8192 || result.height > 8192 || result.width * result.height > 40_000_000) throw new Error('Invalid rendered page size.');
     await page.setViewportSize({ width: Math.ceil(result.width), height: Math.ceil(result.height) });
     const image = await page.screenshot();
     evidence.push(await saveEvidence(directory, 'slide-' + number, image, source, { kind: 'paginated', page: number }));
     layout.push({ page: number, width: Math.ceil(result.width), height: Math.ceil(result.height), rotation: result.rotation, scale: result.scale });
   }
   await context.close();
 } finally {
   options.signal?.removeEventListener('abort', cancel);
   await (cancelledClose ?? browser.close());
   if (closeFailure) throw closeFailure;
 }
 return decodeArtifactResult('render', { status: findings.some(item => item.blocking) ? 'unverified' : 'ready', artifact, diagnostics: findings,
   evidence: { kind: 'paginated', source, scope: { pages }, evidence, layout: { totalPages: artifact.pages, pages: layout },
     engine: { name: converted ? 'LibreOffice/PDF.js' : '@aiden0z/pptx-renderer', version: converted ? converted.version + '/PDF.js ' + version : version }, diagnostics: findings } });
}
