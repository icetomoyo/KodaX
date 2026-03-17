import { describe, expect, it, vi } from "vitest";
import { runQueuedPromptSequence } from "./queued-prompt-sequence.js";

describe("runQueuedPromptSequence", () => {
  it("runs queued prompts one round at a time in FIFO order", async () => {
    const completed: string[] = [];
    const beforeQueued: string[] = [];
    const prompts = ["follow-up one", "follow-up two"];
    const runRound = vi.fn(async (prompt: string) => ({ prompt, interrupted: false }));

    const result = await runQueuedPromptSequence({
      initialPrompt: "initial",
      runRound,
      shiftPendingPrompt: () => prompts.shift(),
      onRoundComplete: async (round) => {
        completed.push(round.prompt);
      },
      onBeforeQueuedRound: async (prompt) => {
        beforeQueued.push(prompt);
      },
      shouldContinue: (round) => !round.interrupted,
    });

    expect(result.prompt).toBe("follow-up two");
    expect(runRound).toHaveBeenCalledTimes(3);
    expect(runRound.mock.calls.map(([prompt]) => prompt)).toEqual([
      "initial",
      "follow-up one",
      "follow-up two",
    ]);
    expect(completed).toEqual(["initial", "follow-up one", "follow-up two"]);
    expect(beforeQueued).toEqual(["follow-up one", "follow-up two"]);
  });

  it("stops before consuming queued prompts when the current round should not continue", async () => {
    const runRound = vi.fn(async (prompt: string) => ({
      prompt,
      interrupted: true,
    }));
    const shiftPendingPrompt = vi.fn(() => "queued");

    const result = await runQueuedPromptSequence({
      initialPrompt: "initial",
      runRound,
      shiftPendingPrompt,
      shouldContinue: (round) => !round.interrupted,
    });

    expect(result.prompt).toBe("initial");
    expect(shiftPendingPrompt).not.toHaveBeenCalled();
  });

  it("skips blank queued prompts before running the next valid round", async () => {
    const prompts = ["   ", "", "follow-up"];
    const runRound = vi.fn(async (prompt: string) => ({ prompt, interrupted: false }));

    const result = await runQueuedPromptSequence({
      initialPrompt: "initial",
      runRound,
      shiftPendingPrompt: () => prompts.shift(),
      shouldContinue: (round) => !round.interrupted,
    });

    expect(result.prompt).toBe("follow-up");
    expect(runRound.mock.calls.map(([prompt]) => prompt)).toEqual([
      "initial",
      "follow-up",
    ]);
  });
});
