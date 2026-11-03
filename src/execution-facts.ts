import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { emitKodaXDiagnostic, type AgentActorOwner } from '@kodax-ai/agent';
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
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isTokenCount(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function validUsage(value: unknown): boolean {
  if (value === undefined) return true;
  return record(value) && isTokenCount(value.inputTokens) && isTokenCount(value.outputTokens)
    && (value.totalTokens === undefined || isTokenCount(value.totalTokens))
    && (value.cachedReadTokens === undefined || isTokenCount(value.cachedReadTokens))
    && (value.cachedWriteTokens === undefined || isTokenCount(value.cachedWriteTokens))
    && (value.thoughtTokens === undefined || isTokenCount(value.thoughtTokens));
}
export function createExecutionFactsStore(configHome: string, owner: AgentActorOwner, sessionsRoot?: string) {
  const incomplete = new Set<string>();
  const unavailable = 'Execution statistics are incomplete because their storage was unavailable. Unknown executions must not be replayed; totals include only recorded facts.';
  const reportFailure = (sessionId: string): void => {
    if (!incomplete.has(sessionId)) emitKodaXDiagnostic({ source: 'execution-facts', level: 'warn',
      message: 'Execution statistics storage is unavailable; inference remains usable and coverage is partial.', detail: { sessionId } });
    incomplete.add(sessionId);
  };
  const partial = (facts: Facts): Facts => {
    if (incomplete.has(facts.sessionId)) { facts.coverage = 'partial'; if (!facts.issues.includes(unavailable)) facts.issues.push(unavailable); }
    return facts;
  };
  const empty = (sessionId: string): Facts => partial({ version: 1, sessionId, revision: 0, coverage: 'partial',
    issues: ['Usage before execution-fact collection is unavailable.'], owners: {}, requests: [], tools: [], contexts: [] });
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const defaultRoot = path.resolve(configHome, 'sessions');
  const canonical = (value: string): string => {
    const resolved = path.resolve(value);
    if (fs.existsSync(resolved)) return fs.realpathSync(resolved);
    const parent = path.dirname(resolved);
    return parent === resolved ? resolved : path.join(canonical(parent), path.basename(resolved));
  };
  const storageRoot = canonical(sessionsRoot ?? defaultRoot);
  const legacyAllowed = storageRoot === canonical(defaultRoot);
  const root = path.join(configHome, 'execution-facts', 'v2', hash(storageRoot));
  let writer = randomUUID();
  type Delta = { kind: 'request'; row: ClientProviderRequestFact; recover?: true }
    | { kind: 'tool'; row: ClientToolExecutionFact; recover?: true }
    | { kind: 'context'; row: ClientContextBudgetFact }
    | { kind: 'created' };
  interface Entry { version: 2; sessionId: string; revision: number; owner: AgentActorOwner;
    coverage: Facts['coverage']; issues: string[]; changes: Delta[] }
  interface Projection { facts: Facts; requests: Map<string, number>; tools: Map<string, number>;
    contexts: Map<string, number>; routes: Map<string, string>;
    heads: Map<string, { size: number; ino: number; mtime: number; ctime: number }>; legacy: string }
  const projections = new Map<string, Projection>();
  const routeKey = (row: Pick<ClientProviderRequestFact, 'target' | 'route' | 'provider'>) =>
    JSON.stringify([row.target, row.route?.chainId ?? row.provider]);
  const loadLegacy = (sessionId: string): Facts => {
    const target = path.join(configHome, 'execution-facts', `${hash(sessionId)}.json`);
    if (!legacyAllowed) return empty(sessionId);
    if (!fs.existsSync(target)) return empty(sessionId);
    const facts = JSON.parse(fs.readFileSync(target, 'utf8')) as Facts;
    if (facts.version !== 1 || facts.sessionId !== sessionId || !Array.isArray(facts.requests) || !Array.isArray(facts.tools)
      || !Array.isArray(facts.contexts) || !Number.isSafeInteger(facts.revision)
      || !facts.owners || typeof facts.owners !== 'object' || Array.isArray(facts.owners)
      || !Array.isArray(facts.issues) || !facts.issues.every(issue => typeof issue === 'string')
      || !['complete', 'partial'].includes(facts.coverage)
      || !Object.values(facts.owners).every(value => record(value) && typeof value.runtimeId === 'string'
        && typeof value.ownerId === 'string' && Number.isSafeInteger(value.pid) && typeof value.startedAt === 'string')
      || !facts.requests.every(row => record(row) && typeof row.requestId === 'string' && typeof row.runtimeId === 'string'
        && typeof row.state === 'string' && validUsage(row.usage) && validUsage(row.partialUsage))
      || !facts.tools.every(row => record(row) && typeof row.id === 'string' && typeof row.runtimeId === 'string'
        && typeof row.state === 'string' && Array.isArray(row.sandbox))
      || !facts.contexts.every(row => record(row) && typeof row.contextId === 'string')) throw new Error('Invalid persisted execution facts.');
    return partial(facts);
  };
  const upsert = (projection: Projection, delta: Delta): void => {
    const facts = projection.facts;
    if (delta.kind === 'created') return;
    if (delta.kind === 'request') {
      const index = projection.requests.get(delta.row.requestId);
      const previous = index === undefined ? undefined : facts.requests[index];
      if (delta.recover && (!previous || previous.runtimeId !== delta.row.runtimeId || previous.state !== 'started')) return;
      if (index === undefined) { projection.requests.set(delta.row.requestId, facts.requests.length); facts.requests.push(delta.row); }
      else facts.requests[index] = delta.row;
      if (index === undefined) projection.routes.set(routeKey(delta.row), delta.row.requestId);
    } else if (delta.kind === 'tool') {
      const index = projection.tools.get(delta.row.id);
      const previous = index === undefined ? undefined : facts.tools[index];
      if (delta.recover && (!previous || previous.runtimeId !== delta.row.runtimeId
        || (previous.state !== 'prepared' && previous.state !== 'executing'))) return;
      if (index === undefined) { projection.tools.set(delta.row.id, facts.tools.length); facts.tools.push(delta.row); }
      else facts.tools[index] = delta.row;
    } else {
      const key = JSON.stringify([delta.row.contextKind, delta.row.contextId]);
      const index = projection.contexts.get(key);
      if (index === undefined) { projection.contexts.set(key, facts.contexts.length); facts.contexts.push(delta.row); }
      else facts.contexts[index] = delta.row;
    }
  };
  const load = (sessionId: string): Facts => {
    const legacyFile = path.join(configHome, 'execution-facts', `${hash(sessionId)}.json`);
    const legacyStat = legacyAllowed && fs.existsSync(legacyFile) ? fs.statSync(legacyFile) : undefined;
    const legacy = legacyStat ? JSON.stringify([legacyStat.ino, legacyStat.size, legacyStat.mtimeMs, legacyStat.ctimeMs]) : '';
    let projection = projections.get(sessionId);
    if (!projection || projection.legacy !== legacy) {
      const facts = loadLegacy(sessionId);
      projection = { facts: { ...facts, requests: [], tools: [], contexts: [] }, requests: new Map(), tools: new Map(),
        contexts: new Map(), routes: new Map(), heads: new Map(), legacy };
      for (const row of facts.requests) upsert(projection, { kind: 'request', row });
      for (const row of facts.tools) upsert(projection, { kind: 'tool', row });
      for (const row of facts.contexts) upsert(projection, { kind: 'context', row });
      projections.set(sessionId, projection);
    }
    // Keep hot observations indexed without retaining every inspected historical session forever.
    projections.delete(sessionId); projections.set(sessionId, projection);
    while (projections.size > 8) projections.delete(projections.keys().next().value!);
    const folder = path.join(root, hash(sessionId));
    const entries: Entry[] = [];
    const names = fs.existsSync(folder) ? fs.readdirSync(folder).filter(name => /^[0-9a-f-]{36}\.jsonl$/.test(name)).sort() : [];
    if ([...projection.heads.keys()].some(name => !names.includes(name))) {
      projections.delete(sessionId); throw new Error('Statistics journal is missing.');
    }
    for (const name of names) {
      const target = path.join(folder, name);
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid statistics journal.');
      const before = projection.heads.get(name);
      if (before && before.ino === stat.ino && before.size === stat.size && before.mtime === stat.mtimeMs && before.ctime === stat.ctimeMs) continue;
      if (before && (before.ino !== stat.ino || stat.size < before.size || stat.size === before.size)) {
        projections.delete(sessionId); throw new Error('Statistics journal was replaced.');
      }
      const start = before?.size ?? 0;
      const bytes = Buffer.alloc(stat.size - start);
      const descriptor = fs.openSync(target, 'r');
      try {
        let read = 0;
        while (read < bytes.length) { const count = fs.readSync(descriptor, bytes, read, bytes.length - read, start + read);
          if (!count) throw new Error('Statistics journal changed while reading.'); read += count; }
      } finally { fs.closeSync(descriptor); }
      const committed = bytes.lastIndexOf(10) + 1;
      if (committed !== bytes.length) reportFailure(sessionId);
      for (const line of bytes.subarray(0, committed).toString('utf8').split('\n')) {
        if (!line) continue;
        const entry = JSON.parse(line) as Entry;
        if (entry.version !== 2 || entry.sessionId !== sessionId || !Number.isSafeInteger(entry.revision)
          || !record(entry.owner) || typeof entry.owner.runtimeId !== 'string' || typeof entry.owner.ownerId !== 'string'
          || !Number.isSafeInteger(entry.owner.pid) || typeof entry.owner.startedAt !== 'string' || !Array.isArray(entry.changes)
          || !Array.isArray(entry.issues) || !entry.issues.every(issue => typeof issue === 'string')
          || !['complete', 'partial'].includes(entry.coverage)) throw new Error('Invalid statistics journal.');
        for (const delta of entry.changes) {
          if (!record(delta) || !['created', 'request', 'tool', 'context'].includes(delta.kind)
            || (delta.kind !== 'created' && (!record(delta.row) || (delta.kind === 'request'
              ? typeof delta.row.requestId !== 'string' || typeof delta.row.runtimeId !== 'string' || typeof delta.row.state !== 'string'
                || !validUsage(delta.row.usage) || !validUsage(delta.row.partialUsage)
              : delta.kind === 'tool' ? typeof delta.row.id !== 'string' || typeof delta.row.runtimeId !== 'string'
                || typeof delta.row.state !== 'string' || !Array.isArray(delta.row.sandbox)
                : typeof delta.row.contextId !== 'string')))) throw new Error('Invalid statistics journal row.');
        }
        entries.push(entry);
      }
      projection.heads.set(name, { size: start + committed, ino: stat.ino, mtime: stat.mtimeMs, ctime: stat.ctimeMs });
    }
    entries.sort((a, b) => a.revision - b.revision || a.owner.runtimeId.localeCompare(b.owner.runtimeId));
    for (const entry of entries) {
      const facts = projection.facts;
      facts.revision = Math.max(facts.revision, entry.revision);
      facts.owners[entry.owner.runtimeId] = entry.owner;
      if (entry.changes.some(delta => delta.kind === 'created') && facts.requests.length === 0 && facts.tools.length === 0) {
        facts.coverage = entry.coverage; facts.issues = entry.issues;
      } else if (entry.coverage === 'partial') {
        facts.coverage = 'partial'; facts.issues = [...new Set([...facts.issues, ...entry.issues])];
      }
      for (const delta of entry.changes) upsert(projection, delta);
    }
    return partial(projection.facts);
  };
  const save = (facts: Facts, changes: Delta[]): void => {
    const folder = path.join(root, hash(facts.sessionId));
    fs.mkdirSync(folder, { recursive: true });
    const entry: Entry = { version: 2, sessionId: facts.sessionId, revision: facts.revision, owner,
      coverage: facts.coverage, issues: facts.issues, changes };
    const name = `${writer}.jsonl`, file = path.join(folder, name), bytes = `${JSON.stringify(entry)}\n`;
    try {
      fs.appendFileSync(file, bytes, { mode: 0o600 });
      const projection = projections.get(facts.sessionId)!;
      const previous = projection.heads.get(name), stat = fs.lstatSync(file);
      // The row is already applied in memory. Advance only over exactly our
      // durable append; unexpected bytes still go through normal validation.
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size === (previous?.size ?? 0) + Buffer.byteLength(bytes)
        && (previous === undefined || previous.ino === stat.ino)) {
        projection.heads.set(name, { size: stat.size, ino: stat.ino, mtime: stat.mtimeMs, ctime: stat.ctimeMs });
      }
    }
    catch (error) { writer = randomUUID(); throw error; } // Retain a possible torn tail; never append new facts to it.
  };
  const change = (sessionId: string, effect: (facts: Facts, projection: Projection) => Delta[]): void => {
    try {
      const facts = load(sessionId); facts.revision += 1;
      facts.owners[owner.runtimeId] = owner;
      const changes = effect(facts, projections.get(sessionId)!);
      save(facts, changes);
    } catch { projections.delete(sessionId); reportFailure(sessionId); }
  };
  const readAvailable = (sessionId: string): Facts => {
    try { return load(sessionId); }
    catch { projections.delete(sessionId); reportFailure(sessionId); return empty(sessionId); }
  };
  const recovered = async (sessionId: string): Promise<Facts> => {
    const observed = readAvailable(sessionId);
    const dead = new Map<string, string>();
    for (const [runtimeId, previous] of Object.entries(observed.owners)) {
      if (!observed.requests.some(row => row.runtimeId === runtimeId && row.state === 'started')
        && !observed.tools.some(row => row.runtimeId === runtimeId && (row.state === 'prepared' || row.state === 'executing'))) continue;
      if (await isRuntimeActorOwnerAlive(previous)) continue;
      dead.set(runtimeId, JSON.stringify(previous));
    }
    // Probes yield; re-read before the synchronous write to preserve new facts.
    const facts = readAvailable(sessionId);
    const changes: Delta[] = [];
    for (const [runtimeId, identity] of dead) {
      if (JSON.stringify(facts.owners[runtimeId]) !== identity) continue;
      facts.revision += 1;
      for (const row of facts.requests) if (row.runtimeId === runtimeId && row.state === 'started') changes.push({ kind: 'request', recover: true,
        row: { ...row, state: 'unknown', recovery: 'outcome_unknown', revision: facts.revision } });
      for (const row of facts.tools) if (row.runtimeId === runtimeId && (row.state === 'prepared' || row.state === 'executing')) changes.push({ kind: 'tool', recover: true,
        row: { ...row, state: 'unknown', revision: facts.revision } });
    }
    for (const delta of changes) upsert(projections.get(sessionId)!, delta);
    if (facts.requests.some(row => row.state === 'unknown' && row.boundary === 'provider_operation')) {
      facts.coverage = 'partial';
      const issue = 'Some adapters report operation boundaries rather than physical wire attempts.';
      if (!facts.issues.includes(issue)) facts.issues.push(issue);
    }
    if (changes.length) try { save(facts, changes); } catch { projections.delete(sessionId); reportFailure(sessionId); }
    return partial(facts);
  };
  const pageEpochs = new WeakMap<Facts, string>();
  const page = <T extends { revision: number }>(facts: Facts, kind: 'requests' | 'tools', rows: readonly T[], options?: { cursor?: string; limit?: number }): ClientExecutionFactsPage<T> => {
    const epoch = pageEpochs.get(facts) ?? randomUUID(); pageEpochs.set(facts, epoch);
    const limit = options?.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw Object.assign(new Error('Fact page limit must be 1–500.'), { code: 'invalid_params' });
    let cursor: { offset: number; size: number; sessionId: string; kind: string; epoch?: string };
    try { cursor = options?.cursor === undefined ? { offset: 0, size: rows.length, sessionId: facts.sessionId, kind, epoch }
      : JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8')) as typeof cursor; }
    catch { throw Object.assign(new Error('Invalid fact cursor.'), { code: 'invalid_params' }); }
    if (!cursor || typeof cursor !== 'object') throw Object.assign(new Error('Invalid fact cursor.'), { code: 'invalid_params' });
    if (cursor.epoch !== epoch) throw Object.assign(new Error('Fact cursor expired after projection recovery. Restart pagination.'), { code: 'conflict' });
    if (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || !Number.isSafeInteger(cursor.size)
      || cursor.size < cursor.offset || cursor.size > rows.length || cursor.sessionId !== facts.sessionId || cursor.kind !== kind) {
      throw Object.assign(new Error('Invalid fact cursor.'), { code: 'invalid_params' });
    }
    const end = Math.min(cursor.offset + limit, cursor.size);
    return { revision: facts.revision, items: structuredClone(rows.slice(cursor.offset, end)),
      ...(end < cursor.size ? { nextCursor: Buffer.from(JSON.stringify({ offset: end, size: cursor.size, sessionId: facts.sessionId, kind, epoch })).toString('base64url') } : {}) };
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
        operationCount: facts.requests.filter(row => row.boundary === 'provider_operation').length, contexts: structuredClone(facts.contexts) };
    },
    async readRequests(sessionId, options) { const facts = await recovered(sessionId); return page(facts, 'requests', facts.requests, options); },
    async readTools(sessionId, options) { const facts = await recovered(sessionId); return page(facts, 'tools', facts.tools, options); },
  };
  return {
    service,
    created(sessionId: string): void {
      try { if (load(sessionId).revision === 0) change(sessionId, facts => {
        if (!incomplete.has(sessionId)) { facts.coverage = 'complete'; facts.issues = []; }
        return [{ kind: 'created' }];
      }); } catch { reportFailure(sessionId); }
    },
    provider(sessionId: string, target: ClientExecutionTarget, observation: ProviderRequestObservation): void {
      change(sessionId, (facts, projection) => {
        const existing = projection.requests.get(observation.requestId) ?? -1;
        const actorTarget = observation.attribution?.kind === 'actor_turn' ? { kind: 'actor_turn' as const,
          actorPath: observation.attribution.actorPath, turnId: observation.attribution.turnId,
          ...(target.kind === 'run' ? { parentRunId: target.runId } : {}) } : target;
        const previousId = projection.routes.get(routeKey({ ...observation, target: actorTarget }));
        const row: ClientProviderRequestFact = { ...observation, target: actorTarget, sessionId, runtimeId: owner.runtimeId,
          revision: facts.revision, fallback: observation.purpose === 'fallback' || (observation.route?.attempt ?? 1) > 1,
          ...(existing >= 0 ? { previousRequestId: facts.requests[existing]?.previousRequestId }
            : previousId ? { previousRequestId: previousId } : {}) };
        upsert(projection, { kind: 'request', row });
        if (observation.boundary === 'provider_operation' && observation.state !== 'started'
          && !facts.issues.includes('Some adapters report operation boundaries rather than physical wire attempts.')) {
          facts.coverage = 'partial'; facts.issues.push('Some adapters report operation boundaries rather than physical wire attempts.');
        }
        return [{ kind: 'request', row }];
      });
    },
    context(sessionId: string, target: ClientExecutionTarget, snapshot: RuntimeContextBudgetSnapshot): void {
      change(sessionId, (facts, projection) => {
        const row: ClientContextBudgetFact = { ...snapshot, runtimeId: owner.runtimeId, target, revision: facts.revision };
        upsert(projection, { kind: 'context', row });
        return [{ kind: 'context', row }];
      });
    },
    tool(sessionId: string, target: ClientExecutionTarget, id: string, toolId: string, name: string | undefined,
      patch: { state?: ClientToolExecutionFact['state']; result?: ClientToolExecutionFact['result']; observation?: KodaXShellSandboxObservation }): void {
      change(sessionId, (facts, projection) => {
        const index = projection.tools.get(id) ?? -1;
        const previous = facts.tools[index];
        const row: ClientToolExecutionFact = { id, revision: facts.revision, toolId, name: name ?? previous?.name ?? 'unknown',
          sessionId, target, runtimeId: owner.runtimeId,
          state: patch.result !== undefined && previous === undefined && facts.issues.includes(unavailable) ? 'unknown'
            : patch.result !== undefined && previous?.state !== 'executing' && previous?.state !== 'completed'
            ? 'not_executed' : patch.state ?? previous?.state ?? 'prepared',
          result: patch.result ?? previous?.result, updatedAt: new Date().toISOString(),
          sandbox: [...(previous?.sandbox ?? []), ...(patch.observation === undefined ? [] : [patch.observation])] };
        upsert(projection, { kind: 'tool', row });
        return [{ kind: 'tool', row }];
      });
    },
  };
}
export type ExecutionFactsStore = ReturnType<typeof createExecutionFactsStore>;
