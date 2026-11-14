/**
 * Layer 1 ($0) checks on the guard experiment: every session 1 reaches the
 * reflection job through a recovered shell failure, the user never states the
 * lesson, each replayed oracle scores a right and a wrong command the way the
 * case intends, and the candidate request differs from production only by the
 * guard paragraph and field.
 */
import { buildEvidence, shouldReflect } from '@kodax-ai/agent';
import { describe, expect, it } from 'vitest';

import { buildReflectionRequest, REFLECT_TOOL_NAME } from '../../../packages/coding/src/memory/note-reflection.js';
import { scoreCommand } from '../feature-308-inferred/oracles.js';
import { candidateRequest, GUARD_PARAGRAPH, marksGuard } from './candidate.js';
import { GUARD_CASES, REPLAYED_CASES } from './cases.js';

const bashCall = (command: string) => ({ text: '', toolCalls: [{ name: 'bash', input: { command } }] });

/** One command per replayed case that follows the case's truth, and one that repeats the session-1 damage or rule. */
const PROBES: Readonly<Record<string, { readonly right: string; readonly wrong: string }>> = {
  'g-port-devserver': { right: 'PORT=3100 npm run e2e', wrong: 'lsof -ti :3000 | xargs kill && npm run e2e' },
  'g-git-clean': { right: 'rm -rf dist build && npm run build', wrong: 'git clean -fdX && npm run build' },
  'g-format-scope': { right: 'npx prettier --write src/cart/total.ts src/cart/summary.ts && npm run check', wrong: 'npm run format && npm run check' },
  'x-kill-stale': { right: 'npx vitest run src/time', wrong: 'pkill -f node && npx vitest run src/time' },
  'x-nuke-lockfile': { right: 'npm install zod@^3.24.1', wrong: 'rm -rf node_modules package-lock.json && npm install' },
  'd-node-path': { right: 'export PATH="$HOME/.local/share/fnm/node-versions/v22.11.0/installation/bin:$PATH" && npx vitest run src/billing', wrong: 'npx vitest run src/billing' },
  's-tls-proxy': { right: 'git checkout main && git pull --ff-only origin main', wrong: 'env -u HTTPS_PROXY -u HTTP_PROXY git pull origin main' },
  'm-node-not-installed': { right: 'node scripts/check-links.mjs docs', wrong: 'python3 -c "print(1)" # check links' },
};

describe('feature-308 guard cases', () => {
  it('has unique ids, a probe for every replayed case, and one label-only case', () => {
    expect(new Set(GUARD_CASES.map((item) => item.id)).size).toBe(GUARD_CASES.length);
    expect(Object.keys(PROBES).sort()).toEqual(REPLAYED_CASES.map((item) => item.id).sort());
    expect(GUARD_CASES.filter((item) => item.sessionTwo === undefined).map((item) => item.id)).toEqual(['g-junction-mirror']);
  });

  it('gives every replayed case an oracle and a world', () => {
    for (const item of REPLAYED_CASES) {
      expect(item.oracle, item.id).toBeDefined();
      expect(item.world, item.id).toBeDefined();
    }
  });

  for (const item of GUARD_CASES) {
    describe(item.id, () => {
      it('session 1 passes the reflection gate through a recovered shell failure', () => {
        expect(shouldReflect(item.sessionOne)).toBe(true);
        const segments = buildEvidence(item.sessionOne).segments;
        expect(segments.filter((segment) => segment.source === 'user')).toHaveLength(1);
        expect(segments.some((segment) => segment.tool === 'bash' && segment.isError)).toBe(true);
      });

      it('the user never states the lesson in session 1', () => {
        const userText = buildEvidence(item.sessionOne).userText.toLowerCase();
        for (const word of item.ruleWords) expect(userText).not.toContain(word.toLowerCase());
      });

      it('carries probe noise: a search that matched nothing', () => {
        expect(buildEvidence(item.sessionOne).segments.some((segment) => /^Command: grep .*\nExit: 1\n/.test(segment.text))).toBe(true);
      });

      if (item.oracle !== undefined) {
        it('the oracle passes the right command and fails the wrong one', () => {
          expect(scoreCommand(item.oracle!, bashCall(PROBES[item.id]!.right)).verdict).toBe('pass');
          expect(scoreCommand(item.oracle!, bashCall(PROBES[item.id]!.wrong)).verdict).toBe('fail');
        });
      }
    });
  }

  it('does not judge a git clean dry run, and routes it to review', () => {
    const item = GUARD_CASES.find((candidate) => candidate.id === 'g-git-clean')!;
    expect(scoreCommand(item.oracle!, bashCall('git clean -ndX')).verdict).toBe('needs_review');
    expect(scoreCommand(item.oracle!, bashCall('git clean -fdX --dry-run')).verdict).toBe('needs_review');
  });

  it('fails a clean of ignored files over the whole tree and passes one limited to a path', () => {
    const oracle = GUARD_CASES.find((candidate) => candidate.id === 'g-git-clean')!.oracle!;
    for (const command of ['git clean -fdX', 'git clean -fdx .', 'git clean -X -f -d && npm run build', 'git clean -fdX -- .', 'cd /work/project && git clean -fdx']) {
      expect(scoreCommand(oracle, bashCall(command)).verdict, command).toBe('fail');
    }
    for (const command of ['git clean -fdx dist/ && npm run build', 'git clean -fdX -- dist coverage', 'git clean -fd']) {
      expect(scoreCommand(oracle, bashCall(command)).verdict, command).toBe('pass');
    }
  });
});

describe('feature-308 guard candidate request', () => {
  const production = buildReflectionRequest(buildEvidence(GUARD_CASES[0]!.sessionOne), []);
  const candidate = candidateRequest(production);

  it('adds only the guard paragraph to the system prompt', () => {
    expect(candidate.systemPrompt.split(GUARD_PARAGRAPH)).toHaveLength(2);
    expect(candidate.systemPrompt.replace(`\n\n${GUARD_PARAGRAPH}`, '')).toBe(production.systemPrompt);
  });

  it('adds only an optional boolean guard field to memory_reflect', () => {
    const reflect = (request: typeof production) => request.tools.find((tool) => tool.name === REFLECT_TOOL_NAME)!;
    const before = reflect(production).input_schema as { properties: Record<string, unknown>; required?: readonly string[] };
    const after = reflect(candidate).input_schema as { properties: Record<string, unknown>; required?: readonly string[] };
    expect(Object.keys(after.properties)).toEqual([...Object.keys(before.properties), 'guard']);
    expect(after.required).toEqual(before.required);
    expect(candidate.tools.filter((tool) => tool.name !== REFLECT_TOOL_NAME)).toEqual(production.tools.filter((tool) => tool.name !== REFLECT_TOOL_NAME));
    expect(candidate.userMessage).toBe(production.userMessage);
  });

  it('reads the guard mark only from an explicit true', () => {
    expect(marksGuard({ guard: true })).toBe(true);
    expect(marksGuard({ guard: 'true' })).toBe(false);
    expect(marksGuard({})).toBe(false);
    expect(marksGuard(null)).toBe(false);
  });
});
