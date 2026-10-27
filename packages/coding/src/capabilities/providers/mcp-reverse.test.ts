import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  McpServerRuntime,
  setActiveUserInteraction,
  type McpElicitRequest,
  type UserInteraction,
} from '@kodax-ai/agent';
import {
  activeElicitHandler,
  buildMcpReverseCapabilities,
  elicitViaUserInteraction,
  mcpRootsFromWorkspace,
} from './mcp-reverse.js';

const fileUri = (dir: string): string => pathToFileURL(path.resolve(dir)).href;

const tempDirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  // Tests register a live interaction surface; never leak it across tests.
  setActiveUserInteraction(undefined);
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kodax-mcp-reverse-'));
  tempDirs.push(dir);
  return dir;
}

/** A minimal form `requestedSchema` with a single typed property. */
const formRequest = (
  properties: Record<string, unknown>,
  message = 'Tell me',
): McpElicitRequest => ({ mode: 'form', message, requestedSchema: { type: 'object', properties } });

describe('mcpRootsFromWorkspace', () => {
  it('exposes the cwd as a single file:// root named after its basename', () => {
    const cwd = path.resolve(path.join('some', 'project'));
    expect(mcpRootsFromWorkspace({ cwd })).toEqual([{ uri: fileUri(cwd), name: 'project' }]);
  });

  it('adds the git root when it differs, cwd first', () => {
    const cwd = path.resolve(path.join('repo', 'packages', 'app'));
    const gitRoot = path.resolve('repo');
    expect(mcpRootsFromWorkspace({ cwd, gitRoot })).toEqual([
      { uri: fileUri(cwd), name: 'app' },
      { uri: fileUri(gitRoot), name: 'repo' },
    ]);
  });

  it('de-duplicates when cwd === gitRoot', () => {
    const cwd = path.resolve('repo');
    expect(mcpRootsFromWorkspace({ cwd, gitRoot: cwd })).toEqual([{ uri: fileUri(cwd), name: 'repo' }]);
  });

  it('includes extra roots, de-duplicated', () => {
    const cwd = path.resolve('a');
    const extra = path.resolve('b');
    const roots = mcpRootsFromWorkspace({ cwd, extraRoots: [extra, cwd] });
    expect(roots.map((r) => r.uri)).toEqual([fileUri(cwd), fileUri(extra)]);
  });
});

describe('buildMcpReverseCapabilities', () => {
  it('returns a listRoots handler resolving to the workspace roots', async () => {
    const cwd = path.resolve(path.join('x', 'proj'));
    const reverse = buildMcpReverseCapabilities({ cwd });
    expect(reverse?.listRoots).toBeDefined();
    expect(await reverse?.listRoots?.()).toEqual([{ uri: fileUri(cwd), name: 'proj' }]);
  });

  it('does NOT wire elicitation unless the host opts in', () => {
    const reverse = buildMcpReverseCapabilities({ cwd: path.resolve('x') });
    expect(reverse?.elicit).toBeUndefined();
    expect(reverse?.elicitationModes).toBeUndefined();
  });

  it('wires form + url elicitation when enableElicitation is set', () => {
    const reverse = buildMcpReverseCapabilities({ cwd: path.resolve('x'), enableElicitation: true });
    expect(reverse?.elicit).toBeInstanceOf(Function);
    expect(reverse?.elicitationModes).toEqual({ form: true, url: true });
  });
});

