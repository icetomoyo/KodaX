import { describe, expect, it } from 'vitest';

import {
  RUNTIME_DAEMON_METHODS,
  createRuntimeDaemonErrorResponse,
  createRuntimeDaemonNotification,
  createRuntimeDaemonRequest,
  createRuntimeDaemonSuccessResponse,
  isRuntimeDaemonErrorResponse,
  isRuntimeDaemonFrame,
  isRuntimeDaemonNotification,
  isRuntimeDaemonRequest,
  isRuntimeDaemonSuccessResponse,
  parseRuntimeDaemonFrame,
} from './protocol.js';

describe('runtime daemon protocol frames', () => {
  it('creates and validates request frames with known methods', () => {
    const request = createRuntimeDaemonRequest('req-1', 'session.create', {
      title: 'Daemon Session',
    });

    expect(isRuntimeDaemonRequest(request)).toBe(true);
    expect(isRuntimeDaemonFrame(request)).toBe(true);
    expect(parseRuntimeDaemonFrame(JSON.stringify(request))).toEqual(request);
  });

  it('rejects unknown request methods fail-closed', () => {
    const frame = {
      ...createRuntimeDaemonRequest('req-1', 'ping'),
      method: 'arbitrary.execute',
    };

    expect(isRuntimeDaemonRequest(frame)).toBe(false);
    expect(parseRuntimeDaemonFrame(JSON.stringify(frame))).toMatchObject({
      kind: 'error',
      error: { code: 'invalid_frame' },
    });
  });

  it('recognizes retired Agent task methods only so the daemon can return an upgrade error', () => {
    const request = {
      ...createRuntimeDaemonRequest('req-legacy-agent', 'ping'),
      method: 'agentTasks.start',
      params: {},
    };

    expect(isRuntimeDaemonRequest(request)).toBe(true);
    expect(parseRuntimeDaemonFrame(JSON.stringify(request))).toEqual(request);
    expect(RUNTIME_DAEMON_METHODS).not.toContain('agentTasks.start');
  });

  it('creates and validates success and error responses', () => {
    const success = createRuntimeDaemonSuccessResponse('req-2', {
      ok: true,
    });
    const error = createRuntimeDaemonErrorResponse({
      code: 'not_found',
      message: 'Session not found.',
    }, 'req-3');

    expect(isRuntimeDaemonSuccessResponse(success)).toBe(true);
    expect(isRuntimeDaemonErrorResponse(error)).toBe(true);
    expect(parseRuntimeDaemonFrame(JSON.stringify(success))).toEqual(success);
    expect(parseRuntimeDaemonFrame(JSON.stringify(error))).toEqual(error);
  });

  it('accepts the public daemon error code families', () => {
    for (const code of [
      'invalid_params',
      'permission_denied',
      'session_not_admitted',
      'overloaded',
      'credential_unavailable',
      'host_tool_unavailable',
      'host_tool_unknown',
    ] as const) {
      const response = createRuntimeDaemonErrorResponse({ code, message: code }, 'req-error');
      expect(isRuntimeDaemonErrorResponse(response)).toBe(true);
      expect(parseRuntimeDaemonFrame(JSON.stringify(response))).toEqual(response);
    }
  });

  it('encodes undefined success results as null so JSON transport keeps the result field', () => {
    const success = createRuntimeDaemonSuccessResponse('req-nullish', undefined);
    const encoded = JSON.stringify(success);

    expect(success.result).toBeNull();
    expect(encoded).toContain('"result":null');
    expect(parseRuntimeDaemonFrame(encoded)).toEqual(success);
  });

  it('creates and validates daemon notifications', () => {
    const notification = createRuntimeDaemonNotification('event', {
      type: 'run.completed',
    });

    expect(isRuntimeDaemonNotification(notification)).toBe(true);
    expect(isRuntimeDaemonFrame(notification)).toBe(true);
    expect(parseRuntimeDaemonFrame(JSON.stringify(notification))).toEqual(notification);
  });

  it('turns malformed JSON into an invalid-frame error response', () => {
    expect(parseRuntimeDaemonFrame('{bad json')).toMatchObject({
      kind: 'error',
      error: {
        code: 'invalid_frame',
        message: 'Frame is not valid JSON.',
      },
    });
  });
});
