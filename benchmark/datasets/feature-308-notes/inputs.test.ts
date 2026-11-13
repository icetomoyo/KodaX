import { describe, expect, it } from 'vitest';

import { FEATURE_308_READ_CASES } from '../feature-308-baseline/cases.js';
import { FEATURE_308_PROBE_CASES } from './cases.js';
import { buildNotesCellInput } from './inputs.js';

const text = (message: { content: unknown }): string =>
  typeof message.content === 'string' ? message.content : JSON.stringify(message.content);

describe('arm N inputs', () => {
  it('carry the memory tool, the note rules and the seeded index', async () => {
    const readCase = FEATURE_308_READ_CASES.find((item) => item.id === 'c1')!;
    const input = await buildNotesCellInput(readCase);
    expect(input.tools.map((tool) => tool.name)).toContain('memory');
    expect(input.tools.map((tool) => tool.name)).not.toContain('memory_recall');
    const context = input.priorMessages.map(text).find((item) => item.includes('# Memory'))!;
    expect(context).toContain('make check-fast');
    expect(context).toContain('memory tool');
  });

  it('are byte-stable across builds (fixed fixture paths)', async () => {
    const probe = FEATURE_308_PROBE_CASES.find((item) => item.id === 'n7')!;
    const first = JSON.stringify(await buildNotesCellInput(probe));
    expect(JSON.stringify(await buildNotesCellInput(probe))).toBe(first);
  });

  it('show an empty index for a probe without seeds and leave the process environment untouched', async () => {
    const before = process.env.KODAX_MEMORY_NOTES;
    const input = await buildNotesCellInput(FEATURE_308_PROBE_CASES.find((item) => item.id === 'n5')!);
    expect(input.priorMessages.map(text).join('\n')).toContain('(no notes yet)');
    expect(process.env.KODAX_MEMORY_NOTES).toBe(before);
  });
});
