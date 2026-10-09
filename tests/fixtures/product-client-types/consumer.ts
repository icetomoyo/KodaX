import {
  connectKodaXClient,
  ensureKodaXClient,
  type ConnectKodaXClientOptions,
  type EnsureKodaXClientOptions,
  type RuntimeClientInfo,
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
const clientInfo: RuntimeClientInfo = { name: 'consumer', clientType: 'app' };
const connectOptions: ConnectKodaXClientOptions = { clientInfo };
const authorizedOptions: ConnectKodaXClientOptions = { clientInfo,
  async authorizeExecution(request, services) {
    if (!request.input.sessionId) throw new Error('An authorized execution requires a Session.');
    const lease = await services.credentials.registerScoped({ providers: ['fixture'] }, async request => {
      const purpose: string = request.purpose;
      const sessionId: string = request.sessionId;
      void purpose; void sessionId;
      return undefined;
    });
    return { credential: { leaseId: lease.id, mode: 'scoped', providers: ['fixture'] } };
  },
};
void authorizedOptions;
const ensureOptions: EnsureKodaXClientOptions = { clientInfo, daemonStartupTimeoutMs: 30_000 };
await connectKodaXClient(connectOptions);
await ensureKodaXClient(ensureOptions);
const sessions: readonly ClientSessionSummary[] = await client.sessions.list();
const exit = await client.lifecycle.requestExit({ requestId: 'quit', shutdownHost: true });
const pending = await client.lifecycle.listPendingExits();
const statistics = await client.statistics.read('session-id');
const physicalRequests: number = statistics.physicalRequestCount;
const requestFacts = await client.statistics.readRequests('session-id', { limit: 20 });
const toolFacts = await client.statistics.readTools('session-id');
void [exit, pending, physicalRequests, requestFacts, toolFacts];
const session: ClientSession = await client.sessions.read('session-id');
const history = await client.sessions.readHistory(session.id);
const sourceRevision: string = history.sourceRevision;
void sourceRevision;
const boundary = history.items[0]?.historyBoundary;
if (boundary) {
  await client.sessions.forkSession(session.id, { historyBoundary: boundary, before: true });
  await client.sessions.rewindSession(session.id, { historyBoundary: boundary, expectedHead: null });
}
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
