import {
  connectKodaXClient,
  type KodaXProductClient,
  type ClientSession,
  type ClientSessionSummary,
  type ClientSessionView,
  type ClientSessionActivity,
  type ClientViewItem,
  type ClientObservation,
  type ClientItemReadOptions,
  type ClientItemContent,
  type ClientRunStatus,
  type ClientRunOutcome,
  type ClientWorkflowStartInput,
  type ClientWorkflowStartResult,
} from '@kodax-ai/kodax/client';
// @ts-expect-error Host adaptation is internal, not a product SDK export.
import { toKodaXProductClient } from '@kodax-ai/kodax/client';

declare const client: KodaXProductClient;
const sessions: readonly ClientSessionSummary[] = await client.sessions.list();
const session: ClientSession = await client.sessions.read('session-id');
const renderItem = (item: ClientViewItem): string => item.text;
const renderActivity = (activity: ClientSessionActivity | undefined): number => activity?.parentContextTokens ?? 0;
const observation: ClientObservation = await client.sessions.observe(session.id, (view: ClientSessionView) => {
  view.items.map(renderItem);
  renderActivity(view.activity);
});
observation.close();
const readOptions: ClientItemReadOptions = { offset: 0, part: 'text' };
const content: ClientItemContent | null = await client.sessions.readItem(session.id, 'item', readOptions);
const run: ClientRunStatus = await client.runs.read('run');
const outcome: ClientRunOutcome = await client.runs.await(run.runId);
declare const workflowInput: ClientWorkflowStartInput;
const workflow: ClientWorkflowStartResult = await client.workflows.start(workflowInput);

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
