import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { KodaXProductClient } from '@kodax-ai/coding/client-contract';
import { createCliClientPlane } from './cli-client-plane.js';
import { createClientInputQueue } from '../packages/repl/src/ui/client-input-queue.js';
import { preparePromptInputArtifacts } from '../packages/repl/src/common/input-artifacts.js';

it.skipIf(process.platform !== 'win32').each(['prompt', 'prepared'] as const)('matches recalled image paths case-insensitively on Windows in the %s path', async mode => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'kodax-client-recall-case-'));
  try {
    const imagePath = path.join(cwd, 'Capture');
    await writeFile(imagePath, 'image-fixture');
    const artifact = { kind: 'image' as const, path: imagePath, mediaType: 'image/png' as const };
    const submit = vi.fn(async () => ({ state: 'queued' as const }));
    const queue = createClientInputQueue({ submit,
      withdraw: async () => ({ text: 'Inspect @"capture"', inputArtifacts: [artifact] }) });
    const recalled = (await queue.pull('s', ['remote'], cwd))!;
    expect(recalled).toBe('Inspect @"capture"');
    if (mode === 'prompt') await queue.submitPrompt({ sessionId: 's', inputId: 'recalled', text: recalled }, cwd);
    else {
      const prepared = preparePromptInputArtifacts(recalled, cwd);
      await queue.submit({ sessionId: 's', inputId: 'recalled', text: prepared.promptText,
        inputArtifacts: prepared.inputArtifacts }, recalled);
    }
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ inputArtifacts: [artifact] }));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

it.each([
  { filename: 'capture', mode: 'prompt', relative: false },
  { filename: 'capture.jpg', mode: 'prompt', relative: false },
  { filename: 'capture', mode: 'prepared', relative: false },
  { filename: 'capture.jpg', mode: 'prepared', relative: false },
  { filename: 'capture', mode: 'prepared', relative: true },
])('preserves explicit image type for recalled $filename in the $mode submission path (relative=$relative)', async ({ filename, mode, relative }) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'kodax-client-recall-type-'));
  try {
    const imagePath = path.join(cwd, filename);
    await writeFile(imagePath, 'image-fixture');
    const artifact = { kind: 'image' as const, path: imagePath, mediaType: 'image/png' as const, source: 'clipboard' as const };
    const submit = vi.fn(async () => ({ state: 'queued' as const, sessionId: 's', inputId: 'recalled' }));
    const client = { inputs: { submit, withdraw: async () => ({ sessionId: 's', inputId: 'remote', text: 'Inspect',
      inputArtifacts: [artifact] }) } } as unknown as KodaXProductClient;
    const queue = createClientInputQueue(createCliClientPlane(client));
    const restored = (await queue.pull('s', ['remote'], cwd))!;
    const recalled = relative ? `Inspect @"${filename}"` : restored;
    if (mode === 'prompt') await queue.submitPrompt({ sessionId: 's', inputId: 'recalled', text: recalled }, cwd);
    else {
      const prepared = preparePromptInputArtifacts(recalled, cwd);
      await queue.submit({ sessionId: 's', inputId: 'recalled', text: prepared.promptText,
        inputArtifacts: prepared.inputArtifacts }, recalled);
    }
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ inputArtifacts: [artifact] }));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

it.each(['detached', 'absolute', 'relative'] as const)('recalls another client image input with %s references and resubmits its attachment', async reference => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'kodax-client-recall-'));
  try {
    const imagePath = path.join(cwd, 'screen shot.png');
    await writeFile(imagePath, 'image-fixture');
    const text = reference === 'detached' ? 'Inspect this image.'
      : `Inspect @"${reference === 'absolute' ? imagePath : 'screen shot.png'}"`;
    const submit = vi.fn(async () => ({ state: 'queued' as const, sessionId: 's', inputId: 'recalled' }));
    const client = { inputs: { submit, withdraw: async () => ({ sessionId: 's', inputId: 'remote', text,
      inputArtifacts: [{ kind: 'image', path: imagePath, mediaType: 'image/png' }] }) } } as unknown as KodaXProductClient;
    // A new queue has no original local composer draft to mask a lost attachment.
    const queue = createClientInputQueue(createCliClientPlane(client));
    const recalled = await queue.pull('s', ['remote'], cwd);
    expect(recalled).toBe(reference === 'detached' ? `${text} @"${imagePath}"` : text);
    await queue.submitPrompt({ sessionId: 's', inputId: 'recalled', text: `${recalled} Please explain.` }, cwd);
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('Please explain.'),
      inputArtifacts: [expect.objectContaining({ kind: 'image', path: imagePath, mediaType: 'image/png' })],
    }));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

