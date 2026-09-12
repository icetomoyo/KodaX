/**
 * FEATURE_159 v0.7.40 — MessageQueue as single source of truth.
 *
 * Pre-FEATURE_159 (v0.7.36 FEATURE_115 Phase 1B): React `pendingInputs`
 * was canonical; manager methods drained + re-enqueued the queue's main-
 * thread user slice to mirror React state — see commit history for the
 * legacy "queue-mirror" pattern.
 *
 * Post-FEATURE_159: MessageQueue is canonical. Manager methods write to
 * the queue directly; a `queue.subscribe` callback inside the manager
 * mirrors the filtered slice back into React `state.pendingInputs`. The
 * end-to-end behavior (queue contents match REPL UI) is unchanged, so
 * the legacy invariants below remain valid. New cases at the bottom
 * cover the reverse direction: any third-party queue mutation
 * (idle-yield wake, mid-turn drain, SDK consumer) immediately updates
 * the REPL state.
 */
import {
  _resetMessageQueueForTests,
  getMessageQueue,
} from "@kodax-ai/agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createStreamingManager } from "./StreamingContext.js";
import { runQueuedPromptSequence } from "../utils/queued-prompt-sequence.js";

function mainThreadUserContents(): string[] {
  return getMessageQueue()
    .peek({ maxPriority: "user" })
    .map((m) => m.content);
}

function scopedUserContents(agentId: string): string[] {
  return getMessageQueue()
    .peek({ agentId, maxPriority: "user", mode: "prompt" })
    .map((message) => message.content);
}

