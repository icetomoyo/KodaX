import {
  connectKodaXClient,
  type KodaXProductClient,
  type ClientSession,
  type ClientSessionSummary,
} from '@kodax-ai/kodax/client';
// @ts-expect-error Host adaptation is internal, not a product SDK export.
import { toKodaXProductClient } from '@kodax-ai/kodax/client';

declare const client: KodaXProductClient;
const sessions: readonly ClientSessionSummary[] = await client.sessions.list();
const session: ClientSession = await client.sessions.read('session-id');

// @ts-expect-error Session facts are read-only.
session.title = 'Changed by UI';
// @ts-expect-error Observed lists are read-only.
sessions.push(sessions[0]);
// @ts-expect-error Product connect does not own Host startup policy.
await connectKodaXClient({ autoStart: true });
// @ts-expect-error Product clients cannot install arbitrary tool executors.
client.hostTools.register({ execute: () => 'unsafe' });

await client.disconnect();

await client.agents.wait(session.id, undefined, 100, { signal: new AbortController().signal });
