import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { getAgentConfigPath, setAgentConfigHome } from '@kodax-ai/agent';
import { memoryMutationDenial, shellMemoryMutationDenial } from './memory-mutation-guard.js';

describe('FEATURE_260 memory mutation guard', () => {
  afterEach(() => setAgentConfigHome(undefined));

  it('denies structured writes under legacy and scoped memory roots', () => {
    setAgentConfigHome(path.resolve('temp-memory-home'));
    const legacy = getAgentConfigPath('projects', 'repo', 'memory', 'project_stack.md');
    const scoped = getAgentConfigPath(
      'memory-scopes',
      'a'.repeat(64),
      'project',
      'b'.repeat(64),
      'project_stack.md',
    );
    expect(memoryMutationDenial(legacy)).toContain('memory tool you were given');
    expect(memoryMutationDenial(scoped)).toContain('memory tool you were given');
    if (process.platform === 'win32') {
      expect(memoryMutationDenial(scoped.toUpperCase())).toContain('memory tool you were given');
    } else {
      expect(memoryMutationDenial(scoped.toUpperCase())).toBeUndefined();
    }
    expect(memoryMutationDenial(path.resolve('src', 'index.ts'))).toBeUndefined();
  });

  it('denies obvious shell mutation but permits read-only inspection', () => {
    setAgentConfigHome(path.resolve('temp-memory-home'));
    const target = getAgentConfigPath('memory-scopes', 'a'.repeat(64), 'project', 'b'.repeat(64), 'x.md');
    expect(shellMemoryMutationDenial(`Set-Content -Path '${target}' -Value hacked`)).toContain('denied');
    expect(shellMemoryMutationDenial(`rm '${target}'`)).toContain('denied');
    expect(shellMemoryMutationDenial(`node overwrite-memory.js '${target}'`)).toContain('denied');
    expect(shellMemoryMutationDenial(`python -c "open(r'${target}', 'w').write('x')"`)).toContain('denied');
    expect(shellMemoryMutationDenial(`cat '${target}' && node overwrite-memory.js '${target}'`))
      .toContain('denied');
    expect(shellMemoryMutationDenial(`Get-Content '${target}'; Set-Content '${target}' hacked`))
      .toContain('denied');
    expect(shellMemoryMutationDenial(`cat '${target}' | tee '${target}'`)).toContain('denied');
    expect(shellMemoryMutationDenial('cd ~/.kodax && rm -rf memory-scopes')).toContain('denied');
    expect(shellMemoryMutationDenial('rm -rf $HOME/.kodax/memory-scopes')).toContain('denied');
    expect(shellMemoryMutationDenial('cd ~/.kodax/projects/repo && rm -rf memory')).toContain('denied');
    expect(shellMemoryMutationDenial(`Get-Content '${target}'`)).toBeUndefined();
    expect(shellMemoryMutationDenial(`Get-Content '${target.toUpperCase()}'`)).toBeUndefined();
    expect(shellMemoryMutationDenial('node scripts/check-build.mjs')).toBeUndefined();
  });
});
