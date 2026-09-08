/**
 * FEATURE_298 T37 — Host-side trusted preparation for /review and
 * /agents lean. Git capture and packet writing are trusted work (they
 * determine exactly what the reviewer sees); the client sends only the
 * parsed flags and the Host returns the prepared invocation or workflow
 * request pieces. Pure prompt/request builders are reused from the repl
 * package so prompt text stays byte-identical with the local path.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { writeReviewPackets } from "@kodax-ai/coding";
import {
  buildLeanReviewPrompt,
  buildReviewDisplayName,
  buildReviewPrompt,
  buildReviewWorkflowRequest,
  parseReviewInvocation,
} from "@kodax-ai/repl";

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

async function detectBaseBranch(cwd: string): Promise<string> {
  for (const branch of ["main", "master", "develop"]) {
    try {
      await git(["rev-parse", "--verify", branch], cwd);
      return branch;
    } catch {
      // Try the next candidate.
    }
  }
  return "HEAD";
}

async function resolveRef(ref: string, cwd: string): Promise<string> {
  return (await git(["rev-parse", ref], cwd)).trim();
}

async function tryResolveRef(ref: string, cwd: string): Promise<string | undefined> {
  try {
    return await resolveRef(ref, cwd);
  } catch {
    return undefined;
  }
}

interface CapturedReviewDiff {
  readonly diff: string;
  readonly label: string;
  readonly scope: "all" | "compare" | "commit";
  readonly baseRef?: string;
  readonly headRef?: string;
}

async function captureDiff(args: readonly string[], cwd: string): Promise<CapturedReviewDiff> {
  const sub = args[0];
  if (sub === "base") {
    const base = await detectBaseBranch(cwd);
    return {
      diff: await git(["diff", `${base}...HEAD`], cwd),
      label: `changes against ${base}`,
      scope: "compare",
      baseRef: await resolveRef(base, cwd),
      headRef: await resolveRef("HEAD", cwd),
    };
  }
  if (sub === "sha" && args[1]) {
    // The sha token reaches git argv without a shell; refuse option-shaped
    // values so a caller cannot smuggle git flags through the ref slot.
    if (args[1].startsWith("-")) {
      throw new Error("invalid commit hash for sha scope");
    }
    const baseRef = await tryResolveRef(`${args[1]}^`, cwd);
    return {
      diff: await git(["show", args[1]], cwd),
      label: `commit ${args[1]}`,
      scope: "commit",
      ...(baseRef !== undefined ? { baseRef } : {}),
      headRef: await resolveRef(args[1], cwd),
    };
  }
  if (sub === "sha") {
    throw new Error("missing commit hash for sha scope; use /review sha <hash>");
  }
  return {
    diff: await git(["diff", "HEAD"], cwd),
    label: "uncommitted changes",
    scope: "all",
    headRef: await resolveRef("HEAD", cwd),
  };
}

export type RuntimePreparedReview =
  | {
    readonly kind: "prepared";
    readonly invocation: {
      readonly prompt: string;
      readonly source: "prompt";
      readonly displayName: string;
    };
  }
  | {
    readonly kind: "workflow";
    readonly workflow: {
      readonly request: string;
      readonly displayName: string;
      readonly builtinName: "scoped-review";
      readonly builtinArgs: Record<string, unknown>;
    };
  }
  | { readonly kind: "empty" }
  | { readonly kind: "error"; readonly message: string };

export type RuntimePreparedAgentsLean =
  | {
    readonly kind: "prepared";
    readonly invocation: {
      readonly prompt: string;
      readonly source: "prompt";
      readonly displayName: string;
    };
  }
  | { readonly kind: "missing" };

export interface RuntimeReviewPreparationService {
  prepareReview(input: {
    readonly projectRoot: string;
    readonly sessionId: string;
    readonly args: readonly string[];
  }): Promise<RuntimePreparedReview>;
  prepareAgentsLean(input: {
    readonly projectRoot: string;
  }): Promise<RuntimePreparedAgentsLean>;
}

export function createRuntimeReviewPreparationService(
  authorize?: (input: Parameters<RuntimeReviewPreparationService['prepareReview']>[0]) => Promise<void>,
): RuntimeReviewPreparationService {
  return {
    async prepareReview(input) {
      await authorize?.(input);
      const invocation = parseReviewInvocation([...input.args]);
      if (invocation.error !== undefined) {
        return { kind: "error", message: `/review: ${invocation.error}` };
      }
      let captured: CapturedReviewDiff;
      try {
        captured = await captureDiff(invocation.diffArgs, input.projectRoot);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { kind: "error", message: `/review: git failed - ${message}` };
      }
      if (!captured.diff.trim()) {
        return { kind: "empty" };
      }
      const displayName = buildReviewDisplayName(invocation);

      if (invocation.workflow) {
        await authorize?.(input);
        try {
          const packets = await writeReviewPackets({
            cwd: input.projectRoot,
            sessionId: input.sessionId,
            label: captured.label,
            diff: captured.diff,
            scope: captured.scope,
            ...(captured.baseRef !== undefined ? { baseRef: captured.baseRef } : {}),
            ...(captured.headRef !== undefined ? { headRef: captured.headRef } : {}),
            customPrompt: invocation.prompt,
          });
          return {
            kind: "workflow",
            workflow: {
              request: buildReviewWorkflowRequest(captured.label, {
                lean: invocation.lean,
                customPrompt: invocation.prompt,
                packets,
              }),
              displayName,
              builtinName: "scoped-review",
              builtinArgs: {
                packets,
                ...(invocation.lean ? { lean: true } : {}),
                ...(invocation.prompt !== undefined
                  ? { reviewFocus: invocation.prompt }
                  : {}),
              },
            },
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { kind: "error", message: `/review: could not create review packet - ${message}` };
        }
      }

      return {
        kind: "prepared",
        invocation: {
          prompt: buildReviewPrompt({
            label: captured.label,
            diff: captured.diff,
            lean: invocation.lean,
            customPrompt: invocation.prompt,
          }),
          source: "prompt",
          displayName,
        },
      };
    },
    async prepareAgentsLean(input) {
      const agentsPath = join(input.projectRoot, "AGENTS.md");
      let content: string;
      try {
        content = await readFile(agentsPath, "utf8");
      } catch {
        return { kind: "missing" };
      }
      return {
        kind: "prepared",
        invocation: {
          prompt: buildLeanReviewPrompt(agentsPath, content),
          source: "prompt",
          displayName: "/agents lean",
        },
      };
    },
  };
}
