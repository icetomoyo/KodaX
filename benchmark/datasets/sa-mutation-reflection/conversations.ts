/**
 * Concrete exploration and mutation calls for each mutation-reflection task.
 *
 * Models notice placeholder tool inputs (for example a `<file body>` stub)
 * and respond to that instead of the reflection, so every call carries
 * plausible source text and every result mirrors the real tool's output.
 */

export interface ExplorationCall {
  readonly name: 'read' | 'grep';
  readonly input: Readonly<Record<string, string | boolean>>;
  readonly result: string;
}

export interface MutationCall {
  readonly name: 'write' | 'edit';
  readonly input:
    | { readonly path: string; readonly content: string }
    | {
      readonly path: string;
      readonly edits: ReadonlyArray<{ readonly old_string: string; readonly new_string: string; readonly replace_all?: boolean }>;
    };
  readonly result: string;
}

export interface TaskConversation {
  readonly exploration: readonly ExplorationCall[];
  readonly mutations: readonly MutationCall[];
}

const numbered = (source: string): string => {
  const lines = source.split('\n');
  return `${lines.map((line, i) => `${String(i + 1).padStart(6)}\t${line}`).join('\n')}\n\n[End of file - ${lines.length} lines total]`;
};

const lineCount = (source: string): number => source.split('\n').length;

// ---------------------------------------------------------------------------
// three-file-refactor
// ---------------------------------------------------------------------------

const LOCAL_FORMAT_ERROR = String.raw`function formatError(err: unknown): { code: string; message: string } {
  if (err instanceof Error) {
    return { code: err.name, message: err.message };
  }
  return { code: 'UnknownError', message: String(err) };
}

`;

const handler = (importLine: string, body: string): string =>
  `import type { Request, Response } from 'express';\n${importLine}\n\n${LOCAL_FORMAT_ERROR}${body}`;

const AUTH_IMPORT = "import { verifyCredentials } from '../services/auth.js';";
const USERS_IMPORT = "import { findUser, updateUser } from '../services/users.js';";
const SESSIONS_IMPORT = "import { revokeSession } from '../services/sessions.js';";

const AUTH_SOURCE = handler(AUTH_IMPORT, String.raw`export async function login(req: Request, res: Response): Promise<void> {
  try {
    const session = await verifyCredentials(req.body.email, req.body.password);
    res.json({ token: session.token });
  } catch (err) {
    res.status(401).json(formatError(err));
  }
}`);

const USERS_SOURCE = handler(USERS_IMPORT, String.raw`export async function getUser(req: Request, res: Response): Promise<void> {
  try {
    res.json(await findUser(req.params.id));
  } catch (err) {
    res.status(404).json(formatError(err));
  }
}

export async function patchUser(req: Request, res: Response): Promise<void> {
  try {
    res.json(await updateUser(req.params.id, req.body));
  } catch (err) {
    res.status(400).json(formatError(err));
  }
}`);

const SESSIONS_SOURCE = handler(SESSIONS_IMPORT, String.raw`export async function logout(req: Request, res: Response): Promise<void> {
  try {
    await revokeSession(req.headers.authorization ?? '');
    res.status(204).end();
  } catch (err) {
    res.status(500).json(formatError(err));
  }
}`);

const SHARED_FORMAT_ERROR = String.raw`export interface ErrorBody {
  readonly code: string;
  readonly message: string;
}

/** Shape any thrown value into the JSON error body the API handlers return. */
export function formatError(err: unknown): ErrorBody {
  if (err instanceof Error) {
    return { code: err.name, message: err.message };
  }
  return { code: 'UnknownError', message: String(err) };
}`;

const extractEdit = (path: string, importLine: string): MutationCall => ({
  name: 'edit',
  input: {
    path,
    edits: [
      { old_string: importLine, new_string: `${importLine}\nimport { formatError } from './_format-error.js';` },
      { old_string: LOCAL_FORMAT_ERROR, new_string: '' },
    ],
  },
  result: `File edited: ${path}\n  (+1 lines, -7 lines)`,
});

const HANDLERS = 'packages/api/src/handlers';

