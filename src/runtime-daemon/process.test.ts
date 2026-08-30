import {
  closeSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  assertRuntimeDaemonCliEntryAvailable,
  buildRuntimeDaemonServeArgs,
  capRuntimeDaemonBootstrapLog,
  consumeRuntimeDaemonOwnerBootstrap,
  createRuntimeDaemonServeEnvironment,
  createRuntimeDaemonOwnerBootstrapFile,
  daemonServeExecArgv,
  openRuntimeDaemonBootstrapLog,
  RUNTIME_DAEMON_OWNER_BOOTSTRAP_ENV,
  RuntimeDaemonProcessCleanupIncompleteError,
  runtimeDaemonBootstrapLogPath,
  waitForHealthyDaemonStartup,
  waitForReadyRuntimeDaemonOwner,
  type RuntimeDaemonStartupProcess,
} from "./process.js";
import {
  resolveRuntimeDaemonPathsFromConfigHome,
  tryAcquireRuntimeDaemonLock,
} from "./state.js";

describe("runtime daemon child process environment", () => {
  it("passes trusted owner policy through a one-shot daemon bootstrap file", () => {
    const configHome = mkdtempSync(
      path.join(os.tmpdir(), "kodax-daemon-owner-bootstrap-"),
    );
    const paths = resolveRuntimeDaemonPathsFromConfigHome(configHome, "coder");
    try {
      const ownerBootstrap = {
        execPolicy: {
          adminRules: [{
            prefix: ["git", "push"],
            decision: "forbidden" as const,
            justification: "Publishing is administrator-controlled.",
            source: "admin" as const,
            sourcePath: "host:admin",
          }],
          trustedProjectRoots: [path.join(configHome, "project")],
        },
        autoReview: {
          administratorPolicy: "Never publish from this host.",
          modelGuidance: "Distinguish staging from production.",
        },
      };
      const bootstrapFile = createRuntimeDaemonOwnerBootstrapFile(
        paths,
        ownerBootstrap,
      );
      const childEnv = createRuntimeDaemonServeEnvironment({
        homeDir: configHome,
        configHome,
        parentEnv: {
          [RUNTIME_DAEMON_OWNER_BOOTSTRAP_ENV]: "untrusted-parent-value",
        },
        ownerBootstrapFile: bootstrapFile,
      });

      expect(childEnv[RUNTIME_DAEMON_OWNER_BOOTSTRAP_ENV]).toBe(bootstrapFile);
      expect(
        consumeRuntimeDaemonOwnerBootstrap({
          configHome,
          profile: "coder",
          environment: childEnv,
        }),
      ).toEqual(ownerBootstrap);
      expect(childEnv[RUNTIME_DAEMON_OWNER_BOOTSTRAP_ENV]).toBeUndefined();
      expect(existsSync(bootstrapFile)).toBe(false);
    } finally {
      rmSync(configHome, { recursive: true, force: true });
    }
  });

  it("does not trust an ambient owner bootstrap path", () => {
    const childEnv = createRuntimeDaemonServeEnvironment({
      homeDir: "runtime-home",
      parentEnv: {
        [RUNTIME_DAEMON_OWNER_BOOTSTRAP_ENV]: "attacker-controlled.json",
      },
    });

    expect(childEnv[RUNTIME_DAEMON_OWNER_BOOTSTRAP_ENV]).toBeUndefined();
  });

  it("refuses to consume an owner bootstrap outside the selected daemon root", () => {
    const configHome = mkdtempSync(
      path.join(os.tmpdir(), "kodax-daemon-owner-root-"),
    );
    const outside = path.join(os.tmpdir(), `kodax-owner-outside-${Date.now()}.json`);
    writeFileSync(outside, "{}", "utf8");
    const environment: NodeJS.ProcessEnv = {
      [RUNTIME_DAEMON_OWNER_BOOTSTRAP_ENV]: outside,
    };
    try {
      expect(() => consumeRuntimeDaemonOwnerBootstrap({
        configHome,
        profile: "coder",
        environment,
      })).toThrow(/daemon root/i);
      expect(environment[RUNTIME_DAEMON_OWNER_BOOTSTRAP_ENV]).toBeUndefined();
      expect(existsSync(outside)).toBe(true);
    } finally {
      rmSync(configHome, { recursive: true, force: true });
      rmSync(outside, { force: true });
    }
  });

  it("passes Space orphan recovery only to the newly spawned daemon", () => {
    const args = buildRuntimeDaemonServeArgs(
      {
        profile: "coder",
        homeDir: "runtime-home",
        configHome: "runtime-config",
        orphanExitMs: 30_000,
      },
      undefined,
      [],
    );

    expect(args).toEqual([
      "daemon",
      "serve",
      "--profile",
      "coder",
      "--home",
      "runtime-home",
      "--config-home",
      "runtime-config",
      "--orphan-exit-ms",
      "30000",
    ]);
  });

  it("passes independent interaction deadlines to a newly spawned daemon", () => {
    const args = buildRuntimeDaemonServeArgs(
      {
        profile: "coder",
        homeDir: "runtime-home",
        configHome: "runtime-config",
        permissionTimeoutMs: 300_000,
        userInputTimeoutMs: 600_000,
      },
      undefined,
      [],
    );

    expect(args).toEqual([
      "daemon",
      "serve",
      "--profile",
      "coder",
      "--home",
      "runtime-home",
      "--config-home",
      "runtime-config",
      "--permission-timeout-ms",
      "300000",
      "--user-input-timeout-ms",
      "600000",
    ]);
  });

  it("does not retain the Electron bootstrap variable in the daemon environment", () => {
    const parentEnv: NodeJS.ProcessEnv = {
      ELECTRON_RUN_AS_NODE: "0",
      KODAX_HOME: "parent-config-home",
      PARENT_SENTINEL: "preserved",
    };

    const childEnv = createRuntimeDaemonServeEnvironment({
      homeDir: "runtime-home",
      parentEnv,
    });

    expect(childEnv).toMatchObject({
      KODAX_DAEMON_SERVE: "1",
      KODAX_HOME: path.join("runtime-home", ".kodax"),
      PARENT_SENTINEL: "preserved",
    });
    expect(childEnv.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(parentEnv).toEqual({
      ELECTRON_RUN_AS_NODE: "0",
      KODAX_HOME: "parent-config-home",
      PARENT_SENTINEL: "preserved",
    });
  });

  it("preserves the ordinary Node child environment contract", () => {
    const childEnv = createRuntimeDaemonServeEnvironment({
      homeDir: "runtime-home",
      parentEnv: { PARENT_SENTINEL: "preserved" },
    });

    expect(childEnv).toMatchObject({
      KODAX_DAEMON_SERVE: "1",
      KODAX_HOME: path.join("runtime-home", ".kodax"),
      PARENT_SENTINEL: "preserved",
    });
    expect(childEnv.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it("passes an arbitrary config home through to the daemon child unchanged", () => {
    const childEnv = createRuntimeDaemonServeEnvironment({
      homeDir: "runtime-home",
      configHome: "custom-config-home",
      parentEnv: {},
    });

    expect(childEnv.KODAX_HOME).toBe("custom-config-home");
  });

  it("fails before spawning when an embedder bundle omitted the daemon CLI sidecar", () => {
    const missingEntry = path.join(
      "missing-kodax-package",
      "dist",
      "kodax_cli.js",
    );

    expect(() => assertRuntimeDaemonCliEntryAvailable(undefined)).not.toThrow();
    expect(() => assertRuntimeDaemonCliEntryAvailable(missingEntry)).toThrow(
      /Keep the published KodaX dist files external/,
    );
  });

  it("does not inherit test-runner loaders into a source daemon child", () => {
    expect(
      daemonServeExecArgv(
        [
          "--import",
          "tsx",
          "--import",
          "vitest/worker",
          "--require",
          "./scripts/production-env.cjs",
          "--require",
          "vitest/register",
          "--loader",
          "some-test-loader",
          "--max-old-space-size=4096",
          "--enable-source-maps",
        ],
        true,
      ),
    ).toEqual([
      "--require",
      "./scripts/production-env.cjs",
      "--max-old-space-size=4096",
      "--enable-source-maps",
      "--import",
      "tsx",
    ]);
  });

  it("rotates and opens a bounded daemon bootstrap stderr log before startup", () => {
    const configHome = mkdtempSync(
      path.join(os.tmpdir(), "kodax-daemon-bootstrap-log-"),
    );
    const paths = resolveRuntimeDaemonPathsFromConfigHome(
      configHome,
      "bootstrap",
    );
    const bootstrapLog = runtimeDaemonBootstrapLogPath(paths);
    try {
      const first = openRuntimeDaemonBootstrapLog(paths, 32);
      writeFileSync(first, "first startup failure\n");
      closeSync(first);

      const second = openRuntimeDaemonBootstrapLog(paths, 16);
      writeFileSync(second, "next failure\n");
      closeSync(second);

      expect(readFileSync(`${bootstrapLog}.1`, "utf8")).toBe(
        "startup failure\n",
      );
      expect(readFileSync(bootstrapLog, "utf8")).toContain("next failure");
      expect(existsSync(paths.rootDir)).toBe(true);
    } finally {
      rmSync(configHome, { recursive: true, force: true });
    }
  });

  it("caps the active bootstrap log to its most recent bytes", () => {
    const configHome = mkdtempSync(
      path.join(os.tmpdir(), "kodax-daemon-bootstrap-cap-"),
    );
    const paths = resolveRuntimeDaemonPathsFromConfigHome(
      configHome,
      "bootstrap",
    );
    const bootstrapLog = runtimeDaemonBootstrapLogPath(paths);
    try {
      const fd = openRuntimeDaemonBootstrapLog(paths, 16);
      writeFileSync(fd, "0123456789abcdefghijklmnopqrstuvwxyz");
      closeSync(fd);

      capRuntimeDaemonBootstrapLog(paths, 16);

      const retained = readFileSync(bootstrapLog, "utf8");
      expect(Buffer.byteLength(retained)).toBeLessThanOrEqual(16);
      expect(retained).toBe("klmnopqrstuvwxyz");
    } finally {
      rmSync(configHome, { recursive: true, force: true });
    }
  });

  it("uses a bounded stdout and stderr writer after daemon bootstrap succeeds", () => {
    const configHome = mkdtempSync(
      path.join(os.tmpdir(), "kodax-daemon-bootstrap-detach-"),
    );
    const paths = resolveRuntimeDaemonPathsFromConfigHome(
      configHome,
      "bootstrap",
    );
    const bootstrapLog = runtimeDaemonBootstrapLogPath(paths);
    const descriptor = openRuntimeDaemonBootstrapLog(paths, 64);
    const processModule = pathToFileURL(
      path.resolve("src/runtime-daemon/process.ts"),
    ).href;
    const stateModule = pathToFileURL(
      path.resolve("src/runtime-daemon/state.ts"),
    ).href;
    const script = `
      const { detachRuntimeDaemonBootstrapOutput } = await import(${JSON.stringify(processModule)});
      const { resolveRuntimeDaemonPathsFromConfigHome } = await import(${JSON.stringify(stateModule)});
      const paths = resolveRuntimeDaemonPathsFromConfigHome(process.argv[1], 'bootstrap');
      console.error('captured-before-ready');
      detachRuntimeDaemonBootstrapOutput(paths, 64);
      console.error('after-ready-' + 'x'.repeat(100) + '-tail-marker');
    `;
    try {
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "--eval",
          script,
          configHome,
        ],
        {
          cwd: process.cwd(),
          stdio: ["ignore", descriptor, descriptor],
          env: process.env,
        },
      );
      closeSync(descriptor);
      expect(result.status).toBe(0);
      const retained = readFileSync(bootstrapLog, "utf8");
      expect(retained).not.toContain("captured-before-ready");
      expect(retained).toContain("tail-marker");
      expect(Buffer.byteLength(retained)).toBeLessThanOrEqual(64);
    } finally {
      try {
        closeSync(descriptor);
      } catch {
        // The descriptor is already closed on the success path.
      }
      rmSync(configHome, { recursive: true, force: true });
    }
  });
});

describe("runtime daemon child startup", () => {
  const paths = resolveRuntimeDaemonPathsFromConfigHome(
    "runtime-config-home",
    "default",
  );
  const missingHealth = async () => ({
    pidAlive: false,
    endpointReachable: false,
    identityMatches: false,
  });
  const healthy = (pid: number) => async () => ({
    state: {
      runtimeId: `runtime-${pid}`,
      profile: "default",
      pid,
      startedAt: "2026-07-17T00:00:00.000Z",
      endpoint: "runtime-endpoint",
      version: "0.7.71",
      status: "ready" as const,
    },
    pidAlive: true,
    endpointReachable: true,
    identityMatches: true,
  });

  it("fails immediately and reclaims the child when it exits before becoming healthy", async () => {
    let reportExit:
      | ((exit: {
          readonly code: number | null;
          readonly signal: NodeJS.Signals | null;
        }) => void)
      | undefined;
    const child: RuntimeDaemonStartupProcess = {
      pid: 321,
      exit: new Promise((resolve) => {
        reportExit = resolve;
      }),
      unref: vi.fn(),
      terminate: vi.fn(async () => undefined),
    };

    const waiting = waitForHealthyDaemonStartup(
      paths,
      {
        startupTimeoutMs: 60_000,
        pollIntervalMs: 1_000,
      },
      child,
      missingHealth,
    );
    reportExit?.({ code: 17, signal: null });

    await expect(waiting).rejects.toThrow(/exited.*code 17.*bootstrap\.log/i);
    expect(child.terminate).toHaveBeenCalledOnce();
    expect(child.unref).not.toHaveBeenCalled();
  });

  it("reclaims a still-running child when startup reaches its timeout", async () => {
    const child: RuntimeDaemonStartupProcess = {
      pid: 654,
      exit: new Promise(() => undefined),
      unref: vi.fn(),
      terminate: vi.fn(async () => undefined),
    };

    await expect(
      waitForHealthyDaemonStartup(
        paths,
        {
          startupTimeoutMs: 0,
          pollIntervalMs: 1,
        },
        child,
        missingHealth,
      ),
    ).rejects.toThrow(/timed out waiting/i);
    expect(child.terminate).toHaveBeenCalledOnce();
    expect(child.unref).not.toHaveBeenCalled();
  });

  it("reclaims a still-starting child when startup is cancelled", async () => {
    const controller = new AbortController();
    const child: RuntimeDaemonStartupProcess = {
      pid: 655,
      exit: new Promise(() => undefined),
      unref: vi.fn(),
      terminate: vi.fn(async () => undefined),
    };

    const waiting = waitForHealthyDaemonStartup(
      paths,
      {
        startupTimeoutMs: 60_000,
        pollIntervalMs: 1_000,
        startupSignal: controller.signal,
      },
      child,
      missingHealth,
    );
    controller.abort();

    await expect(waiting).rejects.toThrow(/startup cancelled/i);
    expect(child.terminate).toHaveBeenCalledOnce();
    expect(child.unref).not.toHaveBeenCalled();
  });

  it("unrefs the spawned child only after that child publishes healthy state", async () => {
    const child: RuntimeDaemonStartupProcess = {
      pid: 777,
      exit: new Promise(() => undefined),
      unref: vi.fn(),
      terminate: vi.fn(async () => undefined),
    };

    await expect(
      waitForHealthyDaemonStartup(paths, {}, child, healthy(777)),
    ).resolves.toMatchObject({ state: { pid: 777 } });
    expect(child.unref).toHaveBeenCalledOnce();
    expect(child.terminate).not.toHaveBeenCalled();
  });

  it("waits for ready state after the endpoint first becomes reachable", async () => {
    const child: RuntimeDaemonStartupProcess = {
      pid: 778,
      exit: new Promise(() => undefined),
      unref: vi.fn(),
      terminate: vi.fn(async () => undefined),
    };
    let healthChecks = 0;
    const startingThenReady = async () => {
      healthChecks += 1;
      const observation = await healthy(778)();
      return healthChecks === 1
        ? {
            ...observation,
            state: { ...observation.state, status: "starting" as const },
          }
        : observation;
    };

    await expect(
      waitForHealthyDaemonStartup(
        paths,
        {
          startupTimeoutMs: 1_000,
          pollIntervalMs: 1,
        },
        child,
        startingThenReady,
      ),
    ).resolves.toMatchObject({
      state: { pid: 778, status: "ready" },
    });
    expect(healthChecks).toBe(2);
    expect(child.unref).toHaveBeenCalledOnce();
    expect(child.terminate).not.toHaveBeenCalled();
  });

  it("waits for an existing healthy owner to publish ready without spawning a competitor", async () => {
    let healthChecks = 0;
    const starting = await healthy(779)();
    const observe = async () => {
      healthChecks += 1;
      return healthChecks === 1
        ? {
            ...starting,
            state: { ...starting.state, status: "starting" as const },
          }
        : healthy(779)();
    };

    await expect(
      waitForReadyRuntimeDaemonOwner(
        paths,
        {
          startupTimeoutMs: 1_000,
          pollIntervalMs: 1,
        },
        await observe(),
        observe,
      ),
    ).resolves.toMatchObject({
      state: { pid: 779, status: "ready" },
    });
    expect(healthChecks).toBe(2);
  });

  it("bounds and cancels waiting for an existing non-ready owner without terminating it", async () => {
    const starting = await healthy(780)();
    const initial = {
      ...starting,
      state: { ...starting.state, status: "starting" as const },
    };
    const observe = vi.fn(async () => initial);

    await expect(
      waitForReadyRuntimeDaemonOwner(
        paths,
        {
          startupTimeoutMs: 0,
        },
        initial,
        observe,
      ),
    ).rejects.toThrow(/timed out waiting/i);
    expect(observe).not.toHaveBeenCalled();

    const controller = new AbortController();
    const cancelled = waitForReadyRuntimeDaemonOwner(
      paths,
      {
        startupTimeoutMs: 60_000,
        pollIntervalMs: 1_000,
        startupSignal: controller.signal,
      },
      initial,
      observe,
    );
    controller.abort();
    await expect(cancelled).rejects.toThrow(/startup cancelled/i);
  });

  it("rejects a self-consistent replacement owner while waiting for the initial owner", async () => {
    const initialOwner = await healthy(781)();
    const initial = {
      ...initialOwner,
      state: { ...initialOwner.state, status: "starting" as const },
    };

    await expect(
      waitForReadyRuntimeDaemonOwner(
        paths,
        {
          startupTimeoutMs: 1_000,
          pollIntervalMs: 1,
        },
        initial,
        healthy(782),
      ),
    ).rejects.toMatchObject({
      reason: "identity_mismatch",
      message: expect.stringMatching(/owner identity changed/i),
    });
  });

  it("reclaims its spawned child when another daemon wins the startup race", async () => {
    const child: RuntimeDaemonStartupProcess = {
      pid: 888,
      exit: new Promise(() => undefined),
      unref: vi.fn(),
      terminate: vi.fn(async () => undefined),
    };

    let healthChecks = 0;
    const competingOwner = async () => {
      healthChecks += 1;
      const observation = await healthy(999)();
      return healthChecks === 1
        ? {
            ...observation,
            state: { ...observation.state, status: "starting" as const },
          }
        : observation;
    };

    await expect(
      waitForHealthyDaemonStartup(
        paths,
        {
          startupTimeoutMs: 1_000,
          pollIntervalMs: 1,
        },
        child,
        competingOwner,
      ),
    ).resolves.toMatchObject({ state: { pid: 999 } });
    expect(healthChecks).toBe(2);
    expect(child.terminate).toHaveBeenCalledOnce();
    expect(child.unref).not.toHaveBeenCalled();
  });

  it("accepts a competing startup child that exits during exact cleanup", async () => {
    const child: RuntimeDaemonStartupProcess = {
      pid: 889,
      exit: Promise.resolve({ code: 1, signal: null }),
      hasExited: vi.fn(() => false),
      unref: vi.fn(),
      terminate: vi.fn(async () => {
        throw new RuntimeDaemonProcessCleanupIncompleteError(889);
      }),
    };

    await expect(
      waitForHealthyDaemonStartup(paths, {}, child, healthy(999)),
    ).resolves.toMatchObject({ state: { pid: 999 } });
    expect(child.terminate).toHaveBeenCalledOnce();
    expect(child.unref).not.toHaveBeenCalled();
  });

  it("waits for the competing owner when its spawned child exits after losing the race", async () => {
    const configHome = mkdtempSync(
      path.join(os.tmpdir(), "kodax-daemon-startup-race-"),
    );
    const racePaths = resolveRuntimeDaemonPathsFromConfigHome(
      configHome,
      "race",
    );
    const winnerPid = 999;
    const lock = tryAcquireRuntimeDaemonLock(racePaths, {
      runtimeId: `runtime-${winnerPid}`,
      pid: winnerPid,
      createdAt: "2026-07-17T00:00:00.000Z",
      kind: "daemon",
    });
    expect(lock).toBeDefined();
    let reportExit:
      | ((exit: {
          readonly code: number | null;
          readonly signal: NodeJS.Signals | null;
        }) => void)
      | undefined;
    const child: RuntimeDaemonStartupProcess = {
      pid: 888,
      exit: new Promise((resolve) => {
        reportExit = resolve;
      }),
      hasExited: vi.fn(() => true),
      unref: vi.fn(),
      terminate: vi.fn(async () => undefined),
    };
    let healthChecks = 0;
    const competingHealth = async () => {
      healthChecks += 1;
      return healthChecks === 1 ? missingHealth() : healthy(winnerPid)();
    };

    try {
      const waiting = waitForHealthyDaemonStartup(
        racePaths,
        {
          startupTimeoutMs: 1_000,
          pollIntervalMs: 1,
        },
        child,
        competingHealth,
      );
      reportExit?.({ code: 1, signal: null });

      await expect(waiting).resolves.toMatchObject({
        state: { pid: winnerPid },
      });
      expect(child.terminate).not.toHaveBeenCalled();
      expect(child.unref).not.toHaveBeenCalled();
    } finally {
      rmSync(configHome, { recursive: true, force: true });
    }
  });

  it("allows a clean loser exit a bounded grace period for winner publication", async () => {
    const child: RuntimeDaemonStartupProcess = {
      pid: 888,
      exit: Promise.resolve({ code: 0, signal: null }),
      hasExited: vi.fn(() => true),
      unref: vi.fn(),
      terminate: vi.fn(async () => undefined),
    };
    let healthChecks = 0;
    const delayedWinner = async () => {
      healthChecks += 1;
      return healthChecks < 3 ? missingHealth() : healthy(999)();
    };

    await expect(
      waitForHealthyDaemonStartup(
        paths,
        {
          startupTimeoutMs: 1_000,
          pollIntervalMs: 1,
        },
        child,
        delayedWinner,
      ),
    ).resolves.toMatchObject({ state: { pid: 999 } });
    expect(healthChecks).toBeGreaterThanOrEqual(3);
    expect(child.terminate).not.toHaveBeenCalled();
    expect(child.unref).not.toHaveBeenCalled();
  });

  it("uses the same winner-publication grace when a clean loser exits between polls", async () => {
    let reportExit:
      | ((exit: {
          readonly code: number | null;
          readonly signal: NodeJS.Signals | null;
        }) => void)
      | undefined;
    const child: RuntimeDaemonStartupProcess = {
      pid: 888,
      exit: new Promise((resolve) => {
        reportExit = resolve;
      }),
      hasExited: vi.fn(() => true),
      unref: vi.fn(),
      terminate: vi.fn(async () => undefined),
    };
    let healthChecks = 0;
    const delayedWinner = async () => {
      healthChecks += 1;
      if (healthChecks === 1) {
        setTimeout(() => reportExit?.({ code: 0, signal: null }), 0);
        return missingHealth();
      }
      if (healthChecks === 2) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return missingHealth();
      }
      return healthy(999)();
    };

    await expect(
      waitForHealthyDaemonStartup(
        paths,
        {
          startupTimeoutMs: 1_000,
          pollIntervalMs: 100,
        },
        child,
        delayedWinner,
      ),
    ).resolves.toMatchObject({ state: { pid: 999 } });
    expect(healthChecks).toBeGreaterThanOrEqual(3);
    expect(child.terminate).not.toHaveBeenCalled();
    expect(child.unref).not.toHaveBeenCalled();
  });

  it("does not add a second poll delay before clean-exit publication grace", async () => {
    let reportExit:
      | ((exit: {
          readonly code: number | null;
          readonly signal: NodeJS.Signals | null;
        }) => void)
      | undefined;
    const child: RuntimeDaemonStartupProcess = {
      pid: 888,
      exit: new Promise((resolve) => {
        reportExit = resolve;
      }),
      hasExited: vi.fn(() => true),
      unref: vi.fn(),
      terminate: vi.fn(async () => undefined),
    };
    let healthChecks = 0;
    const missing = async () => {
      healthChecks += 1;
      if (healthChecks === 1) {
        setTimeout(() => reportExit?.({ code: 0, signal: null }), 0);
      }
      return missingHealth();
    };
    const startedAt = Date.now();

    await expect(
      waitForHealthyDaemonStartup(
        paths,
        { startupTimeoutMs: 200, pollIntervalMs: 1_000 },
        child,
        missing,
      ),
    ).rejects.toMatchObject({ reason: "child_exit" });
    expect(Date.now() - startedAt).toBeLessThan(350);
  });
});
