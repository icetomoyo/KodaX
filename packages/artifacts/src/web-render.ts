import fs from 'node:fs/promises';
import path from 'node:path';
import type { ArtifactRef, ArtifactResult, CaptureInput, Diagnostic, EvidenceLocator, RasterEvidence, VisualSource } from './types.js';
import type { ArtifactRuntimeOptions } from './runtime.js';
import { withArtifactPage } from './browser.js';
import { artifactPath, hashBytes } from './files.js';
import { saveEvidence } from './evidence-files.js';
import { decodeArtifactResult } from './contract.js';

const media: Record<string, string> = { '.html': 'text/html', '.htm': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
 '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.json': 'application/json' };
export async function renderWeb(bytes: Buffer, artifact: ArtifactRef, input: CaptureInput | undefined, options: ArtifactRuntimeOptions): Promise<ArtifactResult> {
 const findings: Diagnostic[] = [], dependencies = new Map<string, string>();
 const locators: readonly EvidenceLocator[] = input?.locators ?? [{ kind: 'static' }];
 const kind = input?.kind ?? 'static';
 if (artifact.format === 'html' && input?.background !== undefined) throw new Error('HTML capture uses its own CSS background; background override is only supported for images/SVG.');
 if (artifact.format === 'html' && (kind !== 'interactive' || locators.some(l => l.kind !== 'interactive' || l.state !== 'loaded' || l.target !== input?.target || l.sequence !== 0 || l.camera !== undefined))) {
  return { status: 'unverified', diagnostics: [{ code: 'surface-state-unavailable', message: 'Local HTML supports only the loaded state, sequence 0. Live application states must be captured by their existing authorized owner.', blocking: true }] };
 }
 if ((kind === 'temporal' && artifact.format !== 'svg') || kind === 'paginated' || (kind === 'interactive' && artifact.format !== 'html')) return { status: 'unverified', diagnostics: [{ code: 'capture-unavailable', message: 'This format does not support the requested capture kind.', blocking: true }] };
 if (locators.length > (options.maxRenderPages ?? 1000)) throw new Error('Specify a bounded capture batch.');
 if (artifact.format === 'webp' && bytes.includes(Buffer.from('ANIM'))) return { status: 'unverified', diagnostics: [{ code: 'animated-webp', message: 'Animated WebP needs a temporal decoder; a single image is insufficient.', blocking: true }] };
 const directory = await fs.mkdtemp(path.join(options.workspaceRoot, '.artifact-render-'));
 return withArtifactPage(options, async page => {
  let totalBytes = bytes.length;
  await page.context().route('**/*', async route => {
   const request = route.request(), url = new URL(request.url());
   if (url.protocol === 'data:' || url.protocol === 'blob:') return route.continue();
   try {
    if (url.origin !== 'https://kodax-artifact.invalid' || request.method() !== 'GET') throw new Error('External/mutating request is outside local capture.');
    const relative = decodeURIComponent(url.pathname.slice(1));
    if (relative.split(/[\\/]/).some(p => ['.git', '.kodax'].includes(p.toLowerCase()))) throw new Error('Protected resource namespace.');
    const extension = path.extname(relative).toLowerCase(); if (!media[extension]) throw new Error('Unsupported local resource type.');
    const file = await artifactPath(options.workspaceRoot, relative), actual = await fs.realpath(file);
    if (path.relative(await fs.realpath(options.workspaceRoot), actual).split(path.sep).some(p => ['.git', '.kodax'].includes(p.toLowerCase()))) throw new Error('Protected resource namespace.');
    const data = file === artifact.path ? bytes : await fs.readFile(file);
    if (file !== artifact.path) { totalBytes += data.length; if (dependencies.size >= 64 || totalBytes > 32 * 1024 * 1024) throw new Error('Local dependency limit exceeded.');
     const sha = hashBytes(data), previous = dependencies.get(file);
     if (previous !== undefined && previous !== sha) throw new Error('Dependency changed between captures.'); dependencies.set(file, sha); }
    await route.fulfill({ status: 200, contentType: media[extension], body: data });
   } catch (error) { findings.push({ code: 'blocked-resource', message: error instanceof Error ? error.message : String(error), blocking: true }); await route.abort('blockedbyclient'); }
  });
  page.on('pageerror', error => findings.push({ code: 'page-script-error', message: error.message, blocking: true }));
  const sourceUrl = 'https://kodax-artifact.invalid/' + path.relative(options.workspaceRoot, artifact.path).split(path.sep).map(encodeURIComponent).join('/');
  const evidence: RasterEvidence[] = [];
  let previousTime = -1;
  for (const [index, locator] of locators.entries()) {
   options.signal?.throwIfAborted();
   if (locator.kind === 'interactive') {
    const [width, height] = locator.viewport;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width > 8192 || height > 8192 || width * height > 40_000_000) throw new Error('Invalid capture viewport.');
    await page.setViewportSize({ width, height });
   }
   await page.goto(sourceUrl, { waitUntil: 'load' });
   const missingImages = await page.evaluate(async () => {
    await document.fonts.ready;
    const decoded = await Promise.allSettled(Array.from(document.images).map(image => image.decode()));
    return decoded.filter(result => result.status === 'rejected').length;
   });
   if (missingImages) findings.push({ code: 'image-resource', message: missingImages + ' image resource(s) could not decode.', blocking: true });
   if (artifact.format !== 'html') {
    const dimensions = await page.evaluate(() => {
     document.body?.style.setProperty('margin', '0');
     const svg = document.documentElement instanceof SVGSVGElement ? document.documentElement : document.querySelector('svg');
     if (svg) return { width: svg.width.baseVal.value || svg.viewBox.baseVal.width, height: svg.height.baseVal.value || svg.viewBox.baseVal.height };
     const image = document.querySelector('img'); if (!image) throw new Error('Image content did not decode.');
     return { width: image.naturalWidth, height: image.naturalHeight };
    });
    if (!dimensions.width || !dimensions.height || dimensions.width > 8192 || dimensions.height > 8192 || dimensions.width * dimensions.height > 40_000_000) throw new Error('Image pixel limit exceeded.');
    await page.setViewportSize({ width: Math.ceil(dimensions.width), height: Math.ceil(dimensions.height) });
    await page.evaluate(background => { if (!CSS.supports('color', background)) throw new Error('Invalid image background color.');
     const root = document.documentElement; root.style.backgroundColor = background; document.body?.style.setProperty('background-color', background); }, input?.background ?? 'white');
   }
   if (artifact.format === 'svg') {
    if (await page.locator('script').count()) findings.push({ code: 'svg-script', message: 'Script-controlled SVG state/time is not certified by the SMIL adapter.', blocking: true });
    const animation = await page.evaluate(() => document.querySelector('animate,animateMotion,animateTransform,set') !== null || document.getAnimations().length > 0);
    if (locator.kind === 'static' && animation) findings.push({ code: 'svg-animation', message: 'Static pixels cannot certify animated SVG; request temporal samples.', blocking: true });
    if (locator.kind === 'temporal') {
     if (locator.time < previousTime || locator.frame !== undefined) throw new Error('SVG samples require increasing seconds and do not provide frame numbers.'); previousTime = locator.time;
     const sampled = await page.evaluate(time => { const svg = document.documentElement; if (!(svg instanceof SVGSVGElement)) return false;
      svg.pauseAnimations(); svg.setCurrentTime(time); return Math.abs(svg.getCurrentTime() - time) < 0.001 && document.getAnimations().length === 0;
     }, locator.time);
     if (!sampled) findings.push({ code: 'svg-time-unverified', message: 'Only actual SVG SMIL time is supported; CSS/script animation time is unverified.', blocking: true });
    }
   }
   await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
   const clip = locator.kind === 'static' && locator.region ? { x: locator.region[0], y: locator.region[1], width: locator.region[2], height: locator.region[3] } : undefined;
   if (clip && (clip.x < 0 || clip.y < 0 || clip.width > 8192 || clip.height > 8192 || clip.width * clip.height > 40_000_000 || clip.x + clip.width > page.viewportSize()!.width || clip.y + clip.height > page.viewportSize()!.height)) throw new Error('Capture region exceeds the actual image.');
   // Final source includes all resources actually fetched across requested viewports.
   const source: VisualSource = { kind: 'file', file: artifact, dependencies: [...dependencies].map(([path, sha256]) => ({ path, sha256 })) };
   evidence.push(await saveEvidence(directory, 'capture-' + index, await page.screenshot({ clip }), source, locator));
  }
  const source: VisualSource = { kind: 'file', file: artifact, dependencies: [...dependencies].map(([path, sha256]) => ({ path, sha256 })) };
  // Complete the per-raster record once all observed dependencies are known.
  for (const raster of evidence) await fs.writeFile(raster.path + '.evidence.json', JSON.stringify({ source, raster }));
  const times = locators.filter(l => l.kind === 'temporal').map(l => l.time);
  return decodeArtifactResult('capture', { status: findings.some(d => d.blocking) ? 'unverified' : 'ready', artifact, diagnostics: findings,
   evidence: { kind: kind as 'static' | 'interactive' | 'temporal', source, engine: { name: 'Chromium', version: page.context().browser()!.version() },
    diagnostics: findings, evidence, ...(artifact.format === 'html' ? {} : { background: input?.background ?? 'white' }), scope: { locators,
     ...(times.length ? { temporal: { start: Math.min(...times), end: Math.max(...times), coverage: 'sampled' as const } } : {}) } } });
 });
}
