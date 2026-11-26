import fs from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright-core';
import type { ArtifactRef, ArtifactResult, CaptureInput, Diagnostic, RasterEvidence, VisualSource } from './types.js';
import type { ArtifactRuntimeOptions } from './runtime.js';
import { withArtifactPage } from './browser.js';
import { saveEvidence } from './evidence-files.js';
import { decodeArtifactResult } from './contract.js';
import type { AnimatedFormat } from './formats.js';

interface Timeline { readonly starts: readonly number[]; readonly durations: readonly number[]; readonly repetitions: number | null; readonly width: number; readonly height: number }
interface Decoded { readonly timeline: Timeline; readonly frames: readonly ({ readonly index: number; readonly png: string } | undefined)[] }

/** Decodes inside a secure-origin page: WebCodecs ImageDecoder composites frames and reports their timing. */
async function decode(page: Page, bytes: Buffer, format: AnimatedFormat, times: readonly number[], background: string): Promise<Decoded> {
 await page.context().route('**/*', route => route.request().url() === 'https://kodax-artifact.invalid/'
  ? route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html></html>' }) : route.abort('blockedbyclient'));
 await page.goto('https://kodax-artifact.invalid/');
 return page.evaluate(async ({ data, type, times, background }) => {
  if (!CSS.supports('color', background)) throw new Error('Invalid image background color.');
  const decoder = new ImageDecoder({ data: Uint8Array.from(atob(data), char => char.charCodeAt(0)), type });
  try {
   await decoder.tracks.ready; await decoder.completed;
   const track = decoder.tracks.selectedTrack;
   if (!track || track.frameCount < 1 || track.frameCount > 10_000) throw new Error('Animation frame count is outside the supported range.');
   const starts: number[] = [], durations: number[] = [];
   let width = 0, height = 0;
   for (let index = 0; index < track.frameCount; index++) {
    const { image } = await decoder.decode({ frameIndex: index });
    starts.push(image.timestamp / 1e6); durations.push((image.duration ?? 0) / 1e6);
    width = image.displayWidth; height = image.displayHeight; image.close();
   }
   if (!width || !height || width > 8192 || height > 8192 || width * height > 40_000_000) throw new Error('Image pixel limit exceeded.');
   const end = starts.at(-1)! + durations.at(-1)!;
   const frames = [];
   for (const time of times) {
    if (time > 0 && time >= end) { frames.push(undefined); continue; }
    let index = 0; while (index + 1 < starts.length && starts[index + 1]! <= time) index++;
    const { image } = await decoder.decode({ frameIndex: index });
    const canvas = new OffscreenCanvas(width, height), context = canvas.getContext('2d')!;
    context.fillStyle = background; context.fillRect(0, 0, width, height); context.drawImage(image, 0, 0); image.close();
    const png = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
    let binary = ''; for (let offset = 0; offset < png.length; offset += 0x8000) binary += String.fromCharCode(...png.subarray(offset, offset + 0x8000));
    frames.push({ index, png: btoa(binary) });
   }
   const repetitions = track.repetitionCount;
   return { timeline: { starts, durations, repetitions: Number.isFinite(repetitions) ? repetitions : null, width, height }, frames };
  } finally { decoder.close(); }
 }, { data: bytes.toString('base64'), type: 'image/' + format, times: [...times], background });
}

function describe(timeline: Timeline): Diagnostic {
 const end = timeline.starts.at(-1)! + timeline.durations.at(-1)!, shown = timeline.starts.slice(0, 20).map(start => +start.toFixed(3));
 const loops = timeline.repetitions === null ? 'loops forever' : timeline.repetitions === 0 ? 'plays once' : 'repeats ' + timeline.repetitions + ' time(s)';
 return { code: 'timeline', message: `Animation timeline: ${timeline.starts.length} frames over ${+end.toFixed(3)}s, ${timeline.width}x${timeline.height}, ${loops}. `
  + `Frame starts (s): ${shown.join(', ')}${timeline.starts.length > shown.length ? ', …' : ''}. Each sample returns the frame displayed at that second.` };
}

export async function animationTimeline(bytes: Buffer, format: AnimatedFormat, options: ArtifactRuntimeOptions): Promise<Diagnostic> {
 return describe((await withArtifactPage(options, page => decode(page, bytes, format, [], 'white'))).timeline);
}

export async function captureAnimation(bytes: Buffer, artifact: ArtifactRef & { format: AnimatedFormat }, input: CaptureInput, options: ArtifactRuntimeOptions): Promise<ArtifactResult> {
 const locators = input.locators.flatMap(locator => locator.kind === 'temporal' ? [locator] : []);
 if (locators.length > (options.maxRenderPages ?? 1000)) throw new Error('Specify a bounded capture batch.');
 const background = input.background ?? 'white';
 const { decoded, version } = await withArtifactPage(options, async page => ({
  decoded: await decode(page, bytes, artifact.format, locators.map(locator => locator.time), background), version: page.context().browser()!.version() }));
 const directory = await fs.mkdtemp(path.join(options.workspaceRoot, '.artifact-render-'));
 const source: VisualSource = { kind: 'file', file: artifact }, findings: Diagnostic[] = [describe(decoded.timeline)], evidence: RasterEvidence[] = [];
 for (const [index, locator] of locators.entries()) {
  const frame = decoded.frames[index];
  if (!frame) { findings.push({ code: 'time-out-of-range', message: `No frame is displayed at ${locator.time}s; the animation ends earlier and samples do not wrap around loops.`, blocking: true }); continue; }
  if (locator.frame !== undefined && locator.frame !== frame.index) findings.push({ code: 'frame-mismatch', message: `Frame ${frame.index}, not ${locator.frame}, is displayed at ${locator.time}s.`, blocking: true });
  evidence.push(await saveEvidence(directory, 'frame-' + index, Buffer.from(frame.png, 'base64'), source, { kind: 'temporal', time: locator.time, frame: frame.index }));
 }
 if (!evidence.length) await fs.rm(directory, { recursive: true, force: true });
 const times = evidence.map(raster => raster.locator.kind === 'temporal' ? raster.locator.time : 0);
 return decodeArtifactResult('capture', { status: findings.some(item => item.blocking) || !evidence.length ? 'unverified' : 'ready', artifact, diagnostics: findings,
  ...(evidence.length ? { evidence: { kind: 'temporal', source, engine: { name: 'Chromium ImageDecoder', version }, diagnostics: findings, evidence, background,
   scope: { locators: evidence.map(raster => raster.locator), temporal: { start: Math.min(...times), end: Math.max(...times), coverage: 'sampled' } } } } : {}) });
}
