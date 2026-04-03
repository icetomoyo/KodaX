import { describe, expect, it } from 'vitest';
import {
  buildSessionOptions,
  createKodaXOptions,
  mergeConfiguredExtensions,
  parseAgentModeOption,
  parseNonNegativeIntWithFallback,
  parseOptionalNonNegativeInt,
  parseOutputModeOption,
  parsePositiveNumberWithFallback,
  resolveCliModelSelection,
  validateCliModeSelection,
  type CliOptions,
} from './cli_option_helpers.js';

function createCliOptions(overrides: Partial<CliOptions> = {}): CliOptions {
  return {
    provider: 'openai',
    thinking: true,
    reasoningMode: 'auto',
    agentMode: 'ama',
    outputMode: 'text',
    parallel: false,
    append: false,
    overwrite: false,
    autoContinue: false,
    maxSessions: 50,
    maxHours: 2,
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

  it('rejects bare resume in json mode', () => {
    expect(() =>
      validateCliModeSelection(
        createCliOptions({ outputMode: 'json' }),
        { resumeWithoutId: true },
      ),
    ).toThrow('`--mode json` requires an explicit session id for `--resume`');
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

describe('createKodaXOptions', () => {
  it('projects repo intelligence mode and trace flags from runtime env into context', () => {
    const previousMode = process.env.KODAX_REPO_INTELLIGENCE_MODE;
    const previousTrace = process.env.KODAX_REPO_INTELLIGENCE_TRACE;
    process.env.KODAX_REPO_INTELLIGENCE_MODE = 'premium-native';
    process.env.KODAX_REPO_INTELLIGENCE_TRACE = '1';

    try {
      const options = createKodaXOptions(createCliOptions());
      expect(options.context).toMatchObject({
        repoIntelligenceMode: 'premium-native',
        repoIntelligenceTrace: true,
      });
    } finally {
      if (previousMode === undefined) {
        delete process.env.KODAX_REPO_INTELLIGENCE_MODE;
      } else {
        process.env.KODAX_REPO_INTELLIGENCE_MODE = previousMode;
      }
      if (previousTrace === undefined) {
        delete process.env.KODAX_REPO_INTELLIGENCE_TRACE;
      } else {
        process.env.KODAX_REPO_INTELLIGENCE_TRACE = previousTrace;
      }
    }
  });
});

describe('parseAgentModeOption', () => {
  it('accepts SA mode case-insensitively', () => {
    expect(parseAgentModeOption('SA')).toBe('sa');
  });

  it('rejects unsupported agent modes', () => {
    expect(() => parseAgentModeOption('team')).toThrow(
      'Expected one of: ama, sa.',
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

  it('uses the fallback for absent non-negative integer values', () => {
    expect(parseNonNegativeIntWithFallback(undefined, 50)).toBe(50);
  });

  it('throws on invalid fallback-backed integer values', () => {
    expect(() => parseNonNegativeIntWithFallback('-1', 50)).toThrow(
      'Expected a non-negative integer, got "-1".',
    );
  });

  it('uses the fallback for absent positive numeric values', () => {
    expect(parsePositiveNumberWithFallback(undefined, 2)).toBe(2);
  });

  it('throws on invalid positive numeric values', () => {
    expect(() => parsePositiveNumberWithFallback('0', 2)).toThrow(
      'Expected a positive number, got "0".',
    );
  });
});

describe('mergeConfiguredExtensions', () => {
  it('merges configured and CLI extension lists with deduplication', () => {
    expect(
      mergeConfiguredExtensions(
        ['  ./local-ext.mjs  ', './shared-ext.mjs'],
        ['./shared-ext.mjs', './config-ext.mjs', ''],
      ),
    ).toEqual([
      './shared-ext.mjs',
      './config-ext.mjs',
      './local-ext.mjs',
    ]);
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
