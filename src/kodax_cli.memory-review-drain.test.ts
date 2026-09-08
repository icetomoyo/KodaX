/**
 * FEATURE_289 (v0.7.85) §3.4 — `kodax memory review-drain` registration
 * tests. The drain itself performs LLM judge calls, so these tests only
 * pin the command wiring (subcommand + `--max` option + bare-command
 * listing), mirroring kodax_cli.command-options.test.ts conventions.
 */

import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { configureKodaXMemoryCommand } from './kodax_cli.js';

const drain = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({
  reviewed: 0, discarded: 0, failed: 0, deferred: 0,
})));
vi.mock('@kodax-ai/coding', async (importOriginal) => ({
  ...await importOriginal<typeof import('@kodax-ai/coding')>(),
  generateSessionId: async () => 'review-session',
  resolveProvider: () => ({ isConfigured: () => true }),
  installProductionLearningReviewer: (options: unknown) => options,
  drainCodingMemoryReviewInbox: drain,
}));
vi.mock('@kodax-ai/agent', async (importOriginal) => ({
  ...await importOriginal<typeof import('@kodax-ai/agent')>(),
  createMemoryControlPlane: () => ({}),
}));
vi.mock('@kodax-ai/repl', async (importOriginal) => ({
  ...await importOriginal<typeof import('@kodax-ai/repl')>(),
  loadConfig: () => ({}),
}));

describe('FEATURE_289 §3.4 — kodax memory review-drain', () => {
  it('passes a resolved session ID to the review drain', async () => {
    const program = new Command().name('kodax').exitOverride();
    configureKodaXMemoryCommand(program);
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await program.parseAsync(['node', 'kodax', 'memory', 'review-drain', '--max', '1']);
      expect(drain.mock.lastCall?.[3]).toBe('review-session');
    } finally {
      output.mockRestore();
    }
  });
  it('registers the memory command with a review-drain subcommand and --max option', () => {
    const program = new Command().name('kodax').exitOverride();
    const memory = configureKodaXMemoryCommand(program);

    const reviewDrain = memory.commands.find((cmd) => cmd.name() === 'review-drain');
    expect(reviewDrain).toBeDefined();
    expect(reviewDrain?.options.some((opt) => opt.long === '--max')).toBe(true);
  });

  it('prints the command listing on bare `kodax memory` without draining', async () => {
    const program = new Command().name('kodax').exitOverride();
    configureKodaXMemoryCommand(program);

    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(' '));
    });
    try {
      await program.parseAsync(['node', 'kodax', 'memory']);
    } finally {
      spy.mockRestore();
    }

    expect(lines.some((line) => line.includes('review-drain'))).toBe(true);
  });

  it('rejects a non-numeric --max value', async () => {
    const program = new Command().name('kodax').exitOverride();
    configureKodaXMemoryCommand(program);

    await expect(
      program.parseAsync(['node', 'kodax', 'memory', 'review-drain', '--max', 'abc']),
    ).rejects.toThrow();
  });
});
