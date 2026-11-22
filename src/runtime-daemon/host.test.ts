import { createSign, generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import fsDefault, * as fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { emitKodaXDiagnostic, generateSummary } from "@kodax-ai/agent";
import {
  createProviderCredentialLeaseScope,
  KodaXBaseProvider,
  runWithProviderCredentialLeaseScope,
  type KodaXStreamResult,
  type ProviderCredentialLeaseAccess,
} from "@kodax-ai/llm";
import type { ManagedWorkflowSnapshot } from "@kodax-ai/coding";

import type {
  RuntimeObservationInvalidation,
  RuntimeSessionObservation,
  KodaXRuntime,
  RuntimeCompactSessionResult,
  RuntimeActiveAgentTurn,
  RuntimeDaemonPreflight,
  RuntimeEvent,
  RuntimeEventFilter,
  RuntimeEventListener,
  RuntimePermissionRequest,
  RuntimeRunResult,
  RuntimeStartRunInput,
} from "../sdk-runtime.js";
import {
  listClientInteractions,
  respondToClientInteraction,
  type ClientInteractionRegistries,
} from "../client-interactions.js";
import { registerHostCloseQuiesce } from "../runtime-host-close.js";
import { HOST_BLOB_LIMITS } from "./host-blobs.js";
import { appendRuntimeDiagnostic, startRuntimeDaemonHost } from "./host.js";
import * as daemonMaintenance from './maintenance.js';
import { createRuntimeDaemonClient, type RuntimeDaemonClientTransport } from "./client.js";
import {
  readRuntimeDaemonLockOwner,
  readRuntimeDaemonLog,
  readRuntimeDaemonState,
  readRuntimeDaemonToken,
  readRuntimeOwnerPolicy,
  resolveRuntimeDaemonPaths,
  tryAcquireRuntimeDaemonLock,
  writeRuntimeDaemonState,
} from "./state.js";
import {
  createRuntimeDaemonSocketClientTransport,
  dialRuntimeDaemonHostRpc,
  RUNTIME_DAEMON_MAX_FRAME_BYTES,
  type RuntimeDaemonEndpoint,
} from "./transport.js";
import { connectHostRpc } from "../host-protocol/client.js";
import { HOST_PROTOCOL, HOST_PROTOCOL_REVISION } from "../host-protocol/codec.js";
import type { HostRpcDial } from "../host-protocol/client.js";
import { connectKodaXHost } from "../host-protocol/remote-host.js";

class BrokerSummaryProvider extends KodaXBaseProvider {
  readonly name = 'broker-summary';
  readonly supportsThinking = false;
  protected readonly config = {
    apiKeyEnv: 'KODAX_TEST_BROKER_SUMMARY_KEY', model: 'summary',
    supportsThinking: false, contextWindow: 131072,
  };
  calls = 0;
  async stream(): Promise<KodaXStreamResult> {
    expect(this.getApiKey()).toBe('synthetic-summary-secret');
    this.calls += 1;
    return { textBlocks: [{ type: 'text', text: 'Continue the implementation after reconnect.' }],
      toolBlocks: [], thinkingBlocks: [] };
  }
}

async function summarizeWithBroker(input: unknown, provider: BrokerSummaryProvider): Promise<void> {
  const { providerCredentialAccess } = input as { providerCredentialAccess: ProviderCredentialLeaseAccess };
  expect(providerCredentialAccess).toBeDefined();
  const scope = createProviderCredentialLeaseScope(providerCredentialAccess);
  try {
    await runWithProviderCredentialLeaseScope(scope, () => generateSummary(
      [{ role: 'user', content: 'Continue the long coding session.' }],
      provider, { readFiles: [], modifiedFiles: [] },
    ));
  } finally {
    scope.close();
  }
}

async function makeBrokerHostConnections(runtime: KodaXRuntime) {
  const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
  const lock = tryAcquireRuntimeDaemonLock(paths, {
    runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt,
  });
  if (!lock) throw new Error('Expected test host lock.');
  const host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint: await makeTestEndpoint() });
  cleanupTasks.push(() => host.close());
  return async () => {
    const transport = await createRuntimeDaemonSocketClientTransport(host.endpoint);
    cleanupTasks.push(async () => transport.close?.());
    await transport.request('initialize', {
      token: readRuntimeDaemonToken(paths),
      clientInfo: { instanceId: 'space-broker-test', instanceSecret: 's'.repeat(32) },
    });
    return transport;
  };
}

async function exerciseBrokerTakeover(
  connect: () => Promise<RuntimeDaemonClientTransport>, runtime: KodaXRuntime,
  mode: 'manual' | 'automatic',
): Promise<void> {
  const first = await connect();
  await first.request('credential.register', {
    leaseId: 'summary-lease', providers: ['broker-summary'], brokerVersion: 2,
  });
  const disconnected = new Promise<void>((resolve) => first.subscribeLifecycle?.((state) => {
    if (state.state !== 'disconnected') return;
    expect(state.reconnectable).toBe(true);
    resolve();
  }));
  const second = await connect();
  await disconnected;
  await second.close?.();
  await expect(first.request('credential.get', { leaseId: 'summary-lease' })).rejects.toMatchObject({ reconnectable: true });
  const resumed = await connect();
  await first.close?.(); // A's late close cannot detach its successor.
  const client = createRuntimeDaemonClient({
    identity: runtime.identity, transport: resumed,
    capabilities: { providerCredentialBroker: { version: 2 } },
  });
  const requests: unknown[] = [];
  await client.credentials.resumeScoped('summary-lease', async (request) => {
    requests.push(request);
    return 'synthetic-summary-secret';
  });
  const input = { sessionId: 'session-1', provider: 'broker-summary',
    credential: { leaseId: 'summary-lease', mode: 'scoped' as const, providers: ['broker-summary'] } };
  if (mode === 'manual') await client.sessions.compact(input);
  else {
    const run = await client.runs.start({
      sessionId: input.sessionId, credential: input.credential,
      options: { provider: input.provider }, prompt: 'continue',
    });
    await run.result;
  }
  expect(requests).toEqual([expect.objectContaining({
    purpose: 'compaction', sessionId: 'session-1', provider: 'broker-summary',
    target: expect.objectContaining(mode === 'manual'
      ? { kind: 'operation', operation: 'session.compact' } : { kind: 'run' }),
  })]);
  expect(JSON.stringify(await resumed.request('credential.get', { leaseId: 'summary-lease' })))
    .not.toContain('synthetic-summary-secret');
  await client.close();
}

const tempRoots: string[] = [];
const cleanupTasks: Array<() => Promise<void>> = [];

function interruptStatePublication(stateFile: string, failures: Record<string, number>) {
  const original = fsDefault.renameSync;
  const error = Object.assign(new Error("Injected daemon state sharing violation"), { code: "EPERM" });
  fsDefault.renameSync = (source, destination) => {
    if (String(destination) === stateFile) {
      const state = JSON.parse(fs.readFileSync(String(source), "utf8")) as { status: string };
      if ((failures[state.status] ?? 0) > 0) {
        failures[state.status] -= 1;
        throw error;
      }
    }
    original(source, destination);
  };
  syncBuiltinESMExports();
  return {
    error,
    restore() {
      fsDefault.renameSync = original;
      syncBuiltinESMExports();
    },
  };
}

