import { afterEach, expect, it, vi } from 'vitest';
import { createCustomProvider } from '@kodax-ai/llm';
import { KODAX_TOOLS } from './index.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it('sends relationship_scan depth as an integer range through a custom provider with the full tool catalog', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
    `data: ${JSON.stringify({
      id: 'schema-compatibility',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'test-model',
      choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }],
    })}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  ));
  vi.stubEnv('KODAX_SCHEMA_COMPATIBILITY_KEY', 'local-test-only');
  const provider = createCustomProvider({
    name: 'schema-compatibility',
    protocol: 'openai',
    model: 'test-model',
    apiKeyEnv: 'KODAX_SCHEMA_COMPATIBILITY_KEY',
    baseUrl: 'https://example.test/v1',
  });

  const result = await provider.stream(
    [{ role: 'user', content: 'hello' }], KODAX_TOOLS, '', false,
  );

  expect(result.textBlocks).toEqual([{ type: 'text', text: 'ok' }]);
  expect(result.stopReason).toBe('stop');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const body = fetchMock.mock.calls[0]?.[1]?.body;
  if (typeof body !== 'string') throw new Error('Expected a JSON request body.');
  const request = JSON.parse(body) as {
    tools: {
      type: string;
      function: {
        name: string;
        parameters: { properties: Record<string, Record<string, unknown>>; required?: string[] };
      };
    }[];
  };
  expect(request.tools.map((tool) => tool.function.name)).toEqual(
    KODAX_TOOLS.map((tool) => tool.name),
  );
  const scan = request.tools.find((tool) => tool.function.name === 'relationship_scan');
  expect(scan?.type).toBe('function');
  const depth = scan?.function.parameters.properties.depth;
  // Gemini's Schema enum is string-only; an integer range preserves 1 | 2 | 3.
  expect(depth).toMatchObject({ type: 'integer', minimum: 1, maximum: 3 });
  expect(depth).not.toHaveProperty('enum');
  expect(scan?.function.parameters.required ?? []).not.toContain('depth');
});
