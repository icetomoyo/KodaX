import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createCustomProvider, createProviderCredentialLeaseScope, runWithProviderCredentialLeaseScope,
  withProviderRequestCredential, KodaXProviderError, type KodaXMessage } from '@kodax-ai/llm';
import * as images from '../../../llm/src/providers/image-serialization.js';
import { recordRejectedImage } from '../../../llm/src/providers/rejected-image.js';
import { createTextRecoveryState, projectTextRecovery, tryTextRecovery, type TextRecoveryInput } from './text-recovery.js';

afterEach(() => vi.restoreAllMocks());

const orphanHistory = (): KodaXMessage[] => [{ role: 'user', content: [
  { type: 'tool_result', tool_use_id: 'completed-write', content: 'Invoice saved successfully: invoice-42.json' },
] }];

function setup(plan: Record<string, unknown> = { action: 'repair_tool_history' }) {
  const provider = createCustomProvider({ name: 'recovery-test', protocol: 'openai', model: 'test-model',
    baseUrl: 'https://provider.invalid', apiKeyEnv: 'UNUSED_RECOVERY_TEST_KEY' });
  const response: Awaited<ReturnType<typeof provider.complete>> = {
    textBlocks: [{ type: 'text', text: JSON.stringify(plan) }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn',
  };
  const complete = vi.spyOn(provider, 'complete').mockResolvedValue(response);
  const input: TextRecoveryInput = { state: createTextRecoveryState(),
    error: new KodaXProviderError('Invalid tool_call_id in history', provider.name, { httpStatus: 400 }),
    messages: orphanHistory(), provider, system: 'Help with the invoice.', reasoning: { enabled: false },
    attempt: 1, maxAttempts: 4, timeoutMs: 1000, onUsage: vi.fn(), onStart: vi.fn() };
  return { input, complete, response };
}

it('does not diagnose an authentication signature error reported as HTTP 400', async () => {
  const { input, complete } = setup({ action: 'sanitize_thinking' });
  input.error = new KodaXProviderError('API key signature invalid', input.provider.name, { httpStatus: 400 });
  expect(await tryTextRecovery(input)).toBe(false);
  expect(complete).not.toHaveBeenCalled();
});

it('retains completed orphan tool evidence when repairing the request view', async () => {
  const { input } = setup();
  const original = structuredClone(input.messages);
  await tryTextRecovery(input);
  expect(JSON.stringify(projectTextRecovery(input.messages, input.state))).toContain('Invoice saved successfully: invoice-42.json');
  expect(input.messages).toEqual(original);
});

it('does not inspect unrelated images for a pure tool-history error', async () => {
  const inspect = vi.spyOn(images, 'inspectPreparedImage').mockResolvedValue({
    validation: { status: 'valid', mediaType: 'image/png' }, dataHash: 'valid-image',
  });
  const { input } = setup();
  input.messages.push({ role: 'user', content: [{ type: 'image', path: 'unrelated.png' }] });
  await tryTextRecovery(input);
  expect(inspect).not.toHaveBeenCalled();
});

it.each([
  ['Quota exceeded', 400], ['Insufficient balance', 400], ['Permission denied', 422],
  ['Invalid tool_call_id', 401], ['Invalid tool_call_id', 403], ['Invalid tool_call_id', 500],
])('does not diagnose %s (HTTP %i)', async (message, status) => {
  const { input, complete } = setup();
  input.error = new KodaXProviderError(message, input.provider.name, { httpStatus: status });
  expect(await tryTextRecovery(input)).toBe(false);
  expect(complete).not.toHaveBeenCalled();
});

it('does not spend a diagnostic when the remaining request budget cannot include the resume', async () => {
  const { input, complete } = setup();
  input.attempt = 3;
  expect(await tryTextRecovery(input)).toBe(false);
  expect(complete).not.toHaveBeenCalled();
});

it('does not diagnose while a follow-up is already pending', async () => {
  const { input, complete } = setup();
  input.hasPendingInputs = () => true;
  expect(await tryTextRecovery(input)).toBe(false);
  expect(complete).not.toHaveBeenCalled();
});

it.each(['queued input', 'history mutation'])('discards a diagnostic made stale by %s', async (change) => {
  const { input, complete, response } = setup();
  let pending = false;
  input.hasPendingInputs = () => pending;
  complete.mockImplementation(async () => {
    if (change === 'queued input') pending = true;
    else input.messages.push({ role: 'user', content: 'Stop editing the invoice.' });
    return response;
  });
  expect(await tryTextRecovery(input)).toBe(false);
  expect(projectTextRecovery(input.messages, input.state)).toBe(input.messages);
});

it('does not make a request after caller cancellation', async () => {
  const { input, complete } = setup();
  const abort = new AbortController();
  abort.abort();
  input.signal = abort.signal;
  expect(await tryTextRecovery(input)).toBe(false);
  expect(complete).not.toHaveBeenCalled();
});

it('propagates caller cancellation to an in-flight diagnostic request', async () => {
  const { input, complete } = setup();
  const abort = new AbortController();
  input.signal = abort.signal;
  complete.mockImplementation(async (_messages, _tools, _system, _reasoning, _options, signal) => {
    if (!signal) throw new Error('Diagnostic request has no abort signal');
    const cancelled = new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    abort.abort(new DOMException('Cancelled by test', 'AbortError'));
    return cancelled;
  });
  await expect(tryTextRecovery(input)).rejects.toMatchObject({ name: 'AbortError' });
  expect(projectTextRecovery(input.messages, input.state)).toBe(input.messages);
});

it('stops a timed-out diagnostic request without applying its plan', async () => {
  const { input, complete } = setup();
  input.timeoutMs = 20;
  complete.mockImplementation(async (_messages, _tools, _system, _reasoning, _options, signal) => {
    if (!signal) throw new Error('Diagnostic request has no deadline signal');
    return new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  expect(await tryTextRecovery(input)).toBe(false);
  expect(projectTextRecovery(input.messages, input.state)).toBe(input.messages);
});

function imageSetup(attachmentId = 'm0/b0') {
  const fixture = setup({ action: 'omit_attachment', attachmentId });
  fixture.input.error = new KodaXProviderError('Invalid image format', fixture.input.provider.name, { httpStatus: 400 });
  fixture.input.messages = [{ role: 'user', content: [{ type: 'image', path: 'original.png', mediaType: 'image/png' }] }];
  return fixture;
}

it.each(['unknown-id', 'm0/b0'])('does not omit a valid image when diagnosis selects %s without rejection evidence', async (id) => {
  vi.spyOn(images, 'inspectPreparedImage').mockResolvedValue({
    validation: { status: 'valid', mediaType: 'image/png' }, dataHash: 'normal-image',
  });
  const { input } = imageSetup(id);
  const original = structuredClone(input.messages);
  expect(await tryTextRecovery(input)).toBe(false);
  expect(projectTextRecovery(input.messages, input.state)).toEqual(original);
  expect(input.messages).toEqual(original);
});

it('permits only one diagnostic in the recovery scope and preserves canonical image history', async () => {
  vi.spyOn(images, 'inspectPreparedImage').mockResolvedValue({ validation: { status: 'invalid' }, dataHash: 'bad-image' });
  const { input, complete } = imageSetup();
  const original = structuredClone(input.messages);
  expect(await tryTextRecovery(input)).toBe(true);
  expect(await tryTextRecovery(input)).toBe(false);
  expect(complete).toHaveBeenCalledOnce();
  expect(JSON.stringify(projectTextRecovery(input.messages, input.state))).not.toContain('original.png');
  expect(input.messages).toEqual(original);
});

it('stops waiting for local inspection at the diagnostic deadline', async () => {
  let finish!: (result: Awaited<ReturnType<typeof images.inspectPreparedImage>>) => void;
  vi.spyOn(images, 'inspectPreparedImage').mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const { input, complete } = imageSetup();
  input.timeoutMs = 20;
  const recovery = tryTextRecovery(input);
  let probeTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([recovery.then(() => 'settled'), new Promise<string>(resolve => {
      probeTimer = setTimeout(() => resolve('still waiting'), 250);
    })]);
    expect(result).toBe('settled');
    expect(complete).not.toHaveBeenCalled();
  } finally {
    if (probeTimer) clearTimeout(probeTimer);
    finish({ validation: { status: 'invalid' }, dataHash: 'bad-image' });
    await recovery;
  }
});

it('retains exact rejected-image evidence across broker credential redaction', async () => {
  const { input } = imageSetup();
  const bytes = Buffer.from('upstream-rejected-original-image');
  const dataHash = createHash('sha256').update(bytes).digest('hex');
  vi.spyOn(images, 'getPreparedImageDiagnostic').mockReturnValue({ dataHash, mediaType: 'image/png' });
  vi.spyOn(images, 'inspectPreparedImage').mockResolvedValue({
    validation: { status: 'valid', mediaType: 'image/png' }, dataHash,
  });
  input.error.message = 'Invalid image format at messages[0].content[0]';
  recordRejectedImage(input.error, { messages: [{ role: 'user', content: [{ type: 'image_url',
    image_url: { url: `data:image/png;base64,${bytes.toString('base64')}` } }] }] });
  const scope = createProviderCredentialLeaseScope({ allowedProviders: [input.provider.name],
    acquire: async () => 'synthetic-credential-for-redaction' });
  try {
    const failure = await runWithProviderCredentialLeaseScope(scope, () => withProviderRequestCredential(
      input.provider.name, 'primary', undefined, async () => { throw input.error; },
    ).catch((error: unknown) => error));
    if (!(failure instanceof Error)) throw new Error('Expected a provider failure');
    input.error = failure;
    expect(await tryTextRecovery(input)).toBe(true);
  } finally { scope.close(); }
});

it('omits only the inspected bad image and preserves a valid companion and completed result', async () => {
  const { input } = imageSetup('m0/b0/i1');
  const bad = { type: 'image' as const, path: 'bad.png' };
  const good = { type: 'image' as const, path: 'good.png' };
  input.messages = [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-header', content: [
    { type: 'text', text: 'Existing quote file was saved.' }, bad, good,
  ] }] }];
  vi.spyOn(images, 'inspectPreparedImage').mockImplementation(async block => block === bad
    ? { validation: { status: 'invalid' }, dataHash: 'bad' }
    : { validation: { status: 'valid', mediaType: 'image/png' }, dataHash: 'good' });
  const original = structuredClone(input.messages);
  expect(await tryTextRecovery(input)).toBe(true);
  const projected = projectTextRecovery(input.messages, input.state);
  expect(JSON.stringify(projected)).toContain('Existing quote file was saved.');
  expect(JSON.stringify(projected)).toContain('good.png');
  expect(JSON.stringify(projected)).not.toContain('bad.png');
  expect(input.messages).toEqual(original);
});

