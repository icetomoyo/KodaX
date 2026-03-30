import type {
  KodaXContextOptions,
  KodaXContextTokenSnapshot,
} from "@kodax/coding";

export function buildManagedRunContext(
  baseContext: KodaXContextOptions | undefined,
  interactiveGitRoot: string | null | undefined,
  contextTokenSnapshot: KodaXContextTokenSnapshot | undefined,
  skillsPrompt: string,
): KodaXContextOptions {
  const gitRoot = baseContext?.gitRoot ?? interactiveGitRoot ?? undefined;
  const executionCwd = baseContext?.executionCwd ?? gitRoot ?? process.cwd();

  return {
    ...baseContext,
    gitRoot,
    executionCwd,
    contextTokenSnapshot,
    taskSurface: "repl",
    skillsPrompt,
  };
}
