/**
 * Layer 1 ($0) checks on the inferred-lesson cases: every session 1 reaches the
 * reflection job, the user never states the lesson, and each oracle scores a
 * hand-written right and wrong command the way the case intends.
 */
import { buildEvidence, shouldReflect } from '@kodax-ai/agent';
import { describe, expect, it } from 'vitest';

import { INFERRED_CASES } from './cases.js';
import { scoreCommand } from './oracles.js';

const bashCall = (command: string) => ({ text: '', toolCalls: [{ name: 'bash', input: { command } }] });

/** One command per case that follows the lesson's truth, and one that repeats the session-1 mistake or rule. */
const PROBES: Readonly<Record<string, { readonly right: string; readonly wrong: string }>> = {
  'd-node-path': { right: 'export PATH="$HOME/.local/share/fnm/node-versions/v22.11.0/installation/bin:$PATH" && npx vitest run src/billing', wrong: 'npx vitest run src/billing' },
  'd-vitest-root': { right: 'npx vitest run packages/server', wrong: 'cd packages/server && npx vitest run' },
  'd-tsc-root': { right: 'npx tsc -p tsconfig.check.json --noEmit', wrong: 'cd tests/e2e && npx tsc --noEmit' },
  'd-gh-jq': { right: "gh run list --branch main -L 20 --json databaseId,conclusion --jq '.[]'", wrong: 'gh run list --branch main -L 20 --json databaseId,conclusion | jq .' },
  's-tls-proxy': { right: 'git checkout main && git pull --ff-only origin main', wrong: 'env -u HTTPS_PROXY -u HTTP_PROXY git pull origin main' },
  's-unpublished-version': { right: 'npm install @acme/ui-kit@3.0.1 && npm run build', wrong: 'npm install ../ui-kit && npm run build' },
  's-db-down': { right: 'npm test', wrong: 'npx vitest run --project unit' },
  'm-node-not-installed': { right: 'node scripts/check-links.mjs docs', wrong: 'python3 -c "print(1)" # check links' },
};

describe('feature-308 inferred cases', () => {
  it('has a probe for every case and unique ids', () => {
    expect(new Set(INFERRED_CASES.map((item) => item.id)).size).toBe(INFERRED_CASES.length);
    expect(Object.keys(PROBES).sort()).toEqual(INFERRED_CASES.map((item) => item.id).sort());
  });

  for (const item of INFERRED_CASES) {
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

      it('the oracle passes the right command and fails the wrong one', () => {
        expect(scoreCommand(item.oracle, bashCall(PROBES[item.id]!.right)).verdict).toBe('pass');
        expect(scoreCommand(item.oracle, bashCall(PROBES[item.id]!.wrong)).verdict).toBe('fail');
      });
    });
  }

  it('judges a build that skips the e2e config, and an edit of the dependency where the case allows edits', () => {
    const byId = (id: string) => INFERRED_CASES.find((item) => item.id === id)!;
    expect(scoreCommand(byId('d-tsc-root').oracle, bashCall('npm run build')).verdict).toBe('fail');
    const editTo = (value: string) => ({ text: '', toolCalls: [{ name: 'edit', input: { path: '/work/project/package.json', edits: [{ old_string: '"file:../ui-kit"', new_string: `"@acme/ui-kit": "${value}",` }] } }] });
    expect(scoreCommand(byId('s-unpublished-version').oracle, editTo('^3.0.1')).verdict).toBe('pass');
    expect(scoreCommand(byId('s-unpublished-version').oracle, editTo('file:../ui-kit')).verdict).toBe('fail');
    expect(scoreCommand(byId('d-node-path').oracle, editTo('vitest run')).verdict).toBe('needs_review');
  });

  it('routes an answer with no judged command to review', () => {
    const item = INFERRED_CASES[0]!;
    expect(scoreCommand(item.oracle, { text: 'Let me look first.', toolCalls: [{ name: 'read', input: { path: 'x' } }] }).verdict).toBe('needs_review');
  });
});
