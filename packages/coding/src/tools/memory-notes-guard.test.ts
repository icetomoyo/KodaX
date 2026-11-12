import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { getAgentConfigPath, setAgentConfigHome } from '@kodax-ai/agent';
import { isGovernedMemoryMutationTarget } from '../permissions/agent-home-policy.js';
import { memoryMutationDenial, shellMemoryMutationDenial } from './memory-mutation-guard.js';

describe('FEATURE_306 note store guard', () => {
  afterEach(() => setAgentConfigHome(undefined));

  const home = path.resolve('temp-notes-home');
  const projectNote = (): string => getAgentConfigPath('projects', 'repo', 'notes', 'tests.md');
  const userNote = (): string => getAgentConfigPath('notes', 'tests.md');

  it('denies structured writes to project and user note files', () => {
    setAgentConfigHome(home);
    expect(memoryMutationDenial(projectNote())).toBeDefined();
    expect(memoryMutationDenial(userNote())).toBeDefined();
    expect(isGovernedMemoryMutationTarget(projectNote(), process.cwd(), home)).toBe(true);
    expect(isGovernedMemoryMutationTarget(userNote(), process.cwd(), home)).toBe(true);
  });

  it('keeps note files readable and leaves unrelated paths alone', () => {
    setAgentConfigHome(home);
    expect(isGovernedMemoryMutationTarget(getAgentConfigPath('projects', 'repo', 'sessions', 'a.jsonl'), process.cwd(), home)).toBe(false);
    expect(memoryMutationDenial(path.resolve('src', 'index.ts'))).toBeUndefined();
  });

  it('denies shell mutation of note directories but permits read-only inspection', () => {
    setAgentConfigHome(home);
    expect(shellMemoryMutationDenial(`rm '${projectNote()}'`)).toContain('denied');
    expect(shellMemoryMutationDenial(`Set-Content -Path '${userNote()}' -Value x`)).toContain('denied');
    expect(shellMemoryMutationDenial(`cat '${projectNote()}'`)).toBeUndefined();
  });
});
