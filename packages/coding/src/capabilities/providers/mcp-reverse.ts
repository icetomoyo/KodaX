/**
 * FEATURE_222 — build the MCP reverse-capability handlers from the host's
 * workspace + interaction surface, to inject into `McpCapabilityProvider`.
 *
 * This is the production wiring the CLI / ACP host uses so the agent-layer
 * reverse seam (roots / elicitation) is actually advertised + served, instead
 * of staying dormant (every reverse request -> -32601). Elicitation is opt-in
 * because it needs a live host UI.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  getActiveUserInteraction,
  asSingleSelection,
  isAskUserUnanswered,
  type McpElicitRequest,
  type McpElicitResult,
  type McpReverseCapabilities,
  type McpRoot,
  type UserInteraction,
  type UserInteractionPromptContext,
} from '@kodax-ai/agent';

const DEFAULT_MCP_ELICITATION_TIMEOUT_MS = 5 * 60 * 1_000;

export interface McpReverseWorkspace {
  /** The directory KodaX is operating in (the project root). */
  readonly cwd: string;
  /** The git root, when it differs from cwd. */
  readonly gitRoot?: string;
  /** Extra working directories to expose as roots. */
  readonly extraRoots?: readonly string[];
  /**
   * Advertise + serve elicitation (form + url) by routing server requests to the
   * live user-interaction surface registered via `setActiveUserInteraction`.
   * When no surface is live (headless / between turns) the handler declines.
   */
  readonly enableElicitation?: boolean;
}

/**
 * Compute the workspace roots a server should see, as `file://` URIs (the spec
 * requires `file://`). De-duplicated; the project cwd comes first.
 */
export function mcpRootsFromWorkspace(workspace: McpReverseWorkspace): McpRoot[] {
  const dirs: string[] = [];
  const add = (dir?: string): void => {
    if (!dir) return;
    const absolute = path.resolve(dir);
    if (!dirs.includes(absolute)) dirs.push(absolute);
  };
  add(workspace.cwd);
  add(workspace.gitRoot);
  for (const extra of workspace.extraRoots ?? []) add(extra);
  return dirs.map((dir) => ({ uri: pathToFileURL(dir).href, name: path.basename(dir) || dir }));
}

/**
 * Build the reverse-capability handlers for a workspace. `listRoots` reflects
 * the workspace captured by the host, and elicitation is wired only when the
 * host opts in. Returns `undefined` when there is nothing to expose, so the
 * caller can omit the injection entirely (no capability advertised).
 */
function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** How the requesting MCP server is named to the user (anti-phishing: the user
 *  must always know WHO is asking, not just "a connected tool"). */
function whoIsAsking(request: McpElicitRequest): string {
  return request.serverId ? `MCP server "${request.serverId}"` : 'A connected MCP server';
}

/** Map an MCP `form` elicitation's schema onto the host's ask-user surface. */
async function elicitForm(
  ui: UserInteraction,
  request: McpElicitRequest,
  context?: UserInteractionPromptContext,
): Promise<McpElicitResult> {
  const who = whoIsAsking(request);
  const banner = `${who} is requesting information.`;
  const detail = request.message ? `\n\n${request.message}` : '';
  const properties = asObject(asObject(request.requestedSchema)?.properties);

  // Confirm-only form (no fields) -> a single approve/decline prompt.
  if (!properties || Object.keys(properties).length === 0) {
    if (!ui.askUser) return { action: 'decline' };
    const result = await ui.askUser({
      question: `${banner}${detail}`,
      kind: 'select',
      allowCustomInput: false,
      options: [{ label: 'Approve', value: 'accept' }, { label: 'Decline', value: 'decline' }],
    }, context);
    if (isAskUserUnanswered(result)) return { action: 'cancel' };
    const answer = asSingleSelection(result);
    return answer === 'accept' ? { action: 'accept', content: {} } : { action: 'decline' };
  }

  const content: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(properties)) {
    const prop = asObject(raw) ?? {};
    const label = typeof prop.title === 'string' ? prop.title : key;
    const question = `${banner}${detail}\n\n${label}`;
    const enumValues = Array.isArray(prop.enum) ? prop.enum : undefined;

    if (enumValues && enumValues.length > 0 && ui.askUser) {
      const choices = enumValues.map((value, index) => ({
        label: String(value),
        value: String(index),
      }));
      const result = await ui.askUser({
        question,
        kind: 'select',
        allowCustomInput: false,
        options: choices,
      }, context);
      if (isAskUserUnanswered(result)) return { action: 'cancel' };
      const answer = asSingleSelection(result);
      const selectedIndex = Number(answer);
      content[key] = Number.isInteger(selectedIndex) && selectedIndex >= 0 && selectedIndex < enumValues.length
        ? enumValues[selectedIndex]
        : answer;
    } else if (prop.type === 'boolean' && ui.askUser) {
      const result = await ui.askUser({
        question,
        kind: 'select',
        allowCustomInput: false,
        options: [{ label: 'Yes', value: 'true' }, { label: 'No', value: 'false' }],
      }, context);
      if (isAskUserUnanswered(result)) return { action: 'cancel' };
      const answer = asSingleSelection(result);
      content[key] = answer === 'true';
    } else if (ui.askUserInput) {
      const answer = await ui.askUserInput({ question }, context);
      if (answer === undefined || isAskUserUnanswered(answer)) return { action: 'cancel' };
      content[key] = prop.type === 'number' || prop.type === 'integer' ? Number(answer) : answer;
    } else {
      return { action: 'decline' };
    }
  }

  // Review-before-send (spec: let the user review their response before it is
  // sent). Show exactly what the server will receive + who receives it.
  if (ui.askUser) {
    const summary = Object.entries(content).map(([key, value]) => `  ${key}: ${String(value)}`).join('\n');
    const confirm = asSingleSelection(await ui.askUser({
      question: `${who} will receive:\n\n${summary}\n\nSend these values?`,
      kind: 'select',
      allowCustomInput: false,
      options: [{ label: 'Send', value: 'send' }, { label: 'Cancel', value: 'cancel' }],
    }, context));
    if (confirm !== 'send') return { action: 'cancel' };
  }
  return { action: 'accept', content };
}