const THREE_FILE_REFACTOR: TaskConversation = {
  exploration: [
    { name: 'read', input: { path: `${HANDLERS}/auth.ts` }, result: numbered(AUTH_SOURCE) },
    { name: 'read', input: { path: `${HANDLERS}/users.ts` }, result: numbered(USERS_SOURCE) },
    { name: 'read', input: { path: `${HANDLERS}/sessions.ts` }, result: numbered(SESSIONS_SOURCE) },
  ],
  mutations: [
    {
      name: 'write',
      input: { path: `${HANDLERS}/_format-error.ts`, content: SHARED_FORMAT_ERROR },
      result: `File created: ${HANDLERS}/_format-error.ts\n  (${lineCount(SHARED_FORMAT_ERROR)} lines written)`,
    },
    extractEdit(`${HANDLERS}/auth.ts`, AUTH_IMPORT),
    extractEdit(`${HANDLERS}/users.ts`, USERS_IMPORT),
    extractEdit(`${HANDLERS}/sessions.ts`, SESSIONS_IMPORT),
  ],
};

// ---------------------------------------------------------------------------
// large-single-file-edit
// ---------------------------------------------------------------------------

const FLAT_MATCHER = String.raw`import type { Handler, Route } from './types.js';

export interface Match {
  readonly handler: Handler;
  readonly params: Readonly<Record<string, string>>;
}

function splitPath(path: string): string[] {
  return path.split('/').filter(segment => segment.length > 0);
}

function matchSegments(pattern: string[], actual: string[]): Record<string, string> | undefined {
  if (pattern.length !== actual.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i += 1) {
    const expected = pattern[i]!;
    if (expected.startsWith(':')) {
      params[expected.slice(1)] = decodeURIComponent(actual[i]!);
    } else if (expected !== actual[i]) {
      return undefined;
    }
  }
  return params;
}

export function match(routes: readonly Route[], method: string, path: string): Match | undefined {
  const actual = splitPath(path);
  for (const route of routes) {
    if (route.method !== method) continue;
    const params = matchSegments(splitPath(route.path), actual);
    if (params) return { handler: route.handler, params };
  }
  return undefined;
}`;

const NESTED_MATCHER = String.raw`import type { Handler, Route, RouteGroup } from './types.js';

export interface Match {
  readonly handler: Handler;
  readonly params: Readonly<Record<string, string>>;
  /** Group prefixes walked to reach the handler, outermost first. */
  readonly groups: readonly string[];
}

export type RouteNode = Route | RouteGroup;

function splitPath(path: string): string[] {
  return path.split('/').filter(segment => segment.length > 0);
}

function isGroup(node: RouteNode): node is RouteGroup {
  return 'children' in node;
}

/**
 * Match a pattern against the start of the actual segments.
 * Returns the captured params and how many segments were consumed.
 */
function matchPrefix(
  pattern: readonly string[],
  actual: readonly string[],
  offset: number,
): { params: Record<string, string>; consumed: number } | undefined {
  if (offset + pattern.length > actual.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i += 1) {
    const expected = pattern[i]!;
    const segment = actual[offset + i]!;
    if (expected.startsWith(':')) {
      params[expected.slice(1)] = decodeURIComponent(segment);
    } else if (expected !== segment) {
      return undefined;
    }
  }
  return { params, consumed: pattern.length };
}

interface WalkState {
  readonly method: string;
  readonly actual: readonly string[];
  readonly offset: number;
  readonly params: Readonly<Record<string, string>>;
  readonly groups: readonly string[];
}

function matchRoute(route: Route, state: WalkState): Match | undefined {
  if (route.method !== state.method) return undefined;
  const result = matchPrefix(splitPath(route.path), state.actual, state.offset);
  if (!result) return undefined;
  if (state.offset + result.consumed !== state.actual.length) return undefined;
  return {
    handler: route.handler,
    params: { ...state.params, ...result.params },
    groups: state.groups,
  };
}

function matchGroup(group: RouteGroup, state: WalkState): Match | undefined {
  const result = matchPrefix(splitPath(group.prefix), state.actual, state.offset);
  if (!result) return undefined;
  const inner: WalkState = {
    method: state.method,
    actual: state.actual,
    offset: state.offset + result.consumed,
    params: { ...state.params, ...result.params },
    groups: [...state.groups, group.prefix],
  };
  return walk(group.children, inner);
}

function walk(nodes: readonly RouteNode[], state: WalkState): Match | undefined {
  for (const node of nodes) {
    const found = isGroup(node) ? matchGroup(node, state) : matchRoute(node, state);
    if (found) return found;
  }
  return undefined;
}

/**
 * Resolve a request against a tree of routes and route groups.
 * Groups contribute their prefix and params to every descendant;
 * the first matching route in declaration order wins.
 */
export function match(nodes: readonly RouteNode[], method: string, path: string): Match | undefined {
  return walk(nodes, {
    method,
    actual: splitPath(path),
    offset: 0,
    params: {},
    groups: [],
  });
}

/** Flatten a route tree into absolute paths, useful for startup diagnostics. */
export function listRoutes(nodes: readonly RouteNode[], prefix = ''): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    if (isGroup(node)) {
      out.push(...listRoutes(node.children, prefix + node.prefix));
    } else {
      out.push(node.method + ' ' + prefix + node.path);
    }
  }
  return out;
}`;

