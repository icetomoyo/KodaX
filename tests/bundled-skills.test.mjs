import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { getDefaultSkillPaths, initializeSkillRegistry } from '../dist/sdk-skills.js';

test('split SDK discovers packaged built-in skills from the installed distribution', async () => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const expected = path.join(root, 'dist', 'builtin');
  assert.equal(getDefaultSkillPaths().builtinPath, expected);
  assert.ok(existsSync(path.join(expected, 'visual-review', 'SKILL.md')));
  const registry = await initializeSkillRegistry(root, {
    projectPaths: [], userPaths: [], pluginPaths: [],
  });
  const skill = registry.get('visual-review');
  assert.equal(skill?.source, 'builtin');
  assert.match((await registry.loadFull('visual-review')).content, /Temporal/);
});
