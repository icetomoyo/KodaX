import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';

import { VIEW_METHODS, VIEW_NOTIFICATIONS, type LocalSessionView, type SessionView } from './view.js';
import { applyViewOps, diffSessionView } from './view-sync.js';

const HOME = '/home/someone/.kodax';

const localView: LocalSessionView = {
  session: {
    id: 'session-1', title: 'View', archived: false, project: 'work', workspaceRoot: `${HOME}/work`,
    recovery: { state: 'recovering', since: 1, code: 'actor_settlement_not_persisted' },
  },
  items: [{
    id: 'session-1:output:out-1:tool:call-1:0',
    type: 'tool',
    state: 'settled',
    text: 'saved a screenshot',
    attachments: [{ kind: 'image', mediaType: 'image/png', path: `${HOME}/media/shot.png`, blobId: 'a_shot' }],
    tool: { callId: 'call-1', name: 'screenshot', status: 'success', inputText: '{}' },
  }],
  runs: [{ id: 'run-1', phase: 'running', provider: 'anthropic' }],
  queue: [],
  settings: { permissionMode: 'accept-edits', model: 'some-model' },
  interactions: [{
    id: 'ask-1', sessionId: 'session-1', runId: 'run-1', createdAt: 1, kind: 'permission',
    request: { toolName: 'bash', inputPreview: 'take a screenshot', executionCwd: `${HOME}/work` },
  }],
  sandbox: { state: 'applied', backend: 'windows-restricted-user', degradedReadRoots: [`${HOME}/sandbox-runtime`] },
  workflows: [{ id: 'run-2', name: 'review', status: 'running', spawnedAgents: 2, startedAt: 1 }],
};
const position = { subscriptionId: 'sub-1', epoch: 'boot-1', seq: 0 };

/** Objects with named fields that would let through a field the contract does not name. */
function openObjects(schema: unknown, found: string[] = [], path = ''): string[] {
  if (typeof schema !== 'object' || schema === null) return found;
  const node = schema as { readonly [key: string]: unknown };
  if (node.type === 'object' && node.properties !== undefined && node.additionalProperties !== false) found.push(path);
  for (const [key, value] of Object.entries(node)) openObjects(value, found, `${path}/${key}`);
  return found;
}

describe('view notifications', () => {
  // The method table's own test covers VIEW_METHODS once they are in it. These
  // payloads are in no table, so nothing else checks them.
  it.each(Object.entries(VIEW_NOTIFICATIONS))('%s names every field it sends and reserves _meta', (_name, spec) => {
    for (const schema of [spec.params, spec.localParams]) {
      const json = z.toJSONSchema(schema);
      expect(openObjects(json)).toEqual([]);
      expect((json as { properties?: object }).properties).toHaveProperty('_meta');
    }
  });
});

describe('Host paths in a view', () => {
  const subscribe = VIEW_METHODS['view.subscribe'];
  const reset = VIEW_NOTIFICATIONS['view.reset'];
  const patch = VIEW_NOTIFICATIONS['view.patch'];
  const ops = diffSessionView<LocalSessionView['items'][number]>({ items: [], runs: [], queue: [], interactions: [], settings: {}, workflows: [] }, localView);

  it('reach the owner in a snapshot and in a patch', () => {
    expect(subscribe.localResult.parse({ ...position, snapshot: localView })).toEqual({ ...position, snapshot: localView });
    expect(patch.localParams.parse({ ...position, seq: 1, ops })).toEqual({ ...position, seq: 1, ops });
  });

  it.each([
    ['the answer to subscribing', () => subscribe.result.parse({ ...position, snapshot: localView })],
    ['a reset', () => reset.params.parse({ ...position, snapshot: localView })],
    ['a patch', () => patch.params.parse({ ...position, seq: 1, ops })],
  ])('are cut from %s for every other role', (_name, send) => {
    const sent = send();
    expect(JSON.stringify(sent)).not.toContain(HOME);
    expect(JSON.stringify(sent)).toContain('saved a screenshot');
    expect(JSON.stringify(sent)).toContain('take a screenshot');
  });

  it('leave a patch a client can apply', () => {
    const sent = patch.params.parse({ ...position, seq: 1, ops });
    const start: SessionView = {
      session: { id: 'session-1', title: 'View', archived: false }, items: [], runs: [], queue: [], interactions: [], settings: {}, workflows: [],
    };
    const applied = applyViewOps(start, sent.ops);
    expect(applied.view).toEqual(subscribe.result.parse({ ...position, snapshot: localView }).snapshot);
  });

  it('cannot be sent under a key the contract does not name', () => {
    expect(() => patch.params.parse({ ...position, seq: 1, ops: [{ op: 'set', key: 'workspaceRoot', value: HOME }] })).toThrow();
  });
});
