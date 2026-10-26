import fs from 'node:fs/promises';
import path from 'node:path';
import type { GuardrailPermissionIntent, ToolGuardrail } from '@kodax-ai/agent';
import { resolveToolBridgeTarget } from '../packages/coding/src/tools/tool-bridge.js';
import { currentProviderRequestAttribution } from '../packages/llm/src/provider-request-observation.js';

export interface CompactReadFaultEvent {
  readonly action: 'allow' | 'block';
  readonly callId: string;
  readonly agentName: string;
  readonly target: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly permissionIntent: GuardrailPermissionIntent;
  readonly actorPath?: string;
  readonly turnId?: string;
}

/** Eval-only fault, not a security boundary. The ordinary workspace guard runs first.
 * Only the first target of an authenticated readonly child is faulted; repeated
 * reads of that target remain denied, so success cannot come from a free retry.
 * Other tools/targets retain their production permission and execution paths.
 */
export function createCompactReadRecoveryFault(workspace: string): {
  guardrail: ToolGuardrail;
  events: readonly CompactReadFaultEvent[];
} {
  let deniedTarget: Promise<string> | undefined;
  const events: CompactReadFaultEvent[] = [];
  const normalize = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value;
  const canonical = async (requested: string): Promise<string> => {
    try { return normalize(await fs.realpath(requested)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return normalize(requested);
    }
  };
  const guardrail: ToolGuardrail = {
    kind: 'tool', name: 'compact-read-recovery-fault',
    beforeTool: async (call, context) => {
      const intent = context.permissionIntent;
      // Intent is runtime-authenticated metadata, never a model/tool argument.
      if (intent?.readOnly !== true || !intent.delegatedObjective) return { action: 'allow' };
      const bridge = resolveToolBridgeTarget(call);
      const targetCall = bridge?.ok ? bridge.call : call;
      if (targetCall.name !== 'read' || typeof targetCall.input.path !== 'string') return { action: 'allow' };
      const requested = path.resolve(workspace, targetCall.input.path);
      const relative = path.relative(workspace, requested);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return { action: 'allow' };
      const resolved = canonical(requested);
      // Reserve synchronously: parallel reads must not choose their fault by I/O speed.
      deniedTarget ??= resolved;
      const [target, denied] = await Promise.all([resolved, deniedTarget]);
      const action = target === denied ? 'block' : 'allow';
      const attribution = currentProviderRequestAttribution();
      events.push({ action, callId: call.id, agentName: context.agent.name, target,
        input: structuredClone(targetCall.input), permissionIntent: structuredClone(intent),
        ...(attribution?.kind === 'actor_turn' ? { actorPath: attribution.actorPath, turnId: attribution.turnId } : {}) });
      return action === 'block'
        ? { action, reason: 'Fixture read refusal: this target remains unavailable to this readonly child. Do not retry it; use other permitted in-scope evidence and report any remaining uncertainty.' }
        : { action };
    },
  };
  return { guardrail, events };
}
