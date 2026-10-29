import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { McpServerRuntime } from './runtime.js';
import { getPreparedImageDiagnostic, prepareImageBlock, withPreparedImageHistory } from '../../../../llm/src/providers/image-serialization.js';
import { createHash } from 'node:crypto';
import * as validation from '../../../../llm/src/image-validation.js';
import { prepareValidatedImageBlock } from '@kodax-ai/llm';
import { withVisualImageAdmission } from '../../media/visual-admission.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAKAAAAAuCAYAAACvdRKFAAAAhUlEQVR4Ae3BQQGAMADEsO6kIG5q8QQy+mlynvt+JJKRiEYiGoloJKKRiEYiGoloJKKRiEYiGoloJKKRiEYiGoloJKKRiEYiGoloJKKRiEYiGoloJKKRiEYiGoloJKKRiEYiGoloJKKRiEYiGoloJKKRiEYiGoloJKKRiEYiGoloJKKRiH7i7gKvb5ZrbwAAAABJRU5ErkJggg==';
let directory: string;
let runtime: McpServerRuntime;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'kodax-mcp-media-'));
  vi.stubEnv('KODAX_HOME', directory);
  const server = path.join(directory, 'server.cjs');
  await writeFile(server, `
    require('node:readline').createInterface({ input: process.stdin }).on('line', async line => {
      const m = JSON.parse(line); if (m.id === undefined) return;
      if (m.method === 'initialize' && process.env.KODAX_MCP_TEST_INITIALIZE_DELAY_MS) {
        await new Promise(resolve => setTimeout(resolve, Number(process.env.KODAX_MCP_TEST_INITIALIZE_DELAY_MS)));
      }
      let result = {};
      const resource = { uri: 'image://pixel', mimeType: 'image/png', blob: '${PNG}' };
      if (m.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'media', version: '1' } };
      if (m.method === 'tools/list') result = { tools: [] };
      if (m.method === 'resources/read') result = { contents: [resource] };
      if (m.method === 'tools/call') result = { isError: true, content: [
        { type: 'text', text: 'Server evidence' }, { type: 'resource', resource },
        ...(['mixed', 'malformed-base64', 'unsupported-mime'].includes(m.params.name) ? [{ type: 'image',
          mimeType: m.params.name === 'unsupported-mime' ? 'image/svg+xml' : 'image/jpeg',
          data: m.params.name === 'malformed-base64' ? '@@@' : '/9j/4AAQSkZJRgABAQAAAQABAAD/2Q==' }] : [])
      ], structuredContent: { reason: 'Denied' } };
      if (m.method === 'tools/call' && m.params.name === 'two-good') result.content.push({type:'image',mimeType:'image/png',data:'${PNG}'});
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
    });
  `);
  runtime = new McpServerRuntime('media', { type: 'stdio', command: process.execPath,
    args: [server], startupTimeoutMs: 2000, requestTimeoutMs: 2000 }, path.join(directory, 'catalog-cache'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await runtime?.dispose();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

it.each(['resource', 'embedded-resource'])('preserves %s image bytes as durable attachments', async (route) => {
  const result = route === 'resource' ? await runtime.readResource('image://pixel', {})
    : await runtime.callTool('image', {});
  expect(Array.isArray(result.content)).toBe(true);
  if (typeof result.content === 'string') throw new Error('Expected image content.');
  const image = result.content?.find((item) => item.type === 'image');
  expect(image?.mediaType).toBe('image/png');
  expect(await readFile(image!.path)).toEqual(Buffer.from(PNG, 'base64'));
  expect(JSON.stringify(result.metadata)).not.toContain(PNG);
  if (route === 'embedded-resource') {
    expect(result.metadata?.isError).toBe(true);
    expect(result.structuredContent).toEqual({ reason: 'Denied' });
  }
});

it.each(['mixed', 'malformed-base64', 'unsupported-mime'])('isolates %s while preserving valid images, text, isError and structured content', async (name) => {
  const result = await runtime.callTool(name, {});
  expect(Array.isArray(result.content)).toBe(true);
  if (!Array.isArray(result.content)) throw new Error('Expected content blocks.');
  expect(result.content.filter(item => item.type === 'image')).toHaveLength(1);
  const image = result.content.find(item => item.type === 'image')!;
  expect(await readFile(image.path)).toEqual(Buffer.from(PNG, 'base64'));
  expect(JSON.stringify(result.content)).toContain('MCP image unavailable');
  expect(JSON.stringify(result.content)).toContain('Server evidence');
  expect(result.metadata?.isError).toBe(true);
  expect(result.structuredContent).toEqual({ reason: 'Denied' });
});

it('MCP uses its first unverified verdict without immediately revalidating retained bytes', async () => {
  const inspect = vi.spyOn(validation, 'validateImageBytes').mockResolvedValue({
    status: 'unverified', reason: 'decoder_unavailable', mediaType: 'image/png',
  });
  await withPreparedImageHistory(async () => {
    const result = await runtime.callTool('image', {});
    if (!Array.isArray(result.content)) throw new Error('Expected content blocks');
    const image = result.content.find(item => item.type === 'image')!;
    expect(await prepareImageBlock(image)).toMatchObject({ data: PNG });
    expect(inspect).toHaveBeenCalledOnce();
  });
});

it.each([0, 1200])('cancels MCP receipt during initial validation instead of decoding the rest of the response (startup delay %ims)', async (startupDelayMs) => {
  vi.stubEnv('KODAX_MCP_TEST_INITIALIZE_DELAY_MS', String(startupDelayMs));
  let finish!: (result: validation.ImageValidation) => void;
  const validationResult = new Promise<validation.ImageValidation>(resolve => { finish = resolve; });
  let markValidationStarted!: () => void;
  const validationStarted = new Promise<void>(resolve => { markValidationStarted = resolve; });
  const inspect = vi.spyOn(validation, 'validateImageBytes').mockImplementation(() => {
    markValidationStarted();
    return validationResult;
  });
  const abort = new AbortController();
  const pending = withPreparedImageHistory(() => runtime.callTool('mixed', {}), abort.signal);
  const outcome = pending.then(
    () => ({ status: 'fulfilled' as const }),
    (error: unknown) => ({ status: 'rejected' as const, error }),
  );
  try {
    // Startup may validly exceed waitFor's one-second default. Cancel only
    // after validation starts, and fail promptly if receipt settles before it.
    await Promise.race([validationStarted, outcome.then(result => {
      throw new Error('MCP receipt settled before initial validation', { cause: result });
    })]);
    abort.abort();
    expect(await outcome).toMatchObject({ status: 'rejected', error: { name: 'AbortError' } });
    expect(inspect).toHaveBeenCalledOnce();
  } finally {
    abort.abort();
    finish({ status: 'valid', mediaType: 'image/png' });
    await outcome;
  }
}, 10_000);

it('prepares MCP bytes at receipt before the persisted attachment can be changed', async () => {
  await withPreparedImageHistory(async () => {
    const result = await runtime.callTool('image', {});
    if (!Array.isArray(result.content)) throw new Error('Expected content blocks.');
    const original = structuredClone(result);
    const image = result.content.find(item => item.type === 'image')!;
    await writeFile(image.path, 'overwritten after receipt');
    expect(await prepareImageBlock(image)).toMatchObject({ data: PNG, mediaType: 'image/png' });
    expect(result).toEqual(original);
  });
});

it('reserves typed output before image validation and preserves exact scoped source slots', async () => {
  const received: { source: string; ordinal: number; bytes: Buffer }[] = [];
  const cancel = vi.fn();
  const reserve = vi.fn(() => ({ cancel }));
  const result = await withVisualImageAdmission({ reserve, async admit(bytes, _mediaType, _verdict, source, ordinal) {
    received.push({ source, ordinal, bytes }); return [{ type: 'text', text: 'accepted typed bytes' }];
  } }, () => runtime.callTool('mixed', {}));
  expect(reserve).toHaveBeenCalledWith(2, 'mcp:media:tool:mixed');
  expect(received).toEqual([{ source: 'mcp:media:tool:mixed', ordinal: 0, bytes: Buffer.from(PNG, 'base64') }]);
  expect(cancel).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).toContain('Server evidence');
  expect(JSON.stringify(result)).toContain('MCP image unavailable');
});

it('rejects insufficient output capacity before local decode/admission without guessing structuredContent paths', async () => {
  const inspect = vi.spyOn(validation, 'validateImageBytes'); const admit = vi.fn();
  await expect(withVisualImageAdmission({ reserve() { throw new Error('batch full'); }, admit }, () => runtime.callTool('image', {}))).rejects.toThrow('batch full');
  expect(inspect).not.toHaveBeenCalled(); expect(admit).not.toHaveBeenCalled();
});

it('cancels validation before scoped admission and refunds exactly once', async () => {
  let started!: () => void; let finish!: (value: validation.ImageValidation) => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const pendingValidation = new Promise<validation.ImageValidation>(resolve => { finish = resolve; });
  vi.spyOn(validation, 'validateImageBytes').mockImplementation(() => { started(); return pendingValidation; });
  const abort = new AbortController(); const cancel = vi.fn(); const admit = vi.fn();
  const outcome = withVisualImageAdmission({ reserve: () => ({ cancel }), admit }, () =>
    withPreparedImageHistory(() => runtime.callTool('mixed', {}), abort.signal)).then(() => 'fulfilled', error => error as Error);
  try {
    await entered; abort.abort();
    expect(await outcome).toMatchObject({ name: 'AbortError' });
    expect(admit).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledOnce();
  } finally { finish({ status: 'valid', mediaType: 'image/png' }); await outcome; }
});

it.each(['archive', 'cancel'])('preserves real prepared first bytes after a later %s failure', async reason => {
  const cancel = vi.fn(); let admitted = 0;
  const abort = new AbortController();
  await withPreparedImageHistory(async () => {
    const result = await withVisualImageAdmission({ reserve: () => ({ cancel }), async admit(bytes, mediaType, verdict) {
      if (++admitted === 2) { if (reason === 'cancel') abort.abort(); throw new Error('second image admission failed'); }
      const image = { type: 'image' as const, path: path.join(directory, 'admitted.png'), mediaType };
      await writeFile(image.path, bytes); prepareValidatedImageBlock(image, bytes, verdict);
      return [{ type: 'text', text: 'first image accepted' }, image];
    } }, () => runtime.callTool('two-good', {}));
    expect(JSON.stringify(result)).toContain('first image accepted');
    expect(JSON.stringify(result)).toContain('second image admission failed');
    if (!Array.isArray(result.content)) throw new Error('Expected retained typed content.');
    const retained = result.content.find(item => item.type === 'image')!;
    expect(getPreparedImageDiagnostic(retained)).toMatchObject({ dataHash: createHash('sha256').update(Buffer.from(PNG, 'base64')).digest('hex') });
    if (reason !== 'cancel') expect(await prepareImageBlock(retained)).toMatchObject({ data: PNG });
    expect(cancel).not.toHaveBeenCalled();
  }, abort.signal);
});
