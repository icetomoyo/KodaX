import { describe, expect, it } from 'vitest';
import { Command } from 'commander';
import {
  buildSessionOptions,
  createKodaXOptions,
  parseAgentModeOption,
  parseEffortOption,
  parseOptionalNonNegativeInt,
  parseOutputModeOption,
  parseReasoningModeOption,
  parseRepoIntelligenceModeOption,
  normalizeCliSessionFlags,
  resolveCliEffort,
  resolveCliModelSelection,
  resolveCliProviderSelection,
  resolveCliRuntimeMode,
  findSessionTitleMatches,
  validateCliModeSelection,
  parsePermissionModeOption,
  type CliOptions,
} from './cli_option_helpers.js';

describe('parsePermissionModeOption FEATURE_297 migration', () => {
  it('returns only canonical permission profile ids', () => {
    expect(parsePermissionModeOption('auto')).toBe('auto');
    expect(parsePermissionModeOption('full-access')).toBe('full-access');
    expect(parsePermissionModeOption('auto-in-project')).toBe('auto');
  });
});

function createCliOptions(overrides: Partial<CliOptions> = {}): CliOptions {
  return {
    provider: 'openai',
    thinking: true,
    reasoningMode: 'auto',
    effort: 'auto',
    agentMode: 'ama',
    outputMode: 'text',
    prompt: ['inspect', 'repo'],
    noSession: false,
    ...overrides,
  };
}

describe('parseOutputModeOption', () => {
  it('accepts json mode', () => {
    expect(parseOutputModeOption('json')).toBe('json');
  });

  it('rejects unsupported values', () => {
    expect(() => parseOutputModeOption('text')).toThrow(
      'Expected "json". Text mode is the default and does not need --mode.',
    );
  });
});

describe('validateCliModeSelection', () => {
  it('rejects combining --mode json with print mode', () => {
    expect(() =>
      validateCliModeSelection(
        createCliOptions({ outputMode: 'json', print: true }),
      ),
    ).toThrow('`--mode json` cannot be combined with `-p/--print`.');
  });

  it('rejects json mode without a positional prompt', () => {
    expect(() =>
      validateCliModeSelection(
        createCliOptions({ outputMode: 'json', prompt: [] }),
      ),
    ).toThrow('`--mode json` requires a prompt as positional arguments.');
  });

  it('rejects ACP cleanup as a json session-management mode', () => {
    expect(() =>
      validateCliModeSelection(
        createCliOptions({ outputMode: 'json', session: 'cleanup-acp', prompt: [] }),
      ),
    ).toThrow('`--mode json` does not support session management sub-modes.');
  });

  it('rejects bare resume in json mode', () => {
    expect(() =>
      validateCliModeSelection(
        createCliOptions({ outputMode: 'json' }),
        { resumeWithoutId: true },
      ),
    ).toThrow('`--mode json` requires an explicit session ID or exact title for `--resume`');
  });
});

describe('findSessionTitleMatches', () => {
  const sessions = [
    { id: 'session-1', title: 'Review Runtime' },
    { id: 'session-2', title: 'review runtime' },
    { id: 'session-3', title: 'Fix ACP storage' },
  ];

  it('matches titles exactly while ignoring case and surrounding whitespace', () => {
    expect(findSessionTitleMatches(sessions, '  REVIEW RUNTIME  ').map((session) => session.id))
      .toEqual(['session-1', 'session-2']);
  });

  it('does not treat a partial title as a direct resume match', () => {
    expect(findSessionTitleMatches(sessions, 'runtime')).toEqual([]);
  });
});

describe('buildSessionOptions', () => {
  it('allows stateless json mode runs with --no-session', () => {
    const options = buildSessionOptions(
      createCliOptions({ outputMode: 'json', noSession: true }),
    );

    expect(options).toBeUndefined();
  });

  it('marks persisted CLI sessions as user-scoped', () => {
    const options = buildSessionOptions(
      createCliOptions({ continue: true }),
    );

    expect(options).toMatchObject({
      resume: true,
      scope: 'user',
    });
  });
});

describe('normalizeCliSessionFlags', () => {
  it('treats Commander --no-session as noSession without a session id', () => {
    const normalized = normalizeCliSessionFlags({ session: false });

    expect(normalized).toEqual({
      session: undefined,
      noSession: true,
    });
  });

  it('preserves real session strings, including the literal string "false"', () => {
    expect(normalizeCliSessionFlags({ session: 'resume' })).toEqual({
      session: 'resume',
      noSession: false,
    });
    expect(normalizeCliSessionFlags({ session: 'false' })).toEqual({
      session: 'false',
      noSession: false,
    });
  });
});

