/**
 * Renders the v2 method reference for embedders from the method table: each
 * method's doc comment, its kind, who may call it, and its params and result
 * fields with their doc comments. Types come from the JSON Schema of the
 * table, docs from the doc comments in this directory's sources, so the page
 * cannot say anything the table does not. `reference-doc.test.ts` keeps
 * `public_docs/sdk/host-protocol-reference.md` equal to the output.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

import { runtimeRoleHasPlane, runtimeRoleRefusal, type RuntimeConnectionRole, type RuntimeMethodPlane } from '../runtime-daemon/access.js';

interface JsonSchema {
  readonly type?: string | readonly string[];
  readonly const?: unknown;
  readonly enum?: readonly unknown[];
  readonly anyOf?: readonly JsonSchema[];
  readonly oneOf?: readonly JsonSchema[];
  readonly items?: JsonSchema;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
}

interface ContractEntry {
  readonly primitive: string;
  readonly resend?: 'auto' | 'never';
  readonly plane: RuntimeMethodPlane;
  readonly params: JsonSchema;
  readonly restricted?: Readonly<Record<string, RuntimeMethodPlane>>;
  readonly result?: JsonSchema;
  readonly localResult?: JsonSchema;
}

interface MethodDocs {
  readonly summary: string;
  readonly params: ReadonlyMap<string, string>;
  readonly result: ReadonlyMap<string, string>;
}

const ROLES: readonly RuntimeConnectionRole[] = ['owner', 'user', 'service'];
/** Fields nested deeper than this show as `object`; the client types have the rest. */
const MAX_DEPTH = 2;
const WRAPPERS = new Set(['optional', 'nullable', 'readonly', 'default', 'min', 'max', 'regex', 'describe', 'nonempty', 'positive']);
const SHAPE_CALLS = new Set(['hostParams', 'hostCommandParams', 'hostResult', 'z.object', 'z.strictObject']);

export function renderHostProtocolReference(contract: Readonly<Record<string, ContractEntry>>, sourceDir: string): string {
  const docs = readMethodDocs(sourceDir, new Set(Object.keys(contract)));
  const groups = new Map<string, string[]>();
  for (const name of Object.keys(contract)) {
    const group = name.includes('.') ? name.slice(0, name.indexOf('.')) : 'connection';
    groups.set(group, [...(groups.get(group) ?? []), name]);
  }
  const lines = [...HEADER, '## Contents', ''];
  for (const [group, names] of groups) lines.push(`- **${group}**: ${names.map(name => `[\`${name}\`](#${anchor(name)})`).join(', ')}`);
  for (const [group, names] of groups) {
    lines.push('', `## ${group}`);
    for (const name of names) lines.push('', ...renderMethod(name, contract[name]!, docs.get(name)));
  }
  return `${lines.join('\n')}\n`;
}

const HEADER = [
  '# KodaX Host protocol v2: method reference',
  '',
  '<!-- Generated from src/host-protocol/. Do not edit by hand: run',
  '     node node_modules/vitest/vitest.mjs run src/host-protocol/reference-doc.test.ts -u -->',
  '',
  'Every method a v2 client may send to a Host, generated from the method table',
  'the Host checks requests against. How to connect and call them is in',
  '[Build a client of a Host](host-client.md); a platform backend is in',
  '[Run a platform on a Host](host-platform.md).',
  '',
  '- **Kind**: a *query* reads and is safe to repeat. A *command* changes state',
  '  once per `requestId`. A *subscription* starts or ends a stream of patches.',
  '  A *notification* gets no answer. The *handshake* opens the connection.',
  '- **Resend**: what the SDK does with a command the link lost on the way.',
  '  *auto*: sent again under the same `requestId`. *never*: the call fails with',
  '  `unknown_outcome`, and the caller reads what happened.',
  '- **Who**: the roles that may call the method. `initialize` returns the exact',
  '  list for a connection in `methods`; a Host operator can lock settings',
  '  further (`locks`).',
  '- Params are strict: a field not listed is an error. Every params and result',
  '  object may also carry `_meta`. Fields deeper than two levels show as',
  '  `object`; the TypeScript types exported from `@kodax-ai/kodax/client` have them.',
  '',
];

