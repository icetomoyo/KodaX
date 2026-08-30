import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLspClient } from './client.js';
import { LspService } from './service.js';
import type { LspServerInfo } from './servers.js';

const FIXTURE = fileURLToPath(new URL('./fake-lsp-server.fixture.mjs', import.meta.url));
const STUBBORN_LSP_SOURCE = `
let buffer = Buffer.alloc(0);
const keepAlive = setInterval(() => {}, 1_000);

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf('\\r\\n\\r\\n');
    if (headerEnd < 0) break;
    const header = buffer.slice(0, headerEnd).toString('ascii');
    const match = /content-length:\\s*(\\d+)/i.exec(header);
    if (!match) {
      buffer = buffer.slice(headerEnd + 4);
      continue;
    }
    const length = Number.parseInt(match[1], 10);
    const start = headerEnd + 4;
    if (buffer.length < start + length) break;
    const body = buffer.slice(start, start + length).toString('utf8');
    buffer = buffer.slice(start + length);
    handle(JSON.parse(body));
  }
});

function send(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  process.stdout.write('Content-Length: ' + payload.length + '\\r\\n\\r\\n');
  process.stdout.write(payload);
}

function handle(message) {
  switch (message.method) {
    case 'initialize':
      send({ jsonrpc: '2.0', id: message.id, result: { capabilities: { textDocumentSync: 1 } } });
      return;
    case 'shutdown':
      send({ jsonrpc: '2.0', id: message.id, result: null });
      return;
    case 'exit':
      return;
    default:
      if (typeof message.id !== 'undefined' && message.method) {
        send({ jsonrpc: '2.0', id: message.id, result: null });
      }
  }
}

process.on('SIGTERM', () => {
  clearInterval(keepAlive);
  process.exit(0);
});
`;

describe('LSP protocol integration (real stdio handshake)', () => {
  let tempDir = '';
  let tsFile = '';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-lsp-int-'));
    tsFile = path.join(tempDir, 'mod.ts');
    await fs.writeFile(tsFile, 'export const x: number = "oops";\n', 'utf8');
  });
  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    }
    tempDir = '';
  });

  it('initializes, opens a document, and receives published diagnostics', async () => {
    const client = await createLspClient({
      serverId: 'fake',
      root: tempDir,
      launch: { command: process.execPath, args: [FIXTURE] },
    });
    try {
      await client.notifyOpenOrChange(tsFile);
      await client.waitForDiagnostics(tsFile, { afterMs: 0, timeoutMs: 4000 });
      const diagnostics = client.diagnostics(tsFile);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].message).toBe('fake type error');
      expect(diagnostics[0].severity).toBe(1);
    } finally {
      await client.shutdown();
    }
  }, 15000);

  it('contains a write failure when the server exits during a request', async () => {
    const client = await createLspClient({
      serverId: 'exiting-server',
      root: tempDir,
      launch: {
        command: process.execPath,
        args: [FIXTURE, '--exit-during-next-request'],
      },
      initializeTimeoutMs: 2_000,
    });
    try {
      await expect(client.documentSymbols(tsFile)).resolves.toHaveLength(1);
      await expect(client.workspaceSymbols('x'.repeat(1024 * 1024))).rejects.toThrow();
    } finally {
      await client.shutdown();
    }
  }, 15_000);

  it('end-to-end: LspService.getDiagnosticsBlock against a real server process', async () => {
    const server: LspServerInfo = {
      id: 'fake',
      languageIds: ['typescript'],
      rootMarkers: ['package.json', '.git'],
      discover: () => ({ command: process.execPath, args: [FIXTURE] }),
      installGuidance: 'n/a',
    };
    const service = new LspService({ servers: [server], documentTimeoutMs: 4000 });
    try {
      const block = await service.getDiagnosticsBlock(tsFile, { gitRoot: tempDir });
      expect(block).toContain('LSP errors detected in this file');
      expect(block).toContain('ERROR [1:1] fake type error');
    } finally {
      await service.shutdownAll();
    }
  }, 15000);

  it('navigation: definition / hover / references / symbols via a real server', async () => {
    const server: LspServerInfo = {
      id: 'fake',
      languageIds: ['typescript'],
      rootMarkers: ['package.json', '.git'],
      discover: () => ({ command: process.execPath, args: [FIXTURE] }),
      installGuidance: 'n/a',
    };
    const service = new LspService({ servers: [server], documentTimeoutMs: 4000 });
    try {
      const def = await service.getDefinition(tsFile, { line: 0, character: 0 }, { gitRoot: tempDir });
      expect(def).toContain(':1:1');
      const hover = await service.getHover(tsFile, { line: 0, character: 0 }, { gitRoot: tempDir });
      expect(hover).toContain('const x: number');
      const refs = await service.getReferences(tsFile, { line: 0, character: 0 }, { gitRoot: tempDir });
      expect(refs.split('\n')).toHaveLength(2);
      const symbols = await service.getDocumentSymbols(tsFile, { gitRoot: tempDir });
      expect(symbols).toContain('Variable x (1)');
    } finally {
      await service.shutdownAll();
    }
  }, 15000);

  it('reports a fresh diagnostic after a second change (didChange path)', async () => {
    const client = await createLspClient({
      serverId: 'fake',
      root: tempDir,
      launch: { command: process.execPath, args: [FIXTURE] },
    });
    try {
      await client.notifyOpenOrChange(tsFile); // didOpen
      await client.waitForDiagnostics(tsFile, { afterMs: 0, timeoutMs: 4000 });
      const second = Date.now();
      await client.notifyOpenOrChange(tsFile); // didChange
      await client.waitForDiagnostics(tsFile, { afterMs: second, timeoutMs: 4000 });
      expect(client.diagnostics(tsFile)).toHaveLength(1);
    } finally {
      await client.shutdown();
    }
  }, 15000);

  it('bounds shutdown when a server ignores the exit notification', async () => {
    const stubbornFixture = path.join(tempDir, 'stubborn-lsp-server.mjs');
    await fs.writeFile(stubbornFixture, STUBBORN_LSP_SOURCE, 'utf8');
    const client = await createLspClient({
      serverId: 'stubborn',
      root: tempDir,
      launch: { command: process.execPath, args: [stubbornFixture] },
    });

    const startedAt = Date.now();
    await client.shutdown();

    expect(Date.now() - startedAt).toBeLessThan(8_000);
  }, 15_000);
});