afterEach(async () => {
  const tasks = cleanupTasks.splice(0);
  await Promise.allSettled(tasks.map((task) => task()));
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("runtime daemon host", () => {
  it('persists info and above to daemon.log but never debug diagnostics', () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'diagnostic-levels');
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      appendRuntimeDiagnostic(paths, { source: 'runtime:windows', level, message: `${level} probe` });
    }
    const messages = fs.readFileSync(paths.logFile, 'utf8').trim().split(/\r?\n/)
      .map(line => (JSON.parse(line) as { message: string }).message);
    expect(messages).toEqual(['[runtime:windows] info probe', '[runtime:windows] warn probe', '[runtime:windows] error probe']);
  });

  it('starts temporary-file maintenance after ready and joins it before closing Runtime', async () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'host-maintenance');
    const runtime = makeRuntime();
    const preflight = runtime.status.preflight.bind(runtime.status);
    const inspect = vi.spyOn(runtime.status, 'preflight').mockImplementation(async () => ({
      ...await preflight(), clientCount: 2, blockers: ['connected_clients'], canStop: false,
    }));
    const order: string[] = [];
    let finish!: () => void;
    let sweepingSignal: AbortSignal | undefined;
    const runOnce = vi.fn((signal?: AbortSignal) => {
      expect(readRuntimeDaemonState(paths)?.status).toBe('ready');
      sweepingSignal = signal;
      order.push('sweep');
      return new Promise<{ scanned: number; removed: number }>((resolve) => {
        finish = () => resolve({ scanned: 1, removed: 0 });
      });
    });
    const factory = vi.spyOn(daemonMaintenance, 'createRuntimeDaemonMaintenance').mockReturnValue({
      runOnce, close: async () => { order.push('cursor-close'); },
    });
    const originalClose = runtime.close.bind(runtime);
    vi.spyOn(runtime, 'close').mockImplementation(async () => { order.push('Runtime-close'); await originalClose(); });
    const lock = tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt,
    });
    if (!lock) throw new Error('Expected maintenance Host owner.');
    const host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint: await makeTestEndpoint() });
    cleanupTasks.push(() => host.close());
    try {
      await waitFor(() => runOnce.mock.calls.length === 1);
      expect(inspect).toHaveBeenCalledTimes(1);
      const closing = host.close();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(sweepingSignal?.aborted).toBe(true);
      expect(order).toEqual(['sweep']);
      finish();
      await closing;
      expect(order).toEqual(['sweep', 'cursor-close', 'Runtime-close']);
    } finally {
      finish?.();
      factory.mockRestore();
    }
  });

  it.runIf(process.platform === "win32")("survives transient state publication contention across ready and concurrent close", async () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), "default");
    const runtime = makeRuntime();
    const close = vi.spyOn(runtime, "close");
    const lock = tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt,
    });
    if (!lock) throw new Error("Expected host publication test lock.");
    const failure = interruptStatePublication(paths.stateFile, { ready: 1, stopping: 1 });
    try {
      const host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint: await makeTestEndpoint() });
      cleanupTasks.push(() => host.close());
      const ready = readRuntimeDaemonState(paths);
      expect(ready).toMatchObject({ status: "ready", runtimeId: runtime.identity.runtimeId });
      expect(close).not.toHaveBeenCalled();
      const first = host.close();
      expect(host.close()).toBe(first);
      await expect(first).resolves.toBeUndefined();
      await expect(host.closed).resolves.toBeUndefined();
      expect(close).toHaveBeenCalledTimes(1);
      expect(readRuntimeDaemonState(paths)).toBeUndefined();
      expect(readRuntimeDaemonLockOwner(paths.lockFile)).toBeUndefined();

      if (!ready) throw new Error("Expected published ready state.");
      const replacement = { ...lock.owner, runtimeId: "replacement-runtime" };
      expect(tryAcquireRuntimeDaemonLock(paths, replacement)).toBeDefined();
      writeRuntimeDaemonState(paths, { ...ready, runtimeId: replacement.runtimeId });
      await host.close();
      expect(readRuntimeDaemonLockOwner(paths.lockFile)).toEqual(replacement);
      expect(readRuntimeDaemonState(paths)?.runtimeId).toBe(replacement.runtimeId);
      expect(close).toHaveBeenCalledTimes(1);
    } finally { failure.restore(); }
  });

  it.runIf(process.platform === "win32")("rejects persistent ready publication failure without advertising a ready host", async () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), "default");
    const runtime = makeRuntime();
    const endpoint = await makeTestEndpoint();
    const lock = tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt,
    });
    if (!lock) throw new Error("Expected host publication test lock.");
    const failure = interruptStatePublication(paths.stateFile, { ready: Infinity });
    try {
      await expect(startRuntimeDaemonHost({ runtime, paths, lock, endpoint })).rejects.toBe(failure.error);
      expect(readRuntimeDaemonState(paths)).toBeUndefined();
      expect(readRuntimeDaemonLockOwner(paths.lockFile)).toBeUndefined();
      expect(fs.readFileSync(paths.logFile, "utf8")).not.toContain("Runtime daemon ready.");
      await expect(createRuntimeDaemonSocketClientTransport(endpoint)).rejects.toThrow();
    } finally { failure.restore(); }
  });

  it.runIf(process.platform === "win32")("reports persistent stopping publication failure without repeating Runtime cleanup", async () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), "default");
    const runtime = makeRuntime();
    const close = vi.spyOn(runtime, "close");
    const lock = tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt,
    });
    if (!lock) throw new Error("Expected host publication test lock.");
    const host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint: await makeTestEndpoint() });
    cleanupTasks.push(() => host.close());
    const failure = interruptStatePublication(paths.stateFile, { stopping: Infinity });
    try {
      const first = host.close();
      expect(host.close()).toBe(first);
      await expect(first).rejects.toThrow("state transition: Injected daemon state sharing violation");
      expect(close).toHaveBeenCalledTimes(1);
      expect(readRuntimeDaemonLockOwner(paths.lockFile)).toBeUndefined();
    } finally { failure.restore(); }
    await expect(host.close()).resolves.toBeUndefined();
    await expect(host.closed).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('does not publish an endpoint when its startup handoff was cancelled', async () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), 'default');
    const runtime = makeRuntime();
    const endpoint = await makeTestEndpoint();
    const lock = tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt,
    });
    if (!lock) throw new Error('Expected test host lock.');
    let accidentalHost: Awaited<ReturnType<typeof startRuntimeDaemonHost>> | undefined;
    try {
      await expect(startRuntimeDaemonHost({ runtime, paths, lock, endpoint,
        commitStartup: () => { throw new Error('Startup was cancelled before publication'); },
      }).then(host => { accidentalHost = host; return host; })).rejects.toThrow(/cancelled/);
      await expect(createRuntimeDaemonSocketClientTransport(endpoint)).rejects.toThrow();
      expect(readRuntimeDaemonLockOwner(paths.lockFile)).toBeUndefined();
      expect(readRuntimeDaemonState(paths)).toBeUndefined();
    } finally { await accidentalHost?.close(); }
  });

  it.each(['manual', 'automatic'] as const)(
    'restores %s summary credentials after A is replaced by B, B closes, and A reconnects',
    async (mode) => {
      const runtime = makeRuntime();
      const summaryProvider = new BrokerSummaryProvider();
      // Exercise the real shared summary/credential seam behind each admitted target.
      if (mode === 'manual') {
        const original = runtime.sessions.compact;
        vi.spyOn(runtime.sessions, 'compact').mockImplementation(async (input) => {
          await summarizeWithBroker(input, summaryProvider);
          return original(input);
        });
      } else {
        const original = runtime.runs.start;
        vi.spyOn(runtime.runs, 'start').mockImplementation(async (input) => {
          await summarizeWithBroker(input, summaryProvider);
          return original(input);
        });
      }
      const connection = await makeBrokerHostConnections(runtime);
      await exerciseBrokerTakeover(connection, runtime, mode);
      expect(summaryProvider.calls).toBe(1);
      expect(mode === 'manual' ? runtime.sessions.compact : runtime.runs.start).toHaveBeenCalledTimes(1);
    },
  );

  it("serves a hosted runtime over the local daemon transport and releases ownership on close", async () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), "default");
    const runtime = makeRuntime();
    const lock = tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: runtime.identity.runtimeId,
      pid: process.pid,
      createdAt: runtime.identity.startedAt,
    });
    expect(lock).toBeDefined();
    if (!lock) throw new Error("Expected daemon lock for host test.");

    const host = await startRuntimeDaemonHost({
      runtime,
      paths,
      endpoint: await makeTestEndpoint(),
      lock,
    });
    cleanupTasks.push(() => host.close());

    expect(readRuntimeDaemonState(paths)).toMatchObject({
      runtimeId: runtime.identity.runtimeId,
      status: "ready",
      endpoint: host.endpoint.path,
      configHome: paths.configHome,
    });

    const client = await createRuntimeDaemonSocketClientTransport(
      host.endpoint,
    );
    cleanupTasks.push(async () => {
      await client.close?.();
    });

    await expect(
      client.request("initialize", { profile: "default" }),
    ).rejects.toThrow("Runtime daemon initialize token is invalid.");
    const token = readRuntimeDaemonToken(paths);
    expect(token).toMatch(/^dt_/);
    await expect(
      client.request("initialize", { profile: "default", token }),
    ).resolves.toMatchObject({
      identity: {
        runtimeId: runtime.identity.runtimeId,
        profile: "default",
      },
    });
    await expect(client.request("ping")).resolves.toMatchObject({
      ok: true,
      runtimeId: runtime.identity.runtimeId,
    });
    await expect(client.request("daemon.logs")).resolves.toMatchObject({
      logFile: paths.logFile,
      entries: expect.arrayContaining([
        expect.objectContaining({ message: "Runtime daemon ready." }),
      ]),
    });

    await host.close();

    expect(runtime.closed).toBe(true);
    expect(readRuntimeDaemonState(paths)).toBeUndefined();
    expect(readRuntimeDaemonLockOwner(paths.lockFile)).toBeUndefined();
  });

  it("serves the v2 Host protocol next to v1 on the same endpoint", async () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), "default");
    const runtime = makeRuntime();
    const lock = tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: runtime.identity.runtimeId,
      pid: process.pid,
      createdAt: runtime.identity.startedAt,
    });
    if (!lock) throw new Error("Expected daemon lock for the v2 test.");
    const host = await startRuntimeDaemonHost({ runtime, paths, endpoint: await makeTestEndpoint(), lock });
    cleanupTasks.push(() => host.close());
    const token = readRuntimeDaemonToken(paths);
    if (token === undefined) throw new Error("Expected a daemon token for the v2 test.");

    const v1 = await createRuntimeDaemonSocketClientTransport(host.endpoint);
    cleanupTasks.push(async () => {
      await v1.close?.();
    });
    await v1.request("initialize", { profile: "default", token });

    const dial = dialRuntimeDaemonHostRpc(host.endpoint);
    const client = { name: "v2-test", version: "1.0.0", instanceId: "v2-client-1" };
    const v2 = await connectHostRpc(dial, { client, auth: { scheme: "ipc", token } });
    cleanupTasks.push(async () => v2.close());

    expect(v2.handshake).toMatchObject({
      protocol: HOST_PROTOCOL,
      revision: HOST_PROTOCOL_REVISION,
      role: "owner",
      subject: "person",
      host: { id: runtime.identity.runtimeId, version: runtime.identity.version },
      methods: expect.arrayContaining(["ping"]),
      limits: { maxFrameBytes: RUNTIME_DAEMON_MAX_FRAME_BYTES },
    });
    await expect(v2.request("ping")).resolves.toEqual({});
    await expect(v1.request("ping")).resolves.toMatchObject({ ok: true });
    // A v1-only method is not reachable through v2 until the contract names it.
    await expect(v2.request("daemon.logs")).rejects.toMatchObject({ kodaxCode: "method_not_found" });

    // The Host counts a v2 connection as a client like any other, so it is not idle while one is attached.
    await expect(v1.request("daemon.preflight")).resolves.toMatchObject({ clientCount: 2 });
    v2.close();
    await waitForClientCount(v1, 1);

    await expect(connectHostRpc(dial, { client, auth: { scheme: "ipc", token: "dt_wrong" } }))
      .rejects.toMatchObject({ kodaxCode: "unauthorized" });
    await expect(connectHostRpc(dial, { client, auth: { scheme: "jwt", token } }))
      .rejects.toMatchObject({ kodaxCode: "unauthorized", reason: "unsupported_auth_scheme" });
    await waitForClientCount(v1, 1);
  });

  it("serves v2 over the network to the JWT subjects host.json admits, and stays up for them", async () => {
    const home = tempHome();
    const paths = resolveRuntimeDaemonPaths(home, "default");
    const runtime = makeRuntime();
    const lock = tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: runtime.identity.runtimeId,
      pid: process.pid,
      createdAt: runtime.identity.startedAt,
    });
    if (!lock) throw new Error("Expected daemon lock for the network test.");
    const idp = await startTestIdentityProvider();
    cleanupTasks.push(() => idp.close());
    fs.mkdirSync(path.join(home, "integrations"), { recursive: true });
    fs.writeFileSync(path.join(home, "integrations", "host.json"), JSON.stringify({
      version: 1,
      server: {
        listen: { hostname: "127.0.0.1", port: 0 },
        jwt: { issuer: idp.issuer, audience: "kodax-host-test", jwksUrl: idp.jwksUrl },
        owner: "person-1",
        services: ["backend-1"],
      },
    }));
    // An orphan timer would stop a Host without clients; the listener must keep it up.
    const host = await startRuntimeDaemonHost({
      runtime, paths, endpoint: await makeTestEndpoint(), lock, networkConfigHome: home, orphanExitMs: 60_000,
      sessionsDir: path.join(home, "sessions"),
    });
    cleanupTasks.push(() => host.close());
    const port = readRuntimeDaemonLog(paths).find(entry => entry.message === "Runtime daemon listening on the network.")?.data?.port;
    if (typeof port !== "number") throw new Error("Expected the Host to log the port it listens on.");
    const url = `ws://127.0.0.1:${port}/v2`;
    const client = { name: "network-test", version: "1.0.0", instanceId: "network-client-1" };

    const person = await connectHostRpc(dialWebSocket(url), { client, auth: { scheme: "jwt", token: idp.token("person-1") } });
    cleanupTasks.push(async () => person.close());
    expect(person.handshake).toMatchObject({
      role: "user",
      subject: "person",
      // A Host that keeps its Sessions takes blobs, and says how big they may be.
      limits: { maxFrameBytes: RUNTIME_DAEMON_MAX_FRAME_BYTES, idleTimeoutMs: 60_000, ...HOST_BLOB_LIMITS },
      expiresAt: expect.any(Number),
    });
    await expect(person.request("ping")).resolves.toEqual({});

    const backend = await connectHostRpc(dialWebSocket(url), {
      client: { ...client, instanceId: "network-client-2" }, auth: { scheme: "jwt", token: idp.token("backend-1") },
    });
    cleanupTasks.push(async () => backend.close());
    expect(backend.handshake).toMatchObject({ role: "service", subject: "service:backend-1" });

    await expect(connectHostRpc(dialWebSocket(url), { client, auth: { scheme: "jwt", token: idp.token("stranger") } }))
      .rejects.toMatchObject({ kodaxCode: "unauthorized", reason: "subject_not_admitted" });
    const token = readRuntimeDaemonToken(paths);
    if (token === undefined) throw new Error("Expected a daemon token for the network test.");
    await expect(connectHostRpc(dialWebSocket(url), { client, auth: { scheme: "ipc", token } }))
      .rejects.toMatchObject({ kodaxCode: "unauthorized", reason: "unsupported_auth_scheme" });
    // A browser is told in a close frame, because it cannot read the status of a refused upgrade.
    await expect(connectHostRpc(dialWebSocket(url, "https://evil.example.test"), { client, auth: { scheme: "jwt", token: idp.token("person-1") } }))
      .rejects.toMatchObject({ kodaxCode: "unauthorized", reason: "origin_not_allowed", retryable: false });

    // The SDK's own dial, on the global WebSocket, from the Host's http address.
    const remote = await connectKodaXHost({
      url: `http://127.0.0.1:${port}`,
      client: { ...client, instanceId: "network-client-3" },
      credential: () => idp.token("backend-1"),
    });
    cleanupTasks.push(async () => remote.close());
    expect(remote.handshake).toMatchObject({ role: "service", subject: "service:backend-1", expiresAt: expect.any(Number) });
    await expect(remote.call("ping")).resolves.toEqual({});

    const local = await createRuntimeDaemonSocketClientTransport(host.endpoint);
    cleanupTasks.push(async () => {
      await local.close?.();
    });
    await expect(local.request("initialize", { profile: "default", token }))
      .resolves.toMatchObject({ daemonLifecycle: "persistent", daemonRetention: "service" });
    await expect(local.request("daemon.integrations.get"))
      .resolves.toMatchObject({ domains: [expect.objectContaining({ domain: "host", source: "user", watching: true })] });

    // A platform probe on the same port: ready, but not to be reclaimed while clients are connected.
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({
      state: "ready", canStop: false, blockers: expect.arrayContaining(["connected_clients"]), lastActivityAt: expect.any(Number),
    });

    // A stopping Host tells its network clients before it closes their sockets.
    const notices: string[] = [];
    person.onNotification(method => notices.push(method));
    await host.close();
    expect(notices).toContain("host.draining");
    await person.closed;
  });

  it("shares concurrent close attempts and retries a failed Runtime cleanup", async () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), "close-retry");
    const runtime = makeRuntime();
    const originalClose = runtime.close.bind(runtime);
    let closeCalls = 0;
    runtime.close = async () => {
      closeCalls += 1;
      if (closeCalls === 1) throw new Error("transient Runtime close failure");
      await originalClose();
    };
    const lock = tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: runtime.identity.runtimeId,
      pid: process.pid,
      createdAt: runtime.identity.startedAt,
    });
    expect(lock).toBeDefined();
    if (!lock) throw new Error("Expected daemon lock for close retry test.");
    const host = await startRuntimeDaemonHost({
      runtime,
      paths,
      endpoint: await makeTestEndpoint(),
      lock,
    });
    cleanupTasks.push(() => host.close());

    const first = host.close();
    const concurrent = host.close();
    expect(concurrent).toBe(first);
    await expect(Promise.all([first, concurrent])).rejects.toThrow(
      "transient Runtime close failure",
    );
    expect(closeCalls).toBe(1);
    expect(readRuntimeDaemonLockOwner(paths.lockFile)).toBeDefined();

    await expect(host.close()).resolves.toBeUndefined();
    await expect(host.closed).resolves.toBeUndefined();
    expect(closeCalls).toBe(2);
    expect(readRuntimeDaemonLockOwner(paths.lockFile)).toBeUndefined();
  });

  it("quiesces Runs and lets their state reach a connected client before the transport closes", async () => {
    const order: string[] = [];
    const deadlines: number[] = [];
    const { runtime, host, client } = await startQuiesceHost("close-quiesce", async ({ deadlineMs }) => {
      deadlines.push(deadlineMs);
      order.push("quiesce");
      // The fixture publishes a terminal Run event, as a Run settling under the quiesce does.
      await runtime.runs.start({ sessionId: "session-1", prompt: "settle" });
      return { unsettledRunIds: [] };
    });
    const closeRuntime = runtime.close.bind(runtime);
    runtime.close = async () => {
      order.push("runtime-close");
      await closeRuntime();
    };
    client.subscribe((notification) => {
      if (extractRuntimeEventNotification(notification.params)?.type === "run.completed") order.push("client-notified");
    });
    client.subscribeLifecycle?.((state) => {
      if (state.state === "disconnected") order.push("client-disconnected");
    });
    await client.request("session.observe", { sessionId: "session-1" });

    await host.close();
    await waitFor(() => order.includes("client-disconnected"));

    expect(order.indexOf("quiesce")).toBeLessThan(order.indexOf("runtime-close"));
    expect(order.filter((step) => step.startsWith("client-"))).toEqual(["client-notified", "client-disconnected"]);
    // The bound a platform adds to its grace period: Run state is out within it.
    expect(deadlines).toEqual([10_000]);
  });

  it("closes at the quiesce bound and names the Runs that had not settled", async () => {
    const { paths, host } = await startQuiesceHost("close-quiesce-bound", async ({ deadlineMs }) => {
      await new Promise((resolve) => setTimeout(resolve, deadlineMs));
      return { unsettledRunIds: ["run-stuck"] };
    }, 40);

    await expect(host.close()).resolves.toBeUndefined();

    expect(readRuntimeDaemonLockOwner(paths.lockFile)).toBeUndefined();
    const warning = fs.readFileSync(paths.logFile, "utf8").split("\n").find((line) => line.includes("run-stuck"));
    expect(warning).toContain("had not settled");
  });

  it("does not quiesce again when a failed close is retried", async () => {
    let quiesces = 0;
    const { runtime, host } = await startQuiesceHost("close-quiesce-retry", async () => {
      quiesces += 1;
      return { unsettledRunIds: [] };
    });
    const closeRuntime = runtime.close.bind(runtime);
    let closeCalls = 0;
    runtime.close = async () => {
      closeCalls += 1;
      if (closeCalls === 1) throw new Error("transient Runtime close failure");
      await closeRuntime();
    };

    await expect(host.close()).rejects.toThrow("transient Runtime close failure");
    await expect(host.close()).resolves.toBeUndefined();

    expect(closeCalls).toBe(2);
    expect(quiesces).toBe(1);
  });

  it("reports a failed quiesce and still closes the transport and the Runtime", async () => {
    const { paths, runtime, host } = await startQuiesceHost("close-quiesce-failure", async () => {
      throw new Error("Run shutdown failed");
    });

    await expect(host.close()).rejects.toThrow("run quiesce: Run shutdown failed");

    expect(runtime.closed).toBe(true);
    expect(readRuntimeDaemonLockOwner(paths.lockFile)).toBeUndefined();
    await expect(host.close()).resolves.toBeUndefined();
  });

  it("keeps answering during the quiesce, so a late request gets the Runtime's conflict", async () => {
    let release!: () => void;
    const settling = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const quiescing = new Promise<void>((resolve) => { entered = resolve; });
    const { runtime, host, client } = await startQuiesceHost("close-quiesce-request", async () => {
      // What a quiesced Runtime answers; src/sdk-runtime.host-close.test.ts pins that half.
      runtime.runs.start = async () => {
        throw Object.assign(new Error("KodaX runtime is shutting down and admits no new work."), { code: "conflict" });
      };
      entered();
      await settling;
      return { unsettledRunIds: [] };
    });

    const closing = host.close();
    await quiescing;
    await expect(client.request("run.start", { sessionId: "session-1", prompt: "too late" }))
      .rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/shutting down/) });
    release();

    await expect(closing).resolves.toBeUndefined();
  });

  it("retains daemon ownership while Runtime cleanup is pending", async () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), "close-barrier");
    const runtime = makeRuntime();
    const originalClose = runtime.close.bind(runtime);
    let releaseRuntimeClose!: () => void;
    const runtimeCloseBarrier = new Promise<void>((resolve) => {
      releaseRuntimeClose = resolve;
    });
    let reportRuntimeCloseStarted!: () => void;
    const runtimeCloseStarted = new Promise<void>((resolve) => {
      reportRuntimeCloseStarted = resolve;
    });
    runtime.close = async () => {
      reportRuntimeCloseStarted();
      await runtimeCloseBarrier;
      await originalClose();
    };
    const lock = tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: runtime.identity.runtimeId,
      pid: process.pid,
      createdAt: runtime.identity.startedAt,
    });
    expect(lock).toBeDefined();
    if (!lock) throw new Error("Expected daemon lock for close barrier test.");
    const host = await startRuntimeDaemonHost({
      runtime,
      paths,
      endpoint: await makeTestEndpoint(),
      lock,
    });
    cleanupTasks.push(() => host.close());

    const closing = host.close();
    await runtimeCloseStarted;
    expect(runtime.closed).toBe(false);
    expect(readRuntimeDaemonLockOwner(paths.lockFile)).toBeDefined();

    releaseRuntimeClose();
    await closing;

    expect(runtime.closed).toBe(true);
    expect(readRuntimeDaemonLockOwner(paths.lockFile)).toBeUndefined();
  });

  it("releases host ownership when daemon.stop is requested through the protocol", async () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), "default");
    const runtime = makeRuntime();
    const lock = tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: runtime.identity.runtimeId,
      pid: process.pid,
      createdAt: runtime.identity.startedAt,
    });
    expect(lock).toBeDefined();
    if (!lock) throw new Error("Expected daemon lock for stop test.");

    const host = await startRuntimeDaemonHost({
      runtime,
      paths,
      endpoint: await makeTestEndpoint(),
      lock,
    });
    cleanupTasks.push(() => host.close());
    const client = await createRuntimeDaemonSocketClientTransport(
      host.endpoint,
    );
    cleanupTasks.push(async () => {
      await client.close?.();
    });
    const token = readRuntimeDaemonToken(paths);

    await expect(
      client.request("initialize", { profile: "default", token }),
    ).resolves.toMatchObject({
      identity: {
        runtimeId: runtime.identity.runtimeId,
        profile: "default",
      },
    });
    await expect(client.request("daemon.stop")).resolves.toEqual({ ok: true });
    await host.closed;
    await waitForHostStateRemoval(paths);

    expect(runtime.closed).toBe(true);
    expect(readRuntimeDaemonState(paths)).toBeUndefined();
    expect(readRuntimeDaemonLockOwner(paths.lockFile)).toBeUndefined();
  });

  it("reports a scheduled daemon.stop cleanup failure through the host lifecycle", async () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), "stop-cleanup-failure");
    const runtime = makeRuntime();
    let signalCloseAttempted: (() => void) | undefined;
    const closeAttempted = new Promise<void>((resolve) => {
      signalCloseAttempted = resolve;
    });
    runtime.close = async () => {
      signalCloseAttempted?.();
      throw new Error("terminal Runtime cleanup failure");
    };
    const lock = tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: runtime.identity.runtimeId,
      pid: process.pid,
      createdAt: runtime.identity.startedAt,
    });
    expect(lock).toBeDefined();
    if (!lock) throw new Error("Expected daemon lock for failed stop test.");

    const host = await startRuntimeDaemonHost({
      runtime,
      paths,
      endpoint: await makeTestEndpoint(),
      lock,
    });
    cleanupTasks.push(() => host.close());
    const client = await createRuntimeDaemonSocketClientTransport(host.endpoint);
    cleanupTasks.push(async () => {
      await client.close?.();
    });
    const token = readRuntimeDaemonToken(paths);
    await client.request("initialize", { profile: "default", token });

    let unhandledRejection: unknown;
    const observeUnhandledRejection = (reason: unknown): void => {
      unhandledRejection = reason;
    };
    process.on("unhandledRejection", observeUnhandledRejection);
    try {
      await expect(client.request("daemon.stop")).resolves.toEqual({ ok: true });
      await closeAttempted;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandledRejection).toBeUndefined();
      await expect(Promise.race([
        host.closed,
        new Promise<void>((_resolve, reject) => {
          setTimeout(() => reject(new Error("host.closed remained pending")), 250);
        }),
      ])).rejects.toThrow("terminal Runtime cleanup failure");
    } finally {
      process.off("unhandledRejection", observeUnhandledRejection);
    }
  });

  it("stops and releases ownership when Runtime close leaves only fenced Actor trees for restart recovery", async () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), "fenced-actor-stop");
    const runtime = makeRuntime();
    // Shape of an Actor controller that stays fenced: it cannot release its
    // durable owner, while the rest of the Runtime has closed.
    const fenced = () => Object.assign(new Error("Actor shutdown could not be durably confirmed before its deadline."), {
      name: "AgentShutdownPersistenceError", code: "actor_shutdown_not_persisted",
    });
    runtime.close = async () => {
      runtime.closed = true;
      throw new AggregateError([fenced(), fenced()], "Runtime cleanup failed.");
    };
    const lock = tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: runtime.identity.runtimeId,
      pid: process.pid,
      createdAt: runtime.identity.startedAt,
    });
    if (!lock) throw new Error("Expected daemon lock for fenced stop test.");
    const host = await startRuntimeDaemonHost({ runtime, paths, endpoint: await makeTestEndpoint(), lock });
    cleanupTasks.push(() => host.close());
    const client = await createRuntimeDaemonSocketClientTransport(host.endpoint);
    cleanupTasks.push(async () => {
      await client.close?.();
    });
    await client.request("initialize", { profile: "default", token: readRuntimeDaemonToken(paths) });

    await expect(client.request("daemon.stop")).resolves.toEqual({ ok: true });
    await host.closed;
    await waitForHostStateRemoval(paths);

    expect(readRuntimeDaemonLockOwner(paths.lockFile)).toBeUndefined();
    expect(fs.readFileSync(paths.logFile, "utf8")).toContain("restart recovery");
  });

  it("counts initialized logical clients instead of internal sockets and stops on the real idle shutdown", async () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), "default");
    const runtime = makeRuntime();
    const lock = tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: runtime.identity.runtimeId,
      pid: process.pid,
      createdAt: runtime.identity.startedAt,
      kind: "daemon",
    });
    expect(lock).toBeDefined();
    if (!lock) throw new Error("Expected daemon lock for management test.");

    const host = await startRuntimeDaemonHost({
      runtime,
      paths,
      endpoint: await makeTestEndpoint(),
      lock,
    });
    cleanupTasks.push(() => host.close());
    const token = readRuntimeDaemonToken(paths);
    const internalSocket = await createRuntimeDaemonSocketClientTransport(
      host.endpoint,
    );
    const first = await createRuntimeDaemonSocketClientTransport(host.endpoint);
    cleanupTasks.push(async () => internalSocket.close?.());
    cleanupTasks.push(async () => first.close?.());
    const oversizedName = "s".repeat(160);
    const oversizedTitle = "t".repeat(300);
    const oversizedVersion = "v".repeat(80);
    const initialized = await first.request("initialize", {
      profile: "default",
      token,
      clientInfo: {
        name: oversizedName,
        instanceId: "space-client",
        instanceSecret: "space-client-secret-that-must-not-be-exposed",
        title: oversizedTitle,
        version: oversizedVersion,
        clientType: "app",
      },
    });
    expect(initialized).toMatchObject({
      capabilities: {
        integrationConfigResilience: {
          version: 1,
          isolatedFailure: true,
          legacySourceWatching: true,
        },
        daemonManagement: {
          version: 1,
          revisionedStop: true,
          reverseBridgeDrainingFence: true,
          backgroundWorkPreflight: true,
        },
        daemonClientInventory: { version: 1 },
      },
    });

    await expect(first.request("daemon.preflight")).resolves.toMatchObject({
      clientCount: 1,
      clients: [{
        daemonConnectionId: expect.stringMatching(/^connection_/),
        principalId: expect.stringMatching(/^client_[a-f0-9]{64}$/),
        name: oversizedName.slice(0, 128),
        title: oversizedTitle.slice(0, 256),
        version: oversizedVersion.slice(0, 64),
        clientType: "app",
        connectedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      }],
      blockers: [],
      canStop: true,
    });
    const probe = await createRuntimeDaemonSocketClientTransport(host.endpoint);
    cleanupTasks.push(async () => probe.close?.());
    await probe.request("initialize", {
      profile: "default",
      token,
      connectionPurpose: "probe",
    });
    await expect(probe.request("daemon.preflight")).rejects.toMatchObject({
      code: "unauthorized",
    });
    await expect(first.request("daemon.preflight")).resolves.toMatchObject({
      clientCount: 1,
    });
    const stale = (await first.request("daemon.management.get")) as {
      runtimeId: string;
      revision: number;
      ownerPolicy: { revision: number };
      preflight: { clients: readonly Record<string, unknown>[] };
    };
    expect(stale.preflight.clients).toHaveLength(1);
    expect(JSON.stringify(stale)).not.toContain("space-client-secret-that-must-not-be-exposed");
    expect(JSON.stringify(stale)).not.toContain("instanceSecret");

    const second = await createRuntimeDaemonSocketClientTransport(
      host.endpoint,
    );
    cleanupTasks.push(async () => second.close?.());
    await second.request("initialize", {
      profile: "default",
      token,
      clientInfo: {
        name: "space-reconnect",
        instanceId: "space-client",
        title: "\u001b[31mspoofed title",
        version: "\u200F1.2.3",
        clientType: "bot",
      },
    });
    const concurrent = await first.request("daemon.preflight") as {
      clientCount: number;
      clients: readonly Record<string, unknown>[];
      blockers: readonly string[];
      canStop: boolean;
    };
    expect(concurrent).toMatchObject({
      clientCount: 2,
      clients: [
        { principalId: expect.stringMatching(/^client_[a-f0-9]{64}$/), name: oversizedName.slice(0, 128) },
        {
          principalId: expect.stringMatching(/^client_[a-f0-9]{64}$/),
          name: "space-reconnect",
          clientType: "unknown",
        },
      ],
      blockers: ["connected_clients"],
      canStop: false,
    });
    expect(new Set(concurrent.clients.map((client) => client.daemonConnectionId)).size).toBe(2);
    expect(concurrent.clients[1]).not.toHaveProperty("title");
    expect(concurrent.clients[1]).not.toHaveProperty("version");
    await second.close?.();
    await waitForClientCount(first, 1);
    const afterReconnectClosed = await first.request("daemon.preflight") as {
      clients: readonly Record<string, unknown>[];
    };
    expect(afterReconnectClosed.clients).toHaveLength(1);
    expect(afterReconnectClosed.clients[0]).not.toHaveProperty("instanceSecret");
    expect(afterReconnectClosed.clients[0]).not.toHaveProperty("token");

    // FEATURE_298 T25 — the retired rollbackToInline protocol is gone; the
    // real idle shutdown stops the Host without touching owner mode.
    await expect(first.request("runtime.shutdown")).resolves.toBeTruthy();
    await host.closed;
    await waitForHostStateRemoval(paths);
    expect(readRuntimeOwnerPolicy(paths)).toMatchObject({
      mode: "daemon",
    });
  });

  it("reports optional integration degradation without making the daemon unhealthy", async () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), "default");
    const runtime = makeRuntime();
    const lock = tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: runtime.identity.runtimeId,
      pid: process.pid,
      createdAt: runtime.identity.startedAt,
      kind: "daemon",
    });
    expect(lock).toBeDefined();
    if (!lock)
      throw new Error("Expected daemon lock for integration health test.");

    const host = await startRuntimeDaemonHost({
      runtime,
      paths,
      endpoint: await makeTestEndpoint(),
      lock,
      integrationStatuses: () => [
        {
          domain: "mcp",
          path: path.join(paths.configHome, "integrations", "mcp.json"),
          source: "default",
          watching: true,
          diagnostic: {
            code: "invalid-config",
            message:
              "Integration configuration is invalid; check the file against its versioned schema.",
            time: "2026-07-28T00:00:00.000Z",
          },
        },
        {
          domain: "extensions",
          path: path.join(paths.configHome, "integrations", "extensions.json"),
          source: "user",
          revision: "extensions-revision",
          lastReloadAt: "2026-07-28T00:00:01.000Z",
          watching: true,
        },
      ],
    });
    cleanupTasks.push(() => host.close());
    const client = await createRuntimeDaemonSocketClientTransport(
      host.endpoint,
    );
    cleanupTasks.push(async () => client.close?.());
    await client.request("initialize", {
      profile: "default",
      token: readRuntimeDaemonToken(paths),
    });

    await expect(
      client.request("daemon.management.get"),
    ).resolves.toMatchObject({
      integrations: {
        state: "degraded",
        domains: [
          {
            domain: "mcp",
            source: "default",
            diagnostic: { code: "invalid-config" },
          },
          {
            domain: "extensions",
            source: "user",
          },
        ],
      },
    });
    expect(readRuntimeDaemonState(paths)).toMatchObject({ status: "ready" });
    const preflight = vi.spyOn(runtime.status, "preflight");
    await expect(client.request("daemon.integrations.get")).resolves.toMatchObject({
      state: "degraded",
      domains: [{ domain: "mcp", diagnostic: { code: "invalid-config" } }, { domain: "extensions" }],
    });
    expect(preflight).not.toHaveBeenCalled();
    await expect(client.request("runtime.capabilities")).resolves.toMatchObject({
      integrationConfigResilience: { healthQuery: true },
    });
  });

  it("advances management revision for daemon-owned background lifecycle changes", async () => {
    let activeWorkflow: ManagedWorkflowSnapshot | undefined;
    let activeAgentTurn: RuntimeActiveAgentTurn | undefined;
    const backgroundWorkflow: ManagedWorkflowSnapshot = {
      runId: "workflow-background",
      runDir: path.join(os.tmpdir(), "workflow-background"),
      workflow: "background-review",
      status: "running",
      totalSpawned: 1,
      eventCount: 1,
      startedAt: 1,
    };
    const runtime = makeRuntime({
      async preflight() {
        const activeWorkflows = activeWorkflow ? [activeWorkflow] : [];
        const activeAgentTurns = activeAgentTurn ? [activeAgentTurn] : [];
        const blockers: RuntimeDaemonPreflight["blockers"][number][] = [];
        if (activeWorkflows.length > 0) blockers.push("active_workflows");
        if (activeAgentTurns.length > 0) blockers.push("active_agent_turns");
        return {
          runtimeId: "runtime-host-test",
          clientCount: 0,
          activeRuns: [],
          queuedRuns: [],
          activeWorkflows,
          activeAgentTurns,
          activeAgentTasks: activeAgentTurns,
          pendingPermissions: [],
          pendingUserInputs: [],
          blockers,
          canStop: blockers.length === 0,
        };
      },
    });
    const paths = resolveRuntimeDaemonPaths(tempHome(), "default");
    const lock = tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: runtime.identity.runtimeId,
      pid: process.pid,
      createdAt: runtime.identity.startedAt,
      kind: "daemon",
    });
    expect(lock).toBeDefined();
    if (!lock)
      throw new Error("Expected daemon lock for background revision test.");
    const host = await startRuntimeDaemonHost({
      runtime,
      paths,
      endpoint: await makeTestEndpoint(),
      lock,
    });
    cleanupTasks.push(() => host.close());
    const client = await createRuntimeDaemonSocketClientTransport(
      host.endpoint,
    );
    cleanupTasks.push(async () => client.close?.());
    await client.request("initialize", {
      profile: "default",
      token: readRuntimeDaemonToken(paths),
    });

    const first = (await client.request("daemon.management.get")) as {
      runtimeId: string;
      revision: number;
      ownerPolicy: { revision: number };
      preflight: RuntimeDaemonPreflight;
    };
    expect(first.preflight).toMatchObject({
      blockers: [],
      canStop: true,
    });

    activeWorkflow = backgroundWorkflow;
    activeAgentTurn = backgroundAgentTurn();
    await expect(
      client.request("runtime.shutdown"),
    ).rejects.toMatchObject({ code: "conflict" });

    const changed = (await client.request("daemon.management.get")) as {
      revision: number;
      preflight: RuntimeDaemonPreflight;
    };
    expect(changed.revision).toBeGreaterThan(first.revision);
    expect(changed.preflight).toMatchObject({
      blockers: expect.arrayContaining([
        "active_workflows",
        "active_agent_turns",
      ]),
      canStop: false,
    });

    activeWorkflow = { ...backgroundWorkflow, eventCount: 2 };
    activeAgentTurn = {
      ...activeAgentTurn,
      turnId: "turn-background-followup",
    };
    const progressed = (await client.request("daemon.management.get")) as {
      revision: number;
      preflight: RuntimeDaemonPreflight;
    };
    expect(progressed.revision).toBeGreaterThan(changed.revision);

    activeWorkflow = undefined;
    activeAgentTurn = undefined;
    const settled = (await client.request("daemon.management.get")) as {
      revision: number;
      preflight: RuntimeDaemonPreflight;
    };
    expect(settled.revision).toBeGreaterThan(progressed.revision);
    expect(settled.preflight).toMatchObject({
      activeWorkflows: [],
      activeAgentTurns: [],
      blockers: [],
      canStop: true,
    });
  });

  it("routes runtime diagnostics to the daemon log without writing to the live terminal", async () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), "default");
    const runtime = makeRuntime();
    const lock = tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: runtime.identity.runtimeId,
      pid: process.pid,
      createdAt: runtime.identity.startedAt,
    });
    expect(lock).toBeDefined();
    if (!lock) throw new Error("Expected daemon lock for diagnostic test.");

    const host = await startRuntimeDaemonHost({
      runtime,
      paths,
      endpoint: await makeTestEndpoint(),
      lock,
    });
    cleanupTasks.push(() => host.close());

    emitKodaXDiagnostic({
      source: "test:diagnostic",
      level: "warn",
      message: "bounded warning",
      detail: { code: "E_TEST" },
    });

    const logText = fs.readFileSync(paths.logFile, "utf8");
    expect(logText).toContain("[test:diagnostic] bounded warning");
    expect(logText).toContain('"code":"E_TEST"');

  await host.close();
});

