import { mkdtempSync, rmSync } from "node:fs";
import { ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
const { observe, spawn } = vi.hoisted(() => ({
  observe: vi.fn(),
  spawn: vi.fn(),
}));
vi.mock("./lifecycle.js", async (original) => ({
  ...(await original<typeof import("./lifecycle.js")>()),
  observeRuntimeDaemonHealth: observe,
}));
vi.mock("./windows-job-supervisor.js", async (original) => ({
  ...(await original<typeof import("./windows-job-supervisor.js")>()),
  spawnWindowsJobContainedProcess: spawn,
}));
import { acquireRuntimeDaemonProcessLease } from "./process.js";
import { WindowsJobStartupCleanupError } from "./windows-job-supervisor.js";

beforeEach(() => vi.resetAllMocks());

it("rejects a pre-cancelled admission without an unhandled background rejection", async () => {
  const configHome = mkdtempSync(
    path.join(os.tmpdir(), "kodax-admission-aborted-"),
  );
  try {
    await expect(
      acquireRuntimeDaemonProcessLease({
        configHome,
        startupSignal: AbortSignal.abort(),
      }),
    ).rejects.toMatchObject({ reason: "cancelled" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(observe).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  } finally {
    rmSync(configHome, { recursive: true, force: true });
  }
});

it.skipIf(process.platform !== "win32")(
  "waits for admitted startup cleanup before returning cancellation",
  async () => {
    const configHome = mkdtempSync(
      path.join(os.tmpdir(), "kodax-admission-cancel-cleanup-"),
    );
    const child = new ChildProcess();
    Object.defineProperty(child, "pid", { value: 12345 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const terminate = vi.fn(async () => {
      await gate;
      Object.defineProperty(child, "exitCode", { value: 0 });
      child.emit("exit", 0, null);
    });
    spawn.mockResolvedValue({
      supervisor: child,
      processPid: 12346,
      terminate,
      release: () => undefined,
    });
    observe.mockResolvedValue({
      state: undefined,
      pidAlive: false,
      reachable: false,
      identityMatches: false,
    });
    const controller = new AbortController();
    let settled = false;
    const result = acquireRuntimeDaemonProcessLease({
      configHome,
      startupSignal: controller.signal,
    })
      .catch((error) => error as unknown)
      .finally(() => {
        settled = true;
      });
    try {
      await vi.waitFor(() => expect(observe).toHaveBeenCalledTimes(2));
      controller.abort();
      await vi.waitFor(() => expect(terminate).toHaveBeenCalledTimes(1));
      expect(settled).toBe(false);
    } finally {
      release();
      expect(await result).toMatchObject({ reason: "cancelled" });
      rmSync(configHome, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform !== "win32").each(["timeout", "cancelled"] as const)(
  "settles a queued caller on %s without releasing the active admission or later spawning for that caller",
  async (reason) => {
    const configHome = mkdtempSync(
      path.join(os.tmpdir(), "kodax-admission-deadline-"),
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const missing = {
      state: undefined,
      pidAlive: false,
      reachable: false,
      identityMatches: false,
    };
    observe
      .mockImplementationOnce(async () => {
        await gate;
        return missing;
      })
      .mockResolvedValue(missing);
    spawn.mockRejectedValue(new Error("fixture spawn refusal"));
    const first = acquireRuntimeDaemonProcessLease({ configHome }).catch(
      (error) => error as unknown,
    );
    await vi.waitFor(() => expect(observe).toHaveBeenCalledTimes(1));
    let outcome: unknown;
    const controller = new AbortController();
    const queued = acquireRuntimeDaemonProcessLease({
      configHome,
      startupTimeoutMs: reason === "timeout" ? 25 : 60_000,
      startupSignal: controller.signal,
    }).catch((error) => {
      outcome = error;
    });
    if (reason === "cancelled") controller.abort();
    try {
      await vi.waitFor(
        () =>
          expect(outcome).toMatchObject({
            reason,
            retryable: reason === "timeout",
          }),
        { timeout: 500 },
      );
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      release();
      await Promise.all([first, queued]);
      rmSync(configHome, { recursive: true, force: true });
    }
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledTimes(1);
  },
);

it.skipIf(process.platform !== "win32")(
  "serializes simultaneous startup admission for the same slot",
  async () => {
    const configHome = mkdtempSync(path.join(os.tmpdir(), "kodax-admission-"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const missing = {
      state: undefined,
      pidAlive: false,
      reachable: false,
      identityMatches: false,
    };
    observe
      .mockImplementationOnce(async () => {
        await gate;
        return missing;
      })
      .mockResolvedValue(missing);
    spawn.mockRejectedValue(new Error("fixture spawn refusal"));
    const first = acquireRuntimeDaemonProcessLease({ configHome }).catch(
      (error) => error as unknown,
    );
    const second = acquireRuntimeDaemonProcessLease({ configHome }).catch(
      (error) => error as unknown,
    );
    try {
      await vi.waitFor(() => expect(observe).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(observe).toHaveBeenCalledTimes(1);
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      release();
      await Promise.all([first, second]);
      rmSync(configHome, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform !== "win32")(
  "retains readiness cleanup and blocks concurrent replacements until that handle settles",
  async () => {
    const configHome = mkdtempSync(
      path.join(os.tmpdir(), "kodax-readiness-cleanup-"),
    );
    let finishCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    const original = new Error("supervisor readiness failed");
    const cleanupFailure = new Error("supervisor exit not verified");
    const cleanup = vi
      .fn()
      .mockRejectedValueOnce(cleanupFailure)
      .mockImplementationOnce(() => cleanupGate);
    observe.mockResolvedValue({
      state: undefined,
      pidAlive: false,
      reachable: false,
      identityMatches: false,
    });
    spawn
      .mockRejectedValueOnce(
        new WindowsJobStartupCleanupError(original, cleanupFailure, cleanup),
      )
      .mockRejectedValue(new Error("replacement fixture refusal"));
    try {
      await expect(
        acquireRuntimeDaemonProcessLease({ configHome }),
      ).rejects.toMatchObject({
        code: "daemon_startup_failed",
        reason: "cleanup_incomplete",
        retryable: true,
        errors: [original, cleanupFailure],
      });
      await expect(
        acquireRuntimeDaemonProcessLease({ configHome }),
      ).rejects.toMatchObject({ reason: "cleanup_incomplete" });
      expect(spawn).toHaveBeenCalledTimes(1);
      const third = acquireRuntimeDaemonProcessLease({ configHome }).catch(
        (error) => error as unknown,
      );
      const fourth = acquireRuntimeDaemonProcessLease({ configHome }).catch(
        (error) => error as unknown,
      );
      await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(2));
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(observe).toHaveBeenCalledTimes(1);
      finishCleanup();
      await Promise.all([third, fourth]);
      expect(spawn).toHaveBeenCalledTimes(3);
      expect(cleanup).toHaveBeenCalledTimes(2);
    } finally {
      finishCleanup();
      rmSync(configHome, { recursive: true, force: true });
    }
  },
);