describe('elicitViaUserInteraction — form mode', () => {
  it.each(['skipped', 'timeout', 'non_interactive'] as const)('cancels unanswered confirmation and URL requests (%s)', async reason => {
    const ui: UserInteraction = { askUser: async () => ({ unanswered: true, reason }) };
    for (const request of [
      { mode: 'form' as const, message: 'Proceed?' },
      { mode: 'url' as const, url: 'https://auth.example.test', message: 'Authorize?' },
    ]) {
      expect(await elicitViaUserInteraction(ui, request)).toEqual({ action: 'cancel' });
    }
  });

  it('confirm-only form (no fields) maps to a single approve prompt → accept {}', async () => {
    const ui: UserInteraction = { askUser: async () => 'accept' };
    const result = await elicitViaUserInteraction(ui, { mode: 'form', message: 'Proceed?' });
    expect(result).toEqual({ action: 'accept', content: {} });
  });

  it('confirm-only form declines when the user picks decline', async () => {
    const ui: UserInteraction = { askUser: async () => 'decline' };
    expect(await elicitViaUserInteraction(ui, { mode: 'form' })).toEqual({ action: 'decline' });
  });

  it('confirm-only form declines when no select surface exists', async () => {
    const ui: UserInteraction = { askUserInput: async () => 'ignored' };
    expect(await elicitViaUserInteraction(ui, { mode: 'form' })).toEqual({ action: 'decline' });
  });

  it('routes a string field to free-text input', async () => {
    const asked: string[] = [];
    const ui: UserInteraction = {
      askUserInput: async ({ question }) => {
        asked.push(question);
        return 'alice';
      },
    };
    const result = await elicitViaUserInteraction(ui, formRequest({ username: { type: 'string', title: 'Name' } }));
    expect(result).toEqual({ action: 'accept', content: { username: 'alice' } });
    expect(asked[0]).toContain('Name');
  });

  it('coerces a number field through Number()', async () => {
    const ui: UserInteraction = { askUserInput: async () => '42' };
    const result = await elicitViaUserInteraction(ui, formRequest({ age: { type: 'number' } }));
    expect(result).toEqual({ action: 'accept', content: { age: 42 } });
  });

  it('routes an enum field to a select prompt', async () => {
    const offered: Array<{ label: string; value: string }> = [];
    const ui: UserInteraction = {
      askUser: async ({ options }) => {
        if (options?.some((o) => o.value === 'send')) return 'send'; // review-before-send
        for (const o of options ?? []) offered.push({ label: o.label, value: o.value });
        return '1';
      },
    };
    const result = await elicitViaUserInteraction(ui, formRequest({ color: { enum: ['red', 'blue'] } }));
    expect(result).toEqual({ action: 'accept', content: { color: 'blue' } });
    expect(offered).toEqual([{ label: 'red', value: '0' }, { label: 'blue', value: '1' }]);
  });

  it('preserves the original enum value type in the accepted content', async () => {
    const ui: UserInteraction = {
      askUser: async ({ options }) => (options?.some((o) => o.value === 'send') ? 'send' : '1'),
    };
    const result = await elicitViaUserInteraction(ui, formRequest({ retries: { enum: [1, 3] } }));
    expect(result).toEqual({ action: 'accept', content: { retries: 3 } });
  });

  it('maps a boolean field to a yes/no select coerced to a boolean', async () => {
    const ui: UserInteraction = {
      askUser: async ({ options }) => (options?.some((o) => o.value === 'send') ? 'send' : 'true'),
    };
    const result = await elicitViaUserInteraction(ui, formRequest({ flag: { type: 'boolean' } }));
    expect(result).toEqual({ action: 'accept', content: { flag: true } });
  });

  it('cancels when the user dismisses a free-text field', async () => {
    const ui: UserInteraction = { askUserInput: async () => undefined };
    expect(await elicitViaUserInteraction(ui, formRequest({ note: { type: 'string' } }))).toEqual({ action: 'cancel' });
  });

  it.each([
    { type: 'string' },
    { type: 'number' },
    { type: 'boolean' },
    { type: 'string', enum: ['first', 'second'] },
  ])('keeps an unanswered $type field out of MCP form content', async property => {
    const ui: UserInteraction = {
      askUser: async ({ options }) => options?.some(option => option.value === 'send')
        ? 'send' : { unanswered: true, reason: 'skipped' },
      askUserInput: async () => ({ unanswered: true, reason: 'skipped' }),
    };
    expect(await elicitViaUserInteraction(ui, formRequest({ field: property }))).toEqual({ action: 'cancel' });
  });

  it('declines a field it cannot ask (no input surface)', async () => {
    const ui: UserInteraction = { askUser: async () => 'x' };
    expect(await elicitViaUserInteraction(ui, formRequest({ note: { type: 'string' } }))).toEqual({ action: 'decline' });
  });

  it('degrades a throwing surface to cancel (never leaks an error to the server)', async () => {
    const ui: UserInteraction = {
      askUserInput: async () => {
        throw new Error('UI torn down');
      },
    };
    expect(await elicitViaUserInteraction(ui, formRequest({ note: { type: 'string' } }))).toEqual({ action: 'cancel' });
  });

  it('shows which MCP server is asking (anti-phishing) in the field prompt', async () => {
    let shown = '';
    const ui: UserInteraction = {
      askUser: async ({ question, options }) => {
        if (options?.some((o) => o.value === 'send')) return 'send';
        shown = question;
        return '0';
      },
    };
    await elicitViaUserInteraction(ui, {
      mode: 'form',
      serverId: 'github',
      message: 'Pick one',
      requestedSchema: { type: 'object', properties: { choice: { enum: ['a'] } } },
    });
    expect(shown).toContain('MCP server "github"');
    expect(shown).toContain('Pick one');
  });

  it('cancels the form when the user declines the review-before-send step', async () => {
    const ui: UserInteraction = {
      askUser: async ({ options }) => (options?.some((o) => o.value === 'send') ? 'cancel' : '0'),
    };
    const result = await elicitViaUserInteraction(ui, formRequest({ choice: { enum: ['a', 'b'] } }));
    expect(result).toEqual({ action: 'cancel' });
  });
});

