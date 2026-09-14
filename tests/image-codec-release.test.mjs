import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('release archives include the image decoder for both tar and Windows zip distributions', async () => {
  const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const sidecars = workflow.match(/sidecars=\(([\s\S]*?)\)/)?.[1];
  assert.match(sidecars ?? '', /\bimage-codec\b/);
  assert.match(workflow, /tar -czf[^\n]+"\$\{sidecars\[@\]\}"/);
  const zipInputs = workflow.match(/Compress-Archive -Path ([^\n]+?) -DestinationPath/)?.[1].split(',');
  assert.ok(zipInputs?.includes('image-codec'));
});
