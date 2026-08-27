import fs from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { setKodaXDiagnosticSink, type KodaXDiagnostic } from "@kodax-ai/agent";
import { FileSessionStorage } from "@kodax-ai/repl";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createKodaXRuntime } from "./sdk-runtime.js";

describe("Runtime Session event journals", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true })
    ));
  });

  async function createRoot(): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kodax-session-events-"));
    roots.push(root);
    return root;
  }

  function sessionEventDir(root: string, sessionId: string): string {
    return path.join(
      root,
      ".kodax",
      "runtime",
      "session-events",
      Buffer.from(sessionId, "utf8").toString("base64url") || "_",
    );
  }

  function windowsPowerShell(): string {
    return path.join(
      process.env.SystemRoot ?? String.raw`C:\Windows`,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
  }

  it("allocates independent monotonic sequences for different Sessions sharing one home", async () => {
    const root = await createRoot();
    const first = await createKodaXRuntime({ mode: "embedded", homeDir: root });
    const second = await createKodaXRuntime({ mode: "embedded", homeDir: root });

    try {
      await first.sessions.create({ sessionId: "session-first" });
      await second.sessions.create({ sessionId: "session-second" });

      const firstEvents = await first.events.replay({ sessionId: "session-first" });
      const secondEvents = await second.events.replay({ sessionId: "session-second" });

      expect(firstEvents.map((event) => event.seq)).toEqual([1]);
      expect(secondEvents.map((event) => event.seq)).toEqual([1]);
      expect(firstEvents[0]?.cursor).toMatchObject({
        sessionId: "session-first",
        seq: 1,
      });
      expect(secondEvents[0]?.cursor).toMatchObject({
        sessionId: "session-second",
        seq: 1,
      });
      await expect(
        fs.stat(path.join(root, ".kodax", "runtime", "event-sequence")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it("rejects a replay cursor from another Session", async () => {
    const root = await createRoot();
    const runtime = await createKodaXRuntime({ mode: "embedded", homeDir: root });

    try {
      await runtime.sessions.create({ sessionId: "session-first" });
      await runtime.sessions.create({ sessionId: "session-second" });
      const [event] = await runtime.events.replay({ sessionId: "session-first" });

      await expect(runtime.events.replay({
        sessionId: "session-second",
        after: event?.cursor,
      })).rejects.toMatchObject({ code: "resync_required" });
    } finally {
      await runtime.close();
    }
  });

  it("rejects a replay cursor ahead of the current Session journal", async () => {
    const root = await createRoot();
    const runtime = await createKodaXRuntime({ mode: "embedded", homeDir: root });

    try {
      await runtime.sessions.create({ sessionId: "session-ahead" });
      const [event] = await runtime.events.replay({ sessionId: "session-ahead" });
      if (event === undefined) throw new Error("Session creation event missing");

      await expect(runtime.events.replay({
        sessionId: "session-ahead",
        after: { ...event.cursor, seq: event.cursor.seq + 1 },
      })).rejects.toMatchObject({ code: "resync_required" });
    } finally {
      await runtime.close();
    }
  });

  it("rejects unscoped public event access", async () => {
    const root = await createRoot();
    const runtime = await createKodaXRuntime({ mode: "embedded", homeDir: root });

    try {
      const replayUnscoped = runtime.events.replay as unknown as () => Promise<unknown>;
      const subscribeUnscoped = runtime.events.subscribe as unknown as (
        filter: Readonly<Record<string, never>>,
        listener: () => void,
      ) => unknown;
      await expect(replayUnscoped()).rejects.toMatchObject({
        code: "invalid_argument",
      });
      await expect((runtime.events.replay as unknown as (
        filter: { readonly sessionId: string },
      ) => Promise<unknown>)({ sessionId: "" })).rejects.toMatchObject({
        code: "invalid_argument",
      });
      expect(() => subscribeUnscoped({}, () => undefined)).toThrow(
        "must specify a Session or Run scope",
      );
    } finally {
      await runtime.close();
    }
  });

  it("continues one Session journal across Runtime recreation", async () => {
    const root = await createRoot();
    const first = await createKodaXRuntime({ mode: "embedded", homeDir: root });
    await first.sessions.create({ sessionId: "session-stable" });
    const [created] = await first.events.replay({ sessionId: "session-stable" });
    await first.close();

    const second = await createKodaXRuntime({ mode: "embedded", homeDir: root });
    try {
      await second.sessions.updateSettings("session-stable", { permissionMode: "plan" });
      const events = await second.events.replay({
        sessionId: "session-stable",
        after: created?.cursor,
      });

      expect(events.map((event) => event.seq)).toEqual([2]);
      expect(events[0]?.cursor?.journalEpoch).toBe(created?.cursor?.journalEpoch);
    } finally {
      await second.close();
    }
  });

  it("pages forward after a cursor while preserving latest-event replay without one", async () => {
    const root = await createRoot();
    const sessionId = "session-pagination";
    const runtime = await createKodaXRuntime({ mode: "embedded", homeDir: root });

    try {
      await runtime.sessions.create({ sessionId });
      await runtime.sessions.updateSettings(sessionId, { provider: "provider-1" });
      await runtime.sessions.updateSettings(sessionId, { model: "model-1" });
      await runtime.sessions.updateSettings(sessionId, { thinking: true });
      const all = await runtime.events.replay({ sessionId });
      const first = all[0];
      if (first === undefined) throw new Error("Session creation event missing");

      await expect(runtime.events.replay({
        sessionId,
        after: first.cursor,
        limit: 2,
      })).resolves.toMatchObject([{ seq: 2 }, { seq: 3 }]);
      await expect(runtime.events.replay({ sessionId, limit: 2 }))
        .resolves.toMatchObject([{ seq: 3 }, { seq: 4 }]);
    } finally {
      await runtime.close();
    }
  });

  it("rejects non-positive or non-integer replay limits", async () => {
    const root = await createRoot();
    const runtime = await createKodaXRuntime({ mode: "embedded", homeDir: root });

    try {
      await runtime.sessions.create({ sessionId: "session-invalid-limit" });
      const replay = runtime.events.replay as unknown as (
        filter: Readonly<Record<string, unknown>>,
      ) => Promise<unknown>;
      for (const limit of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
        await expect(replay({
          sessionId: "session-invalid-limit",
          limit,
        })).rejects.toMatchObject({ code: "invalid_argument" });
      }
    } finally {
      await runtime.close();
    }
  });

  it("excludes an earlier journal epoch from a fresh Session replay", async () => {
    const root = await createRoot();
    const runtime = await createKodaXRuntime({ mode: "embedded", homeDir: root });

    try {
      await runtime.sessions.create({ sessionId: "session-epoch" });
      const [oldEvent] = await runtime.events.replay({
        sessionId: "session-epoch",
      });
      const journalFile = path.join(
        root,
        ".kodax",
        "runtime",
        "session-events",
        Buffer.from("session-epoch", "utf8").toString("base64url"),
        "journal.json",
      );
      await fs.writeFile(journalFile, JSON.stringify({
        version: 1,
        sessionId: "session-epoch",
        journalEpoch: "replacement-epoch",
      }), "utf8");

      await expect(runtime.events.replay({
        sessionId: "session-epoch",
        after: oldEvent?.cursor,
      })).rejects.toMatchObject({ code: "resync_required" });
      expect(await runtime.events.replay({ sessionId: "session-epoch" }))
        .toEqual([]);

      await runtime.sessions.updateSettings("session-epoch", {
        permissionMode: "plan",
      });
      const events = await runtime.events.replay({
        sessionId: "session-epoch",
      });
      expect(events.map((event) => event.cursor.journalEpoch))
        .toEqual(["replacement-epoch"]);
    } finally {
      await runtime.close();
    }
  });

  it("reports corrupt aggregate replay metadata without widening the failure domain", async () => {
    const root = await createRoot();
    const sessionId = "session-aggregate-warning";
    const runtime = await createKodaXRuntime({ mode: "embedded", homeDir: root });
    const diagnostics: KodaXDiagnostic[] = [];
    const restoreDiagnosticSink = setKodaXDiagnosticSink((diagnostic) => {
      diagnostics.push(diagnostic);
    });

    try {
      await runtime.sessions.create({ sessionId });
      const runDir = path.join(root, ".kodax", "runtime", "runs", sessionId);
      await fs.mkdir(runDir, { recursive: true });
      await fs.writeFile(path.join(runDir, "status.json"), "{bad status", "utf8");

      await expect(runtime.diagnostics.latestContextBudget({
        sessionId,
        contextKind: "child",
      })).resolves.toBeNull();

      await fs.writeFile(
        path.join(sessionEventDir(root, sessionId), "journal.json"),
        "{bad journal",
        "utf8",
      );
      await expect(runtime.diagnostics.latestContextBudget({
        sessionId,
        contextKind: "child",
      })).resolves.toBeNull();

      expect(diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          source: "runtime.persistence",
          level: "warn",
          message: expect.stringMatching(/Runtime status.*aggregate event replay/i),
        }),
        expect.objectContaining({
          source: "runtime.persistence",
          level: "warn",
          message: expect.stringMatching(/active Session event journal metadata/i),
        }),
      ]));
    } finally {
      restoreDiagnosticSink();
      await runtime.close();
    }
  });

  it("does not report valid retired Session journal metadata as corrupt", async () => {
    const root = await createRoot();
    const sessionId = "session-retired-journal";
    const runtime = await createKodaXRuntime({ mode: "embedded", homeDir: root });
    const diagnostics: KodaXDiagnostic[] = [];
    const restoreDiagnosticSink = setKodaXDiagnosticSink((diagnostic) => {
      diagnostics.push(diagnostic);
    });

    try {
      await runtime.sessions.create({ sessionId });
      await runtime.sessions.delete(sessionId);
      await expect(runtime.diagnostics.latestContextBudget({
        sessionId,
        contextKind: "child",
      })).resolves.toBeNull();
      expect(diagnostics).not.toContainEqual(expect.objectContaining({
        message: expect.stringMatching(/active Session event journal metadata/i),
      }));
    } finally {
      restoreDiagnosticSink();
      await runtime.close();
    }
  });

  it("does not let another Session lock block event commits", async () => {
    const root = await createRoot();
    const blockedDir = sessionEventDir(root, "session-blocked");
    await fs.mkdir(blockedDir, { recursive: true });
    await fs.writeFile(path.join(blockedDir, "sequence.lock"), "occupied", "utf8");
    const runtime = await createKodaXRuntime({ mode: "embedded", homeDir: root });

    try {
      await runtime.sessions.create({ sessionId: "session-independent" });
      const events = await runtime.events.replay({
        sessionId: "session-independent",
      });
      expect(events.map((event) => event.seq)).toEqual([1]);
    } finally {
      await runtime.close();
    }
  });

  it("lets concurrent Node processes commit different Session journals", async () => {
    const root = await createRoot();
    const runtimeModuleUrl = new URL("./sdk-runtime.ts", import.meta.url).href;
    const runChild = (sessionId: string, peerSessionId: string): Promise<unknown> => {
      const script = `
        import fs from "node:fs/promises";
        import path from "node:path";
        import { createKodaXRuntime } from ${JSON.stringify(runtimeModuleUrl)};
        const root = ${JSON.stringify(root)};
        const sessionId = ${JSON.stringify(sessionId)};
        const peerSessionId = ${JSON.stringify(peerSessionId)};
        const barrierDir = path.join(root, "barrier");
        await fs.mkdir(barrierDir, { recursive: true });
        await fs.writeFile(path.join(barrierDir, sessionId), "ready", "utf8");
        const deadline = Date.now() + 10_000;
        while (true) {
          try {
            await fs.stat(path.join(barrierDir, peerSessionId));
            break;
          } catch (error) {
            if (Date.now() >= deadline) throw error;
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        }
        const runtime = await createKodaXRuntime({
          mode: "embedded",
          homeDir: root,
          sessionsDir: path.join(root, "sessions", sessionId),
        });
        try {
          await runtime.sessions.create({ sessionId });
          const events = await runtime.events.replay({ sessionId });
          process.stdout.write(JSON.stringify(events.map((event) => ({
            seq: event.seq,
            cursor: event.cursor,
          }))));
        } finally {
          await runtime.close();
        }
      `;
      return new Promise((resolve, reject) => {
        execFile(
          process.execPath,
          ["--import", "tsx", "--input-type=module", "--eval", script],
          { cwd: process.cwd() },
          (error, stdout, stderr) => {
            if (error) {
              reject(new Error(stderr || error.message, { cause: error }));
              return;
            }
            resolve(JSON.parse(stdout));
          },
        );
      });
    };

    const [first, second] = await Promise.all([
      runChild("process-session-first", "process-session-second"),
      runChild("process-session-second", "process-session-first"),
    ]);

    expect(first).toEqual([{
      seq: 1,
      cursor: expect.objectContaining({ sessionId: "process-session-first", seq: 1 }),
    }]);
    expect(second).toEqual([{
      seq: 1,
      cursor: expect.objectContaining({ sessionId: "process-session-second", seq: 1 }),
    }]);
  }, 30_000);

  it.runIf(process.platform === "win32")(
    "updates a Session cursor while another process opens it without delete sharing",
    async () => {
      const root = await createRoot();
      const sessionId = "windows-sequence-share-delete";
      const runtime = await createKodaXRuntime({ mode: "embedded", homeDir: root });
      const sequence = path.join(sessionEventDir(root, sessionId), "sequence");
      const ready = path.join(root, "sequence-holder.ready");
      const stop = path.join(root, "sequence-holder.stop");
      const holderScript = String.raw`
$ErrorActionPreference = 'Stop'
$stream = [IO.File]::Open(
  $env:KODAX_SEQUENCE_TEST_PATH,
  [IO.FileMode]::Open,
  [IO.FileAccess]::ReadWrite,
  [IO.FileShare]::ReadWrite
)
try {
  [IO.File]::WriteAllText($env:KODAX_SEQUENCE_TEST_READY, 'ready')
  while (-not [IO.File]::Exists($env:KODAX_SEQUENCE_TEST_STOP)) {
    Start-Sleep -Milliseconds 10
  }
} finally {
  $stream.Dispose()
}
`;
      let stderr = "";
      let holder: ReturnType<typeof spawn> | undefined;
      let holderCompletion: Promise<number | null> | undefined;
      try {
        await runtime.sessions.create({ sessionId });
        holder = spawn(windowsPowerShell(), [
          "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
          "-EncodedCommand", Buffer.from(holderScript, "utf16le").toString("base64"),
        ], {
          env: {
            ...process.env,
            KODAX_SEQUENCE_TEST_PATH: sequence,
            KODAX_SEQUENCE_TEST_READY: ready,
            KODAX_SEQUENCE_TEST_STOP: stop,
          },
          stdio: ["ignore", "ignore", "pipe"],
          windowsHide: true,
        });
        holder.stderr?.on("data", (chunk: Buffer | string) => {
          stderr += chunk.toString();
        });
        holderCompletion = new Promise((resolve) => holder?.once("exit", resolve));
        await vi.waitFor(() => expect(fs.stat(ready)).resolves.toBeDefined(), {
          timeout: 10_000,
          interval: 10,
        });

        await expect(runtime.sessions.updateSettings(sessionId, {
          permissionMode: "plan",
        })).resolves.toMatchObject({ permissionMode: "plan" });
        await expect(runtime.events.replay({ sessionId })).resolves.toHaveLength(2);
      } finally {
        await fs.writeFile(stop, "stop", "utf8").catch(() => undefined);
        const code = await holderCompletion;
        if (holder !== undefined && code !== 0) {
          throw new Error(`Windows sequence-holder failed with ${String(code)}: ${stderr}`);
        }
        await runtime.close();
      }
    },
    30_000,
  );

  it.runIf(process.platform === "win32")(
    "retries a Session cursor write while a non-sharing reader exits",
    async () => {
      const root = await createRoot();
      const sessionId = "windows-sequence-transient-reader";
      const runtime = await createKodaXRuntime({ mode: "embedded", homeDir: root });
      const sequence = path.join(sessionEventDir(root, sessionId), "sequence");
      const ready = path.join(root, "sequence-reader.ready");
      const holderScript = String.raw`
$ErrorActionPreference = 'Stop'
$stream = [IO.File]::Open(
  $env:KODAX_SEQUENCE_TEST_PATH,
  [IO.FileMode]::Open,
  [IO.FileAccess]::Read,
  [IO.FileShare]::Read
)
try {
  [IO.File]::WriteAllText($env:KODAX_SEQUENCE_TEST_READY, 'ready')
  Start-Sleep -Milliseconds 250
} finally {
  $stream.Dispose()
}
`;
      let stderr = "";
      let holder: ReturnType<typeof spawn> | undefined;
      let holderCompletion: Promise<number | null> | undefined;
      try {
        await runtime.sessions.create({ sessionId });
        holder = spawn(windowsPowerShell(), [
          "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
          "-EncodedCommand", Buffer.from(holderScript, "utf16le").toString("base64"),
        ], {
          env: {
            ...process.env,
            KODAX_SEQUENCE_TEST_PATH: sequence,
            KODAX_SEQUENCE_TEST_READY: ready,
          },
          stdio: ["ignore", "ignore", "pipe"],
          windowsHide: true,
        });
        holder.stderr?.on("data", (chunk: Buffer | string) => {
          stderr += chunk.toString();
        });
        holderCompletion = new Promise((resolve) => holder?.once("exit", resolve));
        await vi.waitFor(() => expect(fs.stat(ready)).resolves.toBeDefined(), {
          timeout: 10_000,
          interval: 10,
        });

        await expect(runtime.sessions.updateSettings(sessionId, {
          permissionMode: "plan",
        })).resolves.toMatchObject({ permissionMode: "plan" });
        await expect(runtime.events.replay({ sessionId })).resolves.toHaveLength(2);
      } finally {
        const code = await holderCompletion;
        if (holder !== undefined && code !== 0) {
          throw new Error(`Windows sequence reader failed with ${String(code)}: ${stderr}`);
        }
        await runtime.close();
      }
    },
    30_000,
  );

  it("recovers a truncated Session cursor from the durable event ledgers", async () => {
    const root = await createRoot();
    const sessionId = "truncated-sequence-recovery";
    const first = await createKodaXRuntime({ mode: "embedded", homeDir: root });
    try {
      await first.sessions.create({ sessionId });
      await first.sessions.updateSettings(sessionId, { permissionMode: "plan" });
      await expect(first.events.replay({ sessionId })).resolves.toHaveLength(2);
    } finally {
      await first.close();
    }

    await fs.writeFile(
      path.join(sessionEventDir(root, sessionId), "sequence"),
      "",
      "utf8",
    );
    const recovered = await createKodaXRuntime({ mode: "embedded", homeDir: root });
    try {
      await recovered.sessions.updateSettings(sessionId, { permissionMode: "auto" });
      const events = await recovered.events.replay({ sessionId });
      expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);
    } finally {
      await recovered.close();
    }
  });

  it("starts a fresh Session journal instead of importing legacy global sequences", async () => {
    const root = await createRoot();
    const runtimeDir = path.join(root, ".kodax", "runtime");
    const legacyRunDir = path.join(runtimeDir, "runs", "legacy-run");
    await fs.mkdir(legacyRunDir, { recursive: true });
    await fs.writeFile(path.join(runtimeDir, "event-sequence"), "999\n", "utf8");
    await fs.writeFile(
      path.join(legacyRunDir, "events.jsonl"),
      `${JSON.stringify({
        id: "legacy-event",
        seq: 999,
        time: new Date(0).toISOString(),
        sessionId: "session-migrated",
        runId: "legacy-run",
        type: "run.progress",
        payload: {},
      })}\n`,
      "utf8",
    );
    const runtime = await createKodaXRuntime({ mode: "embedded", homeDir: root });

    try {
      await runtime.sessions.create({ sessionId: "session-migrated" });
      const events = await runtime.events.replay({ sessionId: "session-migrated" });
      expect(events.map((event) => event.seq)).toEqual([1]);
      expect(events[0]?.cursor.journalEpoch).not.toBe("legacy");
    } finally {
      await runtime.close();
    }
  });

  it("uses unambiguous journal directories for Windows-normalized Session IDs", async () => {
    const root = await createRoot();
    const runtime = await createKodaXRuntime({ mode: "embedded", homeDir: root });

    try {
      await runtime.sessions.create({ sessionId: "normalized-session" });
      await runtime.sessions.create({ sessionId: "normalized-session." });

      const first = await runtime.events.replay({
        sessionId: "normalized-session",
      });
      const second = await runtime.events.replay({
        sessionId: "normalized-session.",
      });
      expect(first.map((event) => event.seq)).toEqual([1]);
      expect(second.map((event) => event.seq)).toEqual([1]);
      expect(sessionEventDir(root, "normalized-session")).not.toBe(
        sessionEventDir(root, "normalized-session."),
      );
      await expect(fs.stat(sessionEventDir(root, "normalized-session")))
        .resolves.toBeDefined();
      await expect(fs.stat(sessionEventDir(root, "normalized-session.")))
        .resolves.toBeDefined();
    } finally {
      await runtime.close();
    }
  });

  it("isolates a timed-out Session queue from healthy Session commits", async () => {
    const root = await createRoot();
    const blockedDir = sessionEventDir(root, "session-timeout");
    const lockFile = path.join(blockedDir, "sequence.lock");
    await fs.mkdir(blockedDir, { recursive: true });
    await fs.writeFile(lockFile, "occupied", "utf8");
    const runtime = await createKodaXRuntime({ mode: "embedded", homeDir: root });

    try {
      await runtime.sessions.create({ sessionId: "session-timeout" });
      await expect(runtime.events.replay({ sessionId: "session-timeout" }))
        .rejects.toMatchObject({ lockFile });

      await runtime.sessions.create({ sessionId: "session-healthy" });
      await expect(runtime.events.replay({ sessionId: "session-healthy" }))
        .resolves.toEqual([
          expect.objectContaining({ sessionId: "session-healthy", seq: 1 }),
        ]);
      const subscription = runtime.events.subscribe(
        { sessionId: "session-healthy" },
        () => undefined,
      );
      const closeStartedAt = Date.now();
      subscription.close();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(Date.now() - closeStartedAt).toBeLessThan(1_000);
    } finally {
      await fs.rm(lockFile, { force: true });
      await runtime.close();
    }
  }, 15_000);

  it("rotates the journal epoch when a Session ID is deleted and recreated", async () => {
    const root = await createRoot();
    const runtime = await createKodaXRuntime({ mode: "embedded", homeDir: root });

    try {
      await runtime.sessions.create({ sessionId: "session-recreated" });
      const [beforeDelete] = await runtime.events.replay({
        sessionId: "session-recreated",
      });
      await runtime.sessions.delete("session-recreated");
      await runtime.sessions.create({ sessionId: "session-recreated" });
      const fresh = await runtime.events.replay({
        sessionId: "session-recreated",
      });

      expect(fresh.map((event) => event.seq)).toEqual([1]);
      expect(fresh[0]?.cursor.journalEpoch).not.toBe(
        beforeDelete?.cursor.journalEpoch,
      );
      await expect(runtime.events.replay({
        sessionId: "session-recreated",
        after: beforeDelete?.cursor,
      })).rejects.toMatchObject({ code: "resync_required" });
    } finally {
      await runtime.close();
    }
  });

  it("does not delete or recreate a Session when journal retirement or preparation cannot lock", async () => {
    const root = await createRoot();
    const sessionId = "session-lifecycle-lock";
    const lockFile = path.join(sessionEventDir(root, sessionId), "sequence.lock");
    const runtime = await createKodaXRuntime({ mode: "embedded", homeDir: root });

    try {
      await runtime.sessions.create({ sessionId });
      await fs.writeFile(lockFile, "occupied", "utf8");
      await expect(runtime.sessions.delete(sessionId)).rejects.toMatchObject({
        lockFile,
      });
      await expect(runtime.sessions.load(sessionId)).resolves.toMatchObject({
        id: sessionId,
      });

      await fs.rm(lockFile, { force: true });
      await runtime.sessions.delete(sessionId);
      await fs.writeFile(lockFile, "occupied", "utf8");
      await expect(runtime.sessions.create({ sessionId })).rejects.toMatchObject({
        lockFile,
      });
      await expect(runtime.sessions.load(sessionId)).rejects.toThrow(
        `Session not found: ${sessionId}`,
      );

      await fs.rm(lockFile, { force: true });
      await runtime.sessions.create({ sessionId });
      await expect(runtime.events.replay({ sessionId })).resolves.toEqual([
        expect.objectContaining({ sessionId, seq: 1 }),
      ]);
    } finally {
      await fs.rm(lockFile, { force: true });
      await runtime.close();
    }
  }, 30_000);

  it("restores an active journal when Session storage deletion fails", async () => {
    const root = await createRoot();
    const sessionId = "session-delete-rollback";
    const runtime = await createKodaXRuntime({ mode: "embedded", homeDir: root });
    const deleteOwned = vi.spyOn(FileSessionStorage.prototype, "deleteOwned")
      .mockRejectedValueOnce(new Error("synthetic storage deletion failure"));

    try {
      await runtime.sessions.create({ sessionId });
      const [created] = await runtime.events.replay({ sessionId });
      await expect(runtime.sessions.delete(sessionId)).rejects.toMatchObject({
        code: "session_delete_failed",
      });
      deleteOwned.mockRestore();

      await runtime.sessions.updateSettings(sessionId, { permissionMode: "plan" });
      const replay = await runtime.events.replay({ sessionId });
      expect(replay.map((event) => event.seq)).toEqual([1, 2]);
      expect(replay.every((event) => (
        event.cursor.journalEpoch === created?.cursor.journalEpoch
      ))).toBe(true);
    } finally {
      deleteOwned.mockRestore();
      await runtime.close();
    }
  });

  it("resolves run-only event scopes to their owning Session", async () => {
    const root = await createRoot();
    const runtime = await createKodaXRuntime({ mode: "embedded", homeDir: root });

    try {
      const session = await runtime.sessions.create({ sessionId: "run-owner" });
      await expect(runtime.events.replay({ runId: session.id })).resolves.toEqual([
        expect.objectContaining({ sessionId: session.id, runId: session.id }),
      ]);
      await expect(runtime.events.replay({ runId: "missing-run" }))
        .rejects.toMatchObject({ code: "invalid_argument" });
      expect(() => runtime.events.subscribe(
        { runId: "missing-run" },
        () => undefined,
      )).toThrow("Runtime event Run was not found");
    } finally {
      await runtime.close();
    }
  });

  it("rejects malformed embedded replay cursors", async () => {
    const root = await createRoot();
    const runtime = await createKodaXRuntime({ mode: "embedded", homeDir: root });

    try {
      await runtime.sessions.create({ sessionId: "session-cursor-shape" });
      const replay = runtime.events.replay as unknown as (
        filter: Readonly<Record<string, unknown>>,
      ) => Promise<unknown>;
      for (const seq of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
        await expect(replay({
          sessionId: "session-cursor-shape",
          after: {
            sessionId: "session-cursor-shape",
            journalEpoch: "epoch",
            seq,
          },
        })).rejects.toMatchObject({ code: "invalid_argument" });
      }
      await expect(replay({
        sessionId: "session-cursor-shape",
        after: { sessionId: "session-cursor-shape", seq: 0 },
      })).rejects.toMatchObject({ code: "invalid_argument" });
    } finally {
      await runtime.close();
    }
  });
});