/**
 * Map an MCP `url` elicitation onto an anti-phishing consent prompt: show the
 * full URL + its domain and require explicit consent. KodaX never auto-opens
 * the browser and never exposes the URL/contents to the model — the user
 * decides, then visits the shown URL themselves.
 */
async function elicitUrl(
  ui: UserInteraction,
  request: McpElicitRequest,
  context?: UserInteractionPromptContext,
): Promise<McpElicitResult> {
  const url = request.url;
  if (!url || !ui.askUser) return { action: 'decline' };
  let domain = url;
  try {
    domain = new URL(url).host;
  } catch {
    // keep the raw url as the shown domain when it is not parseable
  }
  const banner = `${whoIsAsking(request)} is requesting browser authorization.`;
  const detail = request.message ? `\n\n${request.message}` : '';
  const result = await ui.askUser({
    question:
      `${banner}${detail}\n\n`
      + `URL: ${url}\nDomain: ${domain}\n\nOnly continue if you trust this domain. KodaX will NOT open it automatically.`,
    kind: 'select',
    allowCustomInput: false,
    options: [
      { label: 'I trust this — open it myself and continue', value: 'accept' },
      { label: 'Decline', value: 'decline' },
    ],
  }, context);
  if (isAskUserUnanswered(result)) return { action: 'cancel' };
  const answer = asSingleSelection(result);
  return answer === 'accept' ? { action: 'accept', content: {} } : { action: 'decline' };
}

/** Route an elicitation request to the host interaction; failures degrade to cancel. */
export async function elicitViaUserInteraction(
  ui: UserInteraction,
  request: McpElicitRequest,
  context?: UserInteractionPromptContext,
): Promise<McpElicitResult> {
  try {
    return request.mode === 'url'
      ? await elicitUrl(ui, request, context)
      : await elicitForm(ui, request, context);
  } catch {
    return { action: 'cancel' };
  }
}

async function elicitWithDeadline(
  ui: UserInteraction,
  request: McpElicitRequest,
): Promise<McpElicitResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<McpElicitResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ action: 'cancel' });
    }, DEFAULT_MCP_ELICITATION_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      elicitViaUserInteraction(ui, request, { signal: controller.signal }),
      deadline,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * An elicit handler that resolves the LIVE user-interaction surface at call
 * time (the MCP provider is built before any interactive loop exists). When
 * nothing is registered — headless, print mode, between turns — it declines.
 */
export function activeElicitHandler(): (request: McpElicitRequest) => Promise<McpElicitResult> {
  return async (request) => {
    const ui = getActiveUserInteraction();
    if (!ui || (!ui.askUser && !ui.askUserInput)) return { action: 'decline' };
    return elicitWithDeadline(ui, request);
  };
}

export function buildMcpReverseCapabilities(
  workspace: McpReverseWorkspace,
): McpReverseCapabilities | undefined {
  const roots = mcpRootsFromWorkspace(workspace);
  const reverse: {
    listRoots?: () => McpRoot[];
    elicit?: (request: McpElicitRequest) => Promise<McpElicitResult>;
    elicitationModes?: { form?: boolean; url?: boolean };
  } = {};
  if (roots.length > 0) {
    reverse.listRoots = () => roots;
  }
  if (workspace.enableElicitation) {
    reverse.elicit = activeElicitHandler();
    reverse.elicitationModes = { form: true, url: true };
  }
  return reverse.listRoots || reverse.elicit ? reverse : undefined;
}
