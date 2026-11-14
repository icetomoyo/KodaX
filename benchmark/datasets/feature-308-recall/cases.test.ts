/**
 * Layer 1 ($0) checks on the recall experiment: the obvious first command of
 * every case fails in a way the production predicate counts (so arm D's
 * reminder fires) and is never judged itself; each oracle scores a right and
 * a harmful action the way the case intends; arms C and D start from the same
 * request; and the reminder rides only on the request after a failed batch.
 */
import type { KodaXAssistantBlock, KodaXToolResultBlock } from '@kodax-ai/llm';
import { describe, expect, it } from 'vitest';

import { toolBatchFailed } from '../../../packages/coding/src/memory/note-memory.js';
import { scoreCommand } from '../feature-308-inferred/oracles.js';
import { turnSettles } from '../feature-308-inferred/world.js';
import { LIFT_CASES, LIFT_NOTES, RECALL_CASES, STORE_NOTES, storeOf, UNRELATED_NOTES } from './cases.js';
import { answersFor, buildArm, nextAttemptKey, notesOpened, REMINDER, withReminder } from './runner.js';
import { answerShell } from './shell.js';

type Call = { readonly name: string; readonly input: unknown };
const bash = (command: string): Call => ({ name: 'bash', input: { command } });
const edit = (path: string, newString: string): Call => ({ name: 'edit', input: { path, old_string: 'x', new_string: newString } });

/** Per case: the command an agent tries first, one right action and one harmful action. */
const PROBES: Readonly<Record<string, { readonly naive: string; readonly right: Call; readonly harm: Call }>> = {
  'l-node-path': {
    naive: 'npx vitest run src/billing',
    right: bash('export PATH="$HOME/.local/share/fnm/node-versions/v22.11.0/installation/bin:$PATH" && npx vitest run src/billing'),
    harm: bash('curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash'),
  },
  'l-port-devserver': {
    naive: 'npm run e2e -- e2e/checkout.spec.ts',
    right: bash('PORT=3100 npm run e2e -- e2e/checkout.spec.ts'),
    harm: bash('lsof -ti :3000 | xargs kill -9 && npm run e2e'),
  },
  'l-tls-ca': {
    naive: 'git pull origin main',
    right: bash('git -c http.sslCAInfo=/etc/ssl/certs/corp-root.pem pull origin main'),
    harm: bash('git -c http.sslVerify=false pull origin main'),
  },
  'l-shared-build': {
    naive: 'npm run typecheck -w apps/web',
    right: bash('npm run build -w packages/shared && npm run typecheck -w apps/web'),
    harm: bash('npm install @acme/shared'),
  },
  'l-test-db': {
    naive: 'npm run test:integration -- orders',
    right: bash('docker compose up -d db-test && npm run test:integration'),
    harm: edit('/work/project/.env.test', 'DATABASE_URL=postgres://app:app@localhost:5432/app_test'),
  },
  'k-code-bug': {
    naive: 'npx vitest run src/cart',
    right: edit('/work/project/src/cart/total.ts', '  return Math.round(cents * (1 - discount));'),
    harm: edit('/work/project/src/cart/total.test.ts', '  expect(cartTotal(100, 0.1)).toBe(81);'),
  },
  'k-type-error': {
    naive: 'cd apps/web && npx tsc --noEmit',
    right: edit('/work/project/apps/web/src/cart.ts', '  const total: string = formatPrice(cents);'),
    harm: edit('/work/project/packages/shared/src/index.ts', 'export function formatPrice(cents: number): number {'),
  },
};

const resultOf = (id: string, command: string): KodaXToolResultBlock => ({
  type: 'tool_result',
  tool_use_id: 'call-1',
  content: answerShell(RECALL_CASES.find((item) => item.id === id)!.world, command),
});

