import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { McpServerRuntime } from './runtime.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=';
let directory: string;
let runtime: McpServerRuntime;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'kodax-mcp-media-'));
  vi.stubEnv('KODAX_HOME', directory);
  const server = path.join(directory, 'server.cjs');
  await writeFile(server, `
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const m = JSON.parse(line); if (m.id === undefined) return;
      let result = {};
      const resource = { uri: 'image://pixel', mimeType: 'image/png', blob: '${PNG}' };
      if (m.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'media', version: '1' } };
      if (m.method === 'tools/list') result = { tools: [] };
      if (m.method === 'resources/read') result = { contents: [resource] };
      if (m.method === 'tools/call') result = { isError: true, content: [
        { type: 'text', text: 'Server evidence' }, { type: 'resource', resource }
      ], structuredContent: { reason: 'Denied' } };
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
    });
  `);
  runtime = new McpServerRuntime('media', { type: 'stdio', command: process.execPath,
    args: [server], startupTimeoutMs: 2000, requestTimeoutMs: 2000 }, path.join(directory, 'catalog-cache'));
});
afterEach(async () => {
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