describe('elicitViaUserInteraction — url mode', () => {
  it('shows which MCP server is requesting browser authorization', async () => {
    let shown = '';
    const ui: UserInteraction = {
      askUser: async ({ question }) => { shown = question; return 'decline'; },
    };
    await elicitViaUserInteraction(ui, { mode: 'url', serverId: 'payments', url: 'https://pay.example/auth' });
    expect(shown).toContain('MCP server "payments"');
    expect(shown).toContain('pay.example');
  });

  it('shows the URL + its domain and accepts on consent (never auto-opens)', async () => {
    let shown = '';
    const ui: UserInteraction = {
      askUser: async ({ question }) => {
        shown = question;
        return 'accept';
      },
    };
    const result = await elicitViaUserInteraction(ui, {
      mode: 'url',
      message: 'Authorize',
      url: 'https://auth.example.test/grant?token=abc',
    });
    expect(result).toEqual({ action: 'accept', content: {} });
    expect(shown).toContain('https://auth.example.test/grant?token=abc');
    expect(shown).toContain('auth.example.test');
    expect(shown).toMatch(/NOT open/i);
  });

  it('declines when the user does not consent', async () => {
    const ui: UserInteraction = { askUser: async () => 'decline' };
    const result = await elicitViaUserInteraction(ui, { mode: 'url', url: 'https://x.example/y' });
    expect(result).toEqual({ action: 'decline' });
  });

  it('declines a url elicitation with no URL', async () => {
    const ui: UserInteraction = { askUser: async () => 'accept' };
    expect(await elicitViaUserInteraction(ui, { mode: 'url' })).toEqual({ action: 'decline' });
  });

  it('declines when there is no select surface to consent with', async () => {
    const ui: UserInteraction = { askUserInput: async () => 'x' };
    expect(await elicitViaUserInteraction(ui, { mode: 'url', url: 'https://x.example/y' })).toEqual({ action: 'decline' });
  });
});

