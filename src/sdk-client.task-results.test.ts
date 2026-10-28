import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { actorQueueId, getMessageQueue, type KodaXTaskResultMetadata } from '@kodax-ai/agent';
import { KodaXBaseProvider, registerModelProvider, clearRuntimeModelProviders,
  type KodaXMessage, type KodaXStreamResult } from '@kodax-ai/llm';
import { FileSessionStorage } from '@kodax-ai/repl';
import type { ClientItemContent, ClientSessionView, ClientViewItem } from '@kodax-ai/coding/client-contract';
import { connectKodaXClient } from './sdk-client.js';
import { createKodaXRuntime } from './sdk-runtime.js';
import { startRuntimeDaemonHost } from './runtime-daemon/host.js';
import { resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from './runtime-daemon/state.js';

async function openHost(homeDir: string) {
  const runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: 'task-report-fixture' });
  const paths = resolveRuntimeDaemonPaths(homeDir);
  const lock = tryAcquireRuntimeDaemonLock(paths, { runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt });
  if (!lock) throw new Error('Could not acquire isolated report Host.');
  const endpoint = { kind: process.platform === 'win32' ? 'pipe' as const : 'unix' as const,
    path: process.platform === 'win32' ? path.win32.join('//./pipe', `kodax-task-report-${randomUUID()}`) : path.join(homeDir, 'host.sock') };
  let host: Awaited<ReturnType<typeof startRuntimeDaemonHost>> | undefined;
  try {
    host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
    const client = await connectKodaXClient({ homeDir, endpoint: endpoint.path });
    return { client, runtime, close: async () => { await client.disconnect(); await host!.close(); await runtime.close(); } };
  } catch (error: unknown) { await host?.close(); await runtime.close(); throw error; }
}

const xml = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const reports = (items: readonly ClientViewItem[]) => items.filter(item => item.taskResult);
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
async function readBody(read: (offset: number) => Promise<ClientItemContent | null>): Promise<string> {
  let body = '', offset = 0;
  for (;;) {
    const chunk = await read(offset);
    expect(chunk).not.toBeNull();
    body += chunk!.text;
    if (chunk!.nextOffset === undefined) return body;
    offset = chunk!.nextOffset;
  }
}

