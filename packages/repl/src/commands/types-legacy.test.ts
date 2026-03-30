import { describe, expect, it } from 'vitest';
import { toCommandDefinition, type CommandHooks } from './types.js';

describe('legacy command metadata parity', () => {
  it('fills builtin defaults and derives argument hints from usage', () => {
    const definition = toCommandDefinition(
      {
        name: 'review-plan',
        description: 'Review a plan',
        usage: '/review-plan <topic>',
        handler: async () => {},
      },
      'builtin',
    );

    expect(definition.source).toBe('builtin');
    expect(definition.userInvocable).toBe(true);
    expect(definition.disableModelInvocation).toBe(false);
    expect(definition.argumentHint).toBe('<topic>');
  });

  it('preserves explicit execution metadata on legacy builtin commands', () => {
    const hooks: CommandHooks = {
      UserPromptSubmit: [{ command: 'echo hi' }],
    };

    const definition = toCommandDefinition(
      {
        name: 'inspect',
        description: 'Inspect the current workspace',
        usage: '/inspect [path]',
        allowedTools: 'Read, Grep',
        agent: 'workspace-inspector',
        argumentHint: '<path>',
        model: 'gpt-5.4-mini',
        userInvocable: false,
        disableModelInvocation: true,
        hooks,
        frontmatter: { area: 'workspace' },
        handler: async () => {},
      },
      'builtin',
    );

    expect(definition.allowedTools).toBe('Read, Grep');
    expect(definition.agent).toBe('workspace-inspector');
    expect(definition.argumentHint).toBe('<path>');
    expect(definition.model).toBe('gpt-5.4-mini');
    expect(definition.userInvocable).toBe(false);
    expect(definition.disableModelInvocation).toBe(true);
    expect(definition.hooks).toEqual(hooks);
    expect(definition.frontmatter).toEqual({ area: 'workspace' });
  });
});
