import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createKodaXRuntime, type RuntimeEvent } from "./sdk-runtime.js";

/**
 * FEATURE_298 T26 — Runtime events are a live, in-process stream. They carry a
 * per-Session ordering seq for handoff and regression checks only; there is no
 * durable journal, no replay, no cursor epoch, and no on-disk event state.
 */
describe("Runtime Session live events (T26)", () => {
  const roots: string[] = [];
  const runtimes: Array<Awaited<ReturnType<typeof createKodaXRuntime>>> = [];

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
    await Promise.all(roots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true })
    ));
  });

  async function createRoot(): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kodax-live-events-"));
    roots.push(root);
    return root;
  }

  async function createRuntime(root: string) {
    const runtime = await createKodaXRuntime({ mode: "embedded", homeDir: root });
    runtimes.push(runtime);
    return runtime;
  }

  function runtimeDir(root: string): string {
    return path.join(root, ".kodax", "runtime");
  }

  async function pathExists(target: string): Promise<boolean> {
    try {
      await fs.access(target);
      return true;
    } catch {
      return false;
    }
  }

  async function collectEvents(
    runtime: Awaited<ReturnType<typeof createKodaXRuntime>>,
    sessionId: string,
  ): Promise<RuntimeEvent[]> {
    const events: RuntimeEvent[] = [];
    const subscription = runtime.events.subscribe({ sessionId }, (event) => {
      events.push(event);
    });
    await subscription.ready;
    await runtime.sessions.create({ sessionId });
    return events;
  }

  it("delivers live events with in-process monotonic seq and no durable cursor fields", async () => {
    const root = await createRoot();
    const runtime = await createRuntime(root);

    const events = await collectEvents(runtime, "session-live");

    expect(events.length).toBeGreaterThan(0);
    expect(events.map((event) => event.seq)).toEqual(
      events.map((_, index) => index + 1)
    );
    for (const event of events) {
      expect(event).not.toHaveProperty("cursor");
      expect(event).not.toHaveProperty("journalEpoch");
      expect(event.sessionId).toBe("session-live");
    }
  });

  it("allocates independent per-Session sequences within one runtime", async () => {
    const root = await createRoot();
    const runtime = await createRuntime(root);

    const first = await collectEvents(runtime, "session-a");
    const second = await collectEvents(runtime, "session-b");

    expect(first[0]?.seq).toBe(1);
    expect(second[0]?.seq).toBe(1);
  });

  it("writes no durable event state anywhere under the runtime home", async () => {
    const root = await createRoot();
    const runtime = await createRuntime(root);

    await runtime.sessions.create({ sessionId: "session-nodisk" });
    await runtime.sessions.create({ sessionId: "session-nodisk-2" });
    await runtime.sessions.delete("session-nodisk-2");

    const runtimeRoot = runtimeDir(root);
    expect(await pathExists(path.join(runtimeRoot, "session-events"))).toBe(false);

    const runsDir = path.join(runtimeRoot, "runs");
    if (await pathExists(runsDir)) {
      for (const entry of await fs.readdir(runsDir)) {
        const runDir = path.join(runsDir, entry);
        expect(await pathExists(path.join(runDir, "events.jsonl"))).toBe(false);
        expect(await pathExists(path.join(runDir, "event-journals.json"))).toBe(false);
        expect(await pathExists(path.join(runDir, "events.watermark"))).toBe(false);
      }
    }
  });

  it("observation snapshots expose a live seq high-water and strictly increasing live events", async () => {
    const root = await createRoot();
    const runtime = await createRuntime(root);
    await runtime.sessions.create({ sessionId: "session-observe" });

    const observed: RuntimeEvent[] = [];
    const observation = await runtime.sessions.observe(
      "session-observe",
      (event) => {
        observed.push(event);
      },
    );
    try {
      expect(observation.snapshot).not.toHaveProperty("cursor");
      expect(typeof observation.snapshot.seq).toBe("number");

      await runtime.sessions.appendNotice({
        sessionId: "session-observe",
        source: "test",
        content: "notice after snapshot",
      });

      expect(observed.length).toBeGreaterThan(0);
      for (const event of observed) {
        expect(event.seq).toBeGreaterThan(observation.snapshot.seq);
      }
      for (let index = 1; index < observed.length; index += 1) {
        expect(observed[index]!.seq).toBeGreaterThan(observed[index - 1]!.seq);
      }
    } finally {
      observation.close();
    }
  });

  it("invalidates live observations when a Session is deleted and recreated (T26)", async () => {
    const root = await createRoot();
    const runtime = await createRuntime(root);
    await runtime.sessions.create({ sessionId: "session-recycle" });

    const observation = await runtime.sessions.observe(
      "session-recycle",
      () => {},
    );
    try {
      await runtime.sessions.delete("session-recycle");
      await expect(observation.invalidated).resolves.toMatchObject({
        code: "observation_invalidated",
        reason: "runtime_changed",
      });

      const events = await collectEvents(runtime, "session-recycle");
      expect(events[0]?.seq).toBe(1);
    } finally {
      observation.close();
    }
  });
});