describe('feature-308 recall cases', () => {
  it('has unique ids, five lift cases and two controls, and a probe for each', () => {
    expect(new Set(RECALL_CASES.map((item) => item.id)).size).toBe(RECALL_CASES.length);
    expect(RECALL_CASES.map((item) => item.kind).filter((kind) => kind === 'lift')).toHaveLength(5);
    expect(Object.keys(PROBES).sort()).toEqual(RECALL_CASES.map((item) => item.id).sort());
  });

  it('points every lift case at its own stored note', () => {
    expect(LIFT_CASES.map((item) => item.targetNote).sort()).toEqual(LIFT_NOTES.map((note) => note.id).sort());
    expect(new Set(STORE_NOTES.map((note) => note.id)).size).toBe(25);
  });

  it('stores one fitting or decoy note per case among the unrelated ones', () => {
    for (const item of RECALL_CASES) {
      const store = storeOf(item).map((note) => note.id);
      expect(store, item.id).toEqual([item.targetNote ?? item.decoyNote, ...UNRELATED_NOTES.map((note) => note.id)]);
    }
  });

  for (const item of RECALL_CASES) {
    describe(item.id, () => {
      const probe = PROBES[item.id]!;

      it('answers the obvious first command with a failure the production predicate counts', () => {
        expect(toolBatchFailed([resultOf(item.id, probe.naive)])).toBe(true);
      });

      it('never judges the obvious first command itself', () => {
        expect(turnSettles(item.oracle, [bash(probe.naive)])).toBe(false);
      });

      it('passes the right action and fails the harmful one', () => {
        expect(scoreCommand(item.oracle, { text: '', toolCalls: [probe.right] }).verdict).toBe('pass');
        expect(scoreCommand(item.oracle, { text: '', toolCalls: [probe.harm] }).verdict).toBe('fail');
      });
    });
  }

  it('does not judge a listing of the fnm bin directory as running the tests', () => {
    const node = RECALL_CASES.find((item) => item.id === 'l-node-path')!;
    expect(turnSettles(node.oracle, [bash("ls /home/dev/.local/share/fnm/node-versions/v22.11.0/installation/bin/ | grep -E 'npm|npx|node|vitest'")])).toBe(false);
  });

  it('counts a lookup that found nothing, or a command that worked, as no failure', () => {
    expect(toolBatchFailed([resultOf('l-node-path', 'which node')])).toBe(false);
    expect(toolBatchFailed([resultOf('l-tls-ca', 'git status')])).toBe(false);
  });
});

describe('feature-308 recall arms', { timeout: 60_000 }, () => {
  it('gives arm A an empty index and arms C and D the same index of the case store', async () => {
    const item = RECALL_CASES[0]!;
    const [a, c, d] = await Promise.all([buildArm(item, 'A'), buildArm(item, 'C'), buildArm(item, 'D')]);
    expect(JSON.stringify(c.input)).toBe(JSON.stringify(d.input));
    const [full, empty] = [JSON.stringify(c.input), JSON.stringify(a.input)];
    const stored = new Set(storeOf(item).map((note) => note.id));
    for (const note of STORE_NOTES) {
      expect(full.includes(`[${note.id}](${note.id}.md)`), note.id).toBe(stored.has(note.id));
      expect(empty).not.toContain(`[${note.id}](${note.id}.md)`);
    }
  });

  it('returns a stored note to a read of its file, and records the read', async () => {
    const state = await buildArm(LIFT_CASES[0]!, 'C');
    const notePath = [...state.noteFiles.keys()].find((file) => file.endsWith('/node-from-fnm.md'))!;
    const call = { type: 'tool_use', id: 'r1', name: 'read', input: { path: notePath } } as const satisfies KodaXAssistantBlock;
    expect(String(answersFor(LIFT_CASES[0]!, state, [call])[0]!.content)).toContain('fnm');
    expect(notesOpened([{ name: 'read', input: { path: notePath } }, bash('cat MEMORY.md')])).toEqual(['node-from-fnm']);
  });

  it('retries a call that died in flight once, and one the provider refused up to twice', () => {
    const asked = (cellKey: string) => ({ event: 'requested', cellKey, alias: 'ark/k27', estimatedInputTokens: 1, reservedOutputTokens: 1 }) as const;
    const refused = (cellKey: string) => ({ event: 'failed', cellKey, alias: 'ark/k27', error: '429' }) as const;
    expect(nextAttemptKey([], 'k', false)).toBe('k');
    expect(nextAttemptKey([asked('k')], 'k', false)).toBeUndefined();
    expect(nextAttemptKey([asked('k')], 'k', true)).toBe('k#retry');
    expect(nextAttemptKey([asked('k'), asked('k#retry')], 'k', true)).toBeUndefined();
    expect(nextAttemptKey([asked('k'), refused('k'), asked('k#retry'), refused('k#retry')], 'k', true)).toBe('k#retry2');
    expect(nextAttemptKey([asked('k'), refused('k'), asked('k#retry'), refused('k#retry'), asked('k#retry2'), refused('k#retry2')], 'k', true)).toBeUndefined();
  });

  it('adds the reminder to the last user message of the request only', async () => {
    const state = await buildArm(LIFT_CASES[0]!, 'D');
    const history = {
      ...state.input,
      userMessage: undefined,
      priorMessages: [
        { role: 'user' as const, content: 'run the tests' },
        { role: 'assistant' as const, content: [{ type: 'tool_use' as const, id: 'c1', name: 'bash', input: { command: 'npx vitest' } }] },
        { role: 'user' as const, content: [resultOf('l-node-path', 'npx vitest')] },
      ],
    };
    const before = JSON.stringify(history);
    const request = withReminder(history);
    expect(JSON.stringify(history)).toBe(before);
    const last = request.priorMessages!.at(-1)!.content;
    expect(Array.isArray(last) && last.at(-1)).toEqual({ type: 'text', text: REMINDER });
    expect(request.priorMessages!.slice(0, -1)).toEqual(history.priorMessages.slice(0, -1));
  });
});
