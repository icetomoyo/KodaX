import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureSkillTriggerInputs } from './skill-trigger.capture.js';
import type { FrozenInput } from './first-turn-eval-support.js';

// Invariants over the assembled default first-turn request (AMA root, real Skill catalog, production
// projections). Single-string tests missed the beta.5 compact projection that made every request
// "invoke a Skill first", so this checks what the model actually receives.
const CASES = [
  { id: 'ordinary', task: '请帮我用 Docker 安装 RPM 的离线包' },
  { id: 'review', task: 'Please review the latest changes in the current code.' },
];

/** Global first-step mandates: each one competes with every request, so none may reach the model. */
const UNCONDITIONAL_MANDATES = [
  /BLOCKING REQUIREMENT/,
  /before any (task )?response/i,
  /as (the|your) FIRST action/i,
  /first [\w -]{0,30}tool MUST/i,
];

const modelText = (input: FrozenInput): string => [input.system, ...input.messages.map(message =>
  typeof message.content === 'string' ? message.content : JSON.stringify(message.content)),
...input.tools.map(tool => `${tool.name}: ${tool.description}`)].join('\n');

describe('default first-turn surface', () => {
  let fixture: string;
  let requests: { id: string; input: FrozenInput; text: string }[];

  beforeAll(async () => {
    fixture = await mkdtemp(path.join(tmpdir(), 'kodax-skill-surface-'));
    const capture = await captureSkillTriggerInputs(fixture, CASES, 'builtin');
    requests = capture.cases.map(row => ({ id: row.id, input: row.input, text: modelText(row.input) }));
  }, 120_000);

  afterAll(async () => {
    await rm(fixture, { recursive: true, force: true });
  });

  it('teaches Skills conditionally with a no-match path', () => {
    for (const request of requests) {
      expect(request.text).toContain('## Available Skills');
      expect(request.text).toContain('When no description clearly covers the request');
    }
  });

  it('carries no unconditional first-step mandate', () => {
    for (const request of requests) {
      for (const pattern of UNCONDITIONAL_MANDATES) expect(request.text).not.toMatch(pattern);
    }
  });

  it('renders no internal routing flag the model could read as a Skill name', () => {
    for (const request of requests) {
      expect(request.text).not.toContain('Brainstorm required');
      expect(request.text).not.toMatch(/Primary task: unknown/);
    }
  });

  it('scopes the product manual to KodaX itself', () => {
    const manual = requests[0]!.input.tools.find(tool => tool.name === 'kodax_manual');
    expect(manual?.description).toContain('KodaX itself');
  });

  // Each check pins one condition a compact projection once dropped.
  it('keeps the trigger conditions of rules that name a Skill or a first tool', () => {
    for (const request of requests) {
      for (const sentence of request.text.split(/(?<=\.)\s+/).filter(s => /use (the )?visual-review/.test(s))) {
        expect(sentence).toContain('visual acceptance requirements');
      }
      expect(request.input.tools.find(tool => tool.name === 'repo_overview')?.description).toContain('needs no call');
      expect(request.text).not.toMatch(/Choose at most \d+ lanes now/);
    }
  });

  it('marks routing labels as a guess the request overrides', () => {
    for (const request of requests) expect(request.text).toContain('These labels are a keyword guess from the request text');
  });

  it('scopes local inspection and the host OS rule to this machine', () => {
    for (const request of requests) {
      expect(request.text).toContain('Answer directly when general knowledge covers the question.');
      expect(request.text).toContain('When the user asks about another system');
    }
  });
});