it.each([1, 3])('preserves %s queued task reports over live Product IPC, history and Host restart', async count => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-client-task-results-'));
  vi.stubEnv('KODAX_TASK_REPORT_KEY', 'fixture-only');
  vi.stubEnv('KODAX_HOME', path.join(root, '.kodax'));
  const requests: KodaXMessage[][] = [];
  class Provider extends KodaXBaseProvider {
    readonly name = 'task-report-fixture';
    readonly supportsThinking = false;
    protected readonly config = { apiKeyEnv: 'KODAX_TASK_REPORT_KEY', model: 'fixture', supportsThinking: false };
    async stream(messages: KodaXMessage[]): Promise<KodaXStreamResult> {
      requests.push(structuredClone(messages));
      if (requests.length > 8) throw new Error('Offline report fixture exceeded its request bound.');
      return { textBlocks: [{ type: 'text', text: 'Root task completed; child outcomes retained.' }],
        thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
    }
  }
  registerModelProvider('task-report-fixture', () => new Provider());
  let connection: Awaited<ReturnType<typeof openHost>> | undefined;
  try {
    connection = await openHost(root);
    let client = connection.client;
    const session = await client.sessions.create({ projectPath: root });
    await client.sessions.updateSettings(session.id, { agentMode: 'ama', permissionMode: 'full-access' });
    const delivered: KodaXTaskResultMetadata[] = (['completed', 'failed', 'cancelled'] as const).slice(0, count).map((status, index) => ({
      type: 'task_result', source: index === 0 ? 'workflow' : 'child_task', runId: index === 0 ? 'workflow-1' : undefined,
      taskId: `child-${index}`, title: `/root/worker-${index}`, status,
      summary: '\n# Report\n```xml\n<node value="&amp; literal"/>\n```\n' + (index === 0 ? '图文🙂'.repeat(40_000) : 'Same body'),
    }));
    const views: ClientSessionView[] = [];
    let rootRunId: string | undefined;
    const observation = await client.sessions.observe(session.id, view => views.push(view));
    try {
      for (const result of delivered) getMessageQueue().enqueue({ priority: 'background', mode: 'task-notification',
        agentId: actorQueueId(session.id, '/root'), taskResult: result,
        content: `<agent-completed turn_id="${result.taskId}" state="${result.status}">\n${xml(result.summary!)}\n</agent-completed>` });
      const accepted = await client.inputs.submit({ sessionId: session.id, inputId: 'root-query', text: 'Read the delivered reports and finish.' });
      rootRunId = accepted.runId;
      const outcome = await client.runs.await(accepted.runId!);
      expect(outcome).toMatchObject({ phase: 'completed' });
      expect(outcome.failureDetail).toBeUndefined();
      await expect.poll(() => reports(views.at(-1)?.items ?? []).length, { timeout: 15_000 }).toBe(count);
      expect(requests.some(messages => messages.some(message => message._taskResult || message._taskResults))).toBe(true);
    } finally { observation.close(); }
    const live = reports(views.at(-1)!.items);
    expect(live.map(item => item.taskResult?.status)).toEqual(delivered.map(result => result.status));
    expect(live.map(item => item.taskResult?.source)).toEqual(delivered.map(result => result.source));
    const identities = live.map(item => item.id);
    const verify = async () => {
      const current: ClientSessionView[] = [];
      const subscription = await client.sessions.observe(session.id, view => current.push(view));
      try {
        await expect.poll(() => reports(current.at(-1)?.items ?? []).length, { timeout: 15_000 }).toBe(count);
        expect(reports(current.at(-1)!.items).map(item => item.id)).toEqual(identities);
        const rootState = await client.runs.read(rootRunId!);
        expect(rootState).toMatchObject({ phase: 'completed' });
        expect(rootState?.failureDetail).toBeUndefined();
        const history = await client.sessions.readHistory(session.id, { limit: 50 });
        const historical = reports(history.items);
        expect(historical.map(item => item.taskResult)).toEqual(live.map(item => item.taskResult));
        for (const [index, item] of historical.entries()) {
          const body = await readBody(offset => client.sessions.readHistoryEntry(session.id, item.id, { offset }));
          expect(hash(body)).toBe(hash(delivered[index]!.summary!));
          const visible = await readBody(offset => client.sessions.readItem(session.id, identities[index]!, { offset }));
          expect(hash(visible)).toBe(hash(body));
        }
      } finally { subscription.close(); }
    };
    await verify();
    await connection.close();
    connection = await openHost(root);
    client = connection.client;
    await verify();
  } finally {
    await connection?.close();
    clearRuntimeModelProviders(); vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 90_000);

it('restores explicitly sourced legacy reports over Product IPC without inferring status from prose', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-client-legacy-report-'));
  const storage = new FileSessionStorage({ sessionsDir: path.join(root, '.kodax/sessions'), configHome: path.join(root, '.kodax'), cwd: root });
  await storage.save('legacy-report', { title: 'Legacy', gitRoot: root, scope: 'user', messages: [
    { role: 'user', _source: 'task-completed', _synthetic: true,
      content: '<task-completed task_id="old">failed: quoted &amp;amp; text</task-completed>' },
  ] });
  let connection: Awaited<ReturnType<typeof openHost>> | undefined;
  try {
    connection = await openHost(root);
    const page = await connection.client.sessions.readHistory('legacy-report');
    expect(reports(page.items)).toHaveLength(1);
    expect(reports(page.items)[0]).toMatchObject({ type: 'event', text: 'failed: quoted &amp; text',
      taskResult: { taskId: 'old', status: 'unknown', reportFormat: 'markdown' } });
  } finally {
    await connection?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 30_000);
