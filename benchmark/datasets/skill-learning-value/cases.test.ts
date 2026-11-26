import { shouldReflect } from '@kodax-ai/agent';
import { describe, expect, it } from 'vitest';

import { reflectionSystemPrompt, REFLECT_TOOL_NAME } from '../../../packages/coding/src/memory/note-reflection.js';
import { SKILL_VALUE_CASES } from './cases.js';
import { notesOnlyReflectionPrompt, reflectInput } from './inputs.js';
import { classifyCheckpoint, classifyDiscovery } from './oracles.js';

const asCall = (step: { tool: string; input: Record<string, unknown> }) => ({ name: step.tool, input: step.input });
const noWorld = { notes: [], skills: [] };

describe('skill learning value cases', () => {
  it.each(SKILL_VALUE_CASES)('$id session 1 passes the reflection gate', (item) => {
    expect(shouldReflect(item.sessionOne)).toBe(true);
  });

  it.each(SKILL_VALUE_CASES)('$id ground-truth steps pass every checkpoint and the first step', (item) => {
    for (const checkpoint of item.checkpoints) {
      expect(classifyCheckpoint(checkpoint, { text: '', toolCalls: [asCall(item.steps[checkpoint.step]!)] })).toBe('pass');
    }
    expect(classifyDiscovery(item, noWorld, { text: '', toolCalls: [asCall(item.steps[0]!)] })).toBe('step');
  });

  it('classifies the pitfalls session 1 walked into as failures', () => {
    const c1 = SKILL_VALUE_CASES.find((item) => item.id === 'c1')!;
    const bash = (command: string) => ({ text: '', toolCalls: [{ name: 'bash', input: { command } }] });
    expect(classifyCheckpoint(c1.checkpoints[0]!, bash('cargo build --release --target x86_64-unknown-linux-gnu'))).toBe('fail');
    expect(classifyCheckpoint(c1.checkpoints[1]!, bash('node scripts/checksums.mjs dist/ && node scripts/sign.mjs dist/'))).toBe('fail');
    expect(classifyCheckpoint(c1.checkpoints[2]!, bash('git tag v0.9.0 && git push origin v0.9.0'))).toBe('fail');
    const c3 = SKILL_VALUE_CASES.find((item) => item.id === 'c3')!;
    expect(classifyCheckpoint(c3.checkpoints[0]!, bash('git am vendor/patches/*.patch'))).toBe('fail');
    expect(classifyCheckpoint(c3.checkpoints[1]!, bash('npm test'))).toBe('fail');
    const s1 = SKILL_VALUE_CASES.find((item) => item.id === 's1')!;
    const edit = { text: '', toolCalls: [{ name: 'edit', input: { path: '/work/project/src/api/generated/invoices.ts', edits: [] } }] };
    expect(classifyCheckpoint(s1.checkpoints[0]!, edit)).toBe('fail');
  });

  it('arm N drops only the skill paragraph and the skill tool', () => {
    const production = reflectionSystemPrompt();
    const notesOnly = notesOnlyReflectionPrompt(production);
    expect(notesOnly).not.toContain('skill_propose');
    expect(production.split('\n\n').length - notesOnly.split('\n\n').length).toBe(1);
    const item = SKILL_VALUE_CASES[0]!;
    expect(reflectInput(item, 'N').tools.map((tool) => tool.name)).toEqual([REFLECT_TOOL_NAME]);
    expect(reflectInput(item, 'N').userMessage).toBe(reflectInput(item, 'S').userMessage);
  });
});