function renderMethod(name: string, entry: ContractEntry, docs: MethodDocs | undefined): string[] {
  const who = ROLES.filter(role => runtimeRoleHasPlane(role, entry.plane) && runtimeRoleRefusal(role, name) === undefined);
  const facts = [`Kind: ${entry.primitive}`, ...(entry.resend ? [`Resend: ${entry.resend}`] : []), `Who: ${who.join(', ') || 'none'}`];
  const lines = [`### \`${name}\``, ''];
  if (docs?.summary) lines.push(docs.summary, '');
  lines.push(facts.join(' · '));
  const params = fieldRows(entry.params, docs?.params ?? new Map(), '', 1, entry.restricted);
  lines.push('', ...(params.length > 0 ? ['| Param | Type | Required | Notes |', '| --- | --- | --- | --- |', ...params] : ['No params.']));
  if (entry.result) {
    const result = fieldRows(entry.result, docs?.result ?? new Map(), '', 1);
    lines.push('', ...(result.length > 0 ? ['| Result field | Type | Always | Notes |', '| --- | --- | --- | --- |', ...result] : ['Empty result.']));
  }
  if (entry.localResult) lines.push('', 'The owner on the Host\'s own machine also receives paths on that machine.');
  return lines;
}

function fieldRows(
  schema: JsonSchema, docs: ReadonlyMap<string, string>, prefix: string, depth: number,
  restricted?: Readonly<Record<string, RuntimeMethodPlane>>,
): string[] {
  const object = objectSchema(schema);
  if (!object?.properties) return [];
  const rows: string[] = [];
  for (const [key, field] of Object.entries(object.properties)) {
    if (key === '_meta') continue;
    const name = `${prefix}${key}`;
    const plane = restricted?.[key];
    const notes = [docs.get(name) ?? (name === 'requestId' ? 'The command runs once per id; send the same id to retry.' : ''),
      ...(plane ? [`Only ${ROLES.filter(role => runtimeRoleHasPlane(role, plane)).join(' and ')} may send it.`] : [])].filter(Boolean).join(' ');
    rows.push(`| \`${name}\` | ${cell(typeOf(field))} | ${object.required?.includes(key) ? 'yes' : 'no'} | ${cell(notes)} |`);
    if (depth < MAX_DEPTH) {
      const element = arrayElement(field);
      rows.push(...fieldRows(element ?? field, docs, `${name}${element ? '[]' : ''}.`, depth + 1));
    }
  }
  return rows;
}

function objectSchema(schema: JsonSchema): JsonSchema | undefined {
  if (schema.properties) return schema;
  const alternatives = (schema.anyOf ?? schema.oneOf ?? []).filter(alt => alt.type !== 'null');
  return alternatives.length === 1 ? objectSchema(alternatives[0]!) : undefined;
}

function arrayElement(schema: JsonSchema): JsonSchema | undefined {
  if (schema.type === 'array' && schema.items) return schema.items;
  const alternatives = (schema.anyOf ?? schema.oneOf ?? []).filter(alt => alt.type !== 'null');
  return alternatives.length === 1 ? arrayElement(alternatives[0]!) : undefined;
}

function typeOf(schema: JsonSchema): string {
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.map(value => JSON.stringify(value)).join(' or ');
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (alternatives) return [...new Set(alternatives.map(typeOf))].join(' or ');
  if (Array.isArray(schema.type)) return schema.type.join(' or ');
  if (schema.type === 'array') {
    const item = schema.items ? typeOf(schema.items) : 'unknown';
    return item.includes(' or ') ? `(${item})[]` : `${item}[]`;
  }
  if (typeof schema.type === 'string') return schema.type;
  return schema.properties ? 'object' : 'any';
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
}

function anchor(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9 -]/g, '');
}

// ---- doc comments from the sources -------------------------------------------------

