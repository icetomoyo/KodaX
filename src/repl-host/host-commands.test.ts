/**
 * The REPL's Host commands over v2, against a real Host with a scripted model.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { disposeReplHosts, replHost } from '../../tests/repl-v2-host.js';
import { createReplHostCommands } from './host-commands.js';

afterEach(disposeReplHosts, 60_000);

async function writeCommand(homeDir: string): Promise<void> {
  const commands = path.join(homeDir, '.kodax', 'commands');
  await mkdir(commands, { recursive: true });
  await writeFile(path.join(commands, 'release.md'),
    ['---', 'name: release', 'description: Check the release', '---', 'Check the actual release gate.'].join('\n'));
}

describe('the REPL Host commands over v2', () => {
  it('lists, reads and runs a command, sent under its input id, on the key the CLI lends', async () => {
    const { client, homeDir, sessionId } = await replHost('answer');
    await writeCommand(homeDir);
    const asked: unknown[] = [];
    const commands = createReplHostCommands(client, async (request) => { asked.push(request); return undefined; });

    expect(await commands.listHostCommands(homeDir))
      .toEqual(expect.arrayContaining([expect.objectContaining({ name: 'release', description: 'Check the release' })]));
    expect(await commands.commandClient.readPrompt({ sessionId, name: 'release', args: ['auth'] }))
      .toMatchObject({ text: expect.stringContaining('Check the actual release gate.') });
    expect(await commands.commandClient.readPrompt({ sessionId, name: 'no-such-command' })).toBeNull();

    const input = { sessionId, inputId: 'command-1', name: 'release', args: ['auth'] };
    const started = await commands.commandClient.execute(input);
    expect(started).toEqual({ kind: 'started', runId: expect.any(String) });
    expect(asked).toEqual([{ kind: 'command', input }]);
    // Sent again, the Host answers with the Run the first one started.
    expect(await commands.commandClient.execute(input)).toEqual(started);

    await client.call('run.wait', { runId: started.kind === 'started' ? started.runId : '' });
    expect(await commands.commandClient.execute({ ...input, inputId: 'command-2', args: ['--help'] }))
      .toEqual({ kind: 'completed', success: true, message: expect.stringContaining('Check the release') });
  }, 60_000);

  it('answers a review and AGENTS.md guidance the Host had nothing to start a Run for', async () => {
    const { client, sessionId } = await replHost('answer');
    const asked: unknown[] = [];
    const commands = createReplHostCommands(client, async (request) => { asked.push(request); return undefined; });

    expect(await commands.startReview({ sessionId, inputId: 'review-1', args: ['--staged'] }))
      .toEqual({ kind: 'completed', success: expect.any(Boolean), message: expect.any(String) });
    expect(await commands.reviewAgentsLean({ sessionId, inputId: 'lean-1' }))
      .toEqual({ kind: 'completed', success: false, message: expect.any(String) });
    expect(asked).toEqual([
      { kind: 'review', input: { sessionId, inputId: 'review-1', args: ['--staged'] } },
      { kind: 'agents_lean', input: { sessionId, inputId: 'lean-1' } },
    ]);
  });

  it('reports extensions and MCP servers as the REPL reads them', async () => {
    const { client } = await replHost('answer');
    const commands = createReplHostCommands(client, async () => undefined);

    expect(await commands.inspectExtensions()).toEqual({ active: expect.any(Boolean), extensions: [], failures: [] });
    expect(await commands.mcp.status()).toEqual([]);
    expect(await commands.mcp.listTools({ forceRefresh: true })).toEqual([]);
    await expect(commands.mcp.listTools({ server: 'no-such-server' })).rejects.toMatchObject({ kodaxCode: 'not_found' });
  });
});
