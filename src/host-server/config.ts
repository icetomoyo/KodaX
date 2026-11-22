/**
 * The `server` block: how a Host serves v2 over the network. The platform writes
 * it to `<configHome>/integrations/host.json` before it starts the Host. A
 * field the Host does not know stops it from starting, so a rollback of the
 * image must roll the file back too.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { emitKodaXDiagnostic } from '@kodax-ai/agent';
import { resolveIntegrationConfigPath, type IntegrationConfigSnapshot } from '@kodax-ai/repl';
import { z } from 'zod/v4';

import { parseOAuthEndpointUrl, parseOAuthIssuerIdentifier } from '../a2a/security.js';

const Subject = z.string().min(1).max(256);

const Origin = z.string().refine(isOrigin, { message: 'must be an origin such as https://app.example.com, without a path' });

/** `{hostname, port}` or `{socketPath}`. One object rather than a union, so an error names the field that is wrong. */
const Listen = z.strictObject({
  hostname: z.string().min(1).optional(),
  port: z.int().min(0).max(65535).optional(),
  socketPath: z.string().min(1).optional(),
}).refine(listen => listen.socketPath === undefined
  ? listen.hostname !== undefined && listen.port !== undefined
  : listen.hostname === undefined && listen.port === undefined, {
  message: 'must be either {hostname, port} or {socketPath}',
});

const Jwt = z.strictObject({
  issuer: z.string(),
  audience: z.string().min(1),
  jwksUrl: z.string(),
}).superRefine((jwt, context) => {
  for (const [field, parse] of [['issuer', parseOAuthIssuerIdentifier], ['jwksUrl', parseOAuthEndpointUrl]] as const) {
    try {
      parse(jwt[field], `server.jwt.${field}`);
    } catch (error: unknown) {
      context.addIssue({ code: 'custom', path: [field], message: error instanceof Error ? error.message : String(error) });
    }
  }
});

const Server = z.strictObject({
  listen: Listen.optional(),
  jwt: Jwt.optional(),
  /** The JWT `sub` of the person this Host belongs to. Connects as `user`. */
  owner: Subject.optional(),
  /** JWT subjects of backends. Each connects as `service`. */
  services: z.array(Subject).default([]),
  /** Browser origins allowed to connect. Empty refuses every browser. */
  allowedOrigins: z.array(Origin).default([]),
  /** Whether a person may pair browsers with this Host, which then connect as `user` without a JWT. */
  pairing: z.boolean().optional(),
  /** The directory of static web pages the Host serves on its own port, such as KodaX Space's web UI. */
  webRoot: z.string().refine(path.isAbsolute, { message: 'must be an absolute path' }).optional(),
  /** The directory network clients may name projects in, by their path inside it. Without it they can name none. */
  workspaceRoot: z.string().refine(path.isAbsolute, { message: 'must be an absolute path' }).optional(),
  /** The only tools any Run on this Host may use, whoever submits it. Absent leaves them unlimited. */
  tools: z.array(z.string().min(1)).optional(),
}).superRefine((server, context) => {
  const admitsBySubject = server.owner !== undefined || server.services.length > 0;
  if (server.jwt !== undefined && !admitsBySubject) {
    context.addIssue({ code: 'custom', path: ['jwt'], message: 'admits nobody: set server.owner or server.services' });
  }
  if (server.jwt === undefined && admitsBySubject) {
    context.addIssue({ code: 'custom', path: ['owner'], message: 'server.owner and server.services name JWT subjects: set server.jwt' });
  }
  if (server.listen !== undefined && server.jwt === undefined && server.pairing !== true) {
    context.addIssue({
      code: 'custom', path: ['listen'], message: 'a Host that listens on the network needs authentication: set server.jwt or turn on server.pairing',
    });
  }
  if (server.owner !== undefined && server.services.includes(server.owner)) {
    context.addIssue({ code: 'custom', path: ['services'], message: `${server.owner} is both the owner and a service` });
  }
});

const HostIntegrationDocument = z.strictObject({
  version: z.literal(1),
  server: Server.optional(),
});

export type HostServerConfig = z.output<typeof Server>;
export type HostIntegrationDocument = z.output<typeof HostIntegrationDocument>;

export function parseHostIntegrationDocument(value: unknown): HostIntegrationDocument {
  const parsed = HostIntegrationDocument.safeParse(value);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map(issue => `${['host', ...issue.path.map(String)].join('.')}: ${issue.message}`
    + (issue.code === 'unrecognized_keys' ? ` (${issue.keys.join(', ')})` : ''));
  throw new Error(`The Host configuration is invalid: ${issues.join('; ')}`);
}

export function readHostIntegration(configHome: string): IntegrationConfigSnapshot<HostIntegrationDocument> {
  const file = resolveIntegrationConfigPath('host', configHome);
  const present = existsSync(file);
  const raw = present ? readFileSync(file, 'utf8') : JSON.stringify({ version: 1 });
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error: unknown) {
    throw new Error(`${path.basename(file)} is not valid JSON.`, { cause: error });
  }
  return {
    domain: 'host',
    source: present ? 'user' : 'default',
    path: file,
    revision: createHash('sha256').update(raw).digest('hex'),
    document: parseHostIntegrationDocument(value),
    loadedAt: new Date().toISOString(),
  };
}

/**
 * The tool limit of the Host as host.json says now, read again for each Run.
 * A file it cannot read at start stops the Host. A bad edit later leaves the
 * last limit read in force, so a slip in the file never lifts it.
 */
export function createHostToolCeiling(configHome: string): () => readonly string[] | undefined {
  let current = readHostIntegration(configHome).document.server?.tools;
  let reported: string | undefined;
  return () => {
    try {
      current = readHostIntegration(configHome).document.server?.tools;
      reported = undefined;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      // Said once per mistake, not once per Run.
      if (message !== reported) {
        emitKodaXDiagnostic({
          source: 'host.tools', level: 'warn', message: 'host.json was not applied; the previous tool limit stays in force.',
          detail: { error: message },
        });
      }
      reported = message;
    }
    return current;
  };
}

function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value;
  } catch {
    return false;
  }
}
