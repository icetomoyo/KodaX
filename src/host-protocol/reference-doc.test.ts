import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { hostMethodContract } from './methods.js';
import { renderHostProtocolReference } from './reference-doc.js';

const sourceDir = fileURLToPath(new URL('.', import.meta.url));

describe('the published v2 method reference', () => {
  const contract = hostMethodContract() as Parameters<typeof renderHostProtocolReference>[0];
  const page = renderHostProtocolReference(contract, sourceDir);

  it('is the method table as it now is', async () => {
    await expect(page).toMatchFileSnapshot('../../public_docs/sdk/host-protocol-reference.md');
  });

  it('lists every method with who may call it and what it is for', () => {
    for (const name of Object.keys(contract)) expect(page).toContain(`### \`${name}\``);
    const create = page.slice(page.indexOf('### `session.create`'));
    expect(create).toMatch(/Kind: command · Resend: \w+ · Who: owner, user, service/);
    expect(page).toMatch(/### `interaction.respond`[\s\S]*?Who: owner, user\n/);
  });

  it('carries the doc comments of params and result fields', () => {
    const list = page.slice(page.indexOf('### `workspace.list`'), page.indexOf('### `workspace.read`'));
    expect(list).toMatch(/\| `path` \| string \| no \| The workspace itself when absent\. \|/);
    expect(list).toMatch(/\| `entries\[\]\.kind` \| "file" or "directory" or "link" or "other" \| yes \| A link is not followed/);
  });
});
