import { describe, expect, it } from 'vitest';

import {
  RUNTIME_DAEMON_METHODS,
} from './protocol.js';
import {
  RUNTIME_DAEMON_METHOD_SCHEMAS,
  RUNTIME_DAEMON_NOTIFICATION_SCHEMAS,
  RUNTIME_DAEMON_PROTOCOL_SCHEMA,
  RUNTIME_DAEMON_PROTOCOL_SCHEMA_JSON,
  validateRuntimeDaemonJsonSchema,
} from './schema.js';

describe('runtime daemon protocol schema', () => {
  it('covers every daemon protocol method with params and result schemas', () => {
    expect(Object.keys(RUNTIME_DAEMON_METHOD_SCHEMAS).sort()).toEqual([...RUNTIME_DAEMON_METHODS].sort());
    expect(RUNTIME_DAEMON_PROTOCOL_SCHEMA_JSON).not.toContain('agentTasks.');

    for (const method of RUNTIME_DAEMON_METHODS) {
      const schema = RUNTIME_DAEMON_METHOD_SCHEMAS[method];
      expect(schema.params).toBeDefined();
      expect(schema.result).toBeDefined();
    }
  });

  it('publishes one schema artifact with method and notification families', () => {
    expect(RUNTIME_DAEMON_PROTOCOL_SCHEMA).toMatchObject({
      protocol: 'kodax-runtime-daemon',
      version: 1,
      methods: RUNTIME_DAEMON_METHOD_SCHEMAS,
      notifications: RUNTIME_DAEMON_NOTIFICATION_SCHEMAS,
    });
    expect(JSON.parse(RUNTIME_DAEMON_PROTOCOL_SCHEMA_JSON)).toMatchObject({
      protocol: 'kodax-runtime-daemon',
      version: 1,
      methods: {
        'provider.custom.list': expect.any(Object),
        'mcp.server.validate': expect.any(Object),
        'extension.list': expect.any(Object),
      },
    });
  });

  it('includes diagnostic daemon methods in the generated method schema map', () => {
    expect(RUNTIME_DAEMON_METHOD_SCHEMAS['session.diagnostics']).toMatchObject({
      params: {
        required: ['sessionId'],
        properties: {
          sessionId: { type: 'string' },
          runId: { type: 'string' },
          timeoutMs: { type: 'integer' },
        },
      },
      result: {
        required: expect.arrayContaining(['schemaVersion', 'observation', 'run']),
      },
    });
    expect(RUNTIME_DAEMON_METHOD_SCHEMAS['context.budget.get'].params).toMatchObject({
      properties: {
        sessionId: { type: 'string' },
        runId: { type: 'string' },
        contextKind: { type: 'string', enum: ['root', 'child'] },
        agentId: { type: 'string' },
      },
    });
    expect(RUNTIME_DAEMON_METHOD_SCHEMAS['tool.exposure.preview'].result).toMatchObject({
      oneOf: expect.arrayContaining([{ type: 'null' }]),
    });
    expect(RUNTIME_DAEMON_METHOD_SCHEMAS['provider.cache.diagnostics.get'].params)
      .toEqual(RUNTIME_DAEMON_METHOD_SCHEMAS['context.budget.get'].params);
  });

  it('validates required, typed, and additional properties', () => {
    const schema = RUNTIME_DAEMON_METHOD_SCHEMAS['session.load'].params;

    expect(validateRuntimeDaemonJsonSchema(schema, { sessionId: 'session-1' })).toEqual([]);
    expect(validateRuntimeDaemonJsonSchema(schema, { sessionId: 42 })).toContain(
      '$.sessionId must be string.',
    );
    expect(validateRuntimeDaemonJsonSchema(schema, {})).toContain(
      '$.sessionId is required.',
    );
    expect(validateRuntimeDaemonJsonSchema(schema, {
      sessionId: 'session-1',
      unexpected: true,
    })).toContain('$.unexpected is not allowed.');
  });

  it('admits credential-safe terminal failure classifications', () => {
    const schema = RUNTIME_DAEMON_METHOD_SCHEMAS['run.await'].result;
    expect(schema).toMatchObject({
      properties: {
        failureDetail: {
          required: [
            'failureKind',
            'stage',
            'providerErrorCode',
            'safeMessage',
          ],
        },
      },
    });
    expect(validateRuntimeDaemonJsonSchema(schema, {
      runId: 'run-1',
      sessionId: 'session-1',
      phase: 'failed',
      failureDetail: {
        failureKind: 'not_found',
        stage: 'transport',
        providerErrorCode: 'model_not_found',
        safeMessage: 'Model missing-model was not found.',
        httpStatus: 404,
        upstreamErrorCode: 'model_not_found',
        requestId: 'req_safe_123',
        retryAfterMs: 2000,
      },
      terminal: {
        revision: 1,
        kind: 'failed',
        code: 'run_failed',
        effectOutcome: 'known',
        failureKind: 'not_found',
      },
    })).toEqual([]);
  });

  it('admits an unconfirmed Runtime settlement across status and diagnostics', () => {
    const failureDetail = {
      failureKind: 'runtime_cleanup',
      stage: 'runtime_settlement',
      providerErrorCode: 'runtime_settlement_failed',
      safeMessage: 'Runtime settlement failed.',
    };
    const lifecycleError = {
      code: 'run_settlement_not_persisted',
      message: 'Runtime settlement failed.',
      retryable: false,
    };
    expect(validateRuntimeDaemonJsonSchema(
      RUNTIME_DAEMON_METHOD_SCHEMAS['run.get'].result,
      {
        runId: 'run-1',
        sessionId: 'session-1',
        phase: 'unknown',
        startedAt: '2026-08-27T00:00:00.000Z',
        provider: 'custom-provider',
        failureDetail,
        lifecycleError,
      },
    )).toEqual([]);
    expect(validateRuntimeDaemonJsonSchema(
      RUNTIME_DAEMON_METHOD_SCHEMAS['session.diagnostics'].result,
      {
        schemaVersion: 1,
        captureStartedAt: '2026-08-27T00:00:00.000Z',
        capturedAt: '2026-08-27T00:00:00.000Z',
        sdkVersion: '0.7.96',
        runtimeVersion: '0.7.96',
        daemonVersion: null,
        runtimeId: 'runtime-1',
        runtimeMode: 'embedded',
        sessionId: 'session-1',
        observation: {
          cursor: { sessionId: 'session-1', journalEpoch: 'epoch-1', seq: 1 },
          transcriptRevision: 'revision-1',
        },
        run: {
          controlRecord: 'present',
          state: 'unknown',
          stage: 'unknown',
          terminalTimeKnown: false,
          failureDetail,
          activeSubtaskCount: null,
          activeSubtaskCountSource: 'unknown',
          errors: [{
            code: 'run_settlement_not_persisted',
            message: 'Runtime settlement failed.',
          }],
        },
      },
    )).toEqual([]);
  });

  it('admits a Runtime-owned cancellation classification', () => {
    expect(validateRuntimeDaemonJsonSchema(
      RUNTIME_DAEMON_METHOD_SCHEMAS['run.await'].result,
      {
        runId: 'run-1',
        sessionId: 'session-1',
        phase: 'cancelled',
        failureDetail: {
          failureKind: 'cancelled',
          stage: 'runtime_control',
          providerErrorCode: 'cancelled',
          safeMessage: 'Runtime run was cancelled by the user.',
        },
      },
    )).toEqual([]);
  });

  it('accepts daemon and supervisor process-start identities returned by management inspection', () => {
    const schema = RUNTIME_DAEMON_METHOD_SCHEMAS['daemon.management.get'].result;

    expect(validateRuntimeDaemonJsonSchema(schema, {
      runtimeId: 'runtime-1',
      revision: 1,
      ownerPolicy: {
        mode: 'daemon',
        revision: 1,
        updatedAt: '2026-08-12T00:00:00.000Z',
      },
      owner: {
        runtimeId: 'runtime-1',
        pid: 42,
        createdAt: '2026-08-12T00:00:00.000Z',
        kind: 'daemon',
        processStartIdentity: 'windows:134158464000000000',
        processContainment: 'windows-job',
        supervisorPid: 43,
        supervisorProcessStartIdentity: 'windows:134158463000000000',
      },
      preflight: {},
    })).toEqual([]);
  });

  it('accepts surface and cursor fields for session.list pagination', () => {
    const schema = RUNTIME_DAEMON_METHOD_SCHEMAS['session.list'].params;
    expect(validateRuntimeDaemonJsonSchema(schema, {
      surface: 'acp',
      cursor: 'opaque-cursor',
      limit: 20,
    })).toEqual([]);
  });

  it('requires event replay limits to be positive', () => {
    const schema = RUNTIME_DAEMON_METHOD_SCHEMAS['event.replay'].params;
    const candidates = schema.oneOf ?? [];
    expect(candidates.map((candidate) => candidate.properties?.limit))
      .toEqual(Array.from({ length: 3 }, () => ({
        type: 'integer',
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
      })));
    const invalidReplay = {
      sessionId: 'session-1',
      limit: 0,
    };
    expect(validateRuntimeDaemonJsonSchema(candidates[0]!, invalidReplay))
      .toContain('$.limit must be at least 1.');
    expect(validateRuntimeDaemonJsonSchema(schema, invalidReplay)).not.toEqual([]);
    expect(validateRuntimeDaemonJsonSchema(candidates[0]!, {
      sessionId: 'session-1',
      limit: Number.MAX_SAFE_INTEGER + 1,
    })).toContain(`$.limit must be at most ${Number.MAX_SAFE_INTEGER}.`);
  });

  it('accepts optional Session correlation on observation invalidation', () => {
    const schema =
      RUNTIME_DAEMON_NOTIFICATION_SCHEMAS['observation.invalidated'];
    const invalidation = {
      code: 'observation_invalidated',
      reason: 'event_overflow',
      runtimeId: 'runtime-1',
      message: 'Observation overflowed.',
    };
    expect(validateRuntimeDaemonJsonSchema(schema, {
      subscriptionId: 'subscription-1',
      sessionId: 'session-1',
      invalidation,
    })).toEqual([]);
    expect(validateRuntimeDaemonJsonSchema(schema, {
      subscriptionId: 'legacy-subscription',
      invalidation,
    })).toEqual([]);
  });

  it('carries complete F263 learned Skill records across Worker and daemon facades', () => {
    const record = {
      schemaVersion: 2,
      capabilityId: 'lc_runtime_promote',
      displayName: 'Runtime promote Skill',
      slug: 'runtime-promote-skill',
      carrier: 'skill',
      lifecycle: 'active_learned',
      revision: 2,
      createdAt: '2026-07-29T00:00:00.000Z',
      updatedAt: '2026-07-29T00:01:00.000Z',
      source: { kind: 'skill_learning_loop' },
      scope: {
        configHomeHash: 'a'.repeat(64),
        tenantHash: 'b'.repeat(64),
        projectHash: 'c'.repeat(64),
      },
      artifact: {
        kind: 'skill_markdown',
        relativePath: 'skills/lc_runtime_promote/revisions/fingerprint/SKILL.md',
        fingerprint: 'd'.repeat(64),
        contentRevision: 1,
      },
      provenance: {
        jobId: 'job-1',
        inputHash: 'e'.repeat(64),
        decisionId: 'decision-1',
        actionId: 'action-1',
      },
      canary: {
        maxInvocations: 3,
        invocationCount: 1,
        verifiedSuccesses: 1,
        credibleNegatives: 0,
        invocations: [{
          invocationId: 'invocation-1',
          bindingId: 'binding-1',
          status: 'verified_success',
          evidenceRefs: ['check:1'],
          invokedAt: '2026-07-29T00:00:30.000Z',
          completedAt: '2026-07-29T00:00:45.000Z',
        }],
      },
    };

    expect(validateRuntimeDaemonJsonSchema(
      RUNTIME_DAEMON_METHOD_SCHEMAS['learning.get'].result,
      record,
    )).toEqual([]);
    expect(validateRuntimeDaemonJsonSchema(
      RUNTIME_DAEMON_METHOD_SCHEMAS['learning.list'].result,
      { items: [record], revision: 2 },
    )).toEqual([]);
    expect(validateRuntimeDaemonJsonSchema(
      RUNTIME_DAEMON_METHOD_SCHEMAS['learning.promote'].params,
      { nameOrSlug: record.slug, scope: 'project' },
    )).toContain('$.scope must be one of: user.');
  });

  it('validates registration ownership and revision-CAS mutation fields', () => {
    const schema = RUNTIME_DAEMON_METHOD_SCHEMAS['agentRegistrations.setEnabled'].params;
    expect(validateRuntimeDaemonJsonSchema(schema, {
      agentId: 'external:managed',
      enabled: false,
      expectedConfigurationRevision: 'rev-1',
      expectedManagementOwner: 'runtime-config-test',
      claimOwner: 'runtime-config-test',
    })).toEqual([]);
    expect(validateRuntimeDaemonJsonSchema(schema, {
      agentId: 'external:managed',
      enabled: false,
      expectedConfigurationRevision: null,
      expectedManagementOwner: null,
    })).toEqual([]);
    expect(validateRuntimeDaemonJsonSchema(schema, {
      agentId: 'external:managed',
      enabled: false,
      claimOwner: 42,
    })).toContain('$.claimOwner must be string.');
    expect(validateRuntimeDaemonJsonSchema(schema, {
      agentId: 'external:managed',
      enabled: false,
      expectedManagementOwner: 42,
    })).toContain('$.expectedManagementOwner must match exactly one allowed schema.');
    for (const method of ['agentRegistrations.upsert', 'agentRegistrations.remove'] as const) {
      const mutationSchema = RUNTIME_DAEMON_METHOD_SCHEMAS[method].params;
      const required = method === 'agentRegistrations.upsert'
        ? { registration: {} }
        : { agentId: 'external:managed' };
      expect(validateRuntimeDaemonJsonSchema(mutationSchema, {
        ...required,
        expectedManagementOwner: null,
      })).toEqual([]);
    }
  });

  it('publishes and validates the run permission broker wire field', () => {
    const schema = RUNTIME_DAEMON_METHOD_SCHEMAS['run.start'].params;

    expect(validateRuntimeDaemonJsonSchema(schema, {
      sessionId: 'session-1',
      permissionBroker: 'client',
    })).toEqual([]);
    expect(validateRuntimeDaemonJsonSchema(schema, {
      sessionId: 'session-1',
      permissionBroker: 'unknown',
    })).toContain('$.permissionBroker must be one of: runtime, client.');
  });

  it('carries the effective execution directory on permission requests', () => {
    const schema = RUNTIME_DAEMON_METHOD_SCHEMAS['permission.request'].params;

    expect(validateRuntimeDaemonJsonSchema(schema, {
      sessionId: 'session-1',
      runId: 'run-1',
      toolName: 'bash',
      executionCwd: 'C:\\work\\project',
    })).toEqual([]);
    expect(validateRuntimeDaemonJsonSchema(schema, {
      sessionId: 'session-1',
      runId: 'run-1',
      toolName: 'bash',
      executionCwd: 42,
    })).toContain('$.executionCwd must be string.');
    expect(validateRuntimeDaemonJsonSchema(schema, {
      sessionId: 'session-1',
      runId: 'run-1',
      toolName: 'bash',
      inputPreview: 'x'.repeat(8_193),
    })).toEqual([]);
    expect(validateRuntimeDaemonJsonSchema(schema, {
      sessionId: 'session-1',
      runId: 'run-1',
      toolName: 'bash',
      toolInput: { command: 'npm test', run_in_background: false },
    })).toEqual([]);
    expect(validateRuntimeDaemonJsonSchema(schema, {
      sessionId: 'session-1',
      runId: 'run-1',
      toolName: 'bash',
      autoModeDiagnostics: {
        source: 'classifier_failure',
        classifierFailureKind: 'timeout',
        classifierAttempts: [{ attempt: 1, outcome: 'timeout' }],
      },
    })).toEqual([]);
    expect(validateRuntimeDaemonJsonSchema(schema, {
      sessionId: 'session-1',
      runId: 'run-1',
      toolName: 'bash',
      projectRoot: 'C:\\untrusted',
    })).toContain('$.projectRoot is not allowed.');
    expect(RUNTIME_DAEMON_METHOD_SCHEMAS['permission.list'].result.items?.properties)
      .not.toHaveProperty('toolInput');
    expect(RUNTIME_DAEMON_METHOD_SCHEMAS['permission.list'].result.items?.properties)
      .toHaveProperty('autoModeDiagnostics');
  });

  it('carries lifecycle stages and unconfirmed Stop outcomes across the daemon facade', () => {
    const schema = RUNTIME_DAEMON_METHOD_SCHEMAS['run.get'].result;
    const status = {
      runId: 'run-1',
      sessionId: 'session-1',
      phase: 'unknown',
      stage: 'unknown',
      stageChangedAt: '2026-07-30T01:10:00.000Z',
      activeSubtaskCount: 0,
      startedAt: '2026-07-30T01:05:13.000Z',
      provider: 'zhipu',
      stop: {
        requestedAt: '2026-07-30T01:14:41.000Z',
        state: 'unknown',
        outcome: 'unknown',
        reason: 'host cancelled',
      },
    };

    expect(validateRuntimeDaemonJsonSchema(schema, status)).toEqual([]);
    expect(validateRuntimeDaemonJsonSchema(schema, {
      ...status,
      phase: 'waiting_agent',
      stage: 'verifying',
    })).toEqual([]);
  });

  it('carries typed approval timeout decisions across permission RPC', () => {
    const schema = RUNTIME_DAEMON_METHOD_SCHEMAS['permission.request'].result;
    expect(validateRuntimeDaemonJsonSchema(schema, {
      type: 'reject',
      reason: 'permission request timed out',
      cause: 'approval_timeout',
    })).toEqual([]);
    const invalid = validateRuntimeDaemonJsonSchema(schema, {
      type: 'reject',
      cause: 'network_timeout',
    });
    expect(invalid).not.toEqual([]);
  });

  it('keeps deprecated scope decisions transport-compatible without trusting them', () => {
    const schema = RUNTIME_DAEMON_METHOD_SCHEMAS['permission.respond'].params;
    const fingerprint = 'a'.repeat(64);
    expect(validateRuntimeDaemonJsonSchema(schema, {
      requestId: 'permission-1',
      decision: {
        type: 'allow_always',
        scope: {
          toolName: 'bash',
          matcher: {
            version: 1,
            kind: 'exact-command',
            toolName: 'bash',
            fingerprint,
            shell: 'posix',
            commandFingerprint: fingerprint,
            cwd: '/workspace',
            background: false,
          },
        },
      },
    })).toEqual([]);
  });
});
