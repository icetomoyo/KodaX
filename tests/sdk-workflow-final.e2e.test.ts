import { mkdir, mkdtemp, readFile, realpath, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import path from 'node:path';
import { expect, it } from 'vitest';
import { ensureKodaXClient, connectKodaXClient } from '../src/sdk-client.js';
import { getKodaXRuntimeOwnerState, waitForRuntimeDaemonShutdown } from '../src/sdk-runtime.js';
import type { RuntimeExecutionAuthorization } from '../src/client-host-authorization.js';

const execFileAsync = promisify(execFile);

it.each(['success', 'failure', 'cancel', 'partial-cleanup', 'crash'] as const)('persists Workflow %s after disconnect and a cold Host restart', async outcome => {
  const homeDir = await mkdtemp(path.join(await realpath(os.tmpdir()), 'kodax-workflow-final-'));
  const profile = 'workflow-final';
  await mkdir(path.join(homeDir, '.kodax'), { recursive: true });
  await writeFile(path.join(homeDir, '.kodax', 'config.json'), JSON.stringify({ provider: 'workflow-fixture', model: 'fixture',
    customProviders: [{ name: 'workflow-fixture', protocol: 'openai', model: 'fixture',
      baseUrl: 'http://127.0.0.1:1/v1', apiKeyEnv: 'KODAX_UNUSED_WORKFLOW_FIXTURE_KEY' }] }));
  const git = (args: string[]) => execFileAsync('git', args, { cwd: homeDir, windowsHide: true });
  if (outcome === 'partial-cleanup' || outcome === 'crash') {
    await git(['init']);
    await git(['config', 'user.email', 'fixture@example.invalid']);
    await git(['config', 'user.name', 'Workflow fixture']);
    await writeFile(path.join(homeDir, 'project.txt'), 'Preserved project original.');
    await git(['add', 'project.txt']); await git(['commit', '-m', 'fixture']);
  }
  let client = await ensureKodaXClient({ homeDir, profile });
  let peer = await connectKodaXClient({ homeDir, profile });
  let cleanupPaths: { scratch: string; locked: string; referenced: string; unknown: string; runDir: string } | undefined;
  let testFailure: unknown;
  try {
    const session = await client.sessions.create({ projectPath: homeDir });
    const started = await client.workflows.start({ sessionId: session.id, projectRoot: homeDir, args: { fail: true },
      source: { kind: 'inline', manifest: { name: 'durable-final', description: 'Persist the final result.',
        phases: ['synthesize'], readOnly: true, maxAgents: 1, maxConcurrency: 1,
        patterns: ['fan-out-and-synthesize'] },
      source: outcome === 'success'
        ? 'async function run(wf, args) { return { synthesis: "Durable workflow answer", details: [1,2,3] }; }'
        : outcome === 'failure'
          ? 'async function run(wf, args) { if (args.fail) throw new Error("Durable workflow failure"); return "unexpected success"; }'
          : 'async function run(wf, args) { await wf.artifact("reference", { originalPath: "worktrees/referenced/project.txt" }); wf.log("waiting for Stop"); await new Promise(() => {}); return "unexpected success"; }' } });
    if (started.kind !== 'started') throw new Error('Fixture Workflow was declined.');
    await client.disconnect();
    if (outcome === 'cancel' || outcome === 'partial-cleanup' || outcome === 'crash') {
      await expect.poll(async () => (await peer.workflows.get(started.runId))?.latestMessage, { timeout: 10_000 }).toBe('waiting for Stop');
      if (outcome === 'partial-cleanup' || outcome === 'crash') {
        const [run] = await peer.workflows.list({ runId: started.runId });
        if (!run) throw new Error('Missing public Workflow run.');
        cleanupPaths = { runDir: run.runDir, scratch: path.join(run.runDir, 'worktrees', 'scratch'),
          locked: path.join(run.runDir, 'worktrees', 'locked'), referenced: path.join(run.runDir, 'worktrees', 'referenced'),
          unknown: path.join(path.dirname(run.runDir), 'unknown-run', 'worktrees', 'unknown') };
        for (const target of [cleanupPaths.scratch, cleanupPaths.locked, cleanupPaths.referenced, cleanupPaths.unknown]) {
          await git(['worktree', 'add', '--detach', target, 'HEAD']);
        }
        await git(['worktree', 'lock', cleanupPaths.locked, '--reason', 'fixture cleanup interruption']);
      }
      if (outcome === 'crash') {
        const beforeCrash = await readFile(path.join(cleanupPaths!.runDir, 'events.jsonl'), 'utf8');
        const owner = getKodaXRuntimeOwnerState({ homeDir, profile }).owner!;
        await peer.disconnect();
        process.kill(owner.pid, 'SIGKILL');
        expect(await waitForRuntimeDaemonShutdown({ configHome: path.join(homeDir, '.kodax'), profile, owner, timeoutMs: 500 })).toMatchObject({ status: 'unverified', reason: 'outcome_missing' });
        client = await ensureKodaXClient({ homeDir, profile });
        peer = await connectKodaXClient({ homeDir, profile });
        expect(await peer.runs.read(started.runId)).toMatchObject({ phase: 'interrupted', terminal: { code: 'daemon_crashed', effectOutcome: 'unknown' } });
        expect((await peer.sessions.readHistory(session.id)).items.filter(item => item.taskResult?.source === 'workflow')).toEqual([]);
        for (const target of [cleanupPaths!.scratch, cleanupPaths!.locked, cleanupPaths!.referenced, cleanupPaths!.unknown]) {
          expect(existsSync(target)).toBe(true);
        }
        expect(await readFile(path.join(cleanupPaths!.runDir, 'events.jsonl'), 'utf8')).toBe(beforeCrash);
        expect(existsSync(path.join(cleanupPaths!.runDir, 'cleanup.json'))).toBe(false);
        return;
      }
      expect(await peer.workflows.stop(started.runId, { sessionId: session.id })).toBe(true);
    }
    const terminal = await peer.runs.await(started.runId);
    expect(terminal.phase).toBe(outcome === 'success' ? 'completed' : outcome === 'failure' ? 'failed' : 'interrupted');
    const history = await peer.sessions.readHistory(session.id);
    const results = history.items.filter(item => item.taskResult?.source === 'workflow');
    expect(results).toHaveLength(1);
    const text = results[0]!.text;
    if (outcome === 'success') {
      expect(text).toContain('Durable workflow answer');
      const resultPath = results[0]!.taskResult?.artifactRefs?.find(ref => path.basename(ref) === 'result.json');
      expect(resultPath).toBeTruthy();
      expect(JSON.parse(await readFile(resultPath!, 'utf8'))).toEqual({ version: 1,
        value: { synthesis: 'Durable workflow answer', details: [1, 2, 3] } });
    } else {
      expect(results[0]!.taskResult?.artifactRefs?.some(ref => path.basename(ref) === 'result.json')).toBe(false);
      if (outcome === 'failure') expect(text).toContain('Durable workflow failure');
    }
    expect(text).not.toContain(homeDir);
    expect(results[0]!.taskResult?.artifactRefs?.some(ref => path.basename(ref) === 'run.json')).toBe(true);
    if (cleanupPaths) {
      const receipt = path.join(cleanupPaths.runDir, 'cleanup.json');
      await expect.poll(() => existsSync(receipt), { timeout: 10_000 }).toBe(true);
      expect(JSON.parse(await readFile(receipt, 'utf8')).completed).toBe(false);
      expect(existsSync(cleanupPaths.scratch)).toBe(false);
      expect(existsSync(cleanupPaths.locked)).toBe(true);
      expect(existsSync(cleanupPaths.referenced)).toBe(true);
      expect(existsSync(cleanupPaths.unknown)).toBe(true);
    }
    const owner = getKodaXRuntimeOwnerState({ homeDir, profile }).owner!;
    await peer.host.shutdown(); await peer.disconnect();
    expect(await waitForRuntimeDaemonShutdown({ configHome: path.join(homeDir, '.kodax'), profile, owner })).toMatchObject({ status: 'succeeded' });
    if (cleanupPaths) await git(['worktree', 'unlock', cleanupPaths.locked]);
    client = await ensureKodaXClient({ homeDir, profile });
    peer = await connectKodaXClient({ homeDir, profile });
    if (cleanupPaths) {
      await expect.poll(() => existsSync(cleanupPaths!.locked), { timeout: 10_000 }).toBe(false);
      await expect.poll(async () => JSON.parse(await readFile(path.join(cleanupPaths!.runDir, 'cleanup.json'), 'utf8')).completed,
        { timeout: 10_000 }).toBe(true);
      expect(existsSync(cleanupPaths.referenced)).toBe(true);
      expect(existsSync(cleanupPaths.unknown)).toBe(true);
      expect(await readFile(path.join(homeDir, 'project.txt'), 'utf8')).toBe('Preserved project original.');
      expect(await readdir(path.join(homeDir, '.kodax', 'runtime', 'workflow-cleanups'))).toEqual([]);
    }
    const recovered = await peer.sessions.readHistory(session.id);
    expect(recovered.items.filter(item => item.taskResult?.source === 'workflow').map(item => item.text)).toEqual([text]);
  } catch (error: unknown) { testFailure = error; throw error; } finally {
    const owner = getKodaXRuntimeOwnerState({ homeDir, profile }).owner;
    await client.disconnect(); await peer.disconnect();
    const cleanupClient = await connectKodaXClient({ homeDir, profile }).catch(error => {
      if (testFailure !== undefined) throw new AggregateError([testFailure, error], 'Workflow test and fixture cleanup failed');
      throw error;
    });
    await cleanupClient.host.shutdown(); await cleanupClient.disconnect();
    if (owner) expect(await waitForRuntimeDaemonShutdown({ configHome: path.join(homeDir, '.kodax'), profile, owner })).toMatchObject({ status: 'succeeded' });
    await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 120_000);

it.each([
  { peerActive: false, projectAlias: false },
  { peerActive: true, projectAlias: false },
  { peerActive: true, projectAlias: true },
])('preserves another client project worktree through Workflow cleanup and cold retry (peer active: $peerActive, project alias: $projectAlias)', async ({ peerActive, projectAlias }) => {
  const homeDir = await mkdtemp(path.join(await realpath(os.tmpdir()), 'kodax-workflow-peer-project-'));
  await mkdir(path.join(homeDir, '.kodax'), { recursive: true });
  await writeFile(path.join(homeDir, '.kodax', 'config.json'), JSON.stringify({ provider: 'workflow-fixture', model: 'fixture',
    customProviders: [{ name: 'workflow-fixture', protocol: 'openai', model: 'fixture',
      baseUrl: 'http://127.0.0.1:1/v1', apiKeyEnv: 'KODAX_UNUSED_WORKFLOW_FIXTURE_KEY' }] }));
  const git = (args: string[]) => execFileAsync('git', args, { cwd: homeDir, windowsHide: true });
  await git(['init']); await git(['config', 'user.name', 'Fixture']); await git(['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(path.join(homeDir, 'project.txt'), 'Peer project original.');
  await git(['add', 'project.txt']); await git(['commit', '-m', 'fixture']);
  const children: ReturnType<typeof spawn>[] = [];
  const launch = async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', path.resolve('tests/sdk-contract-host.fixture.ts'), homeDir], {
      cwd: process.cwd(), windowsHide: true,
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(API_KEY|TOKEN|SECRET|PASSWORD)$/.test(key))),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.push(child); child.stdout!.resume(); child.stderr!.resume();
    const ready = await Promise.race([
      once(child, 'message').then(([value]) => value as { endpoint: string; pid: number }),
      once(child, 'exit').then(([code]) => { throw new Error(`Peer project fixture exited before ready: ${String(code)}`); }),
    ]);
    expect(ready.pid).not.toBe(process.pid);
    return { child, endpoint: ready.endpoint };
  };
  const stopHost = async (child: ReturnType<typeof spawn>) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit'); child.send('close'); await exited;
  };
  const first = await launch();
  let client = await connectKodaXClient({ homeDir, endpoint: first.endpoint });
  let releasePeer = () => {};
  const peerGate = new Promise<void>(resolve => { releasePeer = resolve; });
  let peerEntered = false;
  let authority: RuntimeExecutionAuthorization | undefined;
  let peer = await connectKodaXClient({ homeDir, endpoint: first.endpoint, async authorizeExecution(_request, services) {
    if (!authority) {
      const credential = await services.credentials.registerScoped({ providers: ['workflow-fixture'] }, async () => 'fixture-only');
      const tools = await services.hostTools.register([{ name: 'hold_peer_project', description: 'Hold a read-only peer task.',
        inputSchema: { type: 'object', properties: {} }, sideEffect: 'none' }], {
        async hold_peer_project() { peerEntered = true; await peerGate; return { content: 'Peer task finished.' }; },
      });
      authority = { credential: { mode: 'scoped', leaseId: credential.id, providers: ['workflow-fixture'] },
        hostTools: { leaseId: tools.id }, profile: await services.createExecutionProfile({}, tools.tools) };
    }
    return authority;
  } });
  try {
    const session = await client.sessions.create({ projectPath: homeDir });
    const started = await client.workflows.start({ sessionId: session.id, projectRoot: homeDir,
      source: { kind: 'inline', manifest: { name: 'peer-project', description: 'Preserve another client project.', phases: ['wait'],
        readOnly: true, maxAgents: 1, maxConcurrency: 1, patterns: ['fan-out-and-synthesize'] },
        source: 'async function run(wf) { wf.log("waiting"); await new Promise(() => {}); return "unexpected"; }' } });
    if (started.kind !== 'started') throw new Error('Peer project Workflow was declined.');
    await expect.poll(async () => (await client.workflows.get(started.runId))?.latestMessage, { timeout: 10_000 }).toBe('waiting');
    const [run] = await client.workflows.list({ runId: started.runId });
    if (!run) throw new Error('Missing peer project Workflow run.');
    const shared = path.join(run.runDir, 'worktrees', 'shared');
    const scratch = path.join(run.runDir, 'worktrees', 'scratch');
    const locked = path.join(run.runDir, 'worktrees', 'locked');
    for (const target of [shared, scratch, locked]) await git(['worktree', 'add', '--detach', target, 'HEAD']);
    await git(['worktree', 'lock', locked, '--reason', 'Resume cleanup after cold Host restart']);
    const peerProjectRoot = projectAlias ? path.join(homeDir, 'peer-project-alias') : shared;
    if (projectAlias) await symlink(shared, peerProjectRoot, process.platform === 'win32' ? 'junction' : 'dir');
    const peerSession = await peer.sessions.create({ projectPath: peerProjectRoot });
    let peerRunId: string | undefined;
    if (peerActive) {
      await peer.sessions.updateSettings(peerSession.id, { workMode: 'coding', agentMode: 'sa', permissionMode: 'full-access' });
      peerRunId = (await peer.runs.startTool({ sessionId: peerSession.id, inputId: 'hold-peer-project',
        rawInput: 'Keep working in this project checkout.', name: 'hold_peer_project', input: {} })).runId;
      await expect.poll(() => peerEntered, { timeout: 10_000 }).toBe(true);
      expect((await peer.runs.read(peerRunId)).phase).toBe('running');
    }
    expect(await client.workflows.stop(started.runId, { sessionId: session.id })).toBe(true);
    expect((await client.runs.await(started.runId)).phase).toBe('interrupted');
    await expect.poll(() => existsSync(scratch), { timeout: 10_000 }).toBe(false);
    const cleanupReceipt = path.join(run.runDir, 'cleanup.json');
    await expect.poll(() => existsSync(cleanupReceipt), { timeout: 10_000 }).toBe(true);
    expect(JSON.parse(await readFile(cleanupReceipt, 'utf8')).completed).toBe(false);
    expect(await readFile(path.join(shared, 'project.txt'), 'utf8')).toBe('Peer project original.');
    expect(existsSync(locked)).toBe(true);
    if (peerRunId) {
      expect((await peer.runs.read(peerRunId)).phase).toBe('running');
      releasePeer();
      expect((await peer.runs.await(peerRunId)).phase).toBe('completed');
    }
    // A saved project remains a project after its Session is removed. Cold
    // cleanup may retry the unrelated locked tree without reclaiming it.
    await peer.sessions.delete(peerSession.id);
    await client.disconnect(); await peer.disconnect(); await stopHost(first.child);
    await git(['worktree', 'unlock', locked]);
    const replacement = await launch();
    client = await connectKodaXClient({ homeDir, endpoint: replacement.endpoint });
    peer = await connectKodaXClient({ homeDir, endpoint: replacement.endpoint });
    await expect.poll(() => existsSync(locked), { timeout: 10_000 }).toBe(false);
    expect(await readFile(path.join(shared, 'project.txt'), 'utf8')).toBe('Peer project original.');
    expect(await readFile(path.join(homeDir, 'project.txt'), 'utf8')).toBe('Peer project original.');
    await expect.poll(async () => JSON.parse(await readFile(cleanupReceipt, 'utf8')).completed,
      { timeout: 10_000 }).toBe(true);
    expect(await readdir(path.join(homeDir, '.kodax', 'runtime', 'workflow-cleanups'))).toEqual([]);
  } finally {
    releasePeer(); await client.disconnect(); await peer.disconnect();
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    }
    if (path.dirname(homeDir) !== await realpath(os.tmpdir()) || !path.basename(homeDir).startsWith('kodax-workflow-peer-project-')) {
      throw new Error('Unsafe peer project fixture cleanup.');
    }
    await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 120_000);

it('registers cleanup before the terminal event even if the independent Host crashes inside its listener', async () => {
  const homeDir = await mkdtemp(path.join(await realpath(os.tmpdir()), 'kodax-workflow-terminal-'));
  await mkdir(path.join(homeDir, '.kodax'), { recursive: true });
  await writeFile(path.join(homeDir, '.kodax', 'config.json'), JSON.stringify({ provider: 'workflow-fixture', model: 'fixture',
    customProviders: [{ name: 'workflow-fixture', protocol: 'openai', model: 'fixture',
      baseUrl: 'http://127.0.0.1:1/v1', apiKeyEnv: 'KODAX_UNUSED_WORKFLOW_FIXTURE_KEY' }] }));
  const git = (args: string[]) => execFileAsync('git', args, { cwd: homeDir, windowsHide: true });
  await git(['init']); await git(['config', 'user.name', 'Fixture']); await git(['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(path.join(homeDir, 'project.txt'), 'Project remains.');
  await git(['add', 'project.txt']); await git(['commit', '-m', 'fixture']);
  const children: ReturnType<typeof spawn>[] = [];
  const launch = async (crash: boolean) => {
    const child = spawn(process.execPath, ['--import', 'tsx', path.resolve('tests/sdk-contract-host.fixture.ts'),
      homeDir, ...(crash ? ['crash-on-workflow-terminal'] : [])], { cwd: process.cwd(), windowsHide: true,
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(API_KEY|TOKEN|SECRET|PASSWORD)$/.test(key))),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    children.push(child); child.stdout!.resume(); child.stderr!.resume();
    const ready = await Promise.race([
      once(child, 'message').then(([value]) => value as { endpoint: string }),
      once(child, 'exit').then(([code]) => { throw new Error(`Workflow fixture exited before ready: ${String(code)}`); }),
    ]);
    return { child, endpoint: ready.endpoint };
  };
  const host = await launch(true);
  let client = await connectKodaXClient({ homeDir, endpoint: host.endpoint });
  let peer = await connectKodaXClient({ homeDir, endpoint: host.endpoint });
  try {
    const session = await client.sessions.create({ projectPath: homeDir });
    const started = await client.workflows.start({ sessionId: session.id, projectRoot: homeDir,
      source: { kind: 'inline', manifest: { name: 'crash-boundary', description: 'Crash after final commit', phases: ['wait'],
        readOnly: true, maxAgents: 1, maxConcurrency: 1, patterns: ['fan-out-and-synthesize'] },
        source: 'async function run(wf) { wf.log("waiting"); await new Promise(() => {}); return "unexpected"; }' } });
    if (started.kind !== 'started') throw new Error('Workflow fixture declined.');
    await expect.poll(async () => (await peer.workflows.get(started.runId))?.latestMessage, { timeout: 10_000 }).toBe('waiting');
    const [run] = await peer.workflows.list({ runId: started.runId });
    const worktree = path.join(run!.runDir, 'worktrees', 'scratch');
    await git(['worktree', 'add', '--detach', worktree, 'HEAD']);
    const exited = once(host.child, 'exit');
    await peer.workflows.stop(started.runId, { sessionId: session.id }).catch(error => {
      expect((error as Error).name).toMatch(/RuntimeDaemon(?:Disconnect|Transport)Error/);
    });
    expect((await exited)[0]).toBe(99);
    expect(existsSync(worktree)).toBe(true);
    const pendingDir = path.join(homeDir, '.kodax', 'runtime', 'workflow-cleanups');
    expect(await readdir(pendingDir)).toHaveLength(1);
    await client.disconnect(); await peer.disconnect();
    const replacement = await launch(false);
    client = await connectKodaXClient({ homeDir, endpoint: replacement.endpoint });
    peer = await connectKodaXClient({ homeDir, endpoint: replacement.endpoint });
    await expect.poll(() => existsSync(worktree), { timeout: 10_000 }).toBe(false);
    await expect.poll(async () => {
      const receipt = JSON.parse(await readFile(path.join(run!.runDir, 'cleanup.json'), 'utf8')) as { completed: boolean };
      return receipt.completed;
    }, { timeout: 10_000 }).toBe(true);
    expect(await readdir(pendingDir)).toEqual([]);
    const history = await peer.sessions.readHistory(session.id);
    expect(history.items.filter(item => item.taskResult?.source === 'workflow')).toMatchObject([
      { text: 'Workflow stopped.', taskResult: { runId: started.runId, status: 'cancelled' } },
    ]);
    expect(await readFile(path.join(homeDir, 'project.txt'), 'utf8')).toBe('Project remains.');
  } finally {
    await client.disconnect(); await peer.disconnect();
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    }
    await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 120_000);
