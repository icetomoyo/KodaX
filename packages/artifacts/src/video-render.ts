import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ArtifactRef, ArtifactResult, CaptureInput, Diagnostic, RasterEvidence, VisualSource } from './types.js';
import type { ArtifactRuntimeOptions } from './runtime.js';
import type { VideoFormat } from './formats.js';
import { saveEvidence } from './evidence-files.js';
import { decodeArtifactResult } from './contract.js';

const run = promisify(execFile);
// The demuxer is forced from the detected container so ffmpeg never probes a different format or protocol.
const demuxers: Record<VideoFormat, string> = { mp4: 'mov', mov: 'mov', webm: 'matroska' };
interface Probe { readonly version: string; readonly duration?: number; readonly fps?: number }

export const ffmpegUnavailable = (): Diagnostic => ({ code: 'ffmpeg-unavailable', message: 'The host has not provided ffmpeg, so video frames cannot be extracted.', blocking: true });
function container(format: VideoFormat): string[] { return ['-hide_banner', '-nostdin', '-protocol_whitelist', 'file', '-f', demuxers[format]]; }
function execOptions(options: ArtifactRuntimeOptions) { return { signal: options.signal, timeout: 60_000, maxBuffer: 1024 * 1024, windowsHide: true }; }

async function probe(file: string, format: VideoFormat, options: ArtifactRuntimeOptions): Promise<Probe> {
 const executable = options.ffmpegExecutable!;
 const version = (await run(executable, ['-version'], execOptions(options))).stdout.split(/\r?\n/)[0]!.trim();
 if (!/^ffmpeg version /.test(version)) throw new Error('Configured video decoder is not ffmpeg.');
 // `ffmpeg -i` without an output prints the stream summary and exits non-zero by design.
 let stderr: string;
 try { stderr = (await run(executable, [...container(format), '-i', file], execOptions(options))).stderr; }
 catch (error) {
  // Only an ordinary non-zero exit carries the summary; spawn failures, timeouts and cancellation propagate.
  const failure = error as { code?: unknown; killed?: boolean; stderr?: unknown };
  if (typeof failure.code !== 'number' || failure.killed || typeof failure.stderr !== 'string') throw error;
  stderr = failure.stderr;
 }
 const duration = /Duration: (\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stderr);
 if (!duration && !/Duration: N\/A/.test(stderr)) throw new Error('ffmpeg could not read the video: ' + (stderr.trim().split(/\r?\n/).at(-1) ?? 'no output'));
 if (!/Stream #.*: Video:/.test(stderr)) throw new Error('The file has no video stream.');
 const fps = /Video:.*?(\d+(?:\.\d+)?) fps/.exec(stderr);
 return { version, ...(duration ? { duration: +duration[1]! * 3600 + +duration[2]! * 60 + +duration[3]! } : {}), ...(fps ? { fps: +fps[1]! } : {}) };
}

function describe(probe: Probe): Diagnostic {
 const length = probe.duration === undefined ? 'unknown length' : probe.duration + 's';
 return { code: 'timeline', message: `Video timeline: ${length}${probe.fps ? ' at ' + probe.fps + ' fps' : ''}. `
  + 'Each sample returns the first frame at or after that second, so a time inside the last frame has no frame.' };
}

export async function videoTimeline(file: string, format: VideoFormat, options: ArtifactRuntimeOptions): Promise<Diagnostic> {
 return describe(await probe(file, format, options));
}

export async function captureVideo(artifact: ArtifactRef & { format: VideoFormat }, request: CaptureInput, options: ArtifactRuntimeOptions): Promise<ArtifactResult> {
 const locators = request.locators.flatMap(locator => locator.kind === 'temporal' ? [locator] : []);
 if (locators.length > (options.maxRenderPages ?? 1000)) throw new Error('Specify a bounded capture batch.');
 if (request.background !== undefined) throw new Error('Video frames are opaque; background applies only to images, SVG and animations.');
 if (locators.some(locator => locator.frame !== undefined)) throw new Error('Video samples are addressed by seconds and do not accept frame numbers.');
 const probed = await probe(artifact.path, artifact.format, options);
 const directory = await fs.mkdtemp(path.join(options.workspaceRoot, '.artifact-render-'));
 const source: VisualSource = { kind: 'file', file: artifact }, findings: Diagnostic[] = [describe(probed)], evidence: RasterEvidence[] = [];
 for (const [index, locator] of locators.entries()) {
  options.signal?.throwIfAborted();
  if (probed.duration !== undefined && locator.time >= probed.duration && locator.time > 0) {
   findings.push({ code: 'time-out-of-range', message: `${locator.time}s is not before the end of the ${probed.duration}s video.`, blocking: true }); continue;
  }
  const output = path.join(directory, 'decoded-' + index + '.png');
  await run(options.ffmpegExecutable!, ['-v', 'error', ...container(artifact.format), '-ss', locator.time.toFixed(6), '-i', artifact.path,
   '-map', '0:v:0', '-frames:v', '1', '-update', '1', '-c:v', 'png', output], execOptions(options));
  let bytes: Buffer;
  try { bytes = await fs.readFile(output); }
  catch (error) {
   if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
   findings.push({ code: 'no-frame-at-time', message: `No frame starts at or after ${locator.time}s; request an earlier time to see the final frame.`, blocking: true }); continue;
  }
  await fs.rm(output);
  evidence.push(await saveEvidence(directory, 'frame-' + index, bytes, source, { kind: 'temporal', time: locator.time }));
 }
 if (!evidence.length) await fs.rm(directory, { recursive: true, force: true });
 const times = evidence.map(raster => raster.locator.kind === 'temporal' ? raster.locator.time : 0);
 return decodeArtifactResult('capture', { status: findings.some(item => item.blocking) || !evidence.length ? 'unverified' : 'ready', artifact, diagnostics: findings,
  ...(evidence.length ? { evidence: { kind: 'temporal', source, engine: { name: 'ffmpeg', version: probed.version.replace(/^ffmpeg version /, '').split(' ')[0]! }, diagnostics: findings, evidence,
   scope: { locators: evidence.map(raster => raster.locator), temporal: { start: Math.min(...times), end: Math.max(...times), coverage: 'sampled' } } } } : {}) });
}
