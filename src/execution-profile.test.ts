import { expect, it } from 'vitest';
import { createExecutionProfile } from './execution-profile.js';
import { getAllRegisteredTools } from '@kodax-ai/coding';

it('snapshots the original Partner policy without granting mutation or child-agent tools', () => {
  const profile = { id: 'partner', verification: { requiredChecks: ['Expert review'] } };
  const snapshot = createExecutionProfile({ agentProfile: profile, excludeTools: ['spawn_agent'],
    taskVerification: { summary: 'Review citations' },
    toolVisibilityPolicy: tool => !['mutates-fs', 'mutates-shell'].includes(tool.sideEffect),
  }, [...getAllRegisteredTools().map(tool => ({ ...tool, planModeAllowed: tool.planModeAllowed === true })), { name: 'space_artifact', sideEffect: 'mutates-state', planModeAllowed: false }]);
  expect(snapshot.tools).toEqual(expect.arrayContaining(['read', 'skill', 'web_search', 'space_artifact']));
  for (const name of ['bash', 'write', 'edit', 'spawn_agent']) expect(snapshot.tools).not.toContain(name);
  expect(snapshot.agentProfile).toEqual(profile);
  profile.verification.requiredChecks.push('Later edit');
  expect(snapshot.agentProfile?.verification?.requiredChecks).toEqual(['Expert review']);
  expect(snapshot.taskVerification).toEqual({ summary: 'Review citations' });
});

it('allows persona-only profiles and requires a Host catalog for explicit predicates', () => {
  expect(createExecutionProfile({ agentProfile: { id: 'partner' } })).toEqual({ agentProfile: { id: 'partner' } });
  expect(() => createExecutionProfile({ toolVisibilityPolicy: () => true })).toThrow('Host catalog');
});
