import type { SessionNotification, ToolCall } from '@agentclientprotocol/sdk';
import type { ClientInteraction, ClientPermissionDecision, ClientSessionView, ClientViewItem, KodaXProductClient } from '@kodax-ai/coding/client-contract';

type PermissionInteraction = Extract<ClientInteraction, { kind: 'permission' }>;

/** ACP is append-only: project the Host's stable items, never execute local callbacks. */
export async function observeAcpClientPrompt(
  client: KodaXProductClient,
  sessionId: string,
  notify: (notification: SessionNotification) => Promise<void>,
  permission: (request: PermissionInteraction) => Promise<ClientPermissionDecision>,
  describeTool: (name: string, input: string) => Pick<ToolCall, 'rawInput' | 'kind' | 'locations'>,
) {
  const emitted = new Map<string, string>();
  const emittedRevisions = new Map<string, number>();
  const emittedStates = new Map<string, ClientViewItem['outputState']>();
  const priorItems = new Set<string>();
  const toolFingerprints = new Map<string, string>();
  const seenInteractionIds = new Set<string>();
  let initialized = false;
  let closed = false;
  let latest: ClientSessionView | undefined;
  let chain = Promise.resolve();
  let failure: unknown;
  let reportFailure: (error: unknown) => void = () => {};
  const failed = new Promise<unknown>(resolve => { reportFailure = resolve; });
  function fail(error: unknown): void { failure = error; reportFailure(error); }

  async function fullText(item: ClientViewItem, part: 'text' | 'input', from = 0): Promise<string> {
    const preview = part === 'text' ? item.text : item.tool?.inputText ?? '';
    const total = (part === 'text' ? item.totalTextLength : item.tool?.totalInputLength) ?? preview.length;
    if (total <= preview.length && (part === 'input' || !item.textOffset)) return preview.slice(from);
    let text = '';
    let offset = from;
    while (offset < total) {
      const page = await client.sessions.readItem(sessionId, item.id, { part, offset });
      if (!page) throw new Error(`ACP Host item disappeared during read: ${item.id}`);
      if (part === 'text' && ((page.textRevision ?? 0) !== (item.textRevision ?? 0)
        || page.outputState !== item.outputState)) {
        throw new Error(`ACP Host item changed during read: ${item.id}`);
      }
      const end = offset + page.text.length;
      if (page.id !== item.id || page.offset !== offset || end > page.totalLength || page.totalLength < total
        || (page.nextOffset === undefined ? end !== page.totalLength : page.nextOffset !== end || end <= offset)) {
        throw new Error(`ACP Host returned an inconsistent page for item: ${item.id}`);
      }
      text += page.text.slice(0, total - offset);
      offset = end;
    }
    return text;
  }

  async function projectItem(item: ClientViewItem): Promise<void> {
    if (closed || priorItems.has(item.id)) return;
    if (item.type === 'tool' && item.tool) {
      const tool = item.tool;
      if (!toolFingerprints.has(tool.callId)) {
        const input = await fullText(item, 'input');
        await notify({ sessionId, update: { sessionUpdate: 'tool_call', toolCallId: tool.callId,
          title: tool.name, ...describeTool(tool.name, input), status: 'pending' } });
      }
      const text = await fullText(item, 'text');
      const fingerprint = `${tool.status}:${text}`;
      if (toolFingerprints.get(tool.callId) === fingerprint) return;
      toolFingerprints.set(tool.callId, fingerprint);
      const status = tool.status === 'success' ? 'completed'
        : tool.status === 'error' || tool.status === 'cancelled' ? 'failed' : 'in_progress';
      await notify({ sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: tool.callId,
        title: tool.name, status, rawOutput: text, content: [{ type: 'content', content: { type: 'text', text } }] } });
      return;
    }
    if (item.type !== 'assistant' && item.type !== 'thinking') return;
    const previous = emitted.get(item.id) ?? '';
    const start = item.textOffset ?? 0;
    const end = item.totalTextLength ?? item.text.length;
    const revision = item.textRevision ?? 0;
    const overlap = Math.max(0, previous.length - start);
    // Same-item appends reuse already emitted text; an explicit revision is
    // the only way a bounded view can signal that its hidden prefix changed.
    const appending = emitted.has(item.id) && emittedRevisions.get(item.id) === revision
      && emittedStates.get(item.id) === item.outputState && end >= previous.length
      && item.text.slice(0, overlap) === previous.slice(start);
    const text = appending ? previous + (previous.length < start
      ? await fullText(item, 'text', previous.length) : item.text.slice(previous.length - start)) : await fullText(item, 'text');
    emittedRevisions.set(item.id, revision);
    emittedStates.set(item.id, item.outputState);
    if (text === previous) return;
    // ACP cannot replace an earlier chunk; make a Host revision explicit.
    const delta = text.startsWith(previous) ? text.slice(previous.length) : `\n[Updated response]\n${text}`;
    emitted.set(item.id, text);
    await notify({ sessionId, update: { sessionUpdate: item.type === 'thinking' ? 'agent_thought_chunk' : 'agent_message_chunk',
      content: { type: 'text', text: delta } } });
  }

  function answerInteractions(view: ClientSessionView): void {
    for (const request of view.interactions) {
      if (seenInteractionIds.has(request.requestId)) continue;
      seenInteractionIds.add(request.requestId);
      // ACP has no question/form response channel; other Host clients may answer.
      if (request.kind !== 'permission') {
        chain = chain.then(() => notify({ sessionId, update: { sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: '\n[ACP] This request needs an interactive answer. Open this Session in a KodaX client to answer, or cancel this prompt.\n' } } })).catch(fail);
        continue;
      }
      void permission(request).then(async decision => {
        if (closed || !latest?.interactions.some(item => item.requestId === request.requestId)) return;
        await client.interactions.respond(request.requestId, { kind: 'permission', decision });
      }).catch(fail);
    }
  }

  function receive(view: ClientSessionView): void {
    if (closed) return;
    latest = view;
    if (!initialized) {
      initialized = true;
      for (const item of view.items) {
        priorItems.add(item.id);
      }
      for (const request of view.interactions) seenInteractionIds.add(request.requestId);
      return;
    }
    answerInteractions(view);
    chain = chain.then(async () => { for (const item of view.items) await projectItem(item); })
      .catch(fail);
  }
  const observation = await client.sessions.observe(sessionId, receive, { onStatus(status) {
    if (closed || status.state === 'live' || (status.state === 'closed' && status.reason === 'client')) return;
    closed = true;
    fail(new Error(status.message ?? `ACP Host observation ${status.state === 'interrupted' ? 'was interrupted' : 'is unavailable'}.`));
  } });
  return {
    failed,
    async flush() {
      const final = await client.sessions.observe(sessionId, receive);
      final.close();
      await chain;
      if (failure !== undefined) throw failure;
    },
    close() { closed = true; observation.close(); },
  };
}
