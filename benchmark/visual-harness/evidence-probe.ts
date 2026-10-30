/** Controlled follow-up: the Host supplies evidence; this is not autonomous tool use. */
export function buildEvidenceProbeRequest(input: {
  request: Record<string, unknown>; priorAnswer: string; feedbackImage: Buffer; prompt: string;
}): Record<string, unknown> {
  if (!Array.isArray(input.request.messages) || !input.priorAnswer.trim() || !input.feedbackImage.length || !input.prompt.trim()) {
    throw new Error('Frozen messages, real prior answer and supplemental evidence are required.');
  }
  const request = structuredClone(input.request);
  request.messages = [...request.messages as unknown[],
    { role: 'assistant', content: input.priorAnswer },
    { role: 'user', content: [{ type: 'text', text: input.prompt },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${input.feedbackImage.toString('base64')}` } }] },
  ];
  return { ...request, tool_choice: 'none' };
}
