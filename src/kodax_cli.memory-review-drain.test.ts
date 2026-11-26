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
  it('does not drain the legacy inbox while note memory is on', async () => {
    // The legacy reviewer can create or patch learned skills, and note memory
    // is the default, so a leftover legacy job must not run unless the user
    // switched back to the legacy plane.
    vi.stubEnv('KODAX_MEMORY_NOTES', '1');
    drain.mockClear();
    const program = new Command().name('kodax').exitOverride();
    configureKodaXMemoryCommand(program);
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await program.parseAsync(['node', 'kodax', 'memory', 'review-drain']);
      expect(drain).not.toHaveBeenCalled();
      expect(output.mock.calls.flat().join('\n')).toContain('KODAX_MEMORY_NOTES=0');
    } finally {
      output.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('registers the memory command with a review-drain subcommand and --max option', () => {
    const program = new Command().name('kodax').exitOverride();
    const memory = configureKodaXMemoryCommand(program);

    const reviewDrain = memory.commands.find((cmd) => cmd.name() === 'review-drain');
    expect(reviewDrain).toBeDefined();
    expect(reviewDrain?.options.some((opt) => opt.long === '--max')).toBe(true);
  });

  it('shows help on bare `kodax memory` without draining', async () => {
    let stderr = '';
    const program = new Command().name('kodax').exitOverride()
      .configureOutput({ writeErr: (text) => { stderr += text; } });
    configureKodaXMemoryCommand(program);

    await expect(program.parseAsync(['node', 'kodax', 'memory'])).rejects.toMatchObject({ exitCode: 1 });
    expect(stderr).toContain('review-drain');
  });

  it('rejects a non-numeric --max value', async () => {
    const program = new Command().name('kodax').exitOverride();
    configureKodaXMemoryCommand(program);

    await expect(
      program.parseAsync(['node', 'kodax', 'memory', 'review-drain', '--max', 'abc']),
    ).rejects.toThrow();
  });
});
