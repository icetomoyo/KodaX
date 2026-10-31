import { observeProviderFetch } from '../provider-request-observation.js';
import { markProviderConnectionFailure } from '../retry/provider-network.js';
import { requestExtensionFetch } from './request-extensions.js';

export async function nativeFetch(url: string, init: RequestInit, acceptNotModified = false): Promise<Response> {
  try { return await observeProviderFetch(requestExtensionFetch(globalThis.fetch), acceptNotModified)(url, { ...init, redirect: 'error' }); }
  catch (error) { markProviderConnectionFailure(error); throw error; }
}

/** Preserve status/headers even when an upstream gateway returns a non-JSON error. */
export async function nativeResponse(url: string, init: RequestInit): Promise<Response> {
  const response = await nativeFetch(url, init);
  if (response.ok) return response;
  const text = await response.text();
  let body: unknown;
  try { body = JSON.parse(text) as unknown; } catch { body = undefined; }
  const error = body && typeof body === 'object' && 'error' in body ? body.error : body;
  const message = error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
    ? error.message : `Upstream HTTP ${response.status}`;
  throw Object.assign(new Error(message), { status: response.status, headers: response.headers, error });
}
