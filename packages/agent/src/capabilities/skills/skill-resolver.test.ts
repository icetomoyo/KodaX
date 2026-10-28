import { describe, expect, it, vi } from 'vitest';
import { resolveSkillContent } from './skill-resolver.js';

describe('resolveSkillContent', () => {
  it.each([false, true])('checks substituted commands before execution (Host executor: %s)', async useHost => {
    const execute = vi.fn(async () => 'EXECUTED');
    const resolved = await resolveSkillContent('Output: !`echo $ARGUMENTS`', 'policy-marker', {
      workingDirectory: process.cwd(),
      ...(useHost ? { executeDynamicContext: execute } : {}),
      assertDynamicContextAllowed(command) {
        expect(command).toBe('echo policy-marker');
        throw new Error('Skill policy refused execution');
      },
    });
    expect(resolved).toBe('Output: [Error: Skill policy refused execution]');
    expect(execute).not.toHaveBeenCalled();
  });
  it('blocks unsafe dynamic context commands', async () => {
    const environment = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );

    const resolved = await resolveSkillContent(
      'Context: !`npm install`',
      '',
      {
        sessionId: 'session-1',
        workingDirectory: process.cwd(),
        environment,
      },
    );

    expect(resolved).toContain('Unsafe dynamic context command blocked');
  });
});

// v0.7.42 — `!`cmd`` SDK-embedder hook (gap 3).
//
// Three dispatch tiers in `VariableResolver.executeDynamicCommand`:
//   1. `disableDynamicContext: true` → hard kill switch, throws regardless of hook.
//   2. `executeDynamicContext` provided → host broker takes over, KodaX's
//      whitelist is BYPASSED (the host is presumed to have its own policy).
//   3. neither → legacy whitelist + `execSync`.
//
// Verified via the externally-observable contract (`resolveSkillContent`
// returns either the hook's string output or an `[Error: …]` placeholder),
// not via spying on private internals.
describe('resolveSkillContent — embedder hook dispatch (v0.7.42)', () => {
  it('Tier 1: disableDynamicContext hard-blocks even when hook is present', async () => {
    const hook = vi.fn(async () => 'should not be called');

    const resolved = await resolveSkillContent(
      'Logs: !`ls -la`',
      '',
      {
        workingDirectory: process.cwd(),
        disableDynamicContext: true,
        executeDynamicContext: hook,
      },
    );

    expect(resolved).toContain('Dynamic context disabled by host');
    expect(hook).not.toHaveBeenCalled();
  });

  it('Tier 1: disable applies to every `!`cmd`` token in the same skill', async () => {
    const resolved = await resolveSkillContent(
      'A: !`pwd`\nB: !`whoami`\nC: !`date`',
      '',
      {
        workingDirectory: process.cwd(),
        disableDynamicContext: true,
      },
    );

    const occurrences = resolved.match(/Dynamic context disabled by host/g) ?? [];
    expect(occurrences.length).toBe(3);
  });

  it('Tier 2: executeDynamicContext receives command + cwd and its output is inlined', async () => {
    const hook = vi.fn(async (cmd: string, cwd: string) => {
      expect(cmd).toBe('rm -rf /');  // legacy whitelist would reject this
      expect(cwd).toBe('/repo');
      return 'broker-approved-output';
    });

    const resolved = await resolveSkillContent(
      'Output: !`rm -rf /`',
      '',
      {
        workingDirectory: '/repo',
        executeDynamicContext: hook,
      },
    );

    expect(resolved).toBe('Output: broker-approved-output');
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('Tier 2: hook BYPASSES the built-in safe-command whitelist (broker owns policy)', async () => {
    // `npm install` is rejected by the legacy whitelist (see the test above).
    // With a hook present, the whitelist must be skipped — the host's broker
    // is the authority. Verifies that no double-policy is layered on.
    const hook = vi.fn(async () => 'mocked output');

    const resolved = await resolveSkillContent(
      'Run: !`npm install`',
      '',
      { workingDirectory: process.cwd(), executeDynamicContext: hook },
    );

    expect(resolved).toBe('Run: mocked output');
    expect(hook).toHaveBeenCalledWith('npm install', process.cwd());
  });

  it('Tier 2: hook throw becomes per-token `[Error: …]` placeholder, not full failure', async () => {
    const hook = vi.fn(async (cmd: string) => {
      if (cmd === 'denied') throw new Error('user denied');
      return 'OK';
    });

    const resolved = await resolveSkillContent(
      'A: !`denied`\nB: !`allowed`',
      '',
      { workingDirectory: process.cwd(), executeDynamicContext: hook },
    );

    expect(resolved).toContain('A: [Error: user denied]');
    expect(resolved).toContain('B: OK');
  });

  it('Tier 2: hook output is trimmed (matches legacy execSync behavior)', async () => {
    const hook = vi.fn(async () => '   padded with whitespace\n\n');
    const resolved = await resolveSkillContent(
      'X: !`anything`',
      '',
      { workingDirectory: process.cwd(), executeDynamicContext: hook },
    );
    expect(resolved).toBe('X: padded with whitespace');
  });

  it('Tier 3 (no hook): safe whitelist still permits read-only commands', async () => {
    // `echo` is on the whitelist and exists on every platform (unlike `pwd`,
    // which is absent on Windows and made this test fail there). Verifies the
    // legacy path still works when neither tier 1 nor tier 2 is engaged.
    const resolved = await resolveSkillContent(
      'OUT: !`echo skilltest`',
      '',
      { workingDirectory: process.cwd() },
    );
    expect(resolved).not.toContain('[Error');
    expect(resolved.startsWith('OUT: ')).toBe(true);
    expect(resolved).toContain('skilltest');
  });
});
