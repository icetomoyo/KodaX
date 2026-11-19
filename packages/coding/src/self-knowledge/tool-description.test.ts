import { describe, expect, it } from 'vitest';

import { buildManualToolDescription, withManualToolBranding } from './tool-description.js';

// The exact default description — a byte-identity pin so the single-source-of-
// truth builder can never silently drift the model-visible tool surface.
const KODAX_DESCRIPTION = [
  'First source for using, installing, configuring, troubleshooting or extending KodaX itself, including its SDK.',
  'Other software is outside the manual. Answer from results, not other-product pretraining.',
  'KodaX uses ~/.kodax/config.json/KODAX_*, not .claude/settings.json/config.toml.',
  'Use an exact topic or free-text query. Omit both for the topic index. Explains where to check values, never reads secrets.',
].join(' ');

describe('FEATURE_221 buildManualToolDescription (white-label tool description)', () => {
  it('default (KodaX) is byte-identical to the prior static literal', () => {
    expect(buildManualToolDescription()).toBe(KODAX_DESCRIPTION);
    expect(buildManualToolDescription('KodaX')).toBe(KODAX_DESCRIPTION);
  });

  it('re-brands the product name and drops the ~/.kodax config-path leak for a consumer', () => {
    const d = buildManualToolDescription('KodaX-Space');
    expect(d).toContain('extending KodaX-Space itself');
    expect(d).not.toContain('~/.kodax');
    expect(d).not.toContain('KODAX_');
    // Anti-confusion framing is still present.
    expect(d).toContain('not other-product pretraining');
  });

  it('trims / defaults an empty product name to KodaX', () => {
    expect(buildManualToolDescription('  ')).toBe(KODAX_DESCRIPTION);
  });
});

describe('FEATURE_221 withManualToolBranding', () => {
  const manualDef = { name: 'kodax_manual', description: KODAX_DESCRIPTION };
  const otherDef = { name: 'read', description: 'Read a file.' };

  it('re-brands only the kodax_manual def, only for a non-default product name', () => {
    const branded = withManualToolBranding(manualDef, 'KodaX-Space');
    expect(branded.description).toContain('KodaX-Space');
    expect(branded.description).not.toContain('~/.kodax');
  });

  it('returns the def UNCHANGED (same reference) for the default / absent product name', () => {
    expect(withManualToolBranding(manualDef, undefined)).toBe(manualDef);
    expect(withManualToolBranding(manualDef, 'KodaX')).toBe(manualDef);
    expect(withManualToolBranding(manualDef, '  ')).toBe(manualDef);
  });

  it('never touches a non-manual tool', () => {
    expect(withManualToolBranding(otherDef, 'KodaX-Space')).toBe(otherDef);
  });
});