it("warns in the daemon log when a proxy variable will not reach every request", async () => {
  vi.stubEnv("HTTPS_PROXY", "http://user:proxy-secret@127.0.0.1:9");
  vi.stubEnv("NODE_USE_ENV_PROXY", undefined);
  vi.stubEnv("NODE_OPTIONS", undefined);
  try {
    const paths = resolveRuntimeDaemonPaths(tempHome(), "default");
    const runtime = makeRuntime();
    const lock = tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: runtime.identity.runtimeId,
      pid: process.pid,
      createdAt: runtime.identity.startedAt,
    });
    if (!lock) throw new Error("Expected daemon lock for proxy diagnostic test.");

    const host = await startRuntimeDaemonHost({ runtime, paths, endpoint: await makeTestEndpoint(), lock });
    cleanupTasks.push(() => host.close());

    const logText = fs.readFileSync(paths.logFile, "utf8");
    expect(logText).toContain("[runtime:network] HTTPS_PROXY is set");
    expect(logText).toContain("NODE_USE_ENV_PROXY=1");
    expect(logText).not.toContain("proxy-secret");
    await host.close();
  } finally {
    vi.unstubAllEnvs();
  }
});

it("keeps cyclic Error cause chains diagnosable in the daemon log", async () => {
  const paths = resolveRuntimeDaemonPaths(tempHome(), "default");
  const runtime = makeRuntime();
  const lock = tryAcquireRuntimeDaemonLock(paths, {
    runtimeId: runtime.identity.runtimeId,
    pid: process.pid,
    createdAt: runtime.identity.startedAt,
  });
  expect(lock).toBeDefined();
  if (!lock) throw new Error("Expected daemon lock for cyclic-cause diagnostic test.");

  const host = await startRuntimeDaemonHost({
    runtime,
    paths,
    endpoint: await makeTestEndpoint(),
    lock,
  });
  cleanupTasks.push(() => host.close());

  const cyclic = new Error("ASRT workspace session retirement failed.");
  cyclic.cause = cyclic;
  const pairFirst = new Error("lease release failed");
  const pairSecond = new Error("attestation missing");
  pairFirst.cause = pairSecond;
  pairSecond.cause = pairFirst;

  emitKodaXDiagnostic({
    source: "test:diagnostic",
    level: "error",
    message: "cyclic cleanup failure",
    detail: new AggregateError([cyclic, pairFirst], "Workspace sandbox retirement failed."),
  });

  const logText = fs.readFileSync(paths.logFile, "utf8");
  expect(logText).toContain("retirement failed");
  expect(logText).toContain("lease release failed");
  expect(logText).toContain("attestation missing");
  expect(logText).toContain("[cyclic]");
  expect(logText).not.toContain('"detail":{}');

  await host.close();
});

