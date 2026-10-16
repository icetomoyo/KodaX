import { expect, it } from 'vitest';
import { SYSTEM_PROMPT } from './system.js';

it('uses the host plan approval boundary instead of teaching the model to elevate its own permissions', () => {
  expect(SYSTEM_PROMPT).not.toContain('set_permission_mode');
  expect(SYSTEM_PROMPT).toContain('exit_plan_mode');
  expect(SYSTEM_PROMPT).toContain('approved: true');
  expect(SYSTEM_PROMPT).toMatch(/declines.*plan mode/i);
});
