import { describe, expect, it } from 'vitest';
import { buildEvidenceProbeRequest } from './evidence-probe.js';

describe('frozen evidence follow-up', () => {
  it('keeps the original request and real wrong answer, adding only supplied evidence', () => {
    const original = { model: 'kimi-for-coding', messages: [
      { role: 'system', content: 'Production contract' },
      { role: 'user', content: [{ type: 'text', text: 'Trace J2-3.' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,b3JpZ2luYWw=' } }] },
    ], tools: [{ type: 'function', function: { name: 'visual_inspect', description: 'Frozen production description', parameters: {} } }] };
    const before = structuredClone(original);
    const request = buildEvidenceProbeRequest({ request: original, priorAnswer: 'Motor-E / P1',
      feedbackImage: Buffer.from('related pixels'), prompt: 'Recheck the conclusion using the supplemental view.' });
    expect(request.messages).toEqual([...before.messages,
      { role: 'assistant', content: 'Motor-E / P1' },
      { role: 'user', content: [{ type: 'text', text: 'Recheck the conclusion using the supplemental view.' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,cmVsYXRlZCBwaXhlbHM=' } }] },
    ]);
    expect(request.tools).toEqual(before.tools);
    expect(request.tool_choice).toBe('none');
    expect(original).toEqual(before);
  });

  it('isolates a prepared arm from subsequent edits to the paired arm or frozen prefix', () => {
    const original = { messages: [{ role: 'system', content: 'Frozen instructions' }] };
    const request = buildEvidenceProbeRequest({ request: original, priorAnswer: 'Old answer',
      feedbackImage: Buffer.from('pixels'), prompt: 'Review.' });
    (request.messages as { content: unknown }[])[0]!.content = 'Changed later';
    expect(original.messages[0]!.content).toBe('Frozen instructions');
  });

  it.each([
    { request: {}, priorAnswer: 'answer', feedbackImage: Buffer.from('image'), prompt: 'Review.' },
    { request: { messages: [] }, priorAnswer: '', feedbackImage: Buffer.from('image'), prompt: 'Review.' },
    { request: { messages: [] }, priorAnswer: 'answer', feedbackImage: Buffer.alloc(0), prompt: 'Review.' },
    { request: { messages: [] }, priorAnswer: 'answer', feedbackImage: Buffer.from('image'), prompt: '' },
  ])('rejects missing frozen input instead of manufacturing a transcript', input => {
    expect(() => buildEvidenceProbeRequest(input)).toThrow('required');
  });
});
