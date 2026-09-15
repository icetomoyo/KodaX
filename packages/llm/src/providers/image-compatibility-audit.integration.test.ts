/** Issue 335 regression audit: synthetic fixtures, no network; verifies production image preparation. */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Jimp } from 'jimp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { KodaXMessage, KodaXToolResultContentItem } from '../types.js';
import { createCustomProvider } from './custom-provider.js';
import { NATIVE_PROVIDER_CAPABILITY_PROFILE } from './capability-profile.js';
import { KODAX_PROVIDERS } from './registry.js';
import { buildImageDataUrlIfAvailable } from './image-serialization.js';
import { toolRead } from '../../../coding/src/tools/read.js';
import { normalizePastedImage } from '../../../agent/src/media/image-normalize.js';
import { persistImageAsBlock } from '../../../agent/src/media/persist-image.js';
import { McpServerRuntime } from '../../../agent/src/capabilities/mcp/runtime.js';

const enabled = process.env.KODAX_IMAGE_COMPAT_AUDIT === '1';
type Protocol = 'anthropic' | 'openai';
type Wire = { messages: unknown[]; stream?: boolean };
const observations: Record<string, unknown>[] = [];
let directory: string;
let jpeg: Buffer;
let png: Buffer;
// Valid SOI + APP0/JFIF and APP1/EXIF segments, but no SOF/SOS/frame data.
const noFrame = Buffer.from('ffd8ffe000104a46494600010100000100010000ffe10008457869660000ffd9', 'hex');
// Pillow-generated 2x2 RGB controls; the WebP is valid even though Jimp has no WebP codec.
const webp = Buffer.from('UklGRjoAAABXRUJQVlA4IC4AAADQAQCdASoCAAIAAUAmJaACdLoB+AADsAD+771X/rgPzgPzgP5lv/zYEDND50AA', 'base64');
const gif = Buffer.from('R0lGODdhAgACAIEAACJmzAAAAAAAAAAAACwAAAAAAgACAAAIBgABCAQQEAA7', 'base64');

function history(filePath: string, direct: boolean, mediaType = 'image/jpeg'): KodaXMessage[] {
  const image = { type: 'image' as const, path: filePath, mediaType };
  return direct ? [{ role: 'user', content: [{ type: 'text', text: 'Inspect header.' }, image] }] : [
    { role: 'user', content: 'Inspect header.' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'read_header', name: 'read', input: { path: filePath } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read_header', content: [
      { type: 'text', text: 'Keep this tool text.' }, image,
    ] }] },
    { role: 'user', content: 'Continue with the updated price.' },
  ];
}

async function capture(protocol: Protocol, messages: KodaXMessage[], vision: boolean, stream = false, alias?: 'zhipu-coding' | 'zai-coding') {
  const provider = alias ? KODAX_PROVIDERS[alias]() : createCustomProvider({
    name: 'image-audit', protocol, model: 'audit', baseUrl: 'https://provider.invalid',
    apiKeyEnv: 'UNUSED_IMAGE_AUDIT', imageInput: vision,
    capabilityProfile: { ...NATIVE_PROVIDER_CAPABILITY_PROFILE },
  });
  const create = vi.fn(async (_wire: Wire) => stream
    ? (async function* () {
      yield protocol === 'anthropic' ? { type: 'message_stop' }
        : { choices: [{ delta: {}, finish_reason: 'stop' }] };
    })()
    : protocol === 'anthropic' ? { content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' }
      : { choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] });
  Reflect.set(provider, '_client', protocol === 'anthropic' ? { messages: { create } }
    : { chat: { completions: { create } } });
  const original = structuredClone(messages);
  await provider[stream ? 'stream' : 'complete'](messages, [], 'Synthetic offline image audit.');
  expect(messages).toEqual(original);
  expect(create).toHaveBeenCalledTimes(1);
  return create.mock.calls[0]![0];
}