describe('activeElicitHandler — resolves the live surface at call time', () => {
  it('declines when no interaction surface is registered (headless / between turns)', async () => {
    setActiveUserInteraction(undefined);
    expect(await activeElicitHandler()({ mode: 'form' })).toEqual({ action: 'decline' });
  });

  it('declines when the registered surface has no ask capability', async () => {
    setActiveUserInteraction({});
    expect(await activeElicitHandler()({ mode: 'form' })).toEqual({ action: 'decline' });
  });

  it('routes to the surface registered AFTER the handler was built (late binding)', async () => {
    const handler = activeElicitHandler(); // built before any surface is live
    setActiveUserInteraction({ askUser: async () => 'accept' });
    expect(await handler({ mode: 'form', message: 'ok?' })).toEqual({ action: 'accept', content: {} });
  });

  it('cancels and aborts a registered surface that never answers', async () => {
    vi.useFakeTimers();
    let promptSignal: AbortSignal | undefined;
    setActiveUserInteraction({
      askUser: async (_options, context) => {
        promptSignal = context?.signal;
        return new Promise<never>(() => undefined);
      },
    });

    const handling = activeElicitHandler()({ mode: 'form', message: 'ok?' });
    await Promise.resolve();
    expect(promptSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(5 * 60 * 1_000);

    await expect(handling).resolves.toEqual({ action: 'cancel' });
    expect(promptSignal?.aborted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: a fake stdio MCP server elicits the user; the coding bridge must
// resolve the live interaction surface and answer the server over the wire.
// ---------------------------------------------------------------------------

function createFormElicitServerSource(recordPath: string): string {
  return `
const fs = require('node:fs');
let buffer = '';
function writeMessage(p){ process.stdout.write(JSON.stringify(p) + '\\n'); }
function record(p){ fs.appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify(p) + '\\n'); }
function handle(m){
  if (m.method === undefined && m.id !== undefined) { record(m); return; } // client response
  if (m.method === 'initialize') {
    writeMessage({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'coding-elicit-test', version: '1.0.0' } } });
    writeMessage({ jsonrpc: '2.0', id: 'elicit-1', method: 'elicitation/create', params: { mode: 'form', message: 'Your name?', requestedSchema: { type: 'object', properties: { username: { type: 'string' } }, required: ['username'] } } });
    return;
  }
  if (m.method === 'tools/list'){ writeMessage({ jsonrpc: '2.0', id: m.id, result: { tools: [] } }); return; }
  if (m.method === 'resources/list'){ writeMessage({ jsonrpc: '2.0', id: m.id, result: { resources: [] } }); return; }
  if (m.method === 'prompts/list'){ writeMessage({ jsonrpc: '2.0', id: m.id, result: { prompts: [] } }); }
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (true) {
    const lineEnd = buffer.indexOf('\\n');
    if (lineEnd < 0) { return; }
    const line = buffer.slice(0, lineEnd).replace(/\\r$/, '').trim();
    buffer = buffer.slice(lineEnd + 1);
    if (!line) { continue; }
    try { handle(JSON.parse(line)); } catch { process.exit(2); }
  }
});
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
`;
}

describe('FEATURE_222 elicitation bridge (coding → agent runtime → fake MCP server)', () => {
  it('answers a server form elicitation from the live host interaction surface', async () => {
    const dir = await createTempDir();
    const recordPath = path.join(dir, 'elicit.jsonl');
    const scriptPath = path.join(dir, 'server.cjs');
    await writeFile(scriptPath, createFormElicitServerSource(recordPath), 'utf8');

    // The host registers its live ask-user surface (as the REPL does on mount).
    setActiveUserInteraction({ askUserInput: async () => 'alice' });

    const reverse = buildMcpReverseCapabilities({ cwd: dir, enableElicitation: true });
    const runtime = new McpServerRuntime(
      'coding-elicit-test',
      {
        type: 'stdio',
        command: process.execPath,
        args: [scriptPath],
        connect: 'lazy',
        startupTimeoutMs: 1_000,
        requestTimeoutMs: 1_000,
      },
      path.join(dir, 'cache'),
      reverse,
    );

    try {
      await runtime.refreshCatalog(true);
      await expect
        .poll(() => readFile(recordPath, 'utf8').catch(() => ''))
        .toContain('elicit-1');
    } finally {
      await runtime.dispose();
    }

    const records = (await readFile(recordPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const response = records.find((r) => r.id === 'elicit-1' && r.method === undefined);
    expect(response?.result).toEqual({ action: 'accept', content: { username: 'alice' } });
  });

  it('declines a server elicitation when no host surface is live (headless)', async () => {
    const dir = await createTempDir();
    const recordPath = path.join(dir, 'elicit-headless.jsonl');
    const scriptPath = path.join(dir, 'server.cjs');
    await writeFile(scriptPath, createFormElicitServerSource(recordPath), 'utf8');

    // No setActiveUserInteraction — simulate print/headless mode.
    const reverse = buildMcpReverseCapabilities({ cwd: dir, enableElicitation: true });
    const runtime = new McpServerRuntime(
      'coding-elicit-headless',
      {
        type: 'stdio',
        command: process.execPath,
        args: [scriptPath],
        connect: 'lazy',
        startupTimeoutMs: 1_000,
        requestTimeoutMs: 1_000,
      },
      path.join(dir, 'cache'),
      reverse,
    );

    try {
      await runtime.refreshCatalog(true);
      await expect
        .poll(() => readFile(recordPath, 'utf8').catch(() => ''))
        .toContain('elicit-1');
    } finally {
      await runtime.dispose();
    }

    const records = (await readFile(recordPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const response = records.find((r) => r.id === 'elicit-1' && r.method === undefined);
    // Capability is advertised (host opted in), but with no live surface the
    // bridge declines rather than hanging the server.
    expect(response?.result).toEqual({ action: 'decline' });
  });
});
