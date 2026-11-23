import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// FEATURE_314: Host protocol v1 is removed in 0.7.100, or in 0.8.0 if that comes first. 0.8.0 sorts after
// 0.7.100, so 0.7.100 is the one line. The check fails from the first 0.7.100 build, prereleases included,
// so CI stops a release that still carries v1. Delete this file in the commit that deletes v1.
const REMOVE_AT = [0, 7, 100] as const;

function isRemovalDue(version: string): boolean {
  const core = version.split(/[-+]/)[0]!.split('.').map(Number);
  if (core.length !== 3 || core.some(part => !Number.isInteger(part))) throw new Error(`Not a version: ${version}`);
  for (let i = 0; i < 3; i++) {
    if (core[i] !== REMOVE_AT[i]) return core[i]! > REMOVE_AT[i];
  }
  return true;
}

describe('Host protocol v1 removal', () => {
  it('counts every build of the removal version as due, prereleases included', () => {
    expect(isRemovalDue('0.7.97-beta.13')).toBe(false);
    expect(isRemovalDue('0.7.99')).toBe(false);
    expect(isRemovalDue('0.7.100-alpha.1')).toBe(true);
    expect(isRemovalDue('0.8.0')).toBe(true);
  });

  it('is not due yet for the package version', () => {
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(isRemovalDue(version), `${version} must not ship protocol v1. Do FEATURE_314 in docs/FEATURE_LIST.md, `
      + 'delete the hidden `kodax daemon` alias (FEATURE_318, configureKodaXHostCommand in src/cli/host.ts), '
      + 'then delete this test.').toBe(false);
  });
});
