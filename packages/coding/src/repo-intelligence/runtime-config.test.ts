import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  inspectRepoIntelligenceRuntime,
  isRepoIntelligenceSemanticSurfaceEnabled,
  SEMANTIC_SURFACE_OPT_IN_NOTE,
} from './runtime-config.js';

describe('repo-intelligence semantic surface switch', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('keeps the semantic surface off by default', () => {
    vi.stubEnv('KODAX_REPO_INTELLIGENCE', '');
    expect(isRepoIntelligenceSemanticSurfaceEnabled()).toBe(false);
    expect(isRepoIntelligenceSemanticSurfaceEnabled('auto')).toBe(false);
    expect(isRepoIntelligenceSemanticSurfaceEnabled('off')).toBe(false);
  });

  it('turns the semantic surface on only for an explicit full or light mode', () => {
    expect(isRepoIntelligenceSemanticSurfaceEnabled('full')).toBe(true);
    expect(isRepoIntelligenceSemanticSurfaceEnabled('light')).toBe(true);
  });

  it('honours the environment opt-in when no mode is passed', () => {
    vi.stubEnv('KODAX_REPO_INTELLIGENCE', 'full');
    expect(isRepoIntelligenceSemanticSurfaceEnabled()).toBe(true);
  });

  it('reports auto mode as having no semantic engine instead of probing storage', async () => {
    const inspection = await inspectRepoIntelligenceRuntime({ mode: 'auto' });

    expect(inspection).toMatchObject({
      configuredMode: 'auto',
      requestedMode: 'off',
      effectiveEngine: 'off',
      status: 'ok',
    });
    expect(inspection.storageRoot).toBeUndefined();
    expect(inspection.warnings).toContain(SEMANTIC_SURFACE_OPT_IN_NOTE);
  });
});
