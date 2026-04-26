/**
 * REPL-side bootstrap for the v0.7.28 ConstructionRuntime
 * (FEATURE_087 + FEATURE_088).
 *
 * Wires three things the engine layer cannot do on its own:
 *
 *   1. `configureRuntime({ cwd, policy })` — one-time module-singleton
 *      configuration. cwd is the resolved gitRoot (or process.cwd()),
 *      policy is the REPL-bound `replConstructionPolicy` defined below.
 *
 *   2. `rehydrateActiveArtifacts()` — scan `.kodax/constructed/<kind>s/`
 *      and re-register every `status='active'` artifact into TOOL_REGISTRY
 *      so previously-activated constructed tools survive process restart.
 *
 *   3. A mutable `activeAskUser` cell the policy reads from each invocation.
 *      The InkREPL component binds this on mount (and clears on unmount)
 *      so the policy can present an interactive approval dialog with the
 *      live session's UI surface — without baking React state into the
 *      policy function itself.
 *
 * The policy intentionally returns `'reject'` when no askUser callback is
 * bound (e.g. ACP server, single-shot CLI, child agent contexts). That
 * means non-interactive surfaces cannot activate constructed tools, which
 * matches the v0.7.28 design (REPL-only true): construction is a meta
 * action that requires explicit user consent.
 */

import {
  type AskUserQuestionOptions,
  type ConstructionArtifact,
  type ConstructionPolicy,
  configureRuntime,
  rehydrateActiveArtifacts,
} from '@kodax/coding';

type AskUserFn = (options: AskUserQuestionOptions) => Promise<string>;

let activeAskUser: AskUserFn | null = null;

/**
 * Bind / unbind the askUser implementation the construction policy will use.
 * Call with the live `events.askUser` on REPL session start, and with
 * `null` on session end / unmount.
 */
export function bindAskUserForConstruction(fn: AskUserFn | null): void {
  activeAskUser = fn;
}

/**
 * Read declared capability tools from an artifact in a shape-tolerant way.
 * Falls back to `[]` if the artifact is missing the field — the policy
 * should still be able to surface a dialog, even if the dialog's tools
 * line is empty.
 */
function readDeclaredTools(artifact: ConstructionArtifact): readonly string[] {
  const content = artifact.content as
    | { capabilities?: { tools?: readonly string[] } }
    | undefined;
  return content?.capabilities?.tools ?? [];
}

/**
 * REPL-bound policy. Default verdict is `'reject'`; on UI binding,
 * promotes to interactive approve/reject via askUser.
 */
const replConstructionPolicy: ConstructionPolicy = async (artifact) => {
  if (!activeAskUser) {
    // No UI channel bound. This path runs on ACP / single-shot CLI / child
    // agents — surfaces that cannot prompt the user. Rejecting prevents
    // silent activation.
    return 'reject';
  }
  const declaredTools = readDeclaredTools(artifact);
  const toolsLabel = declaredTools.length > 0 ? declaredTools.join(', ') : '<none>';
  const answer = await activeAskUser({
    question: `Activate constructed tool ${artifact.name}@${artifact.version}?\nIt declares capabilities.tools = [${toolsLabel}].`,
    options: [
      {
        label: 'Approve — register and make callable',
        description: 'The tool will be added to the active tool registry and the LLM can invoke it on the next turn.',
        value: 'approve',
      },
      {
        label: 'Reject — do not register',
        description: 'The artifact stays staged on disk; rerun activate_tool to retry.',
        value: 'reject',
      },
    ],
  });
  return answer === 'approve' ? 'approve' : 'reject';
};

/**
 * One-time REPL startup hook: configure ConstructionRuntime cwd + policy,
 * then rehydrate any previously-activated constructed tools.
 *
 * Idempotent — calling twice is harmless (configureRuntime accepts the
 * same overrides; rehydrateActiveArtifacts will re-register, and
 * registerActiveArtifact unregisters any prior entry first).
 */
export async function bootstrapConstructionRuntime(
  cwd: string,
): Promise<{ loaded: number; failed: number; tampered: number }> {
  configureRuntime({
    cwd,
    policy: replConstructionPolicy,
  });
  return rehydrateActiveArtifacts();
}
