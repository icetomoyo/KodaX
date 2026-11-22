/**
 * The REPL's Learning Center over v2, against a real Host.
 */
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { createLearningCenterService, type LearningEvent } from '@kodax-ai/agent';

import { disposeReplHosts, replHost } from '../../tests/repl-v2-host.js';
import { createReplLearning } from './learning.js';

afterEach(disposeReplHosts, 60_000);

async function seed(homeDir: string, capabilityId: string, slug: string): Promise<void> {
  await createLearningCenterService({ rootDir: path.join(homeDir, '.kodax', 'learned'), clientIdentity: 'seed' }).record({
    schemaVersion: 1, capabilityId, displayName: `Skill ${slug}`, slug, carrier: 'skill', lifecycle: 'ready', revision: 1,
    createdAt: '2026-07-17T00:00:00.000Z', updatedAt: '2026-07-17T00:00:00.000Z',
    source: { kind: 'learning_controller' },
  });
}

describe('the REPL Learning Center over v2', () => {
  it('reads capabilities under the names the REPL reads and passes decisions on', async () => {
    const { client, homeDir } = await replHost('answer');
    await seed(homeDir, 'lc_release', 'release-check');
    const learning = createReplLearning(client);

    expect((await learning.list({ lifecycle: 'ready' })).items).toEqual([{
      capabilityId: 'lc_release', displayName: 'Skill release-check', slug: 'release-check', carrier: 'skill', lifecycle: 'ready',
    }]);
    expect(await learning.get('release-check')).toMatchObject({ capabilityId: 'lc_release' });
    expect(await learning.getSnapshot()).toMatchObject({ ready: 1 });

    await learning.snooze('release-check', '2099-01-01T00:00:00.000Z');
    expect(await learning.getSnapshot()).toMatchObject({ ready: 0 });
    await learning.reject('release-check');
    expect(await learning.get('lc_release')).toMatchObject({ lifecycle: 'rejected' });
    await expect(learning.get('missing')).rejects.toMatchObject({ kodaxCode: 'not_found' });
  });

  it('tells the REPL what happened since the revision it last saw, and stops when closed', async () => {
    const { client, homeDir } = await replHost('answer');
    await seed(homeDir, 'lc_old', 'old-skill');
    const { revision } = await createReplLearning(client).getSnapshot();
    const learning = createReplLearning(client, 20);

    const seen: LearningEvent[] = [];
    const errors: unknown[] = [];
    let heard: () => void = () => undefined;
    const second = new Promise<void>((resolve) => { heard = resolve; });
    const subscription = learning.subscribe((event) => {
      seen.push(event);
      if (event.capabilityId === 'lc_new') heard();
    }, { afterRevision: revision }, error => errors.push(error));
    await subscription.ready;
    expect(seen).toEqual([]);

    await seed(homeDir, 'lc_new', 'new-skill');
    await second;
    subscription.close();
    expect(seen).toEqual([expect.objectContaining({
      schemaVersion: 1, capabilityId: 'lc_new', displayName: 'Skill new-skill', kind: 'ready', eventId: expect.any(String),
    })]);
    expect(Date.parse(seen[0]!.createdAt)).toBeGreaterThan(0);

    await seed(homeDir, 'lc_late', 'late-skill');
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(seen.map(event => event.capabilityId)).toEqual(['lc_new']);
    expect(errors).toEqual([]);
  });
});
