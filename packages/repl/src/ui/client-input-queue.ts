import type { InkClientPlane } from './client-plane.js';
import { preparePromptInputArtifacts } from '../common/input-artifacts.js';
import { emitKodaXDiagnostic } from '@kodax-ai/agent';

type Input = Parameters<InkClientPlane['submit']>[0];
type QueuePlane = Pick<InkClientPlane, 'submit' | 'withdraw' | 'readInput'>;
const inputKey = (sessionId: string, inputId: string): string => JSON.stringify([sessionId, inputId]);

/** Composer-local drafts shared by submit, ↑ recall and Esc withdrawal. */
export function createClientInputQueue(plane: QueuePlane, report: (error: unknown) => void = (error) => {
  emitKodaXDiagnostic({ source: 'repl:input-queue', level: 'warn', message: String(error) });
}) {
  const drafts = new Map<string, { input: Input; originalText: string; state: 'unknown' | 'queued' | 'rejected'; settled: Promise<void> }>();
  const withdrawing = new Set<string>();
  const withdrawn = new Map<string, string>();

  async function submit(input: Input, originalText = input.text) {
    const key = inputKey(input.sessionId, input.inputId);
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    drafts.set(key, { input, originalText, state: 'unknown', settled });
    try {
      const accepted = await plane.submit(input);
      const draft = drafts.get(key);
      if (draft) draft.state = accepted.state === 'dropped' || accepted.state === 'withdrawn' ? 'rejected' : 'queued';
      if (accepted.state === 'submitted') drafts.delete(key);
      return accepted;
    } finally {
      settle();
    }
  }

  async function submitPrompt(input: Input, cwd: string, preserveSkillText = false) {
    const prepared = preparePromptInputArtifacts(input.text, cwd);
    for (const warning of prepared.warnings) report(warning);
    return submit({ ...input, text: preserveSkillText ? input.text : prepared.promptText, inputArtifacts: prepared.inputArtifacts }, input.text);
  }

  async function take(sessionId: string, id: string): Promise<string | undefined> {
    const key = inputKey(sessionId, id);
    try {
      const pendingDraft = drafts.get(key);
      await pendingDraft?.settled;
      const draft = drafts.get(key);
      if (pendingDraft && !draft) return undefined;
      if (draft?.state === 'rejected') {
        drafts.delete(key);
        return draft.originalText;
      }
      if (draft?.state === 'unknown') {
        if (!plane.readInput) throw new Error('Input acceptance is unknown; reconnect before taking it back.');
        const accepted = await plane.readInput(sessionId, id);
        if (!accepted || accepted.state === 'dropped' || accepted.state === 'withdrawn') {
          drafts.delete(key);
          withdrawn.set(key, sessionId);
          return draft.originalText;
        }
        if (accepted.state === 'submitted') {
          drafts.delete(key);
          return undefined;
        }
      }
      const text = await plane.withdraw(sessionId, id);
      if (text === undefined) throw new Error('Input withdrawal was not confirmed; it may still run.');
      drafts.delete(key);
      withdrawn.set(key, sessionId);
      return draft?.originalText ?? text;
    } finally {
      withdrawing.delete(key);
    }
  }

  async function pull(sessionId: string, queuedIds: readonly string[]): Promise<string | undefined> {
    const ids = new Set(queuedIds);
    for (const draft of drafts.values()) if (draft.input.sessionId === sessionId) ids.add(draft.input.inputId);
    const selected = [...ids].filter((id) => !withdrawing.has(inputKey(sessionId, id)) && !withdrawn.has(inputKey(sessionId, id)));
    selected.forEach((id) => withdrawing.add(inputKey(sessionId, id)));
    const settled = await Promise.allSettled(selected.map((id) => take(sessionId, id)));
    const results: string[] = [];
    for (const result of settled) {
      if (result.status === 'fulfilled' && result.value !== undefined) results.push(result.value);
      else if (result.status === 'rejected') report(result.reason);
    }
    if (results.length === 0 && settled.some((result) => result.status === 'rejected')) {
      throw new Error('No inputs could be taken back; they may still run.');
    }
    return results.length > 0 ? results.join('\n---\n') : undefined;
  }

  async function discardNewest(sessionId: string, queuedIds: readonly string[]): Promise<void> {
    const id = [...queuedIds].reverse().find((id) => !withdrawing.has(inputKey(sessionId, id)) && !withdrawn.has(inputKey(sessionId, id)));
    if (!id) return;
    withdrawing.add(inputKey(sessionId, id));
    await take(sessionId, id);
  }

  async function observeQueue(sessionId: string, queuedIds: readonly string[]): Promise<void> {
    const queued = new Set(queuedIds);
    const queuedKeys = new Set(queuedIds.map((id) => inputKey(sessionId, id)));
    for (const [key, owner] of withdrawn) if (owner === sessionId && !queuedKeys.has(key)) withdrawn.delete(key);
    if (!plane.readInput) return;
    for (const [key, draft] of drafts) {
      const id = draft.input.inputId;
      if (draft.input.sessionId !== sessionId || draft.state !== 'queued' || queued.has(id) || withdrawing.has(key)) continue;
      const accepted = await plane.readInput(sessionId, id);
      if (accepted?.state === 'submitted') drafts.delete(key);
    }
  }

  return { submit, submitPrompt, pull, discardNewest, observeQueue };
}
