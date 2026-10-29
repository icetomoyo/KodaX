import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Jimp } from 'jimp';
import { freezeVisualPilot, writeVisualPilot } from './pilot-plan.js';

it('freezes exact production tool bytes, equal initial evidence and a zero-generation authorization', () => {
  const baseline = { model: 'old', messages: [{ role: 'system', content: 'production system' }, { role: 'user', content: 'old task' }],
    tools: [{ type: 'function', function: { name: 'visual_inspect', description: 'Literal production bytes.', parameters: { type: 'object' } } }] };
  const candidate = { ...baseline, tools: [...baseline.tools, { type: 'function', function: { name: 'visual_read_pixels', description: 'Literal numeric contract.', parameters: { type: 'object' } } }] };
  const frozen = freezeVisualPilot({ baseline, candidate, candidateRevision: 'a'.repeat(40), image: Buffer.from('fixed image bytes') });
  expect(frozen.cells).toHaveLength(4);
  expect(frozen.authorizedBudget).toMatchObject({ maxProviderCalls: 0, maxExternalSpendUsd: 0 });
  expect(frozen.proposedBudget).toMatchObject({ maxProviderCalls: 4, maxCallsPerCell: 1, maxRoundsPerCell: 1, maxOutputTokensPerCall: 512 });
  for (const name of ['exact-rgba', 'irrelevant-image']) {
    const pair = frozen.cells.filter(cell => cell.caseId === name);
    expect(pair[0]!.request.messages.at(-1)).toEqual(pair[1]!.request.messages.at(-1));
    expect(pair[0]!.imageSha256).toBe(pair[1]!.imageSha256);
    expect(JSON.stringify(pair[0]!.request.tools)).toBe(JSON.stringify(baseline.tools));
    expect(JSON.stringify(pair[1]!.request.tools)).toBe(JSON.stringify(candidate.tools));
  }
  expect(frozen.externalCalls).toBe(0); expect(frozen.status).toBe('not-executed');
});

it('rejects extra history pictures instead of reporting equal one-frame inputs', () => {
  const baseline = { messages: [{ role: 'system', content: 'same system' }, { role: 'user', content: 'task' }], tools: [{ function: { name: 'visual_inspect' } }] };
  const candidate = { ...baseline, messages: [baseline.messages[0]!, { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,extra' } }] }, baseline.messages[1]!] };
  expect(() => freezeVisualPilot({ baseline, candidate, candidateRevision: 'a'.repeat(40), image: Buffer.from('same frame') })).toThrow('history image');
});

it('rejects unusable captures and an unfrozen revision before creating an experiment', () => {
  const capture = { messages: [{ role: 'user', content: 'task' }], tools: [{ function: { name: 'read' } }] };
  for (const baseline of [null, [], {}, { ...capture, tools: [] }, { ...capture, messages: [{ role: 'assistant', content: 'done' }] }]) {
    expect(() => freezeVisualPilot({ baseline, candidate: capture, candidateRevision: 'a'.repeat(40), image: Buffer.from('bytes') })).toThrow();
  }
  expect(() => freezeVisualPilot({ baseline: capture, candidate: capture, candidateRevision: 'short', image: Buffer.from('bytes') })).toThrow('exact candidate commit');
  const pinned = freezeVisualPilot({ baseline: capture, candidate: capture, candidateRevision: 'a'.repeat(40), image: Buffer.from('bytes'), provider: 'offline', model: 'pinned-fixture' });
  expect(pinned.cells.every(cell => cell.request.model === 'pinned-fixture')).toBe(true);
  expect(pinned.routeVerified).toBe(false);
});

it('writes four frozen request drafts and the exact alpha fixture to OS Temp without contacting a provider', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-visual-plan-inputs-'));
  let output: string | undefined;
  try {
    const source = { model: 'fixture', messages: [{ role: 'system', content: 'production' }, { role: 'user', content: 'task' }],
      tools: [{ type: 'function', function: { name: 'inspect', description: 'actual bytes', parameters: { type: 'object' } } }] };
    const baselineFile = path.join(directory, 'baseline.json'); const candidateFile = path.join(directory, 'candidate.json');
    await writeFile(baselineFile, JSON.stringify(source)); await writeFile(candidateFile, JSON.stringify(source));
    output = await writeVisualPilot({ baselineFile, candidateFile, candidateRevision: 'a'.repeat(40) });
    const plan = JSON.parse(await readFile(path.join(output, 'plan.json'), 'utf8')) as { externalCalls: number; cells: { caseId: string; arm: string }[] };
    expect(plan.externalCalls).toBe(0); expect(plan.cells).toHaveLength(4);
    for (const cell of plan.cells) {
      const body = JSON.parse(await readFile(path.join(output, `${cell.caseId}-${cell.arm}.json`), 'utf8')) as { tools: unknown; max_completion_tokens: number };
      expect(body.tools).toEqual(source.tools); expect(body.max_completion_tokens).toBe(512);
    }
    const png = await Jimp.read(await readFile(path.join(output, 'reference.png')));
    expect(png.getPixelColor(1, 1)).toBe(0x00ffff80);
    expect(JSON.parse(await readFile(path.join(output, 'review-template.json'), 'utf8'))).toMatchObject({ status: 'not-executed', recommendation: null });
  } finally {
    await rm(directory, { recursive: true, force: true });
    if (output) { expect(path.dirname(path.resolve(output))).toBe(path.resolve(os.tmpdir())); await rm(output, { recursive: true, force: true }); }
  }
});
