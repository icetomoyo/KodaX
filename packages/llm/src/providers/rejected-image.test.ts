import { expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createCustomProvider } from './custom-provider.js';
import { getRejectedImageHash, recordRejectedImage } from './rejected-image.js';

for (const protocol of ['anthropic', 'openai'] as const) {
  for (const method of ['complete', 'stream'] as const) it(`${protocol}/${method} preserves precise serialized-image evidence through provider error wrapping`, async () => {
    const provider = createCustomProvider({ name: 'rejected-image', protocol, model: 'vision', imageInput: true,
      baseUrl: 'https://unused.invalid', apiKeyEnv: 'UNUSED' });
    let expected: string | undefined;
    const create = async (request: { messages: unknown[] }) => {
      const visit = (value: unknown, address: string): string | undefined => {
        if (!value || typeof value !== 'object') return;
        const block = value as Record<string, unknown>;
        const source = block.source as { data?: string } | undefined;
        const url = block.image_url as { url?: string } | undefined;
        const bytes = source?.data ?? url?.url?.split(',')[1];
        if (bytes) { expected = createHash('sha256').update(Buffer.from(bytes, 'base64')).digest('hex'); return address; }
        for (const [key, child] of Object.entries(value)) {
          const found = visit(child, `${address}${/^\d+$/.test(key) ? `[${key}]` : `.${key}`}`);
          if (found) return found;
        }
      };
      const address = visit(request.messages, 'messages');
      throw Object.assign(new Error(`Invalid image format at ${address}`), { status: 400 });
    };
    Reflect.set(provider, '_client', protocol === 'anthropic' ? { messages: { create } } : { chat: { completions: { create } } });
    try {
      await provider[method]([{ role: 'assistant', content: 'Prior text.' }, { role: 'user', content: [
        { type: 'image', path: 'tests/fixtures/images/valid-png.png' }] }], [], 'system');
      throw new Error('Expected provider rejection');
    } catch (error) {
      expect(expected).toBeDefined();
      expect(getRejectedImageHash(error as Error)).toBe(expected);
      expect(JSON.stringify(error)).not.toContain(expected);
    }
  });
}

it('ignores ambiguous or unrelated image error locations', () => {
  const block = (data: string) => ({ type: 'image', source: { type: 'base64', data: Buffer.from(data).toString('base64') } });
  const request = { messages: [{ content: [block('first'), block('second')] }] };
  for (const message of ['Invalid image format at messages[0].content[0] and messages[0].content[1]',
    'Invalid image format at messages[3].content[0]',
    'Invalid image format at messages[0].content[0] and messages[9].content[1]', 'Invalid image format without a location',
    'API key invalid at messages[0].content[0]']) {
    const error = new Error(message);
    recordRejectedImage(error, request);
    expect(getRejectedImageHash(error)).toBeUndefined();
  }
});

for (const protocol of ['anthropic', 'openai'] as const) {
  for (const method of ['complete', 'stream'] as const) {
    it.each([
      [429, 'Rate limit exceeded'], [400, 'Unsupported reasoning_effort'],
      [400, 'Invalid tool_choice'], [400, 'Context length exceeded. Please reduce max_tokens to 1000.'],
    ])(`${protocol}/${method} sends only once when caller owns the recovery budget (%s %s)`, async (status, message) => {
      const provider = createCustomProvider({ name: 'single-recovery', protocol, model: 'vision',
        baseUrl: 'https://unused.invalid', apiKeyEnv: 'UNUSED' });
      const create = vi.fn(async (_request: unknown, options?: { maxRetries?: number }) => {
        expect(options?.maxRetries).toBe(0);
        throw Object.assign(new Error(message), { status });
      });
      Reflect.set(provider, '_client', protocol === 'anthropic' ? { messages: { create } } : { chat: { completions: { create } } });
      await expect(provider[method]([{ role: 'user', content: 'Continue.' }], [], 'system', false,
        { singleAttempt: true })).rejects.toBeInstanceOf(Error);
      expect(create).toHaveBeenCalledOnce();
    });
  }
}
