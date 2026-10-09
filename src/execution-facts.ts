import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentActorOwner } from '@kodax-ai/agent';
import type { ProviderRequestObservation } from '@kodax-ai/llm';
import type { KodaXShellSandboxObservation, RuntimeContextBudgetSnapshot } from '@kodax-ai/coding';
import type { ClientExecutionTarget, ClientProviderRequestFact, ClientToolExecutionFact, ClientStatisticsService,
  ClientContextBudgetFact, ClientExecutionFactsPage } from '@kodax-ai/coding/client-contract';
import { isRuntimeActorOwnerAlive } from './runtime-actor-owner-liveness.js';

interface Facts {
  version: 1; sessionId: string; revision: number; coverage: 'complete' | 'partial'; issues: string[];
  owners: Record<string, AgentActorOwner>;
  requests: ClientProviderRequestFact[]; tools: ClientToolExecutionFact[]; contexts: ClientContextBudgetFact[];
}
export function createExecutionFactsStore(configHome: string, owner: AgentActorOwner) {
  const file = (sessionId: string) => path.join(configHome, 'execution-facts', `${createHash('sha256').update(sessionId).digest('hex')}.json`);
  const load = (sessionId: string): Facts => {
    const target = file(sessionId);
    if (!fs.existsSync(target)) return { version: 1, sessionId, revision: 0, coverage: 'partial',
      issues: ['Usage before execution-fact collection is unavailable.'], owners: {}, requests: [], tools: [], contexts: [] };
    const facts = JSON.parse(fs.readFileSync(target, 'utf8')) as Facts;
    if (facts.version !== 1 || facts.sessionId !== sessionId || !Array.isArray(facts.requests) || !Array.isArray(facts.tools)
      || !Array.isArray(facts.contexts) || !Number.isSafeInteger(facts.revision)) throw new Error('Invalid persisted execution facts.');
    return facts;
  };
  const save = (facts: Facts): void => {
    const target = file(facts.sessionId);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(temporary, JSON.stringify(facts), { mode: 0o600 }); fs.renameSync(temporary, target); }
    finally { fs.rmSync(temporary, { force: true }); }
  };
  const change = (sessionId: string, effect: (facts: Facts) => void): void => {
    const facts = load(sessionId); facts.revision += 1;
    facts.owners[owner.runtimeId] = owner;
    effect(facts); save(facts);
  };
  const recovered = async (sessionId: string): Promise<Facts> => {
    const observed = load(sessionId);
    const dead = new Map<string, string>();
    for (const [runtimeId, previous] of Object.entries(observed.owners)) {
      if (!observed.requests.some(row => row.runtimeId === runtimeId && row.state === 'started')
        && !observed.tools.some(row => row.runtimeId === runtimeId && (row.state === 'prepared' || row.state === 'executing'))) continue;
      if (await isRuntimeActorOwnerAlive(previous)) continue;
      dead.set(runtimeId, JSON.stringify(previous));
    }
    // Probes yield; re-read before the synchronous write to preserve new facts.
    const facts = load(sessionId);
    let changed = false;
    for (const [runtimeId, identity] of dead) {
      if (JSON.stringify(facts.owners[runtimeId]) !== identity) continue;
      facts.revision += 1; changed = true;
      facts.requests = facts.requests.map(row => row.runtimeId === runtimeId && row.state === 'started'
        ? { ...row, state: 'unknown', recovery: 'outcome_unknown', revision: facts.revision } : row);
      facts.tools = facts.tools.map(row => row.runtimeId === runtimeId && (row.state === 'prepared' || row.state === 'executing')
        ? { ...row, state: 'unknown', revision: facts.revision } : row);
    }
    if (facts.requests.some(row => row.state === 'unknown' && row.boundary === 'provider_operation')) {
      facts.coverage = 'partial';
      const issue = 'Some adapters report operation boundaries rather than physical wire attempts.';
      if (!facts.issues.includes(issue)) facts.issues.push(issue);
    }
    if (changed) save(facts);
    return facts;
  };
  const page = <T extends { revision: number }>(facts: Facts, kind: 'requests' | 'tools', rows: readonly T[], options?: { cursor?: string; limit?: number }): ClientExecutionFactsPage<T> => {
    const limit = options?.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw Object.assign(new Error('Fact page limit must be 1–500.'), { code: 'invalid_params' });
    let cursor: { offset: number; size: number; sessionId: string; kind: string };
    try { cursor = options?.cursor === undefined ? { offset: 0, size: rows.length, sessionId: facts.sessionId, kind }
      : JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8')) as typeof cursor; }
    catch { throw Object.assign(new Error('Invalid fact cursor.'), { code: 'invalid_params' }); }
    if (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || !Number.isSafeInteger(cursor.size)
      || cursor.size < cursor.offset || cursor.size > rows.length || cursor.sessionId !== facts.sessionId || cursor.kind !== kind) {
      throw Object.assign(new Error('Invalid fact cursor.'), { code: 'invalid_params' });
    }
    const end = Math.min(cursor.offset + limit, cursor.size);
    return { revision: facts.revision, items: rows.slice(cursor.offset, end),
      ...(end < cursor.size ? { nextCursor: Buffer.from(JSON.stringify({ offset: end, size: cursor.size, sessionId: facts.sessionId, kind })).toString('base64url') } : {}) };
  };
  const service: ClientStatisticsService = {
    async read(sessionId) {
      const facts = await recovered(sessionId);
      const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, thoughtTokens: 0 };
      for (const row of facts.requests) {
        if (!row.usage) continue;
        usage.inputTokens += row.usage.inputTokens; usage.outputTokens += row.usage.outputTokens;
        usage.totalTokens += row.usage.inputTokens + row.usage.outputTokens;
        usage.cacheReadTokens += row.usage.cachedReadTokens ?? 0; usage.cacheWriteTokens += row.usage.cachedWriteTokens ?? 0;
        usage.thoughtTokens += row.usage.thoughtTokens ?? 0;
      }
      const operationOnlyPending = facts.requests.some(row => row.state === 'started' && row.boundary === 'provider_operation' && row.wireObservation !== 'pending');
      const pendingIssue = 'An executing adapter has not exposed a physical request boundary.';
      return { sessionId, revision: facts.revision, coverage: operationOnlyPending ? 'partial' : facts.coverage,
        issues: operationOnlyPending && !facts.issues.includes(pendingIssue) ? [...facts.issues, pendingIssue] : facts.issues, usage,
        requestCount: facts.requests.length, requestsWithoutUsage: facts.requests.filter(row => row.usage === undefined).length,
        physicalRequestCount: facts.requests.filter(row => row.boundary === 'physical_attempt').length,
        operationCount: facts.requests.filter(row => row.boundary === 'provider_operation').length, contexts: facts.contexts };
    },
    async readRequests(sessionId, options) { const facts = await recovered(sessionId); return page(facts, 'requests', facts.requests, options); },
    async readTools(sessionId, options) { const facts = await recovered(sessionId); return page(facts, 'tools', facts.tools, options); },
  };
  return {
    service,
    created(sessionId: string): void { if (load(sessionId).revision === 0) change(sessionId, facts => { facts.coverage = 'complete'; facts.issues = []; }); },
    provider(sessionId: string, target: ClientExecutionTarget, observation: ProviderRequestObservation): void {
      change(sessionId, facts => {
        const existing = facts.requests.findIndex(row => row.requestId === observation.requestId);
        const actorTarget = observation.attribution?.kind === 'actor_turn' ? { kind: 'actor_turn' as const,
          actorPath: observation.attribution.actorPath, turnId: observation.attribution.turnId,
          ...(target.kind === 'run' ? { parentRunId: target.runId } : {}) } : target;
        const previous = [...facts.requests].reverse().find(row => JSON.stringify(row.target) === JSON.stringify(actorTarget)
          && (observation.route !== undefined ? row.route?.chainId === observation.route.chainId : row.provider === observation.provider));
        const row: ClientProviderRequestFact = { ...observation, target: actorTarget, sessionId, runtimeId: owner.runtimeId,
          revision: facts.revision, fallback: observation.purpose === 'fallback' || (observation.route?.attempt ?? 1) > 1,
          ...(existing >= 0 ? { previousRequestId: facts.requests[existing]?.previousRequestId }
            : previous ? { previousRequestId: previous.requestId } : {}) };
        if (existing < 0) facts.requests.push(row); else facts.requests[existing] = row;
        if (observation.boundary === 'provider_operation' && observation.state !== 'started'
          && !facts.issues.includes('Some adapters report operation boundaries rather than physical wire attempts.')) {
          facts.coverage = 'partial'; facts.issues.push('Some adapters report operation boundaries rather than physical wire attempts.');
        }
      });
    },
    context(sessionId: string, target: ClientExecutionTarget, snapshot: RuntimeContextBudgetSnapshot): void {
      change(sessionId, facts => {
        const row: ClientContextBudgetFact = { ...snapshot, runtimeId: owner.runtimeId, target, revision: facts.revision };
        const index = facts.contexts.findIndex(row => row.contextId === snapshot.contextId && row.contextKind === snapshot.contextKind);
        if (index < 0) facts.contexts.push(row); else facts.contexts[index] = row;
      });
    },
    tool(sessionId: string, target: ClientExecutionTarget, id: string, toolId: string, name: string | undefined,
      patch: { state?: ClientToolExecutionFact['state']; result?: ClientToolExecutionFact['result']; observation?: KodaXShellSandboxObservation }): void {
      change(sessionId, facts => {
        const index = facts.tools.findIndex(row => row.id === id);
        const previous = facts.tools[index];
        const row: ClientToolExecutionFact = { id, revision: facts.revision, toolId, name: name ?? previous?.name ?? 'unknown',
          sessionId, target, runtimeId: owner.runtimeId,
          state: patch.result !== undefined && previous?.state !== 'executing' && previous?.state !== 'completed'
            ? 'not_executed' : patch.state ?? previous?.state ?? 'prepared',
          result: patch.result ?? previous?.result, updatedAt: new Date().toISOString(),
          sandbox: [...(previous?.sandbox ?? []), ...(patch.observation === undefined ? [] : [patch.observation])] };
        if (index < 0) facts.tools.push(row); else facts.tools[index] = row;
      });
    },
  };
}
export type ExecutionFactsStore = ReturnType<typeof createExecutionFactsStore>;