describe("StreamingContext queue-as-source-of-truth (FEATURE_159)", () => {
  it('captures Stop input identities without discarding later submissions or another Session', () => {
    const manager = createStreamingManager({ getPendingInputAgentId: () => 'session-a' });
    manager.addPendingInput('old');
    const cancelCaptured = manager.capturePendingInputCancellation();
    manager.addPendingInput('later');
    getMessageQueue().enqueue({ agentId: 'session-b', priority: 'user', mode: 'prompt', content: 'other' });
    cancelCaptured();
    expect(scopedUserContents('session-a')).toEqual(['later']);
    expect(scopedUserContents('session-b')).toEqual(['other']);
    manager.dispose();
  });
  beforeEach(() => {
    _resetMessageQueueForTests();
  });
  afterEach(() => {
    _resetMessageQueueForTests();
  });

  it("addPendingInput enqueues to MessageQueue with priority='user' / agentId undefined", () => {
    const mgr = createStreamingManager();
    mgr.addPendingInput("first follow-up");
    expect(mainThreadUserContents()).toEqual(["first follow-up"]);
  });

  it("marks explicit Skill follow-ups for host-only delivery", () => {
    const mgr = createStreamingManager();
    mgr.addPendingInput("please use /hidden-skill args", { delivery: "host" });

    expect(getMessageQueue().peek({ maxPriority: "user" })).toEqual([
      expect.objectContaining({
        content: "please use /hidden-skill args",
        delivery: "host",
      }),
    ]);
    expect(mgr.peekPendingInputDelivery()).toBe("host");
    expect(mgr.shiftPendingInput()).toBe("please use /hidden-skill args");
    expect(mgr.peekPendingInputDelivery()).toBeUndefined();
  });

  it("preserves host-owned Skill boundaries when draining the real queue", async () => {
    const mgr = createStreamingManager();
    mgr.addPendingInput("/skill-a args", { delivery: "host" });
    mgr.addPendingInput("ordinary follow-up");
    const rounds: string[] = [];

    await runQueuedPromptSequence({
      initialPrompt: "active round",
      runRound: async (prompt) => {
        rounds.push(prompt);
        return prompt;
      },
      shiftPendingPrompt: mgr.shiftPendingInput,
      peekPendingPromptDelivery: mgr.peekPendingInputDelivery,
    });

    expect(rounds).toEqual([
      "active round",
      "/skill-a args",
      "ordinary follow-up",
    ]);
  });

  it("routes pending input to the current session root without exposing another session", () => {
    let agentId = "actor:session-a:/root";
    const mgr = createStreamingManager({ getPendingInputAgentId: () => agentId });

    mgr.addPendingInput("for session a");
    expect(scopedUserContents("actor:session-a:/root")).toEqual(["for session a"]);
    expect(mainThreadUserContents()).toEqual([]);

    agentId = "actor:session-b:/root";
    mgr.addPendingInput("for session b");
    expect(mgr.getState().pendingInputs).toEqual(["for session b"]);
    expect(scopedUserContents("actor:session-a:/root")).toEqual(["for session a"]);
    expect(scopedUserContents("actor:session-b:/root")).toEqual(["for session b"]);

    expect(mgr.shiftPendingInput()).toBe("for session b");
    expect(scopedUserContents("actor:session-a:/root")).toEqual(["for session a"]);
  });

  it("multiple addPendingInput calls preserve insertion order in the queue", () => {
    const mgr = createStreamingManager();
    mgr.addPendingInput("one");
    mgr.addPendingInput("two");
    mgr.addPendingInput("three");
    expect(mainThreadUserContents()).toEqual(["one", "two", "three"]);
  });

  it("removeLastPendingInput drops the tail item from the queue", () => {
    const mgr = createStreamingManager();
    mgr.addPendingInput("one");
    mgr.addPendingInput("two");
    mgr.addPendingInput("three");
    mgr.removeLastPendingInput();
    expect(mainThreadUserContents()).toEqual(["one", "two"]);
  });

  it("shiftPendingInput drops the head item from the queue and returns it", () => {
    const mgr = createStreamingManager();
    mgr.addPendingInput("one");
    mgr.addPendingInput("two");
    const next = mgr.shiftPendingInput();
    expect(next).toBe("one");
    expect(mainThreadUserContents()).toEqual(["two"]);
  });

  it("clearPendingInputs empties the queue's main-thread user slice", () => {
    const mgr = createStreamingManager();
    mgr.addPendingInput("one");
    mgr.addPendingInput("two");
    mgr.clearPendingInputs();
    expect(mainThreadUserContents()).toEqual([]);
  });

  it("consumePendingInputs returns the React-state contents and empties the queue", () => {
    const mgr = createStreamingManager();
    mgr.addPendingInput("one");
    mgr.addPendingInput("two");
    const consumed = mgr.consumePendingInputs();
    expect(consumed).toEqual(["one", "two"]);
    expect(mainThreadUserContents()).toEqual([]);
  });

  it("background-priority and subagent-scoped messages survive a sync pass", () => {
    // Out-of-band enqueues that the StreamingContext mirror must NOT
    // disturb when it resyncs the main-thread user slice.
    const queue = getMessageQueue();
    queue.enqueue({
      priority: "background",
      mode: "task-notification",
      content: "bg-keep",
    });
    queue.enqueue({
      priority: "user",
      mode: "prompt",
      content: "subagent-keep",
      agentId: "sub-1",
    });

    const mgr = createStreamingManager();
    mgr.addPendingInput("main-1");
    mgr.removeLastPendingInput();
    mgr.addPendingInput("main-2");

    // Main-thread slice reflects React state.
    expect(mainThreadUserContents()).toEqual(["main-2"]);
    // Background is untouched.
    expect(
      queue.peek({ maxPriority: "background" }).map((m) => m.content),
    ).toContain("bg-keep");
    // Sub-1 user-priority message is untouched.
    expect(
      queue.peek({ agentId: "sub-1", maxPriority: "user" }).map((m) => m.content),
    ).toEqual(["subagent-keep"]);
  });

  it("addPendingInput rejects empty trimmed input and does NOT touch the queue", () => {
    const mgr = createStreamingManager();
    mgr.addPendingInput("real");
    mgr.addPendingInput("   ");
    mgr.addPendingInput("");
    expect(mainThreadUserContents()).toEqual(["real"]);
  });

  it("addPendingInput respects MAX_PENDING_INPUTS gating", () => {
    const mgr = createStreamingManager();
    for (let i = 0; i < 10; i++) {
      mgr.addPendingInput(`m${i}`);
    }
    // MAX_PENDING_INPUTS is 5; React state caps; queue mirrors react state.
    expect(mainThreadUserContents()).toEqual(["m0", "m1", "m2", "m3", "m4"]);
  });

  // FEATURE_149 Phase B1a (v0.7.38): the default abort() clears the queue
  // (Esc / exit semantics — drop everything). The fast-abort path passes
  // `{ preservePendingInputs: true }` so the freshly-submitted prompt
  // sitting in the queue survives and gets picked up by the next
  // runQueuedPromptSequence iteration.
  describe("abort options.preservePendingInputs", () => {
    it("default abort() clears the pendingInputs queue (Esc behavior)", () => {
      const mgr = createStreamingManager();
      mgr.addPendingInput("legacy-keep");
      expect(mgr.getState().pendingInputs).toEqual(["legacy-keep"]);
      mgr.abort();
      expect(mgr.getState().pendingInputs).toEqual([]);
    });

    it("abort({ preservePendingInputs: true }) keeps the queue intact (fast-abort)", () => {
      const mgr = createStreamingManager();
      mgr.addPendingInput("survives-abort");
      mgr.addPendingInput("also-survives");
      expect(mgr.getState().pendingInputs).toEqual(["survives-abort", "also-survives"]);
      mgr.abort({ preservePendingInputs: true });
      expect(mgr.getState().pendingInputs).toEqual(["survives-abort", "also-survives"]);
    });

    it("abort({ preservePendingInputs: false }) is equivalent to default abort", () => {
      const mgr = createStreamingManager();
      mgr.addPendingInput("clear-me");
      mgr.abort({ preservePendingInputs: false });
      expect(mgr.getState().pendingInputs).toEqual([]);
    });
  });

  // FEATURE_159 — reverse-direction invariants. The legacy mirror only
  // supported React → queue propagation; the canonical-queue design adds
  // queue → React. These cases pin the new behavior so a future
  // refactor can't accidentally drop the subscribe wiring.
  describe("FEATURE_159 — third-party queue mutation updates REPL state", () => {
    it("a direct queue.enqueue (e.g. SDK consumer) appears in pendingInputs", () => {
      const mgr = createStreamingManager();
      // Bypass the manager — write to the queue as if a non-React
      // consumer (idle-yield resumer / SDK caller / mid-turn drain) had.
      getMessageQueue().enqueue({
        priority: "user",
        mode: "prompt",
        content: "out-of-band",
      });
      expect(mgr.getState().pendingInputs).toEqual(["out-of-band"]);
    });

    it("a direct queue.dequeue (e.g. wake-drain) clears pendingInputs", () => {
      const mgr = createStreamingManager();
      mgr.addPendingInput("ready-to-drain");
      expect(mgr.getState().pendingInputs).toEqual(["ready-to-drain"]);

      // Simulate idle-yield wake draining the user-priority slice.
      getMessageQueue().dequeue({ maxPriority: "user", mode: "prompt" });
      expect(mgr.getState().pendingInputs).toEqual([]);
    });

    it("out-of-slice queue events do NOT cause spurious React mutations", () => {
      const mgr = createStreamingManager();
      mgr.addPendingInput("anchor");
      const before = mgr.getState().pendingInputs;

      // Subagent task-notification — different priority + mode + agentId.
      getMessageQueue().enqueue({
        priority: "background",
        mode: "task-notification",
        content: "child-done",
      });
      getMessageQueue().enqueue({
        priority: "user",
        mode: "prompt",
        content: "subagent-msg",
        agentId: "sub-1",
      });

      // Reference identity preserved because the filtered slice didn't
      // change — guards against spurious React renders.
      expect(mgr.getState().pendingInputs).toBe(before);
      expect(mgr.getState().pendingInputs).toEqual(["anchor"]);
    });

    it("dispose() releases the queue subscription", () => {
      const mgr = createStreamingManager();
      mgr.addPendingInput("before-dispose");
      expect(mgr.getState().pendingInputs).toEqual(["before-dispose"]);

      mgr.dispose();
      // Out-of-band queue mutation after dispose must NOT update the
      // disposed manager's state.
      getMessageQueue().enqueue({
        priority: "user",
        mode: "prompt",
        content: "after-dispose",
      });
      expect(mgr.getState().pendingInputs).toEqual(["before-dispose"]);
    });
  });

  // FEATURE_159 — wake-drain visibility regression guard.
  // The original bug: idle-yield's waitForWakeEvent drained the queue
  // but the REPL's "Queue N" indicator never cleared (React mirror lag).
  // This test pins that the indicator does clear in the queue-canonical
  // model.
  describe("FEATURE_159 — wake-drain visibility regression guard", () => {
    it("Queue N indicator clears synchronously when wake-drain takes the slice", () => {
      const mgr = createStreamingManager();
      mgr.addPendingInput("user typed this while worker was busy");
      expect(mgr.getState().pendingInputs.length).toBe(1);

      // Simulate idle-yield's wake-drain shape: drain main-thread
      // user-priority prompt mode messages.
      const drained = getMessageQueue().dequeue({
        agentId: undefined,
        maxPriority: "background",
        mode: "prompt",
      });
      expect(drained.map((m) => m.content)).toEqual([
        "user typed this while worker was busy",
      ]);

      // The legacy bug: state.pendingInputs.length would stay 1 here.
      expect(mgr.getState().pendingInputs.length).toBe(0);
    });
  });
});
