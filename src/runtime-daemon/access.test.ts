import { describe, expect, it } from 'vitest';
import { RUNTIME_DAEMON_METHODS, type RuntimeDaemonMethod } from './protocol.js';
import {
  RUNTIME_METHOD_PLANES,
  runtimeAccessDenial,
  runtimeAuthorizationSubject,
  type RuntimeConnectionRole,
  type RuntimeMethodPlane,
} from './access.js';

const ROLES: readonly RuntimeConnectionRole[] = ['owner', 'user', 'service'];

function methodsIn(plane: RuntimeMethodPlane): RuntimeDaemonMethod[] {
  return RUNTIME_DAEMON_METHODS.filter(method => RUNTIME_METHOD_PLANES[method] === plane);
}

describe('runtime connection access', () => {
  it('places every live method in exactly one plane', () => {
    expect(Object.keys(RUNTIME_METHOD_PLANES).sort()).toEqual([...RUNTIME_DAEMON_METHODS].sort());
  });

  it('rejects every method, the handshake included, on a connection without a role', () => {
    for (const method of RUNTIME_DAEMON_METHODS) {
      expect(runtimeAccessDenial(undefined, method, {}), method).toMatch(/no role/);
    }
  });

  it('rejects a role value the Host does not know', () => {
    expect(runtimeAccessDenial('admin' as RuntimeConnectionRole, 'ping', {})).toMatch(/no role/);
  });

  it('keeps every method and trusted parameter open to the owner', () => {
    for (const method of RUNTIME_DAEMON_METHODS) {
      expect(
        runtimeAccessDenial('owner', method, { authorization: {}, credential: {}, hostTools: [], policy: {}, runOptions: {} }),
        method,
      ).toBeUndefined();
    }
  });

  it('limits the user role to the data plane', () => {
    for (const method of methodsIn('data')) expect(runtimeAccessDenial('user', method, {}), method).toBeUndefined();
    for (const plane of ['settings', 'trusted', 'local'] as const) {
      for (const method of methodsIn(plane)) {
        expect(runtimeAccessDenial('user', method, {}), method).toMatch(/not available to the user role/);
      }
    }
  });

  it('gives the service role the data and trusted planes, without answering for the person', () => {
    for (const plane of ['data', 'trusted'] as const) {
      for (const method of methodsIn(plane)) {
        if (method === 'interaction.respond') continue;
        expect(runtimeAccessDenial('service', method, {}), method).toBeUndefined();
      }
    }
    for (const plane of ['settings', 'local'] as const) {
      for (const method of methodsIn(plane)) {
        expect(runtimeAccessDenial('service', method, {}), method).toMatch(/not available to the service role/);
      }
    }
    expect(runtimeAccessDenial('service', 'interaction.respond', {})).toMatch(/person/);
    expect(runtimeAccessDenial('user', 'interaction.respond', {})).toBeUndefined();
  });

  it.each(['authorization', 'credential', 'hostTools', 'policy', 'runOptions'])(
    'rejects the trusted parameter %s from the user role and accepts it from a service',
    (name) => {
      const params = { sessionId: 's1', text: 'hi', [name]: {} };
      expect(runtimeAccessDenial('user', 'input.submit', params)).toMatch(new RegExp(name));
      expect(runtimeAccessDenial('service', 'input.submit', params)).toBeUndefined();
    },
  );

  it('treats an undefined trusted parameter as absent and an explicit null as sent', () => {
    expect(runtimeAccessDenial('user', 'input.submit', { authorization: undefined })).toBeUndefined();
    expect(runtimeAccessDenial('user', 'input.submit', { authorization: null })).toMatch(/authorization/);
  });

  it('keeps the planes the plan assigns to the sensitive domains', () => {
    const planes: Record<string, RuntimeMethodPlane> = {
      'execution.register': 'trusted',
      'credential.supply': 'trusted',
      'host_tool.complete': 'trusted',
      'session.promote': 'trusted',
      'config.patch': 'settings',
      'mcp.server.upsert': 'settings',
      'agentRegistrations.upsert': 'settings',
      'daemon.stop': 'local',
      'runtime.shutdown': 'local',
      'client.exit.request': 'local',
      'memory.remember': 'local',
      'learning.trust': 'local',
      'session.diagnostics': 'local',
      'repo.intelligence.prewarm': 'local',
    };
    for (const [method, plane] of Object.entries(planes)) {
      expect(RUNTIME_METHOD_PLANES[method as keyof typeof RUNTIME_METHOD_PLANES], method).toBe(plane);
    }
  });

  it('covers every role', () => {
    for (const role of ROLES) expect(runtimeAccessDenial(role, 'ping', {})).toBeUndefined();
  });

  it('names the person for every human connection and a service by its token subject', () => {
    expect(runtimeAuthorizationSubject('owner', undefined)).toBe('person');
    expect(runtimeAuthorizationSubject('user', 'alice')).toBe('person');
    expect(runtimeAuthorizationSubject('service', 'billing')).toBe('service:billing');
  });

  it('gives no subject to a service without a token subject or to a connection without a role', () => {
    expect(runtimeAuthorizationSubject('service', undefined)).toBeUndefined();
    expect(runtimeAuthorizationSubject('service', '')).toBeUndefined();
    expect(runtimeAuthorizationSubject(undefined, 'billing')).toBeUndefined();
  });
});