describe('createKodaXOptions', () => {
  it('ignores the obsolete sandbox environment pass variable', () => {
    const previous = process.env.KODAX_SANDBOX_ENV_PASS;
    process.env.KODAX_SANDBOX_ENV_PASS = 'GH_TOKEN, GITHUB_TOKEN,GH_TOKEN';
    try {
      expect(createKodaXOptions(createCliOptions()).sandbox).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.KODAX_SANDBOX_ENV_PASS;
      else process.env.KODAX_SANDBOX_ENV_PASS = previous;
    }
  });

  it('projects repo intelligence mode and trace flags from runtime env into context', () => {
    const previousMode = process.env.KODAX_REPO_INTELLIGENCE;
    const previousTrace = process.env.KODAX_REPO_INTELLIGENCE_TRACE;
    process.env.KODAX_REPO_INTELLIGENCE = 'full';
    process.env.KODAX_REPO_INTELLIGENCE_TRACE = '1';

    try {
      const options = createKodaXOptions(createCliOptions());
      expect(options.context).toMatchObject({
        repoIntelligenceMode: 'full',
        repoIntelligenceTrace: true,
      });
    } finally {
      if (previousMode === undefined) {
        delete process.env.KODAX_REPO_INTELLIGENCE;
      } else {
        process.env.KODAX_REPO_INTELLIGENCE = previousMode;
      }
      if (previousTrace === undefined) {
        delete process.env.KODAX_REPO_INTELLIGENCE_TRACE;
      } else {
        process.env.KODAX_REPO_INTELLIGENCE_TRACE = previousTrace;
      }
    }
  });

  it('projects resolved effort into KodaX options', () => {
    const options = createKodaXOptions(createCliOptions({ effort: 'high' }));
    expect(options.effort).toBe('high');
  });

  it('projects effort none as disabled thinking', () => {
    const options = createKodaXOptions(createCliOptions({
      effort: 'none',
      thinking: true,
      reasoningMode: 'auto',
    }));

    expect(options.thinking).toBe(false);
    expect(options.reasoningMode).toBe('off');
  });

  it('treats effort off as the user-facing alias for none', () => {
    const effort = parseEffortOption('off');
    const options = createKodaXOptions(createCliOptions({
      effort,
      thinking: true,
      reasoningMode: 'auto',
    }));

    expect(effort).toBe('none');
    expect(options.thinking).toBe(false);
    expect(options.reasoningMode).toBe('off');
  });
});

describe('parseEffortOption', () => {
  it('normalizes effort values case-insensitively', () => {
    expect(parseEffortOption(' HIGH ')).toBe('high');
  });

  it('rejects empty effort values', () => {
    expect(() => parseEffortOption('   ')).toThrow('Reasoning effort cannot be empty.');
  });
});

describe('resolveCliEffort', () => {
  it('uses explicit --effort before config and legacy reasoning', () => {
    const program = new Command();
    program.option('--effort <level>', 'effort');
    program.parse(['node', 'kodax', '--effort', 'high']);

    expect(resolveCliEffort(program, program.opts(), { effort: 'low' })).toBe('high');
  });

  it('uses explicit --effort before KODAX_EFFORT', () => {
    const previous = process.env.KODAX_EFFORT;
    process.env.KODAX_EFFORT = 'low';
    const program = new Command();
    program.option('--effort <level>', 'effort');
    program.parse(['node', 'kodax', '--effort', 'high']);

    try {
      expect(resolveCliEffort(program, program.opts(), { effort: 'medium' })).toBe('high');
    } finally {
      if (previous === undefined) {
        delete process.env.KODAX_EFFORT;
      } else {
        process.env.KODAX_EFFORT = previous;
      }
    }
  });

  it('lets KODAX_EFFORT=auto clear only the env layer', () => {
    const previous = process.env.KODAX_EFFORT;
    process.env.KODAX_EFFORT = 'auto';
    const program = new Command();
    program.option('--effort <level>', 'effort');
    program.parse(['node', 'kodax']);

    try {
      expect(resolveCliEffort(program, program.opts(), { effort: 'medium' })).toBe('medium');
    } finally {
      if (previous === undefined) {
        delete process.env.KODAX_EFFORT;
      } else {
        process.env.KODAX_EFFORT = previous;
      }
    }
  });
});