it('does not erase a write whose execution status is unknown', async () => {
  const { input } = setup();
  input.messages = [{ role: 'user', content: 'Continue the existing task.' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'unfinished', name: 'write', input: { path: 'invoice' } }] }];
  const original = structuredClone(input.messages);
  expect(await tryTextRecovery(input)).toBe(false);
  expect(JSON.stringify(projectTextRecovery(input.messages, input.state))).toContain('unfinished');
  expect(input.messages).toEqual(original);
});

it('cleans explicitly rejected opaque reasoning without deleting ordinary text', async () => {
  const { input } = setup({ action: 'sanitize_thinking' });
  input.error.message = 'Invalid thinking signature';
  input.messages = [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'private trace', signature: 'old' },
    { type: 'text', text: 'The draft was saved.' }] }];
  expect(await tryTextRecovery(input)).toBe(true);
  const projected = JSON.stringify(projectTextRecovery(input.messages, input.state));
  expect(projected).not.toContain('private trace');
  expect(projected).toContain('The draft was saved.');
});

it.each(['malformed', 'truncated', 'tool-call'])('does not apply a %s diagnostic response', async kind => {
  const { input, response } = imageSetup();
  vi.spyOn(images, 'inspectPreparedImage').mockResolvedValue({ validation: { status: 'invalid' }, dataHash: 'bad' });
  if (kind === 'malformed') response.textBlocks[0]!.text = '{incomplete';
  if (kind === 'truncated') response.stopReason = 'max_tokens';
  if (kind === 'tool-call') response.toolBlocks.push({ type: 'tool_use', id: 'write', name: 'write', input: { path: 'invoice' } });
  expect(await tryTextRecovery(input)).toBe(false);
  expect(projectTextRecovery(input.messages, input.state)).toBe(input.messages);
});

it('does not strip fresh valid reasoning produced after the repaired request', async () => {
  const { input } = setup({ action: 'sanitize_thinking' });
  input.error.message = 'Invalid thinking signature';
  input.messages = [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'rejected', signature: 'old' }] }];
  expect(await tryTextRecovery(input)).toBe(true);
  const fresh = { type: 'thinking' as const, thinking: 'fresh valid reasoning', signature: 'new-valid' };
  input.messages.push({ role: 'assistant', content: [fresh, { type: 'text', text: 'Continue.' }] });
  expect(JSON.stringify(projectTextRecovery(input.messages, input.state))).toContain('fresh valid reasoning');
});

it('does not erase later operations after a tool-history projection was activated', async () => {
  const { input } = setup();
  input.messages = [{ role: 'assistant', content: [] }];
  expect(await tryTextRecovery(input)).toBe(true);
  input.messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: 'later-write', name: 'write', input: { path: 'invoice' } }] });
  expect(JSON.stringify(projectTextRecovery(input.messages, input.state))).toContain('later-write');
});