it('scopes recalled metadata to its session and removes it after a submission that deletes the reference', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'kodax-client-recall-scope-'));
  try {
    const imagePath = path.join(cwd, 'capture');
    await writeFile(imagePath, 'image-fixture');
    const artifact = { kind: 'image' as const, path: imagePath, mediaType: 'image/png' as const };
    const submit = vi.fn(async () => ({ state: 'submitted' as const }));
    const queue = createClientInputQueue({ submit, withdraw: async () => ({ text: 'Inspect', inputArtifacts: [artifact] }) });
    const recalled = (await queue.pull('owner', ['remote'], cwd))!;
    await queue.submitPrompt({ sessionId: 'other', inputId: 'foreign', text: recalled }, cwd);
    expect(submit).toHaveBeenLastCalledWith(expect.objectContaining({ inputArtifacts: [] }));
    await queue.submitPrompt({ sessionId: 'owner', inputId: 'without-image', text: 'Only inspect text' }, cwd);
    expect(submit).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'Only inspect text', inputArtifacts: [] }));
    await queue.submitPrompt({ sessionId: 'owner', inputId: 'later', text: recalled }, cwd);
    expect(submit).toHaveBeenLastCalledWith(expect.objectContaining({ inputArtifacts: [] }));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

it('retains explicit image metadata after a failed submission and after taking a submitted draft back again', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'kodax-client-recall-retry-'));
  try {
    const imagePath = path.join(cwd, 'capture');
    await writeFile(imagePath, 'image-fixture');
    const artifact = { kind: 'image' as const, path: imagePath, mediaType: 'image/png' as const };
    let fail = true;
    const submit = vi.fn(async () => {
      if (fail) throw new Error('acknowledgement lost');
      return { state: 'queued' as const };
    });
    const queue = createClientInputQueue({ submit, readInput: async () => null,
      withdraw: async () => ({ text: 'Inspect', inputArtifacts: [artifact] }) });
    const recalled = (await queue.pull('owner', ['remote'], cwd))!;
    await expect(queue.submitPrompt({ sessionId: 'owner', inputId: 'failed', text: recalled }, cwd)).rejects.toThrow('acknowledgement lost');
    const retry = (await queue.pull('owner', [], cwd))!;
    expect(retry).toBe(recalled);
    fail = false;
    await queue.submitPrompt({ sessionId: 'owner', inputId: 'retry', text: retry }, cwd);
    expect(submit).toHaveBeenLastCalledWith(expect.objectContaining({ inputArtifacts: [artifact] }));
    const again = (await queue.pull('owner', ['retry'], cwd))!;
    await queue.submitPrompt({ sessionId: 'owner', inputId: 'again', text: again }, cwd);
    expect(submit).toHaveBeenLastCalledWith(expect.objectContaining({ inputArtifacts: [artifact] }));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

it('reports a recalled extensionless image that disappears before a prepared submission', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'kodax-client-recall-missing-'));
  try {
    const imagePath = path.join(cwd, 'capture');
    await writeFile(imagePath, 'image-fixture');
    const artifact = { kind: 'image' as const, path: imagePath, mediaType: 'image/png' as const };
    const submit = vi.fn(async () => ({ state: 'submitted' as const }));
    const report = vi.fn();
    const queue = createClientInputQueue({ submit,
      withdraw: async () => ({ text: 'Inspect', inputArtifacts: [artifact] }) }, report);
    const recalled = (await queue.pull('owner', ['remote'], cwd))!;
    await rm(imagePath);
    const prepared = preparePromptInputArtifacts(recalled, cwd);
    await queue.submit({ sessionId: 'owner', inputId: 'missing', text: prepared.promptText,
      inputArtifacts: prepared.inputArtifacts }, recalled);
    expect(report).toHaveBeenCalledWith(expect.stringContaining('[Image input missing]'));
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ inputArtifacts: [] }));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
