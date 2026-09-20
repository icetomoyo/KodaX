import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { killChildProcessTreeMock } = vi.hoisted(() => ({
  killChildProcessTreeMock: vi.fn(),
}));

vi.mock("@kodax-ai/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@kodax-ai/agent")>()),
  killChildProcessTree: killChildProcessTreeMock,
}));

const {
  createRuntimeDaemonStartupProcess,
  RuntimeDaemonProcessCleanupIncompleteError,
} = await import("./process.js");

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    pid: 4_242,
    exitCode: 0,
    signalCode: null,
    unref: vi.fn(),
  });
  return child;
}

describe("Runtime daemon startup process cleanup", () => {
  it('detaches a committed Windows owner without waiting for its intentional persistence', async () => {
    const child = fakeChild();
    Object.assign(child, { exitCode: null });
    const release = vi.fn();
    const processHandle = createRuntimeDaemonStartupProcess(child,
      new Promise(() => undefined), 5_252, async () => 'retained' as const, release);
    await expect(processHandle.terminate()).resolves.toBe('retained');
    expect(release).toHaveBeenCalledOnce();
    expect(killChildProcessTreeMock).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    killChildProcessTreeMock.mockReset();
  });

  it("accepts an unknown tree result after the root has already exited", async () => {
    killChildProcessTreeMock.mockResolvedValue({ status: "unknown" });
    const processHandle = createRuntimeDaemonStartupProcess(
      fakeChild(),
      Promise.resolve({ code: 0, signal: null }),
    );

    await expect(processHandle.terminate()).resolves.toBeUndefined();
  });

  it("accepts a verified tree result after the root has exited", async () => {
    killChildProcessTreeMock.mockResolvedValue({ status: "terminated" });
    const processHandle = createRuntimeDaemonStartupProcess(
      fakeChild(),
      Promise.resolve({ code: 0, signal: null }),
    );

    await expect(processHandle.terminate()).resolves.toBeUndefined();
  });

  it("accepts an already-exited tree only after the exit promise is settled", async () => {
    killChildProcessTreeMock.mockResolvedValue({ status: "already-exited" });
    const processHandle = createRuntimeDaemonStartupProcess(
      fakeChild(),
      Promise.resolve({ code: 0, signal: null }),
    );

    await expect(processHandle.terminate()).resolves.toBeUndefined();
  });

  it("terminates a Windows Job supervisor directly instead of snapshotting its tree", async () => {
    const child = fakeChild();
    Object.assign(child, { exitCode: null });
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    const terminateContainedProcess = vi.fn(async () => {
      Object.assign(child, { exitCode: 1 });
      child.emit("exit", 1, null);
    });
    const processHandle = createRuntimeDaemonStartupProcess(
      child,
      exit,
      5_252,
      terminateContainedProcess,
    );

    await expect(processHandle.terminate()).resolves.toBeUndefined();
    expect(terminateContainedProcess).toHaveBeenCalledOnce();
    expect(killChildProcessTreeMock).not.toHaveBeenCalled();
  });

  it("releases a healthy Windows Job bootstrap control channel before unref", () => {
    const child = fakeChild();
    const releaseContainedProcess = vi.fn();
    const processHandle = createRuntimeDaemonStartupProcess(
      child,
      Promise.resolve({ code: 0, signal: null }),
      5_353,
      undefined,
      releaseContainedProcess,
    );

    processHandle.unref();
    expect(releaseContainedProcess).toHaveBeenCalledOnce();
    expect(child.unref).not.toHaveBeenCalled();
  });
});
