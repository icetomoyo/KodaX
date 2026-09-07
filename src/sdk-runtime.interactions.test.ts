import { describe, expect, it, vi } from "vitest";

import {
  connectKodaXRuntime,
  createKodaXRuntime,
  handleRuntimePermissionRequest,
  type CreateKodaXRuntimeOptions,
  type KodaXRuntime,
  type RuntimeEvent,
  type RuntimeEventListener,
  type RuntimePermissionRequest,
} from "./sdk-runtime.js";

function permissionRequest(
  overrides: Partial<RuntimePermissionRequest> = {},
): RuntimePermissionRequest {
  return {
    id: "perm-sdk-lifecycle",
    sessionId: "session-sdk-lifecycle",
    runId: "run-sdk-lifecycle",
    toolName: "bash",
    createdAt: "2026-08-17T00:00:00.000Z",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

function runtimeFixture(
  listPending?: () => Promise<readonly RuntimePermissionRequest[]>,
): {
  readonly runtime: KodaXRuntime;
  readonly respond: ReturnType<typeof vi.fn>;
  readonly emit: (event: RuntimeEvent) => void;
} {
  const listeners = new Set<RuntimeEventListener>();
  const respond = vi.fn(async () => true);
  return {
    runtime: {
      events: {
        subscribe: vi.fn((_filter, listener: RuntimeEventListener) => {
          listeners.add(listener);
          return { close: () => listeners.delete(listener) };
        }),
      },
      permissions: {
        respond,
        ...(listPending !== undefined ? { listPending } : {}),
      },
    } as unknown as KodaXRuntime,
    respond,
    emit: (event) => {
      for (const listener of listeners) listener(event);
    },
  };
}

function runtimeWithPendingSubscriptionReadiness(): {
  readonly runtime: KodaXRuntime;
  readonly respond: ReturnType<typeof vi.fn>;
} {
  const respond = vi.fn(async () => true);
  return {
    runtime: {
      events: {
        subscribe: vi.fn(() => ({
          ready: new Promise<void>(() => undefined),
          close: vi.fn(),
        })),
      },
      permissions: { respond },
    } as unknown as KodaXRuntime,
    respond,
  };
}

function resolvedEvent(
  request: RuntimePermissionRequest,
): RuntimeEvent {
  return {
    id: "event-permission-resolved",
    type: "permission.resolved",
    sessionId: request.sessionId,
    runId: request.runId,
    seq: 2,
    time: "2026-08-17T00:00:01.000Z",

    payload: {
      requestId: request.id,
      decision: {
        type: "reject",
        reason:
          "permission request timed out; choose a safer approach that does not require this approval",
        cause: "approval_timeout",
      },
    },
  };
}

describe("handleRuntimePermissionRequest", () => {
  it("aborts a host prompt when the Runtime resolves the request first", async () => {
    const fixture = runtimeFixture();
    const request = permissionRequest();
    let promptSignal: AbortSignal | undefined;
    const prompt = vi.fn((_request, context: { readonly signal: AbortSignal }) => {
      promptSignal = context.signal;
      return new Promise<never>(() => undefined);
    });

    const handling = handleRuntimePermissionRequest(
      fixture.runtime,
      request,
      prompt,
    );
    await Promise.resolve();
    fixture.emit(resolvedEvent(request));

    await expect(handling).resolves.toMatchObject({
      requestId: request.id,
      status: "already_resolved",
      decision: { type: "reject", cause: "approval_timeout" },
    });
    expect(promptSignal?.aborted).toBe(true);
    expect(fixture.respond).not.toHaveBeenCalled();
  });

  it("responds exactly once when the host prompt wins", async () => {
    const fixture = runtimeFixture();
    const request = permissionRequest();

    await expect(handleRuntimePermissionRequest(
      fixture.runtime,
      request,
      async () => ({ type: "allow_once" }),
    )).resolves.toEqual({
      requestId: request.id,
      status: "responded",
      decision: { type: "allow_once" },
    });
    expect(fixture.respond).toHaveBeenCalledOnce();
    expect(fixture.respond).toHaveBeenCalledWith(
      request.id,
      { type: "allow_once" },
      { runId: request.runId },
    );
  });

  it("returns the Runtime decision when another resolver wins during respond", async () => {
    const fixture = runtimeFixture();
    const request = permissionRequest();
    fixture.respond.mockImplementation(async () => {
      fixture.emit(resolvedEvent(request));
      return false;
    });

    await expect(handleRuntimePermissionRequest(
      fixture.runtime,
      request,
      async () => ({ type: "allow_once" }),
    )).resolves.toEqual({
      requestId: request.id,
      status: "already_resolved",
      decision: {
        type: "reject",
        reason:
          "permission request timed out; choose a safer approach that does not require this approval",
        cause: "approval_timeout",
      },
    });
  });

  it("never opens a prompt for an already-expired request", async () => {
    const fixture = runtimeFixture();
    const request = permissionRequest({
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const prompt = vi.fn(async () => ({ type: "allow_once" as const }));

    await expect(handleRuntimePermissionRequest(
      fixture.runtime,
      request,
      prompt,
    )).resolves.toMatchObject({
      status: "responded",
      decision: { type: "reject", cause: "approval_timeout" },
    });
    expect(prompt).not.toHaveBeenCalled();
  });

  it("does not open a stale prompt while the pending-state check is delayed", async () => {
    const fixture = runtimeFixture(
      () => new Promise<readonly RuntimePermissionRequest[]>(() => undefined),
    );
    const request = permissionRequest();
    const prompt = vi.fn(async () => ({ type: "allow_once" as const }));
    const handling = handleRuntimePermissionRequest(
      fixture.runtime,
      request,
      prompt,
    );
    await Promise.resolve();
    await Promise.resolve();

    fixture.emit(resolvedEvent(request));

    await expect(handling).resolves.toMatchObject({
      status: "already_resolved",
      decision: { type: "reject", cause: "approval_timeout" },
    });
    expect(prompt).not.toHaveBeenCalled();
    expect(fixture.respond).not.toHaveBeenCalled();
  });

  it("rejects safely when the pending-state check fails", async () => {
    const fixture = runtimeFixture(async () => {
      throw new Error("transport unavailable");
    });
    const request = permissionRequest();
    const prompt = vi.fn(async () => ({ type: "allow_once" as const }));

    await expect(handleRuntimePermissionRequest(
      fixture.runtime,
      request,
      prompt,
    )).resolves.toMatchObject({
      status: "responded",
      decision: {
        type: "reject",
        reason: expect.stringContaining("transport unavailable"),
      },
    });
    expect(prompt).not.toHaveBeenCalled();
    expect(fixture.respond).toHaveBeenCalledOnce();
  });

  it("rejects safely at expiresAt even when the host prompt ignores abort", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-17T00:00:00.000Z"));
    try {
      const fixture = runtimeFixture();
      const request = permissionRequest({
        expiresAt: "2026-08-17T00:01:00.000Z",
      });
      let promptSignal: AbortSignal | undefined;
      let markPromptStarted: (() => void) | undefined;
      const promptStarted = new Promise<void>((resolve) => {
        markPromptStarted = resolve;
      });
      const handling = handleRuntimePermissionRequest(
        fixture.runtime,
        request,
        async (_request, context) => {
          promptSignal = context.signal;
          markPromptStarted?.();
          return new Promise<never>(() => undefined);
        },
      );
      await promptStarted;

      await vi.advanceTimersByTimeAsync(60_000);

      await expect(handling).resolves.toEqual({
        requestId: request.id,
        status: "responded",
        decision: {
          type: "reject",
          reason:
            "permission request timed out; choose a safer approach that does not require this approval",
          cause: "approval_timeout",
        },
      });
      expect(promptSignal?.aborted).toBe(true);
      expect(fixture.respond).toHaveBeenCalledWith(
        request.id,
        {
          type: "reject",
          reason:
            "permission request timed out; choose a safer approach that does not require this approval",
          cause: "approval_timeout",
        },
        { runId: request.runId },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a prompt answer that crosses expiresAt before its timer runs", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-17T00:00:00.000Z"));
    try {
      const fixture = runtimeFixture();
      const request = permissionRequest({
        expiresAt: "2026-08-17T00:01:00.000Z",
      });
      let resolvePrompt: ((decision: { readonly type: "allow_once" }) => void)
        | undefined;
      let promptSignal: AbortSignal | undefined;
      let markPromptStarted: (() => void) | undefined;
      const promptStarted = new Promise<void>((resolve) => {
        markPromptStarted = resolve;
      });
      const handling = handleRuntimePermissionRequest(
        fixture.runtime,
        request,
        (_request, context) => {
          promptSignal = context.signal;
          markPromptStarted?.();
          return new Promise((resolve) => {
            resolvePrompt = resolve;
          });
        },
      );
      await promptStarted;

      vi.setSystemTime(new Date("2026-08-17T00:01:01.000Z"));
      resolvePrompt?.({ type: "allow_once" });

      await expect(handling).resolves.toMatchObject({
        status: "responded",
        decision: { type: "reject", cause: "approval_timeout" },
      });
      expect(promptSignal?.aborted).toBe(true);
      expect(fixture.respond).toHaveBeenCalledWith(
        request.id,
        expect.objectContaining({ type: "reject", cause: "approval_timeout" }),
        { runId: request.runId },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let stalled subscription readiness outlive expiresAt", async () => {
    const fixture = runtimeWithPendingSubscriptionReadiness();
    const request = permissionRequest({
      expiresAt: new Date(Date.now() + 5).toISOString(),
    });
    const prompt = vi.fn(async () => ({ type: "allow_once" as const }));

    await expect(handleRuntimePermissionRequest(
      fixture.runtime,
      request,
      prompt,
    )).resolves.toMatchObject({
      status: "responded",
      decision: { type: "reject", cause: "approval_timeout" },
    });
    expect(prompt).not.toHaveBeenCalled();
    expect(fixture.respond).toHaveBeenCalledOnce();
  });
});

describe("Runtime user-input timeout validation", () => {
  it("rejects invalid values before embedded or daemon startup", async () => {
    const modes: readonly CreateKodaXRuntimeOptions[] = [
      {},
      { mode: "daemon", autoStartDaemon: false },
    ];
    const invalidTimeouts = [
      0,
      -1,
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      2_147_483_648,
    ];
    for (const mode of modes) {
      for (const timeoutMs of invalidTimeouts) {
        await expect(createKodaXRuntime({
          ...mode,
          userInputTimeoutMs: timeoutMs,
        })).rejects.toThrow("userInputTimeoutMs must be a positive integer no greater than 2147483647.");
        if (timeoutMs !== 0) {
          await expect(createKodaXRuntime({
            ...mode,
            permissionTimeoutMs: timeoutMs,
          })).rejects.toThrow("permissionTimeoutMs must be a non-negative integer no greater than 2147483647.");
        }
      }
    }
  });

  it("rejects an invalid value before a direct daemon connection", async () => {
    await expect(connectKodaXRuntime({
      userInputTimeoutMs: Number.NaN,
    })).rejects.toThrow("userInputTimeoutMs must be a positive integer no greater than 2147483647.");
    await expect(connectKodaXRuntime({
      permissionTimeoutMs: 2_147_483_648,
    })).rejects.toThrow("permissionTimeoutMs must be a non-negative integer no greater than 2147483647.");
  });
});
