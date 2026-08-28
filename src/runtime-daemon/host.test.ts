import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { emitKodaXDiagnostic } from "@kodax-ai/agent";
import type { ManagedWorkflowSnapshot } from "@kodax-ai/agent";

import type {
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
import { startRuntimeDaemonHost } from "./host.js";
import {
  readRuntimeDaemonLockOwner,
  readRuntimeDaemonState,
  readRuntimeDaemonToken,
  readRuntimeOwnerPolicy,
  resolveRuntimeDaemonPaths,
  tryAcquireRuntimeDaemonLock,
} from "./state.js";
import {
  createRuntimeDaemonSocketClientTransport,
  type RuntimeDaemonEndpoint,
} from "./transport.js";

const tempRoots: string[] = [];
const cleanupTasks: Array<() => Promise<void>> = [];

afterEach(async () => {
  const tasks = cleanupTasks.splice(0);
  await Promise.allSettled(tasks.map((task) => task()));
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("runtime daemon host", () => {
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

  it("counts initialized logical clients instead of internal sockets and rejects stale rollback commits", async () => {
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
        principalId: "space-client",
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
        { principalId: "space-client", name: oversizedName.slice(0, 128) },
        {
          principalId: "space-client",
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

    await expect(
      first.request("daemon.rollbackToInline", {
        expectedRuntimeId: stale.runtimeId,
        expectedRevision: stale.revision,
        expectedOwnerPolicyRevision: stale.ownerPolicy.revision,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(readRuntimeDaemonState(paths)).toMatchObject({ status: "ready" });

    const current = (await first.request("daemon.management.get")) as {
      runtimeId: string;
      revision: number;
      ownerPolicy: { revision: number };
    };
    await expect(
      first.request("daemon.rollbackToInline", {
        expectedRuntimeId: current.runtimeId,
        expectedRevision: current.revision,
        expectedOwnerPolicyRevision: current.ownerPolicy.revision,
      }),
    ).resolves.toMatchObject({
      accepted: true,
      ownerPolicy: { mode: "inline", revision: 1 },
    });
    await host.closed;
    await waitForHostStateRemoval(paths);
    expect(readRuntimeOwnerPolicy(paths)).toMatchObject({
      mode: "inline",
      revision: 1,
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
  });

  it("advances management revision for daemon-owned background lifecycle changes", async () => {
    let activeWorkflow: ManagedWorkflowSnapshot | undefined;
    let activeAgentTurn: RuntimeActiveAgentTurn | undefined;
    const backgroundWorkflow: ManagedWorkflowSnapshot = {
      runId: "workflow-background",
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
      client.request("daemon.rollbackToInline", {
        expectedRuntimeId: first.runtimeId,
        expectedRevision: first.revision,
        expectedOwnerPolicyRevision: first.ownerPolicy.revision,
      }),
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
      replClient.request("event.subscribe", {
        filter: { sessionId: "session-1", type: "run.completed" },
      }),
    ).resolves.toMatchObject({ subscriptionId: expect.any(String) });
    await expect(
      spaceClient.request("event.subscribe", {
        filter: { sessionId: "session-1", type: "run.completed" },
      }),
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
    const runtime: KodaXRuntime & { closed: boolean } = {
      ...baseRuntime,
      permissions: {
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
      },
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
      firstClient.request("permission.list", { runId: "run-1" }),
    ).resolves.toEqual([
      expect.objectContaining({ id: "perm-1", toolName: "bash" }),
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
      secondClient.request("permission.respond", {
        requestId: "perm-1",
        decision: { type: "allow_once" },
        runId: "run-1",
      }),
    ).resolves.toBe(true);
    await expect(
      secondClient.request("permission.respond", {
        requestId: "perm-1",
        decision: { type: "allow_once" },
        runId: "run-1",
      }),
    ).resolves.toBe(false);
    expect(pending).toEqual([]);
  });
});

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
    event: Omit<RuntimeEvent, "id" | "seq" | "time">,
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
      async observe(sessionId) {
        return createTestObservation(sessionId);
      },
      async fork() {
        return { id: "fork-1", title: "Forked Session" };
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
      async abort() {},
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
      async replay() {
        return [];
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
    credentials: createTestCredentialService(),
    hostTools: createTestHostToolService(),
    operations: {
      async get() {
        throw new Error("operation not found");
      },
    },
    workflows: {
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
    learning: {} as KodaXRuntime["learning"],
    config: {
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
    diagnostics: {
      async latestContextBudget() {
        return null;
      },
      async latestToolExposure() {
        return null;
      },
      async latestProviderCacheDiagnostic() {
        return null;
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

function createTestCredentialService(): KodaXRuntime["credentials"] {
  return {
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

function createTestObservation(sessionId: string) {
  return {
    snapshot: {
      runtimeId: "runtime-test",
      cursor: 0,
      transcriptRevision: "sha256:test",
      session: { id: sessionId, title: "Test Session" },
      transcript: null,
      settings: { revision: 0, value: {} },
      runs: [],
      pendingPermissions: [],
      live: {
        assistantTextByRun: {},
        thinkingTextByRun: {},
        activeTools: [],
        pendingUserInputs: [],
        managedTasks: [],
      },
    },
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