function readMethodDocs(sourceDir: string, names: ReadonlySet<string>): Map<string, MethodDocs> {
  const files = readdirSync(sourceDir)
    .filter(file => file.endsWith('.ts') && !file.endsWith('.test.ts') && file !== 'reference-doc.ts')
    .sort()
    .map(file => ts.createSourceFile(file, readFileSync(path.join(sourceDir, file), 'utf8'), ts.ScriptTarget.Latest, true));
  const consts = new Map<string, ts.Expression>();
  for (const file of files) {
    for (const statement of file.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer && !consts.has(declaration.name.text)) {
          consts.set(declaration.name.text, declaration.initializer);
        }
      }
    }
  }
  const docs = new Map<string, MethodDocs>();
  const visit = (node: ts.Node): void => {
    const spec = ts.isPropertyAssignment(node) ? specLiteral(node.initializer, consts) : undefined;
    if (spec && ts.isPropertyAssignment(node)) {
      const name = propertyName(node.name);
      if (name !== undefined && names.has(name)) {
        const params = property(spec, 'params');
        const result = property(spec, 'result');
        docs.set(name, {
          summary: jsDoc(node) ?? '',
          params: params ? shapeDocs(params, consts) : new Map(),
          result: result ? shapeDocs(result, consts) : new Map(),
        });
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const file of files) visit(file);
  return docs;
}

/** A method's definition, written in place or shared through a const, as the workflow commands are. */
function specLiteral(expression: ts.Expression, consts: ReadonlyMap<string, ts.Expression>): ts.ObjectLiteralExpression | undefined {
  const target = ts.isIdentifier(expression) ? consts.get(expression.text) : expression;
  const literal = target && ts.isAsExpression(target) ? target.expression : target;
  return literal && ts.isObjectLiteralExpression(literal) && property(literal, 'primitive') ? literal : undefined;
}

function shapeDocs(expression: ts.Expression, consts: ReadonlyMap<string, ts.Expression>, prefix = '', depth = 1): Map<string, string> {
  const docs = new Map<string, string>();
  const shape = shapeOf(expression, consts);
  if (!shape) return docs;
  for (const member of shape.literal.properties) {
    if (!ts.isPropertyAssignment(member)) continue;
    const name = propertyName(member.name);
    if (name === undefined) continue;
    const doc = jsDoc(member);
    if (doc) docs.set(`${prefix}${name}`, doc);
    if (depth < MAX_DEPTH) {
      const nested = shapeOf(member.initializer, consts);
      if (nested) for (const [key, value] of shapeDocs(member.initializer, consts, `${prefix}${name}${nested.array ? '[]' : ''}.`, depth + 1)) docs.set(key, value);
    }
  }
  return docs;
}

/** The object literal a zod expression is built from, seeing through wrappers, arrays and named consts. */
function shapeOf(
  expression: ts.Expression, consts: ReadonlyMap<string, ts.Expression>, array = false, seen = new Set<string>(),
): { readonly literal: ts.ObjectLiteralExpression; readonly array: boolean } | undefined {
  if (ts.isIdentifier(expression)) {
    const init = seen.has(expression.text) ? undefined : consts.get(expression.text);
    return init ? shapeOf(init, consts, array, new Set([...seen, expression.text])) : undefined;
  }
  if (!ts.isCallExpression(expression)) return undefined;
  const callee = expression.expression;
  const calleeText = callee.getText();
  const first = expression.arguments[0];
  if (SHAPE_CALLS.has(calleeText) && first && ts.isObjectLiteralExpression(first)) return { literal: first, array };
  if (calleeText === 'z.array' && first) return shapeOf(first, consts, true, seen);
  if (ts.isPropertyAccessExpression(callee) && WRAPPERS.has(callee.name.text)) return shapeOf(callee.expression, consts, array, seen);
  return undefined;
}

function property(literal: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const member of literal.properties) {
    if (ts.isPropertyAssignment(member) && propertyName(member.name) === name) return member.initializer;
  }
  return undefined;
}

function propertyName(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
}

function jsDoc(node: ts.Node): string | undefined {
  const text = node.getSourceFile().text;
  const comment = (ts.getLeadingCommentRanges(text, node.getFullStart()) ?? [])
    .filter(range => text.startsWith('/**', range.pos)).at(-1);
  if (!comment) return undefined;
  const lines = text.slice(comment.pos + 3, comment.end - 2).split(/\r?\n/).map(line => line.replace(/^\s*\*? ?/, '').trimEnd());
  const paragraphs = lines.join('\n').trim().split(/\n\s*\n/).map(paragraph => paragraph.split('\n').map(line => line.trim()).join(' '));
  return paragraphs.join('\n\n') || undefined;
}