it("keeps Error diagnostic details diagnosable in the daemon log", async () => {
  const paths = resolveRuntimeDaemonPaths(tempHome(), "default");
    const runtime = makeRuntime();
    const lock = tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: runtime.identity.runtimeId,
      pid: process.pid,
      createdAt: runtime.identity.startedAt,
    });
    expect(lock).toBeDefined();
    if (!lock) throw new Error("Expected daemon lock for error-detail diagnostic test.");

    const host = await startRuntimeDaemonHost({
      runtime,
      paths,
      endpoint: await makeTestEndpoint(),
      lock,
    });
    cleanupTasks.push(() => host.close());

    emitKodaXDiagnostic({
      source: "test:diagnostic",
      level: "warn",
      message: "aggregate cleanup warning",
      detail: new AggregateError(
        [
          new Error("ASRT workspace session cleanup request timed out."),
          new Error("Required OS sandbox execution could not be attested."),
        ],
        "Workspace sandbox command cleanup failed.",
      ),
    });

    const logText = fs.readFileSync(paths.logFile, "utf8");
    expect(logText).toContain('"message":"Workspace sandbox command cleanup failed."');
    expect(logText).toContain("cleanup request timed out");
    expect(logText).toContain("could not be attested");
    expect(logText).not.toContain('"detail":{}');

    await host.close();
  });

  it("retains run results across daemon client reconnects", async () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), "default");
    const runtime = makeRuntime();
    const lock = tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: runtime.identity.runtimeId,
      pid: process.pid,
      createdAt: runtime.identity.startedAt,
    });
    expect(lock).toBeDefined();
    if (!lock) throw new Error("Expected daemon lock for reconnect test.");

    const host = await startRuntimeDaemonHost({
      runtime,
      paths,
      endpoint: await makeTestEndpoint(),
      lock,
    });
    cleanupTasks.push(() => host.close());

    const firstClient = await createRuntimeDaemonSocketClientTransport(
      host.endpoint,
    );
    cleanupTasks.push(async () => {
      await firstClient.close?.();
    });
    const token = readRuntimeDaemonToken(paths);
    await expect(
      firstClient.request("initialize", { profile: "default", token }),
    ).resolves.toMatchObject({
      identity: {
        runtimeId: runtime.identity.runtimeId,
        profile: "default",
      },
    });
    await expect(
      firstClient.request("run.start", {
        sessionId: "session-1",
        prompt: "hello",
      }),
    ).resolves.toMatchObject({
      runId: "run-1",
      sessionId: "session-1",
    });
    await firstClient.close?.();

    const secondClient = await createRuntimeDaemonSocketClientTransport(
      host.endpoint,
    );
    cleanupTasks.push(async () => {
      await secondClient.close?.();
    });
    await expect(
      secondClient.request("initialize", { profile: "default", token }),
    ).resolves.toMatchObject({
      identity: {
        runtimeId: runtime.identity.runtimeId,
        profile: "default",
      },
    });
    await expect(
      secondClient.request("run.await", { runId: "run-1" }),
    ).resolves.toMatchObject({
      runId: "run-1",
      sessionId: "session-1",
      phase: "completed",
      result: {
        success: true,
        lastText: "done",
      },
    });
  });

  it("broadcasts matching session events to multiple initialized daemon clients", async () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), "default");
    const runtime = makeRuntime();
    const lock = tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: runtime.identity.runtimeId,
      pid: process.pid,
      createdAt: runtime.identity.startedAt,
    });
    expect(lock).toBeDefined();
    if (!lock) throw new Error("Expected daemon lock for multi-client test.");

    const host = await startRuntimeDaemonHost({
      runtime,
      paths,
      endpoint: await makeTestEndpoint(),
      lock,
    });
    cleanupTasks.push(() => host.close());
    const token = readRuntimeDaemonToken(paths);

    const replClient = await createRuntimeDaemonSocketClientTransport(
      host.endpoint,
    );
    const spaceClient = await createRuntimeDaemonSocketClientTransport(
      host.endpoint,
    );
    cleanupTasks.push(async () => {
      await replClient.close?.();
      await spaceClient.close?.();
    });

    await expect(
      replClient.request("initialize", {
        profile: "default",
        token,
        clientInfo: { name: "kodax-repl-test" },
      }),
    ).resolves.toMatchObject({
      identity: { runtimeId: runtime.identity.runtimeId },
    });
    await expect(
      spaceClient.request("initialize", {
        profile: "default",
        token,
        clientInfo: { name: "kodax-space-test" },
      }),
    ).resolves.toMatchObject({
      identity: { runtimeId: runtime.identity.runtimeId },
    });
    await expect(
      spaceClient.request("daemon.preflight"),
    ).resolves.toMatchObject({
      clientCount: 2,
      blockers: expect.arrayContaining(["connected_clients"]),
      canStop: false,
    });

    const replEvents: RuntimeEvent[] = [];
    const spaceEvents: RuntimeEvent[] = [];
    replClient.subscribe((notification) => {
      const event = extractRuntimeEventNotification(notification.params);
      if (event) replEvents.push(event);
    });
    spaceClient.subscribe((notification) => {
      const event = extractRuntimeEventNotification(notification.params);
      if (event) spaceEvents.push(event);
    });

    await expect(
      replClient.request("session.observe", { sessionId: "session-1" }),
    ).resolves.toMatchObject({ subscriptionId: expect.any(String) });
    await expect(
      spaceClient.request("session.observe", { sessionId: "session-1" }),
    ).resolves.toMatchObject({ subscriptionId: expect.any(String) });
    await expect(
      replClient.request("run.start", {
        sessionId: "session-1",
        prompt: "hello from repl",
      }),
    ).resolves.toMatchObject({
      runId: "run-1",
      sessionId: "session-1",
    });

    await waitFor(() => replEvents.length === 1 && spaceEvents.length === 1);
    expect(replEvents[0]).toMatchObject({
      type: "run.completed",
      sessionId: "session-1",
      runId: "run-1",
      payload: { lastText: "done" },
    });
    expect(spaceEvents[0]).toEqual(replEvents[0]);
  });

  it("lists and answers pending permissions after a daemon client reconnects", async () => {
    const paths = resolveRuntimeDaemonPaths(tempHome(), "default");
    const baseRuntime = makeRuntime();
    const pending: RuntimePermissionRequest[] = [
      {
        id: "perm-1",
        sessionId: "session-1",
        runId: "run-1",
        toolName: "bash",
        reason: "edit requires approval",
        createdAt: "2026-07-09T00:00:00.000Z",
      },
    ];
    const permissionService: KodaXRuntime["permissions"] = {
      ...baseRuntime.permissions,
      async request() {
        return { type: "allow_once" };
      },
      async listPending(filter) {
        return pending.filter(
          (request) =>
            (filter?.sessionId === undefined ||
              request.sessionId === filter.sessionId) &&
            (filter?.runId === undefined || request.runId === filter.runId) &&
            (filter?.toolName === undefined ||
              request.toolName === filter.toolName),
        );
      },
      async respond(requestId, _decision, options) {
        const index = pending.findIndex(
          (request) =>
            request.id === requestId &&
            (options?.runId === undefined || request.runId === options.runId),
        );
        if (index < 0) return false;
        pending.splice(index, 1);
        return true;
      },
    };
    const runtime: KodaXRuntime & { closed: boolean } = {
      ...baseRuntime,
      permissions: permissionService,
      interactions: createTestInteractions({
        userInputs: baseRuntime.userInputs,
        permissions: permissionService,
      }),
    };
    const lock = tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: runtime.identity.runtimeId,
      pid: process.pid,
      createdAt: runtime.identity.startedAt,
    });
    expect(lock).toBeDefined();
    if (!lock)
      throw new Error("Expected daemon lock for permission reconnect test.");

    const host = await startRuntimeDaemonHost({
      runtime,
      paths,
      endpoint: await makeTestEndpoint(),
      lock,
    });
    cleanupTasks.push(() => host.close());
    const token = readRuntimeDaemonToken(paths);

    const firstClient = await createRuntimeDaemonSocketClientTransport(
      host.endpoint,
    );
    cleanupTasks.push(async () => {
      await firstClient.close?.();
    });
    await expect(
      firstClient.request("initialize", { profile: "default", token }),
    ).resolves.toMatchObject({
      identity: { runtimeId: runtime.identity.runtimeId },
    });
    await expect(
      firstClient.request("interaction.list", { sessionId: "session-1" }),
    ).resolves.toEqual([
      expect.objectContaining({
        requestId: "perm-1",
        kind: "permission",
        options: expect.objectContaining({ toolName: "bash" }),
      }),
    ]);
    await firstClient.close?.();

    const secondClient = await createRuntimeDaemonSocketClientTransport(
      host.endpoint,
    );
    cleanupTasks.push(async () => {
      await secondClient.close?.();
    });
    await expect(
      secondClient.request("initialize", { profile: "default", token }),
    ).resolves.toMatchObject({
      identity: { runtimeId: runtime.identity.runtimeId },
    });
    await expect(
      secondClient.request("interaction.respond", {
        requestId: "perm-1",
        response: { kind: "permission", decision: { type: "allow_once" } },
      }),
    ).resolves.toEqual({
      requestId: "perm-1",
      accepted: true,
      status: "answered",
    });
    await expect(
      secondClient.request("interaction.respond", {
        requestId: "perm-1",
        response: { kind: "permission", decision: { type: "allow_once" } },
      }),
    ).resolves.toEqual({
      requestId: "perm-1",
      accepted: false,
      status: "already_resolved",
    });
    expect(pending).toEqual([]);
  });
});