describe.skipIf(!enabled)('Issue 335 expanded image compatibility audit (current behavior)', () => {
  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'kodax-image-compat-audit-'));
    const image = new Jimp({ width: 160, height: 46, color: 0x2266ccff });
    jpeg = Buffer.from(await image.getBuffer('image/jpeg'));
    png = Buffer.from(await image.getBuffer('image/png'));
    await writeFile(path.join(directory, 'valid.jpg'), jpeg);
    await writeFile(path.join(directory, 'missing-sof.jpg'), noFrame);
  });
  afterAll(async () => {
    await writeFile(path.join(directory, 'observations.json'), JSON.stringify(observations, null, 2));
    // Synthetic fixtures retained beside the evidence for independent inspection.
    process.stdout.write(`Image audit evidence: ${directory}\n`);
  });

  for (const sample of ['missing-sof', 'truncated-jpeg', 'png-header-only', 'empty', 'valid-jpeg', 'valid-png'] as const) {
    it(`read versus existing decoder: ${sample}`, async () => {
      const bytes = sample === 'missing-sof' ? noFrame : sample === 'truncated-jpeg' ? jpeg.subarray(0, jpeg.length / 2)
        : sample === 'png-header-only' ? png.subarray(0, 33) : sample === 'empty' ? Buffer.alloc(0)
          : sample === 'valid-jpeg' ? jpeg : png;
      const filePath = path.join(directory, `${sample}.${sample.includes('png') ? 'png' : 'jpg'}`);
      await writeFile(filePath, bytes);
      const result = await toolRead({ path: filePath }, { executionCwd: directory, backups: new Map() });
      const inline = Array.isArray(result) && result.some(item => item.type === 'image');
      expect(inline).toBe(sample.startsWith('valid-'));
      let decoded = false;
      try { await normalizePastedImage(bytes); decoded = true; } catch (error) {
        expect(error).toMatchObject({ code: 'IMAGE_DECODE_FAILED' });
      }
      expect(decoded).toBe(sample.startsWith('valid-'));
      observations.push({ sample, readReturnedImage: inline, decoded });
    });
  }

  for (const protocol of ['anthropic', 'openai'] as const) {
    for (const direct of [true, false]) {
      for (const stream of [true, false]) {
        it(`${protocol}/${direct ? 'direct' : 'tool'}/${stream ? 'stream' : 'complete'} isolates undecodable JPEG before sending`, async () => {
          const wire = await capture(protocol, history(path.join(directory, 'missing-sof.jpg'), direct), true, stream);
          expect(JSON.stringify(wire)).not.toContain(noFrame.toString('base64'));
          expect(JSON.stringify(wire)).toContain('cannot be decoded');
          observations.push({ protocol, direct, stream, invalidBytesForwarded: false });
        });
      }
    }
  }
  for (const alias of ['zhipu-coding', 'zai-coding'] as const) {
    it(`${alias} blocks the missing-SOF JPEG at read`, async () => {
      const filePath = path.join(directory, 'missing-sof.jpg');
      const content = await toolRead({ path: filePath }, { executionCwd: directory, backups: new Map() });
      const messages = history(filePath, false);
      messages[2]!.content = [{ type: 'tool_result', tool_use_id: 'read_header', content:
        typeof content === 'string' ? content : [...content] }];
      expect(JSON.stringify(await capture('anthropic', messages, true, false, alias))).not.toContain(noFrame.toString('base64'));
      expect(typeof content).toBe('string');
      observations.push({ alias, missingSofReadReplay: 'blocked before history insertion' });
    });
  }
  for (const protocol of ['anthropic', 'openai'] as const) {
    it(`${protocol}: records direct/tool behavior with explicit text-only capability`, async () => {
      const imagePath = path.join(directory, 'valid.jpg');
      const direct = JSON.stringify(await capture(protocol, history(imagePath, true), false));
      const tool = JSON.stringify(await capture(protocol, history(imagePath, false), false));
      expect(direct).toContain(jpeg.toString('base64'));
      expect(tool.includes(jpeg.toString('base64'))).toBe(protocol === 'anthropic');
      expect(tool).toContain('Keep this tool text.');
      observations.push({ protocol, advertisedVision: false, directImageForwarded: true, toolImageForwarded: protocol === 'anthropic' });
    });
    it(`${protocol}: replay rereads changed bytes and corrects stale mediaType`, async () => {
      const filePath = path.join(directory, `${protocol}-mutable.jpg`);
      await writeFile(filePath, jpeg);
      const messages = history(filePath, true);
      await writeFile(filePath, png);
      const wire = JSON.stringify(await capture(protocol, messages, true));
      expect(wire).toContain(png.toString('base64'));
      expect(wire).toContain('image/png');
      observations.push({ protocol, replayedBytes: 'PNG', declaredMediaType: 'image/png' });
    });
  }
  it('legacy raw I/O helper remains unchanged; providers use prepareImageFile', async () => {
    expect(await buildImageDataUrlIfAvailable(path.join(directory, 'absent.jpg'))).toBeUndefined();
    expect(await buildImageDataUrlIfAvailable(path.join(directory, 'missing-sof.jpg'))).toContain(noFrame.toString('base64'));
    observations.push({ missing: 'undefined / serializer placeholder', invalidExisting: 'forwarded' });
  });
  it('public durable image persistence accepts bad bytes', async () => {
    const block = await persistImageAsBlock({ buffer: noFrame, mediaType: 'image/jpeg' }, { directory });
    expect(await readFile(block.path)).toEqual(noFrame);
    observations.push({ persistence: 'bad bytes retained' });
  });
  it('an oversized image is blocked at read but forwarded via a direct caller', async () => {
    const filePath = path.join(directory, 'oversized.jpg');
    const bytes = Buffer.concat([jpeg, Buffer.alloc(10 * 1024 * 1024)]);
    await writeFile(filePath, bytes);
    const result = await toolRead({ path: filePath }, { executionCwd: directory, backups: new Map() });
    expect(typeof result).toBe('string');
    expect(result).toContain('Image too large');
    const data = await buildImageDataUrlIfAvailable(filePath);
    expect(data!.length).toBeGreaterThan(10 * 1024 * 1024);
    observations.push({ oversizedRawBytes: bytes.length, read: 'blocked', directSerializer: 'forwarded' });
  });
  it('mixed tool results retain good images and isolate only bad images', async () => {
    const messages = history(path.join(directory, 'valid.jpg'), false);
    const content: KodaXToolResultContentItem[] = [
      { type: 'text', text: 'Keep this tool text.' },
      { type: 'image', path: path.join(directory, 'valid.jpg'), mediaType: 'image/jpeg' },
      { type: 'image', path: path.join(directory, 'missing-sof.jpg'), mediaType: 'image/jpeg' },
    ];
    messages[2]!.content = [{ type: 'tool_result', tool_use_id: 'read_header', content }];
    const wire = JSON.stringify(await capture('anthropic', messages, true));
    expect(wire).toContain(jpeg.toString('base64'));
    expect(wire).not.toContain(noFrame.toString('base64'));
    expect(wire).toContain('cannot be decoded');
    expect(wire).toContain('Keep this tool text.');
    observations.push({ mixedImages: 'good image preserved; bad image replaced with text' });
  });
  for (const format of ['gif', 'webp'] as const) {
    it(`valid ${format}: distinguishes existing decoder coverage from provider forwarding`, async () => {
      const bytes = format === 'gif' ? gif : webp;
      const filePath = path.join(directory, `valid.${format}`);
      await writeFile(filePath, bytes);
      let decoded = false;
      try { await normalizePastedImage(bytes); decoded = true; } catch (error) {
        expect(error).toMatchObject({ code: 'IMAGE_DECODE_FAILED' });
      }
      expect(decoded).toBe(format === 'gif');
      const wire = JSON.stringify(await capture('anthropic', history(filePath, true, `image/${format}`), true));
      expect(wire).toContain(bytes.toString('base64'));
      observations.push({ validFormat: format, jimpDecoded: decoded, providerForwarded: true });
    });
  }
  it('MCP tool, embedded resource and resource read all isolate undecodable images', async () => {
    const server = path.join(directory, 'mcp-fixture.cjs');
    await writeFile(server, `
      require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
        const m = JSON.parse(line); if (m.id === undefined) return;
        const resource = { uri: 'image://header', mimeType: 'image/jpeg', blob: '${noFrame.toString('base64')}' };
        let result = {};
        if (m.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'audit', version: '1' } };
        if (m.method === 'resources/read') result = { contents: [resource] };
        if (m.method === 'tools/call') result = { isError: true, content: [
          { type: 'text', text: 'Keep MCP evidence.' }, m.params.name === 'embedded'
            ? { type: 'resource', resource } : { type: 'image', mimeType: 'image/jpeg', data: resource.blob }
        ], structuredContent: { reason: 'original tool status' } };
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
      });
    `);
    vi.stubEnv('KODAX_HOME', directory);
    const runtime = new McpServerRuntime('image-audit', { type: 'stdio', command: process.execPath,
      args: [server], startupTimeoutMs: 2000, requestTimeoutMs: 2000 }, path.join(directory, 'mcp-cache'));
    try {
      for (const route of ['image', 'embedded', 'resource']) {
        const result = route === 'resource' ? await runtime.readResource('image://header', {}) : await runtime.callTool(route, {});
        if (!Array.isArray(result.content)) throw new Error('Expected multimodal content');
        const image = result.content.find(item => item.type === 'image');
        expect(image).toBeUndefined();
        expect(JSON.stringify(result.content)).toContain('cannot be decoded');
        if (route !== 'resource') {
          expect(result.metadata?.isError).toBe(true);
          expect(result.structuredContent).toEqual({ reason: 'original tool status' });
          expect(result.content).toContainEqual({ type: 'text', text: 'Keep MCP evidence.' });
        }
        observations.push({ mcpRoute: route, invalidImagePersisted: false, otherChannelsPreserved: true });
      }
    } finally { await runtime.dispose(); vi.unstubAllEnvs(); }
  });
});