describe('resolveCliProviderSelection', () => {
  it('uses CLI > env > config > default precedence', () => {
    expect(resolveCliProviderSelection(
      'cli-provider',
      'env-provider',
      'config-provider',
      'default-provider',
    )).toBe('cli-provider');
    expect(resolveCliProviderSelection(
      undefined,
      'env-provider',
      'config-provider',
      'default-provider',
    )).toBe('env-provider');
    expect(resolveCliProviderSelection(
      undefined,
      undefined,
      'config-provider',
      'default-provider',
    )).toBe('config-provider');
    expect(resolveCliProviderSelection(
      undefined,
      undefined,
      undefined,
      'default-provider',
    )).toBe('default-provider');
  });
});

describe('resolveCliRuntimeMode', () => {
  it('uses CLI > env > config > embedded precedence', () => {
    expect(resolveCliRuntimeMode('daemon', 'embedded', 'embedded')).toBe('daemon');
    expect(resolveCliRuntimeMode(undefined, 'daemon', 'embedded')).toBe('daemon');
    expect(resolveCliRuntimeMode(undefined, undefined, 'daemon')).toBe('daemon');
    expect(resolveCliRuntimeMode(undefined, undefined, undefined)).toBe('embedded');
  });

  it('validates environment and config values', () => {
    expect(() => resolveCliRuntimeMode(undefined, 'remote', undefined)).toThrow(
      'Expected one of: embedded, daemon.',
    );
    expect(() => resolveCliRuntimeMode(undefined, undefined, 'remote')).toThrow(
      'Expected one of: embedded, daemon.',
    );
  });
});

describe('parseAgentModeOption', () => {
  it('accepts SA mode case-insensitively', () => {
    expect(parseAgentModeOption('SA')).toBe('sa');
  });

  it.each(['AMAW', 'ama-workflow'])('rejects retired %s with a migration hint', (mode) => {
    expect(() => parseAgentModeOption(mode)).toThrow(/retired in v0\.7\.72.*Use "ama"/);
  });

  it('rejects unsupported agent modes', () => {
    expect(() => parseAgentModeOption('team')).toThrow(
      'Expected one of: ama, sa.',
    );
  });
});

describe('parseReasoningModeOption', () => {
  it('accepts supported reasoning modes', () => {
    expect(parseReasoningModeOption('balanced')).toBe('balanced');
  });

  it('rejects unsupported reasoning modes', () => {
    expect(() => parseReasoningModeOption('verbose')).toThrow(
      'Expected one of: off, auto, quick, balanced, deep.',
    );
  });
});

describe('parseRepoIntelligenceModeOption', () => {
  it('accepts public repo-intelligence modes', () => {
    expect(parseRepoIntelligenceModeOption('full')).toBe('full');
    expect(parseRepoIntelligenceModeOption('light')).toBe('light');
    expect(parseRepoIntelligenceModeOption('auto')).toBe('auto');
    expect(parseRepoIntelligenceModeOption('off')).toBe('off');
  });

  it('rejects unsupported repo-intelligence modes', () => {
    expect(() => parseRepoIntelligenceModeOption('premium')).toThrow(
      'Expected one of: auto, full, light, off.',
    );
  });
});

describe('numeric CLI helpers', () => {
  it('accepts a valid non-negative integer', () => {
    expect(parseOptionalNonNegativeInt('12')).toBe(12);
  });

  it('throws on invalid non-negative integers instead of silently swallowing them', () => {
    expect(() => parseOptionalNonNegativeInt('abc')).toThrow(
      'Expected a non-negative integer, got "abc".',
    );
  });

  it('rejects partially numeric and decimal values', () => {
    expect(() => parseOptionalNonNegativeInt('12abc')).toThrow(
      'Expected a non-negative integer, got "12abc".',
    );
    expect(() => parseOptionalNonNegativeInt('1.5')).toThrow(
      'Expected a non-negative integer, got "1.5".',
    );
  });
});

describe('resolveCliModelSelection', () => {
  it('uses the configured model when the provider is unchanged', () => {
    expect(
      resolveCliModelSelection(
        undefined,
        undefined,
        'zhipu-coding',
        'glm-5.1',
      ),
    ).toBe('glm-5.1');
  });

  it('does not carry a configured model across provider switches', () => {
    expect(
      resolveCliModelSelection(
        'newapi-openai',
        undefined,
        'zhipu-coding',
        'glm-5.1',
      ),
    ).toBeUndefined();
  });

  it('drops an ambiguous configured model when the CLI explicitly switches providers', () => {
    expect(
      resolveCliModelSelection(
        'newapi-openai',
        undefined,
        undefined,
        'gpt-4o',
      ),
    ).toBeUndefined();
  });

  it('prefers an explicit CLI model override', () => {
    expect(
      resolveCliModelSelection(
        'newapi-openai',
        'gpt-5',
        'zhipu-coding',
        'glm-5.1',
      ),
    ).toBe('gpt-5');
  });
});
