import type { KodaXProductClient } from '@kodax-ai/coding/client-contract';
import { memoryProposalRevision } from '@kodax-ai/agent';
import type { KodaXRuntime } from './sdk-runtime.js';
import { toClientConfig, toClientSessionSettings } from './client-settings.js';

/**
 * FEATURE_298 T35 — project a connected runtime as the product client. The
 * CLI projects its connection to the independent Host through this adapter;
 * external clients use connectKodaXClient.
 */
export function toKodaXProductClient(
  runtime: KodaXRuntime,
): KodaXProductClient {
  return {
    commands: {
      execute: (input) => runtime.invocations.executeCommand(input),
      readPrompt: (input) => runtime.invocations.readCommandPrompt(input),
    },
    review: { start: (input) => runtime.invocations.startReview(input) },
    host: {
      shutdown: () => runtime.daemon !== undefined
        ? runtime.daemon.shutdown()
        // An embedded facade is the Host in this process: closing it is the
        // shutdown.
        : runtime.close().then(() => ({ accepted: true as const })),
    },
    sessions: {
      create: (input) => runtime.sessions.create(input),
      list: (filter) => runtime.sessions.list(filter),
      read: (sessionId) => runtime.sessions.load(sessionId),
      delete: (sessionId) => runtime.sessions.delete(sessionId),
      archive: (sessionId) => runtime.sessions.archive(sessionId),
      unarchive: (sessionId) => runtime.sessions.unarchive(sessionId),
      getAutoModeStats: async sessionId => (await runtime.sessions.getAutoModeStats(sessionId)) ?? undefined,
      getSettings: async (sessionId) => toClientSessionSettings(await runtime.sessions.getSettings(sessionId)),
      updateSettings: async (sessionId, patch) => toClientSessionSettings(await runtime.sessions.updateSettings(sessionId, patch)),
      observe: (sessionId, onView, options) => runtime.sessions.observeView(sessionId, onView, options),
      readItem: (sessionId, itemId, options) => runtime.sessions.readViewItem(sessionId, itemId, options),
      readHistory: (sessionId, options) => runtime.sessions.readHistory(sessionId, options),
      readHistoryEntry: (sessionId, itemId, options) => runtime.sessions.readHistoryEntry(sessionId, itemId, options),
      searchHistory: (sessionId, input) => runtime.sessions.searchHistory(sessionId, input),
      readGoal: (sessionId) => runtime.sessions.readGoal(sessionId),
      createGoal: (sessionId, input) => runtime.sessions.createGoal({ sessionId, ...input }),
      pauseGoal: (sessionId) => runtime.sessions.pauseGoal(sessionId),
      resumeGoal: (sessionId) => runtime.sessions.resumeGoal(sessionId),
      clearGoal: (sessionId) => runtime.sessions.clearGoal(sessionId),
      appendNotice: async (sessionId, input) => {
        await runtime.sessions.appendNotice({ sessionId, ...input });
      },
      readLineage: (sessionId) => runtime.sessions.readLineage(sessionId),
      labelEntry: (sessionId, input) => runtime.sessions.labelEntry({ sessionId, ...input }),
      selectBranch: (sessionId, selector, options) => runtime.sessions.setActiveEntry({ sessionId, entryId: selector, ...options })
        .then((session) => {
          // Same-version Hosts throw conflict themselves; null only survives
          // from an older Host that predates the explicit-conflict contract.
          if (session === null) throw Object.assign(new Error('No lineage entry matches the selector.'), { code: 'conflict' as const });
          return session;
        }),
      rewindSession: (sessionId, input) => runtime.sessions.rewind({ sessionId, ...input })
        .then((session) => {
          if (session === null) throw Object.assign(new Error('Rewind target no longer resolves.'), { code: 'conflict' as const });
          return session;
        }),
      forkSession: (sessionId, input) => runtime.sessions.fork({ sessionId, ...(input ?? {}) })
        .then((session) => {
          if (session === null) throw Object.assign(new Error('Fork boundary no longer resolves.'), { code: 'conflict' as const });
          return session;
        }),
      recoverSession: (sessionId, input) => runtime.sessions.recover({ sessionId, ...(input ?? {}) }),
      compact: async (sessionId, input) => {
        const result = await runtime.sessions.compact({ sessionId, ...input });
        return {
          compacted: result.compacted, messages: result.messages,
          tokensBefore: result.tokensBefore, tokensAfter: result.tokensAfter,
          ...(result.report !== undefined ? { report: result.report } : {}),
          ...(result.reason !== undefined ? { reason: result.reason } : {}),
        };
      },
    },
    learning: {
      list: (query) => runtime.learning.list(query),
      get: (nameOrSlugOrId) => runtime.learning.get(nameOrSlugOrId),
      getSnapshot: () => runtime.learning.getSnapshot(),
      events: (afterRevision) => runtime.learning.events(afterRevision),
      subscribe: (options) => runtime.learning.subscribe(options),
      acknowledge: (nameOrSlugOrId) => runtime.learning.acknowledge(nameOrSlugOrId),
      snooze: (nameOrSlugOrId, until) => runtime.learning.snooze(nameOrSlugOrId, until),
      reject: (nameOrSlugOrId) => runtime.learning.reject(nameOrSlugOrId),
      disable: (nameOrSlugOrId) => runtime.learning.disable(nameOrSlugOrId),
      rollback: (nameOrSlugOrId) => runtime.learning.rollback(nameOrSlugOrId),
      promote: (nameOrSlugOrId, scope) => runtime.learning.promote(nameOrSlugOrId, scope),
      review: (nameOrSlugOrId) => runtime.learning.review(nameOrSlugOrId),
      trust: (nameOrSlugOrId) => runtime.learning.trust(nameOrSlugOrId),
    },
    memory: {
      async forProject(projectRoot) {
        const plane = await runtime.memory.forProject(projectRoot);
        return {
          memoryRoot: plane.memoryRoot,
          entrypointPath: plane.entrypointPath,
          listReviews: () => plane.listReviews(),
          reviewerProviderConfigured: () => plane.reviewerProviderConfigured(),
          rebuild: () => plane.rebuild(),
          ensureOpenTarget: (targetPath) => plane.ensureOpenTarget(targetPath),
          controller: {
            listRefs: (filter) => plane.controller.listRefs(filter),
            readRef: (ref) => plane.controller.readRef(ref),
            remember: (input) => plane.controller.remember(input),
            forgetRef: (id, fingerprint) => plane.controller.forgetRef(id, fingerprint),
            approveProposal: (id, fingerprints, revision) => plane.controller.approveProposal(id, fingerprints, revision),
            rejectProposal: (id, reason, revision) => plane.controller.rejectProposal(id, reason, revision),
            listInbox: async () => (await plane.controller.listInbox()).map((proposal) => ({
              ...proposal, revision: memoryProposalRevision(proposal),
            })),
            showProposal: async (id) => {
              const proposal = await plane.controller.showProposal(id);
              return proposal === undefined ? undefined : { ...proposal, revision: memoryProposalRevision(proposal) };
            },
          },
        };
      },
    },
    inputs: {
      submit: (input) => runtime.runs.acceptInput(input),
      read: (sessionId, inputId) => runtime.runs.getInput(sessionId, inputId),
      withdraw: (sessionId, inputId) => runtime.runs.withdrawInput(sessionId, inputId),
    },
    runs: {
      read: (runId) => runtime.runs.get(runId),
      stop: (runId) => runtime.runs.abort(runId),
      await: async (runId) => {
        const outcome = await runtime.runs.await(runId);
        return {
          runId: outcome.runId,
          sessionId: outcome.sessionId,
          phase: outcome.phase,
          ...(outcome.result !== undefined ? { result: outcome.result } : {}),
          ...(outcome.error !== undefined ? { error: outcome.error.message } : {}),
        };
      },
    },
    interactions: {
      list: (filter) => runtime.interactions.list(filter),
      respond: (requestId, response) => runtime.interactions.respond(requestId, response),
    },
    permissions: {
      listGrants: async () => {
        const current = await runtime.permissions.listGrants();
        return {
          revision: current.revision,
          grants: current.value.map((grant) => ({
            id: grant.id,
            ...(grant.label !== undefined ? { label: grant.label } : {}),
            ...(grant.persistence !== undefined ? { persistence: grant.persistence } : {}),
          })),
        };
      },
      revokeGrant: (grantId, expectedRevision) => runtime.permissions.revokeGrant(grantId, expectedRevision),
    },
    registrations: {
      list: () => runtime.admin.agentRegistrations.list(),
      upsert: (registration, options) => runtime.admin.agentRegistrations.upsert(registration, options),
      setEnabled: (agentId, enabled, options) =>
        runtime.admin.agentRegistrations.setEnabled(agentId, enabled, options),
      remove: (agentId, options) => runtime.admin.agentRegistrations.remove(agentId, options),
    },
    agents: {
      reviewLean: (input) => runtime.invocations.startAgentsLean(input),
      tree: (sessionId) => runtime.agents.tree(sessionId),
      detail: (sessionId, actorPath) => runtime.agents.detail(sessionId, actorPath),
      spawn: (sessionId, input) => runtime.agents.spawn(sessionId, input),
      send: (sessionId, actorPath, content, classification) =>
        runtime.agents.send(sessionId, actorPath, content, classification),
      followup: (sessionId, actorPath, objective, options) =>
        runtime.agents.followup(sessionId, actorPath, objective,
          options?.expectedRevision === undefined ? undefined : { expectedRevision: options.expectedRevision }),
      interrupt: (sessionId, actorPath, reason) => runtime.agents.interrupt(sessionId, actorPath, reason),
      output: (sessionId, actorPath, turnId) => runtime.agents.output(sessionId, actorPath, turnId),
      wait: (sessionId, afterSequence, timeoutMs, options) =>
        runtime.agents.wait(sessionId, afterSequence, timeoutMs,
          options?.signal === undefined ? undefined : { signal: options.signal }),
    },
    config: {
      read: async () => toClientConfig(await runtime.config.read()),
      patch: async (patch) => toClientConfig(await runtime.config.patch(patch)),
      reload: async () => ({ ok: true, config: toClientConfig((await runtime.config.reload()).config) }),
    },
    mcp: {
      listServers: () => runtime.mcp.listServers(),
      getServer: (name) => runtime.mcp.getServer(name),
      validateServer: (name, config) => runtime.mcp.validateServer(name, config),
      upsertServer: (name, config) => runtime.mcp.upsertServer(name, config),
      deleteServer: (name) => runtime.mcp.deleteServer(name),
      reloadServers: () => runtime.mcp.reloadServers(),
      listTools: (filter) => runtime.mcp.listTools(filter),
    },
    workflows: {
      start: (input) => runtime.workflows.start(input),
      list: async (filter) => (await runtime.workflows.list(filter ?? {})).map((run) => ({
        runId: run.runId,
        workflowName: run.workflow,
        status: run.status,
        totalSpawned: run.totalSpawned, eventCount: run.eventCount, runDir: run.runDir,
        ...(run.endedAt !== undefined ? { endedAt: new Date(run.endedAt).toISOString() } : {}),
        startedAt: new Date(run.startedAt).toISOString(),
        updatedAt: run.endedAt !== undefined
          ? new Date(run.endedAt).toISOString()
          : new Date(run.startedAt).toISOString(),
        ...(run.resultText !== undefined ? { resultSummary: run.resultText } : {}),
        ...(run.error !== undefined ? { error: run.error } : {}),
      })),
      get: (runId) => runtime.workflows.get(runId),
      subscribe: (filter, listener) => runtime.workflows.subscribe(filter, listener),
      pause: (runId) => runtime.workflows.pause(runId),
      resume: (runId) => runtime.workflows.resume(runId),
      stop: (runId) => runtime.workflows.stop(runId),
    },
    catalog: {
      providers: () => runtime.catalog.providers(),
      models: async (filter) => (await runtime.catalog.providers())
        .filter((provider) => filter?.provider === undefined || provider.name === filter.provider)
        .map((provider) => ({ provider: provider.name, models: provider.models })),
      reasoningEfforts: (input) => runtime.catalog.reasoningEfforts(input),
      probeReasoningEfforts: (input) => runtime.catalog.probeReasoningEfforts(input),
      forgetCapabilities: (input) => runtime.catalog.forgetCapabilities(input),
      commands: async (workspaceRoot) => (await runtime.catalog.commands(workspaceRoot)).map((command) => ({
        name: command.name,
        ...(command.aliases !== undefined ? { aliases: command.aliases } : {}),
        description: command.description,
        source: String(command.source),
        ...(command.userInvocable !== undefined ? { userInvocable: command.userInvocable } : {}),
      })),
      skills: async (input) => (await runtime.catalog.skills(input)).map((skill) => ({
        name: skill.name,
        description: skill.description,
        userInvocable: skill.userInvocable,
        path: skill.path,
        source: String(skill.source),
      })),
    },
    disconnect: () => runtime.close(),
  };
}
