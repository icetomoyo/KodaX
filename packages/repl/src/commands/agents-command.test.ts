import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  KODAX_LEAN_AGENTS_CONTENT,
  agentsCommand,
} from './agents-command.js';

function buildContext(cwd: string) {
  return {
    messages: [],
    runtimeInfo: { workspaceRoot: cwd, executionCwd: cwd },
  };
}

describe('/agents command', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-agents-cmd-'));
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('starts lean review in the Host and leaves its prompt there', async () => {
    fs.writeFileSync(path.join(cwd, 'AGENTS.md'), '# Instructions', 'utf8');
    const reviewAgentsLean = vi.fn(async () => ({ kind: 'started', runId: 'lean-1' }));
    expect(await agentsCommand.handler(['lean'], { ...buildContext(cwd), sessionId: 's1' } as never,
      { reviewAgentsLean } as never, {} as never)).toEqual({ startedRunId: 'lean-1' });
    expect(reviewAgentsLean).toHaveBeenCalledWith({ sessionId: 's1', inputId: expect.any(String) });
  });

  it('creates AGENTS.md with KodaX Lean Mode when absent', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const reloadAgentsFiles = vi.fn(async () => []);

    const result = await agentsCommand.handler(
      ['init'],
      buildContext(cwd) as never,
      { reloadAgentsFiles } as never,
      {} as never,
    );

    const agentsPath = path.join(cwd, 'AGENTS.md');
    expect(fs.readFileSync(agentsPath, 'utf8')).toBe(KODAX_LEAN_AGENTS_CONTENT);
    expect(reloadAgentsFiles).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: true });
  });

  it('does not overwrite an existing AGENTS.md', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const existing = '# Existing Instructions\n\nKeep this.\n';
    const agentsPath = path.join(cwd, 'AGENTS.md');
    fs.writeFileSync(agentsPath, existing, 'utf8');
    const reloadAgentsFiles = vi.fn(async () => []);

    const result = await agentsCommand.handler(
      ['init'],
      buildContext(cwd) as never,
      { reloadAgentsFiles } as never,
      {} as never,
    );

    expect(fs.readFileSync(agentsPath, 'utf8')).toBe(existing);
    expect(reloadAgentsFiles).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: true });
  });

  it('returns a structured failure when init cannot write AGENTS.md', async () => {
    const missingRoot = path.join(cwd, 'missing', 'nested');
    const reloadAgentsFiles = vi.fn(async () => []);

    const result = await agentsCommand.handler(
      ['init'],
      buildContext(missingRoot) as never,
      { reloadAgentsFiles } as never,
      {} as never,
    );

    expect(result).toMatchObject({ success: false });
    expect(typeof result === 'object' ? result.message : '').toContain('/agents init: failed to write');
    expect(reloadAgentsFiles).not.toHaveBeenCalled();
  });

  it('returns a structured failure when init creates the file but reload fails', async () => {
    const reloadAgentsFiles = vi.fn(async () => {
      throw new Error('reload exploded');
    });

    const result = await agentsCommand.handler(
      ['init'],
      buildContext(cwd) as never,
      { reloadAgentsFiles } as never,
      {} as never,
    );

    expect(fs.readFileSync(path.join(cwd, 'AGENTS.md'), 'utf8')).toBe(KODAX_LEAN_AGENTS_CONTENT);
    expect(result).toMatchObject({ success: false });
    expect(typeof result === 'object' ? result.message : '').toContain('failed to reload');
  });

  it('lean initializes AGENTS.md when absent', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const reloadAgentsFiles = vi.fn(async () => []);

    const result = await agentsCommand.handler(
      ['lean'],
      buildContext(cwd) as never,
      { reloadAgentsFiles } as never,
      {} as never,
    );

    expect(fs.readFileSync(path.join(cwd, 'AGENTS.md'), 'utf8')).toBe(KODAX_LEAN_AGENTS_CONTENT);
    expect(reloadAgentsFiles).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: true });
  });

  it('lean returns an LLM invocation for existing AGENTS.md without overwriting it', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const existing = '# Project Rules\n\n- Prefer small diffs.\n';
    const agentsPath = path.join(cwd, 'AGENTS.md');
    fs.writeFileSync(agentsPath, existing, 'utf8');
    const reloadAgentsFiles = vi.fn(async () => []);

    const result = await agentsCommand.handler(
      ['lean'],
      buildContext(cwd) as never,
      { reloadAgentsFiles } as never,
      {} as never,
    );

    expect(fs.readFileSync(agentsPath, 'utf8')).toBe(existing);
    expect(reloadAgentsFiles).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      invocation: {
        source: 'prompt',
        displayName: '/agents lean',
      },
    });
    const invocation = typeof result === 'object' ? result.invocation : undefined;
    expect(invocation?.prompt).toContain('without duplicating equivalent existing guidance');
    expect(invocation?.prompt).toContain(KODAX_LEAN_AGENTS_CONTENT.trimEnd());
    expect(invocation?.prompt).toContain(existing);
  });

  it('exposes help metadata', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(agentsCommand.name).toBe('agents');
    expect(agentsCommand.usage).toContain('/agents init');
    expect(agentsCommand.usage).toContain('lean');
    expect(agentsCommand.argumentHint).toContain('init');
    expect(agentsCommand.argumentHint).toContain('lean');
    expect(agentsCommand.detailedHelp).toBeDefined();

    agentsCommand.detailedHelp?.();
    expect(log).toHaveBeenCalled();
  });
});