interface TestWebSocket {
  send(data: string): void;
  close(): void;
  on(event: "open", listener: () => void): void;
  on(event: "close", listener: (code: number, reason: Buffer) => void): void;
  on(event: "message", listener: (data: Buffer) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
}

/** A v2 link over the Host's network listener, the way a remote client opens one. */
function dialWebSocket(url: string, origin?: string): HostRpcDial {
  const { WebSocket } = createRequire(import.meta.url)("ws") as {
    WebSocket: new (url: string, options: { headers?: Record<string, string> }) => TestWebSocket;
  };
  return async (events) => {
    const socket = new WebSocket(url, origin !== undefined ? { headers: { origin } } : {});
    await new Promise<void>((resolve, reject) => {
      socket.on("open", resolve);
      socket.on("error", reject);
    });
    socket.on("message", data => events.frame(data.toString("utf8")));
    socket.on("close", (code, reason) => events.end({ code, reason: reason.toString("utf8") }));
    return { send: frame => socket.send(frame), close: () => socket.close() };
  };
}

/** A key set on loopback, and tokens it signs for this Host's audience. */
async function startTestIdentityProvider() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", use: "sig" };
  const server = createHttpServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const issuer = "https://idp.example.test/realm";
  return {
    issuer,
    jwksUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/jwks`,
    token: (sub: string) => signTestJwt(privateKey, { iss: issuer, aud: "kodax-host-test", sub, exp: Math.floor(Date.now() / 1000) + 300 }),
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

function signTestJwt(key: KeyObject, claims: Record<string, unknown>): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = `${encode({ alg: "RS256", kid: "k1", typ: "JWT" })}.${encode(claims)}`;
  return `${input}.${createSign("sha256").update(input).sign(key).toString("base64url")}`;
}

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kodax-daemon-host-"));
  tempRoots.push(dir);
  return dir;
}

async function makeTestEndpoint(): Promise<RuntimeDaemonEndpoint> {
  if (process.platform === "win32") {
    return {
      kind: "pipe",
      path: `\\\\.\\pipe\\kodax-runtime-host-test-${randomUUID()}`,
    };
  }
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "kodax-daemon-host-socket-"),
  );
  tempRoots.push(dir);
  return {
    kind: "unix",
    path: path.join(dir, "daemon.sock"),
  };
}

/** A Host whose fake Runtime registered `quiesce`, with one initialized client attached. */
async function startQuiesceHost(
  profile: string,
  quiesce: Parameters<typeof registerHostCloseQuiesce>[1],
  runQuiesceMs?: number,
) {
  const paths = resolveRuntimeDaemonPaths(tempHome(), profile);
  const runtime = makeRuntime();
  registerHostCloseQuiesce(runtime, quiesce);
  const lock = tryAcquireRuntimeDaemonLock(paths, {
    runtimeId: runtime.identity.runtimeId,
    pid: process.pid,
    createdAt: runtime.identity.startedAt,
  });
  if (!lock) throw new Error("Expected daemon lock for the quiesce test.");
  const host = await startRuntimeDaemonHost({
    runtime,
    paths,
    endpoint: await makeTestEndpoint(),
    lock,
    ...(runQuiesceMs !== undefined ? { runQuiesceMs } : {}),
  });
  cleanupTasks.push(() => host.close().catch(() => undefined));
  const client = await createRuntimeDaemonSocketClientTransport(host.endpoint);
  cleanupTasks.push(async () => {
    await client.close?.();
  });
  await client.request("initialize", { profile: "default", token: readRuntimeDaemonToken(paths) });
  return { paths, runtime, host, client };
}

async function waitForHostStateRemoval(
  paths: ReturnType<typeof resolveRuntimeDaemonPaths>,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() <= deadline) {
    if (
      !readRuntimeDaemonState(paths) &&
      !readRuntimeDaemonLockOwner(paths.lockFile)
    ) {
      return;
    }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 25);
      timer.unref?.();
    });
  }
  throw new Error("Timed out waiting for daemon host state removal.");
}

async function waitForClientCount(
  client: Awaited<ReturnType<typeof createRuntimeDaemonSocketClientTransport>>,
  expected: number,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() <= deadline) {
    const preflight = (await client.request("daemon.preflight")) as {
      clientCount?: unknown;
    };
    if (preflight.clientCount === expected) return;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 25);
      timer.unref?.();
    });
  }
  throw new Error(`Timed out waiting for daemon client count ${expected}.`);
}

function makeRuntime(
  options: {
    readonly preflight?: () => Promise<RuntimeDaemonPreflight>;
  } = {},
): KodaXRuntime & { closed: boolean } {
  const runs = new Map<string, RuntimeRunResult>();
  const eventSubscribers: Array<{
    readonly filter: RuntimeEventFilter;
    readonly listener: RuntimeEventListener;
  }> = [];
  let eventSeq = 1;
  const emitEvent = (
    event: Omit<RuntimeEvent, "id" | "seq" | "time" | "cursor">,
  ): RuntimeEvent => {
    const fullEvent: RuntimeEvent = {
      ...event,
      id: `evt_${eventSeq}`,
      seq: eventSeq,
      time: new Date().toISOString(),
    };
    eventSeq += 1;
    for (const subscriber of eventSubscribers) {
      if (runtimeEventMatchesFilter(fullEvent, subscriber.filter)) {
        subscriber.listener(fullEvent);
      }
    }
    return fullEvent;
  };
  const runtime: KodaXRuntime & { closed: boolean } = {
    closed: false,
    identity: {
      runtimeId: "runtime-host-test",
      mode: "daemon",
      profile: "default",
      startedAt: "2026-07-09T00:00:00.000Z",
      version: "0.7.66",
    },
    sessions: {
      async promote(input) { return { requestId: input.requestId, session: { id: input.sessionId, title: 'Promoted', tag: input.tag } }; },
      async readPromotion() { return null; },
      async cancel(input) { return { ...input, frontier: 0, receipts: [] }; },
      async status(sessionId) {
        return { sessionId, runtimeId: "runtime-test", phase: "idle",
          observedAt: new Date(0).toISOString() };
      },
      async conversation() { return null; },
      async conversationPage() { return null; },
      async conversationEntryChunk() { return null; },
      async diagnostics() { throw new Error("Session diagnostics are not used by this fixture."); },
      async create(input) {
        return {
          id: input?.sessionId ?? "session-1",
          title: input?.title ?? "Test Session",
        };
      },
      async load(sessionId) {
        return { id: sessionId, title: "Loaded Session" };
      },
      async list() {
        return [{ id: "session-1", title: "Test Session", msgCount: 0 }];
      },
      async transcript() {
        return null;
      },
      async transcriptPage() {
        return null;
      },
      async transcriptEntryChunk() {
        return null;
      },
      async transcriptSearch() {
        return null;
      },
      async observe(sessionId, listener) {
        const subscriber = { filter: { sessionId } as RuntimeEventFilter, listener };
        eventSubscribers.push(subscriber);
        return {
          ...createTestObservation(sessionId),
          close() {
            const index = eventSubscribers.indexOf(subscriber);
            if (index >= 0) eventSubscribers.splice(index, 1);
          },
        };
      },
      async openSide() { return { id: 'side-1', title: 'Side chat' }; },
      async fork() {
        return { id: "fork-1", title: "Forked Session" };
      },
      async observeView(sessionId, listener) {
        listener({ session: { id: sessionId, title: "Test Session" }, items: [], settings: {}, runs: [], queue: [], interactions: [] });
        return { close() {} };
      },
      async readViewItem() { return null; },
      async readHistory() {
        return { items: [], revision: "sha256:" + "0".repeat(64), sourceRevision: 'source', status: 'resolved', issues: [], oversized: [] };
      },
      async readHistoryEntry() { return null; },
      async resolveHistoryTurn() { return { status: 'unavailable', reason: 'no_turns' }; },
      async searchHistory() {
        return { revision: "sha256:" + "0".repeat(64), hits: [] };
      },
      async readGoal() { return null; },
      async createGoal() { throw new Error("Goals are not used by this fixture."); },
      async pauseGoal() { throw new Error("No goal exists in this fixture."); },
      async resumeGoal() { throw new Error("No goal exists in this fixture."); },
      async clearGoal() {},
      async readLineage() { return null; },
      async labelEntry() { throw new Error("No lineage exists in this fixture."); },
      async recover(input) {
        return { id: input.sessionId, title: "Recovered Session" };
      },
      async getSettings() {
        return {};
      },
      async getSettingsVersioned() {
        return { revision: 0, value: {} };
      },
      async getAutoModeStats() {
        return undefined;
      },
      async updateSettings() {
        return {};
      },
      async updateSettingsVersioned(_sessionId, _patch, options) {
        return { revision: options.expectedRevision + 1, value: {} };
      },
      async appendNotice() {
        return null;
      },
      async confirmIdentityAlias() {
        throw new Error('Identity confirmation is outside this host fixture.');
      },
      async rewind(input) {
        return { id: input.sessionId, title: "Rewound Session" };
      },
      async setActiveEntry(input) {
        return { id: input.sessionId, title: "Active Entry Session" };
      },
      async compact(input) {
        return {
          compacted: false,
          tokensBefore: 0,
          tokensAfter: 0,
          messages: [],
          session: { id: input.sessionId, title: "Compacted Session" },
        } satisfies RuntimeCompactSessionResult;
      },
      async archive() {},
      async unarchive() {},
      async delete() {},
    },
    runs: {
      async recover() { throw new Error('No generation checkpoint exists in this fixture.'); },
      async acceptInput() { throw new Error("Product inputs are not used by this fixture."); },
      async getInput() { return null; },
      async withdrawInput() { throw new Error("No queued input exists in this fixture."); },
      async start(input: RuntimeStartRunInput) {
        const result: RuntimeRunResult = {
          runId: "run-1",
          sessionId: input.sessionId,
          phase: "completed",
          result: {
            success: true,
            lastText: "done",
            messages: [],
            sessionId: input.sessionId,
          },
        };
        runs.set(result.runId, result);
        emitEvent({
          sessionId: result.sessionId,
          runId: result.runId,
          type: "run.completed",
          payload: { lastText: result.result?.lastText },
        });
        return {
          runId: result.runId,
          sessionId: result.sessionId,
          result: Promise.resolve(result),
        };
      },
      async submitInput(input) {
        return {
          accepted: false,
          delivery: input.delivery,
          sessionId: input.sessionId,
          afterRunId: input.afterRunId,
          reason: "stale_run",
        };
      },
      async await(runId) {
        const result = runs.get(runId);
        if (result) return result;
        return { runId, sessionId: "session-1", phase: "completed" };
      },
      async get(runId) {
        const result = runs.get(runId);
        return {
          runId,
          sessionId: result?.sessionId ?? "session-1",
          phase: result?.phase ?? "completed",
          startedAt: "2026-07-09T00:00:00.000Z",
          provider: "mock",
        };
      },
      async list() {
        return [];
      },
      async abort(runId) {
        return { runId, sessionId: "session-1", accepted: false,
          state: "confirmed", outcome: "completed", phase: "completed", revision: 0 };
      },
      async setModel() {},
      async setProvider() {},
      async setReasoning() {},
    },
    events: {
      subscribe(filter, listener) {
        const subscriber = { filter, listener };
        eventSubscribers.push(subscriber);
        return {
          close() {
            const index = eventSubscribers.indexOf(subscriber);
            if (index >= 0) eventSubscribers.splice(index, 1);
          },
        };
      },
    },
    permissions: {
      async request() {
        return { type: "allow_once" };
      },
      async listPending() {
        return [];
      },
      async respond() {
        return true;
      },
      async listGrants() {
        return { revision: 0, value: [] };
      },
      async revokeGrant() {
        return false;
      },
    },
    userInputs: createTestUserInputs(),
    interactions: createTestInteractions(),
    executionBindings: { async register() { return { id: 'binding-test' }; }, async revoke() { return false; } },
    credentials: createTestCredentialService(),
    hostTools: createTestHostToolService(),
    workflows: {
      async start() {
        return { kind: 'declined', reason: 'fake' };
      },
      async list() {
        return [];
      },
      async get() {
        return undefined;
      },
      subscribe() {
        return { close() {} };
      },
      async pause() {
        return false;
      },
      async resume() {
        return false;
      },
      async stop() {
        return false;
      },
    },
    learning: {
      async list() { return { items: [], revision: 0 }; },
      async get() { throw new Error("Learning is not used by this fixture."); },
      async getSnapshot() { return { ready: 0, newlyActive: 0, attention: 0, active: 0, revision: 0 }; },
      async events() { return []; },
      subscribe() { return Object.assign((async function* () {})(), { ready: Promise.resolve() }); },
      async acknowledge() {},
      async snooze() {},
      async reject() {},
      async disable() {},
      async rollback() {},
      async promote() {},
      async review() {},
      async trust() {},
    },
    memory: {
      forProject() { throw new Error("Memory is not used by this fixture."); },
    },
    invocations: {
      async readCommandPrompt() { return null; },
      async executeCommand() { return { kind: 'completed', success: true }; },
      async startReview() { return { kind: 'completed', success: true }; },
      async startAgentsLean() { return { kind: 'completed', success: false }; },
      async prepareSkill() { return { kind: "unknown" }; },
      async prepareCommand() { return { kind: "local" }; },
      async prepareReview() { return { kind: "empty" }; },
      async prepareAgentsLean() { return { kind: "missing" }; },
    },
    config: {
      async readEffective() {
        return { schemaVersion: 1, capturedAt: new Date(0).toISOString(),
          persistedConfig: { state: "missing" }, entries: {}, credentials: {} };
      },
      async read() {
        return {};
      },
      async patch(patch) {
        return patch;
      },
      async reload() {
        return { ok: true, config: {} };
      },
    },
    catalog: {
      async reasoningEfforts() {
        return [];
      },
      async probeReasoningEfforts() {
        return [];
      },
      async forgetCapabilities() {},
      async providers() {
        return [];
      },
      async models() {
        return [];
      },
      async commands() {
        return [];
      },
      async resolveCommand() {
        return null;
      },
      async skills() {
        return [];
      },
      async agents() {
        return [];
      },
      async describeSkill() {
        return null;
      },
      async customProviders() {
        return [];
      },
      async upsertCustomProvider(config) {
        return config;
      },
      async deleteCustomProvider() {
        return false;
      },
      async extensions() {
        return { active: false, extensions: [] };
      },
      async reloadExtensions() {
        return { ok: true, active: false };
      },
    },
    mcp: {
      async status() { return []; },
      async listServers() {
        return {};
      },
      async getServer() {
        return undefined;
      },
      async validateServer(_name, config) {
        return {
          ok: true,
          config: config as Parameters<KodaXRuntime["mcp"]["upsertServer"]>[1],
        };
      },
      async upsertServer(_name, config) {
        return config;
      },
      async deleteServer() {
        return false;
      },
      async reloadServers() {
        return { ok: true, servers: [] };
      },
      async listTools() {
        return [];
      },
    },
    artifacts: {
      async create(input) {
        return {
          id: "art-1",
          kind: input.kind,
          path: input.path,
          sizeBytes: 0,
          createdAt: "2026-07-09T00:00:00.000Z",
        };
      },
      async get() {
        return undefined;
      },
      async delete() {
        return false;
      },
    },
    admin: {
      agentRegistrations: {
        async list() {
          return [];
        },
        async upsert() {
          throw new Error("External agents are disabled in this test runtime.");
        },
        async setEnabled() {
          throw new Error("External agents are disabled in this test runtime.");
        },
        async remove() {
          throw new Error("External agents are disabled in this test runtime.");
        },
      },
    },
    agents: {
      enabled: false,
      async listDispatchable() {
        return [];
      },
      async describe() {
        return undefined;
      },
      async preflight() {
        throw new Error("External agents are disabled in this test runtime.");
      },
      async tree() {
        return {
          rootPath: "/root" as const,
          actors: [],
          activeNonRootTurns: 0,
          maxConcurrentThreads: 4,
          revision: 0,
        };
      },
      async detail() {
        throw new Error("Actor not found.");
      },
      async spawn() {
        throw new Error("Actor execution is disabled in this test runtime.");
      },
      async send() {
        throw new Error("Actor execution is disabled in this test runtime.");
      },
      async followup() {
        throw new Error("Actor execution is disabled in this test runtime.");
      },
      async interrupt() {
        throw new Error("Actor execution is disabled in this test runtime.");
      },
      async output() {
        throw new Error("Actor execution is disabled in this test runtime.");
      },
      async events() {
        return [];
      },
      async wait() {
        return undefined;
      },
    },
    status: {
      async snapshot() {
        return {
          ...runtime.identity,
          sessions: [],
          runs: [],
          pendingPermissions: [],
          workflows: [],
        };
      },
      async preflight() {
        if (options.preflight) return options.preflight();
        return {
          runtimeId: runtime.identity.runtimeId,
          clientCount: 0,
          activeRuns: [],
          queuedRuns: [],
          activeWorkflows: [],
          activeAgentTurns: [],
          activeAgentTasks: [],
          pendingPermissions: [],
          pendingUserInputs: [],
          blockers: [],
          canStop: true,
        };
      },
    },
    async close() {
      runtime.closed = true;
    },
  };
  return runtime;
}

function backgroundAgentTurn(): RuntimeActiveAgentTurn {
  return {
    sessionId: "session-background",
    actorPath: "/root/background",
    turnId: "turn-background",
    kind: "external",
  };
}

function createTestUserInputs(): KodaXRuntime["userInputs"] {
  return {
    async listPending() {
      return [];
    },
    async respond(requestId) {
      return { requestId, accepted: false, status: "already_resolved" };
    },
    async dismiss(requestId) {
      return { requestId, accepted: false, status: "already_resolved" };
    },
  };
}

function createTestInteractions(
  registries: ClientInteractionRegistries = {
    userInputs: createTestUserInputs(),
    permissions: {
      async listPending() {
        return [];
      },
      async respond() {
        return true;
      },
    },
  },
): KodaXRuntime["interactions"] {
  return {
    list: (filter) => listClientInteractions(registries, filter),
    respond: (requestId, response) =>
      respondToClientInteraction(registries, requestId, response),
  };
}

function createTestCredentialService(): KodaXRuntime["credentials"] {
  return {
    async registerScoped(input) {
      return { id: "credential-test", ...input, brokerVersion: 2 };
    },
    async resumeScoped() {
      throw new Error("Missing credential lease.");
    },
    async register(input) {
      return { id: "credential-test", ...input };
    },
    async resume() {
      throw new Error("Missing credential lease.");
    },
    async revoke() {
      return false;
    },
  };
}

function createTestHostToolService(): KodaXRuntime["hostTools"] {
  return {
    async register(tools) {
      return { id: "host-tools-test", tools };
    },
    async resume() {
      throw new Error("Missing host tool lease.");
    },
    async revoke() {
      return false;
    },
    async getInvocation() {
      return undefined;
    },
  };
}

function createTestObservation(sessionId: string): RuntimeSessionObservation {
  return {
    snapshot: {
      runtimeId: "runtime-test",
      seq: 0,
      transcriptRevision: "sha256:test",
      session: { id: sessionId, title: "Test Session" },
      transcript: null,
      settings: { revision: 0, value: {} },
      runs: [],
      pendingPermissions: [],
      live: {
        assistantTextByRun: {},
        outputSegmentsByRun: {},
        thinkingTextByRun: {},
        activeTools: [],
        pendingUserInputs: [],
        managedTasks: [],
      },
    },
    invalidated: new Promise<RuntimeObservationInvalidation>(() => undefined),
    close() {},
  };
}

function extractRuntimeEventNotification(
  params: unknown,
): RuntimeEvent | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return undefined;
  }
  const event = (params as { readonly event?: unknown }).event;
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return undefined;
  }
  return event as RuntimeEvent;
}

function runtimeEventMatchesFilter(
  event: RuntimeEvent,
  filter: RuntimeEventFilter,
): boolean {
  if (filter.sessionId !== undefined && event.sessionId !== filter.sessionId)
    return false;
  if (filter.runId !== undefined && event.runId !== filter.runId) return false;
  if (filter.type !== undefined && event.type !== filter.type) return false;
  return true;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() <= deadline) {
    if (predicate()) return;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 25);
      timer.unref?.();
    });
  }
  throw new Error("Timed out waiting for daemon test condition.");
}
