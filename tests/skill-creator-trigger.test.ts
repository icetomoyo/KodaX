// skill-creator's trigger eval on the real SDK: the staged candidate reaches the
// product catalog, the first response's calls are recorded without running, and
// one query costs one primary request. A loopback provider stands in for the model.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { KodaXBaseProvider, registerModelProvider, type KodaXMessage, type KodaXProviderConfig,
  type KodaXStreamResult, type KodaXToolDefinition } from '@kodax-ai/llm';
import { runKodaX } from '../packages/coding/src/index.js';
import { runTriggerEval } from '../packages/agent/src/capabilities/skills/builtin/skill-creator/scripts/run-trigger-eval.js';
import { setKodaXSDKForSkillCreator } from '../packages/agent/src/capabilities/skills/builtin/skill-creator/scripts/utils.js';

const PROVIDER = 'skill-creator-trigger-loopback';
const CANDIDATE = 'Use when drafting TRIGGER_FIXTURE_MARK release notes.';

let directory = '';
const primary: Array<{ opening: string; skillCalled: boolean }> = [];

class LoopbackProvider extends KodaXBaseProvider {
  readonly name = PROVIDER;
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = { apiKeyEnv: 'KODAX_SKILL_TRIGGER_KEY', model: 'fixture', contextWindow: 128_000, supportsThinking: false };
  override isConfigured(): boolean { return true; }
  async stream(messages: KodaXMessage[], tools: KodaXToolDefinition[]): Promise<KodaXStreamResult> {
    const done: KodaXStreamResult = { textBlocks: [{ type: 'text', text: 'done' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
    if (tools.length <= 1) return done;
    const opening = JSON.stringify(messages);
    const skillCalled = opening.includes('draft the release notes');
    primary.push({ opening, skillCalled });
    if (!skillCalled) return done;
    return { textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use', toolBlocks: [
      { type: 'tool_use', id: `skill-${primary.length}`, name: 'skill', input: { skill: 'trigger-fixture' } },
      { type: 'tool_use', id: `write-${primary.length}`, name: 'write', input: { path: 'SHOULD_NOT_EXIST.md', content: 'x' } },
    ] };
  }
}

let unregister: () => void = () => undefined;
beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-skill-trigger-'));
  const skillDir = path.join(directory, 'trigger-fixture');
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: trigger-fixture\ndescription: Old description.\n---\n\n# Fixture\n');
  await writeFile(path.join(directory, 'evals.json'), JSON.stringify({ evals: [
    { query: 'draft the release notes', should_trigger: true },
    { query: 'explain git rebase', should_trigger: false },
  ] }));
  unregister = registerModelProvider(PROVIDER, () => new LoopbackProvider());
  setKodaXSDKForSkillCreator({ runKodaX });
});
afterAll(async () => {
  setKodaXSDKForSkillCreator(null);
  unregister();
  await rm(directory, { recursive: true, force: true });
});

it('observes the staged candidate on the real AMA root without running its calls', async () => {
  const report = await runTriggerEval({ skillPath: path.join(directory, 'trigger-fixture'),
    evalsPath: path.join(directory, 'evals.json'), provider: PROVIDER, descriptionOverride: CANDIDATE });

  expect(primary).toHaveLength(2);
  // The Skill catalog rides in the Run Context envelope of the opening message.
  for (const request of primary) expect(request.opening).toContain(CANDIDATE);
  expect(report.results.map(result => result.attempts[0])).toEqual([
    { trigger: true, tool_calls: ['skill:trigger-fixture', 'write'] },
    { trigger: false, tool_calls: [] },
  ]);
  expect(report.summary).toMatchObject({ passed: 2, total: 2 });
}, 60_000);
