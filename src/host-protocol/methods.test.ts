import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';

import { HOST_METHODS, hostMethodContract, type HostMethodSpec } from './methods.js';

type JsonSchema = { readonly [key: string]: unknown };

/** Every object with named fields, at any depth, must refuse fields it does not name. */
function openObjects(schema: unknown, path: string, found: string[] = []): string[] {
  if (Array.isArray(schema)) {
    schema.forEach((entry, index) => openObjects(entry, `${path}[${index}]`, found));
    return found;
  }
  if (typeof schema !== 'object' || schema === null) return found;
  const node = schema as JsonSchema;
  if (node.type === 'object' && node.properties !== undefined && node.additionalProperties !== false) found.push(path);
  for (const [key, value] of Object.entries(node)) openObjects(value, `${path}/${key}`, found);
  return found;
}

/** The named fields of a schema at every depth, as paths. */
function fieldPaths(schema: unknown, path = '', found: string[] = []): string[] {
  if (typeof schema !== 'object' || schema === null) return found;
  const node = schema as JsonSchema;
  if (typeof node.properties === 'object' && node.properties !== null) {
    for (const [key, value] of Object.entries(node.properties)) {
      found.push(`${path}.${key}`);
      fieldPaths(value, `${path}.${key}`, found);
    }
  }
  if (node.items !== undefined) fieldPaths(node.items, `${path}[]`, found);
  return found;
}

describe('host method definitions', () => {
  const entries: Array<[string, HostMethodSpec]> = Object.entries(HOST_METHODS);

  it.each(entries)('%s refuses unknown params at every depth', (name, spec) => {
    // Checked as what a client may send: the Host must reject the field, not drop it.
    expect(openObjects(z.toJSONSchema(spec.params, { io: 'input' }), `${name}.params`)).toEqual([]);
  });

  it.each(entries)('%s produces no field its contract does not name', (name, spec) => {
    if (spec.result !== undefined) expect(openObjects(z.toJSONSchema(spec.result), `${name}.result`)).toEqual([]);
    if (spec.localResult !== undefined) {
      expect(openObjects(z.toJSONSchema(spec.localResult), `${name}.localResult`)).toEqual([]);
    }
  });

  it.each(entries)('%s reserves _meta in its params and result', (_name, spec) => {
    const params = z.toJSONSchema(spec.params) as { properties?: JsonSchema };
    expect(params.properties).toHaveProperty('_meta');
    for (const schema of [spec.result, spec.localResult]) {
      if (schema === undefined) continue;
      expect((z.toJSONSchema(schema) as { properties?: JsonSchema }).properties).toHaveProperty('_meta');
    }
  });

  it.each(entries)('%s answers unless it is a notification', (_name, spec) => {
    expect(spec.result === undefined).toBe(spec.primitive === 'notification');
  });

  it.each(entries)('%s takes a requestId exactly when it is a command', (_name, spec) => {
    const params = z.toJSONSchema(spec.params, { io: 'input' }) as { required?: string[] };
    expect(params.required?.includes('requestId') === true).toBe(spec.primitive === 'command');
  });

  it.each(entries)('%s restricts only params it defines', (_name, spec) => {
    const params = z.toJSONSchema(spec.params) as { properties?: JsonSchema };
    for (const name of Object.keys(spec.restricted ?? {})) expect(params.properties).toHaveProperty(name);
  });

  it.each(entries)('%s answers the owner with everything other roles get', (_name, spec) => {
    if (spec.localResult === undefined) return;
    expect(spec.result).toBeDefined();
    const local = new Set(fieldPaths(z.toJSONSchema(spec.localResult)));
    expect(fieldPaths(z.toJSONSchema(spec.result!)).filter(path => !local.has(path))).toEqual([]);
  });

  it('matches the recorded contract', async () => {
    // A change here changes what clients may send or receive. Update the file
    // on purpose (vitest -u), and raise HOST_PROTOCOL_REVISION when a released
    // revision would no longer accept or produce the same messages.
    await expect(`${JSON.stringify(hostMethodContract(), null, 2)}\n`).toMatchFileSnapshot('./methods.contract.json');
  });
});