const MATCHER_PATH = 'packages/api/src/router/match.ts';

const LARGE_SINGLE_FILE_EDIT: TaskConversation = {
  exploration: [
    { name: 'read', input: { path: MATCHER_PATH }, result: numbered(FLAT_MATCHER) },
  ],
  mutations: [
    {
      name: 'write',
      input: { path: MATCHER_PATH, content: NESTED_MATCHER },
      result: `File updated: ${MATCHER_PATH}\n  (+${lineCount(NESTED_MATCHER) - 20} lines, -15 lines)`,
    },
  ],
};

// ---------------------------------------------------------------------------
// cross-module-rename
// ---------------------------------------------------------------------------

const RENAME_SITES = [
  ['packages/coding/src/utils/path.ts', 12, 'export function getCwd(): string {'],
  ['packages/coding/src/agent.ts', 4, "import { getCwd } from './utils/path.js';"],
  ['packages/coding/src/task-engine.ts', 9, "import { getCwd } from './utils/path.js';"],
  ['packages/coding/src/tools/bash.ts', 6, "import { getCwd } from '../utils/path.js';"],
  ['packages/repl/src/ui/StatusBar.tsx', 3, "import { getCwd } from '@kodax-ai/coding/utils/path';"],
] as const;

const CROSS_MODULE_RENAME: TaskConversation = {
  exploration: [
    {
      name: 'grep',
      input: { pattern: 'getCwd', path: 'packages' },
      result: [
        ...RENAME_SITES.map(([file, line, text]) => `${file}:${line}:${text}`),
        'packages/coding/src/agent.ts:88:  const root = options.cwd ?? getCwd();',
        'packages/coding/src/task-engine.ts:141:    workspaceRoot: getCwd(),',
        'packages/coding/src/tools/bash.ts:52:  const cwd = input.cwd ?? getCwd();',
        'packages/repl/src/ui/StatusBar.tsx:27:  const cwd = useMemo(() => getCwd(), []);',
      ].join('\n'),
    },
  ],
  mutations: RENAME_SITES.map(([path]) => ({
    name: 'edit' as const,
    input: { path, edits: [{ old_string: 'getCwd', new_string: 'getCurrentWorkingDirectory', replace_all: true }] },
    result: `File edited: ${path} (2 replacements)\n  (+2 lines, -2 lines)`,
  })),
};

export const TASK_CONVERSATIONS = Object.freeze({
  'three-file-refactor': THREE_FILE_REFACTOR,
  'large-single-file-edit': LARGE_SINGLE_FILE_EDIT,
  'cross-module-rename': CROSS_MODULE_RENAME,
});

/** Touched-line estimate per file, matching the production mutation tracker. */
export function mutatedFiles(conversation: TaskConversation): ReadonlyArray<readonly [path: string, lines: number]> {
  const totals = new Map<string, number>();
  for (const { input } of conversation.mutations) {
    const lines = 'content' in input
      ? lineCount(input.content)
      : input.edits.reduce((sum, edit) => sum + Math.max(lineCount(edit.old_string), lineCount(edit.new_string)), 0);
    totals.set(input.path, (totals.get(input.path) ?? 0) + lines);
  }
  return [...totals];
}
