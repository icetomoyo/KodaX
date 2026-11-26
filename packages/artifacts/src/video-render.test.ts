import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { captureVideo, videoTimeline } from './video-render.js';
const run = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile: Object.assign(() => undefined, { [promisify.custom]: run }) }));
const roots: string[] = [];
afterEach(async () => { run.mockReset(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
const summary = 'Input #0, mov,mp4\n  Duration: 00:00:04.50, start: 0.000000\n  Stream #0:0: Video: h264, yuv420p, 1280x720, 30 fps, 30 tbr\nAt least one output file must be specified';
const exit = (stderr: string) => Object.assign(new Error('exit 1'), { code: 1, stderr });
async function fixture() {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact video ')); roots.push(root);
 const png = await fs.readFile('tests/fixtures/images/valid-png.png');
 run.mockImplementation(async (_exe: string, args: string[]) => {
  if (args[0] === '-version') return { stdout: 'ffmpeg version 7.1-test Copyright\n', stderr: '' };
  if (!args.includes('-ss')) throw exit(summary);
  await fs.writeFile(args.at(-1)!, png); return { stdout: '', stderr: '' };
 });
 const artifact = { path: path.join(root, 'clip.mp4'), sourceHash: 'a'.repeat(64), format: 'mp4' as const };
 return { root, artifact, options: { workspaceRoot: root, ffmpegExecutable: process.execPath, maxRenderPages: 4 } };
}

it('runs fixed argv with a file-only protocol and the detected demuxer, seeking before the input', async () => {
 const { artifact, options } = await fixture();
 const result = await captureVideo(artifact, { kind: 'temporal', target: 'clip.mp4', locators: [{ kind: 'temporal', time: 1.25 }, { kind: 'temporal', time: 5 }] }, options);
 const sample = run.mock.calls.find(call => (call[1] as string[]).includes('-ss'))![1] as string[];
 expect(sample).toEqual(['-v', 'error', '-hide_banner', '-nostdin', '-protocol_whitelist', 'file', '-f', 'mov', '-ss', '1.250000', '-i', artifact.path,
  '-map', '0:v:0', '-frames:v', '1', '-update', '1', '-c:v', 'png', expect.stringMatching(/decoded-0\.png$/)]);
 expect(run.mock.calls.filter(call => (call[1] as string[]).includes('-ss'))).toHaveLength(1);
 expect(result.status).toBe('unverified');
 expect(result.diagnostics.map(item => item.code)).toEqual(['timeline', 'time-out-of-range']);
 expect(result.diagnostics[0]!.message).toMatch(/4\.5s at 30 fps/);
 expect(result.evidence?.evidence.map(item => item.locator)).toEqual([{ kind: 'temporal', time: 1.25 }]);
 expect(result.evidence?.engine).toEqual({ name: 'ffmpeg', version: '7.1-test' });
});

it('refuses non-ffmpeg executables, frame numbers and backgrounds, and propagates spawn failures', async () => {
 const { artifact, options } = await fixture();
 const capture = (locator: { kind: 'temporal'; time: number; frame?: number }, background?: string) =>
  captureVideo(artifact, { kind: 'temporal', target: 'clip.mp4', locators: [locator], ...(background ? { background } : {}) }, options);
 await expect(capture({ kind: 'temporal', time: 0, frame: 3 })).rejects.toThrow(/frame numbers/);
 await expect(capture({ kind: 'temporal', time: 0 }, 'white')).rejects.toThrow(/opaque/);
 run.mockImplementationOnce(async () => ({ stdout: 'LibreOffice 24.2', stderr: '' }));
 await expect(capture({ kind: 'temporal', time: 0 })).rejects.toThrow(/not ffmpeg/);
 run.mockImplementationOnce(async () => ({ stdout: 'ffmpeg version 7', stderr: '' })).mockImplementationOnce(async () => { throw Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }); });
 await expect(videoTimeline(artifact.path, 'mp4', options)).rejects.toThrow(/EACCES/);
 run.mockImplementationOnce(async () => ({ stdout: 'ffmpeg version 7', stderr: '' })).mockImplementationOnce(async () => { throw exit('clip.mp4: Invalid data found when processing input'); });
 await expect(videoTimeline(artifact.path, 'mp4', options)).rejects.toThrow(/Invalid data/);
 run.mockImplementationOnce(async () => ({ stdout: 'ffmpeg version 7', stderr: '' })).mockImplementationOnce(async () => { throw exit('Input #0, mov,mp4\n  Duration: 00:00:04.50\n  Stream #0:0: Audio: aac'); });
 await expect(videoTimeline(artifact.path, 'mp4', options)).rejects.toThrow(/no video stream/);
});
