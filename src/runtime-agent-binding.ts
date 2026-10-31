import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  SkillRegistry,
  LearnedAreaStore,
  admitAndRecordLearnedSkillInvocation,
  admitLearnedSkillBinding,
  completeLearnedSkillSessionOutcomes,
  createLearnedCapabilityScope,
  emitKodaXDiagnostic,
  formatSkillsSystemPrompt,
  getDefaultSkillPaths,
  migrateLegacyLearnedSkillsForProject,
  recordLearnedSkillOffered,
  reconcileLearnedSkillBindingOutcomes,
  releaseLearnedSkillBinding,
  resolveProjectLearnedAreaRoot,
  tryGitRemote,
  type AgentDispatchContext,
  type Agent,
  type ISkillRegistry,
  type LearnedCapabilityScope,
  type Skill,
  type SkillContext,
  type SkillMetadata,
  type SkillResult,
  type ToolGuardrail,
} from '@kodax-ai/agent';
import {
  getAllRegisteredTools,
  canonicalMemoryProjectId,
  loadMarkdownAgentScope,
  type KodaXAgentScope,
  type KodaXContextOptions,
  type KodaXSkillScriptRunner,
  type LoadedMarkdownAgent,
  type RuntimeRemoteToolContract,
} from '@kodax-ai/coding';

import type {
  RuntimeInput,
  RuntimePermissionBroker,
  RuntimeRunHandle,
  RuntimeRunService,
  RuntimeSessionService,
} from './sdk-runtime.js';

export interface RuntimeUserMarkdownAgentRef {
  readonly source: 'markdown:user';
  readonly name: string;
}

export interface RuntimeEffectiveSkillRef {
  readonly name: string;
  readonly source: 'workspace' | 'user' | 'plugin' | 'builtin' | 'learned';
  readonly revision: string;
}

export type RuntimeWorkspaceBinding =
  | { readonly mode: 'managed' }
  | { readonly mode: 'fixed'; readonly root: string };

export interface RuntimeExecutionToolPolicy {
  readonly workspace: 'none' | 'read' | 'write';
  readonly process: 'deny' | 'isolated';
  readonly network:
    | { readonly mode: 'deny' }
    | { readonly mode: 'allowlist'; readonly origins: readonly string[] };
  readonly tools: readonly string[];
  readonly mcp: Readonly<Record<string, readonly string[]>>;
  readonly skillScripts: Readonly<Record<string, readonly string[]>>;
  readonly subagents: 'deny' | 'inherit';
  /** Exact names of materialized host tools (capability ids host:<leaseId>:<toolName>) admitted by this policy. */
  readonly hostTools?: readonly string[];
}

export interface RuntimeResolvedLocalAgent {
  readonly ref: RuntimeUserMarkdownAgentRef;
  readonly agentId: string;
  readonly displayName: string;
  readonly description: string;
  readonly configurationRevision: string;
  readonly effectiveSkills: readonly RuntimeEffectiveSkillRef[];
  readonly skillSetRevision: string;
}

export interface RuntimeAgentOwnerSession {
  readonly ownerSessionId: string;
}

export interface RuntimeBoundDefaultAgent {
  readonly ownerSessionId: string;
  readonly bindingId: string;
  readonly executionPolicyRevision: string;
  readonly toolPolicyRevision: string;
  readonly workspaceBindingRevision: string;
  readonly skillSetRevision: string;
  readonly effectiveSkills: readonly RuntimeEffectiveSkillRef[];
  readonly effectiveTools: readonly string[];
}

export interface RuntimeBoundLocalAgent extends RuntimeResolvedLocalAgent {
  readonly ownerSessionId: string;
  readonly bindingId: string;
  readonly executionPolicyRevision: string;
  readonly toolPolicyRevision: string;
  readonly workspaceBindingRevision: string;
  readonly effectiveTools: readonly string[];
}

interface RuntimeAgentStartBase {
  readonly ownerSessionId: string;
  readonly bindingId: string;
  readonly expectedExecutionPolicyRevision: string;
  readonly sessionId: string;
  readonly input: RuntimeInput | readonly RuntimeInput[];
  readonly permissionBroker?: RuntimePermissionBroker;
  readonly agentContext?: AgentDispatchContext;
}

export interface RuntimeDefaultAgentStartInput extends RuntimeAgentStartBase {}

export interface RuntimeLocalAgentStartInput extends RuntimeAgentStartBase {
  readonly expectedConfigurationRevision: string;
}

export interface RuntimeAgentBindingService {
  resolveLocal(input: {
    readonly ref: RuntimeUserMarkdownAgentRef;
    readonly workspace: RuntimeWorkspaceBinding;
  }): Promise<RuntimeResolvedLocalAgent>;
  openOwnerSession(): Promise<RuntimeAgentOwnerSession>;
  bindDefault(input: {
    readonly ownerSessionId: string;
    readonly profileId?: string;
    readonly workspace: RuntimeWorkspaceBinding;
    readonly toolPolicy: RuntimeExecutionToolPolicy;
    readonly expectedExecutionPolicyRevision?: string;
    readonly workspaceByteLimit?: number;
  }): Promise<RuntimeBoundDefaultAgent>;
  startDefault(input: RuntimeDefaultAgentStartInput): Promise<RuntimeRunHandle>;
  bindLocal(input: {
    readonly ownerSessionId: string;
    readonly ref: RuntimeUserMarkdownAgentRef;
    readonly profileId?: string;
    readonly workspace: RuntimeWorkspaceBinding;
    readonly toolPolicy: RuntimeExecutionToolPolicy;
    readonly expectedConfigurationRevision?: string;
    readonly expectedExecutionPolicyRevision?: string;
    readonly workspaceByteLimit?: number;
  }): Promise<RuntimeBoundLocalAgent>;
  startLocal(input: RuntimeLocalAgentStartInput): Promise<RuntimeRunHandle>;
  prepareWorkspace(input: {
    readonly ownerSessionId: string;
    readonly bindingId: string;
    readonly contextKey: string;
  }): Promise<string>;
  releaseBinding(input: {
    readonly ownerSessionId: string;
    readonly bindingId: string;
  }): Promise<void>;
  closeOwnerSession(ownerSessionId: string): Promise<void>;
}

export interface RuntimeAgentBindingHost {
  readonly configHome: string;
  readonly managedWorkspaceRoot: string;
  readonly defaultProvider?: string;
  readonly defaultModel?: string;
  readonly runs: Pick<RuntimeRunService, 'start'>;
  readonly sessions: Pick<RuntimeSessionService, 'load'>;
  createSkillScriptRunner?(input: {
    readonly registry: ISkillRegistry;
    readonly admissions: Readonly<Record<string, readonly string[]>>;
    readonly workspaceAccess: RuntimeExecutionToolPolicy['workspace'];
    readonly network: RuntimeExecutionToolPolicy['network'];
    readonly workspaceByteLimit?: number;
  }): Promise<KodaXSkillScriptRunner>;
}

interface BindingResources {
  readonly ownerSessionId: string;
  readonly bindingId: string;
  readonly kind: 'runtime-default' | 'local-agent';
  readonly executionPolicyRevision: string;
  readonly toolPolicyRevision: string;
  readonly workspaceBindingRevision: string;
  readonly workspace: RuntimeWorkspaceBinding;
  readonly toolPolicy: RuntimeExecutionToolPolicy;
  readonly effectiveTools: readonly string[];
  readonly effectiveSkills: readonly RuntimeEffectiveSkillRef[];
  readonly skillSetRevision: string;
  readonly skillRegistry: ISkillRegistry;
  readonly protectedFormalSkillNames: readonly string[];
  readonly learnedSkills?: PreparedProjectLearnedSkills;
  readonly skillScriptRunner?: KodaXSkillScriptRunner;
  readonly remoteContracts: ReadonlyMap<string, RuntimeRemoteToolContract>;
  readonly toolRegistrations: ReadonlyMap<string, string>;
  readonly workspaceByteLimit?: number;
  readonly scope?: KodaXAgentScope;
  readonly loadedAgent?: LoadedMarkdownAgent;
  readonly agent?: Agent;
  readonly configurationRevision?: string;
}

const NATIVE_READ_TOOLS = ['read', 'grep', 'glob'] as const;
const NATIVE_WRITE_TOOLS = ['write', 'edit', 'multi_edit', 'insert_after_anchor'] as const;
const MCP_TOOLS = ['mcp_search', 'mcp_describe', 'mcp_call', 'mcp_read_resource', 'mcp_get_prompt'] as const;
const SUBAGENT_TOOLS = [
  'list_dispatchable_agents',
  'spawn_agent',
  'send_message',
  'followup_task',
  'wait_agent',
  'interrupt_agent',
  'list_agents',
  'agent_output',
] as const;
const PATH_TOOLS = new Set<string>([...NATIVE_READ_TOOLS, ...NATIVE_WRITE_TOOLS]);
const SENSITIVE_PATH_PARTS = new Set(['.ssh', '.aws', '.azure', '.gnupg', '.kodax', '.agents']);
const SENSITIVE_FILES = new Set(['.env', '.npmrc', '.pypirc', 'credentials', 'id_rsa', 'id_ed25519']);
const HOST_TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const HOST_CAPABILITY_PATTERN = /^host:([^:]+):(.+)$/;

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonicalValue(item)]));
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalValue(value))).digest('hex');
}

function hashParts(parts: readonly (string | Buffer)[]): string {
  const digest = createHash('sha256');
  for (const part of parts) digest.update(part);
  return digest.digest('hex');
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function directoryBytes(root: string): number {
  if (!fs.existsSync(root)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const item = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) total += directoryBytes(item);
    else if (entry.isFile()) total += fs.statSync(item).size;
  }
  return total;
}

function validateWorkspaceByteLimit(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Runtime workspace byte limit must be positive.');
  return value;
}

function normalizedWorkspace(input: RuntimeWorkspaceBinding): RuntimeWorkspaceBinding {
  if (input.mode === 'managed') return { mode: 'managed' };
  if (!path.isAbsolute(input.root)) throw new Error('Fixed Runtime workspace root must be absolute.');
  return { mode: 'fixed', root: path.resolve(input.root) };
}

function exactList(value: unknown, label: string, allowEmpty = true): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new Error(`${label} must be ${allowEmpty ? 'an' : 'a non-empty'} array.`);
  }
  const result = value.map((item) => {
    if (typeof item !== 'string' || item.trim().length === 0 || item.includes('*')) {
      throw new Error(`${label} must contain exact names without wildcards.`);
    }
    return item.trim();
  });
  if (new Set(result).size !== result.length) throw new Error(`${label} contains duplicates.`);
  return result.sort();
}

function exactMap(value: unknown, label: string): Record<string, readonly string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, entries]) => {
      if (!name || name.includes('*')) throw new Error(`${label} keys must be exact names.`);
      return [name, exactList(entries, `${label}.${name}`, false)];
    }));
}

function exactHostTools(value: readonly string[] | undefined, label: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  const names = exactList(value, label);
  if (names.some((name) => !HOST_TOOL_NAME_PATTERN.test(name))) {
    throw new Error(`${label} must contain valid host tool names.`);
  }
  return names;
}

function validatedToolPolicy(value: RuntimeExecutionToolPolicy): RuntimeExecutionToolPolicy {
  if (!['none', 'read', 'write'].includes(value?.workspace)) throw new Error('Runtime toolPolicy.workspace is invalid.');
  if (!['deny', 'isolated'].includes(value?.process)) throw new Error('Runtime toolPolicy.process is invalid.');
  if (!['deny', 'inherit'].includes(value?.subagents)) throw new Error('Runtime toolPolicy.subagents is invalid.');
  const network = value?.network;
  if (!network || (network.mode !== 'deny' && network.mode !== 'allowlist')) throw new Error('Runtime toolPolicy.network is invalid.');
  const normalizedNetwork = network.mode === 'deny'
    ? { mode: 'deny' as const }
    : {
        mode: 'allowlist' as const,
        origins: exactList(network.origins, 'Runtime toolPolicy.network.origins')
          .map((origin) => {
            const url = new URL(origin);
            if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) {
              throw new Error('Runtime network authority must be an exact HTTP(S) origin.');
            }
            return url.origin;
          }),
      };
  const skillScripts = exactMap(value.skillScripts, 'Runtime toolPolicy.skillScripts');
  const scriptCount = Object.values(skillScripts).reduce((sum, entries) => sum + entries.length, 0);
  if ((value.process === 'deny') !== (scriptCount === 0)) {
    throw new Error('Runtime isolated process authority and skillScripts must be enabled together.');
  }
  return {
    workspace: value.workspace,
    process: value.process,
    network: normalizedNetwork,
    tools: exactList(value.tools, 'Runtime toolPolicy.tools'),
    mcp: exactMap(value.mcp, 'Runtime toolPolicy.mcp'),
    skillScripts,
    subagents: value.subagents,
    ...(value.hostTools === undefined
      ? {}
      : { hostTools: exactHostTools(value.hostTools, 'Runtime toolPolicy.hostTools') }),
  };
}

function skillSource(source: SkillMetadata['source']): RuntimeEffectiveSkillRef['source'] {
  return source === 'project' ? 'workspace' : source;
}

function skillFiles(skill: Skill): readonly { readonly relativePath: string; readonly path: string }[] {
  return [
    ...(skill.scripts ?? []).map((file) => ({ ...file, relativePath: `scripts/${file.relativePath}` })),
    ...(skill.references ?? []).map((file) => ({ ...file, relativePath: `references/${file.relativePath}` })),
    ...(skill.assets ?? []).map((file) => ({ ...file, relativePath: `assets/${file.relativePath}` })),
    ...(skill.templates ?? []).map((file) => ({ ...file, relativePath: `templates/${file.relativePath}` })),
    ...(skill.resources ?? []).map((file) => ({ ...file, relativePath: `resources/${file.relativePath}` })),
  ].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function skillRevision(skill: Skill): Promise<string> {
  const parts: Array<string | Buffer> = [skill.name, skill.rawContent];
  for (const file of skillFiles(skill)) {
    parts.push(file.relativePath, await readFile(file.path));
  }
  return hashParts(parts);
}

class PinnedSkillRegistry implements ISkillRegistry {
  readonly #delegate: ISkillRegistry;
  readonly #metadata: ReadonlyMap<string, SkillMetadata>;

  constructor(delegate: ISkillRegistry, metadata: readonly SkillMetadata[],
    readonly discoveryIncomplete = delegate.discoveryIncomplete === true) {
    this.#delegate = delegate;
    this.#metadata = new Map(metadata.map((item) => [item.name, item]));
  }

  get skills(): ReadonlyMap<string, SkillMetadata> { return this.#metadata; }
  get size(): number { return this.#metadata.size; }
  async discover(): Promise<void> {}
  get(name: string): SkillMetadata | undefined { return this.#metadata.get(name); }
  has(name: string): boolean { return this.#metadata.has(name); }
  list(): SkillMetadata[] { return [...this.#metadata.values()]; }
  listUserInvocable(): SkillMetadata[] { return this.list(); }
  async loadFull(name: string): Promise<Skill> {
    if (!this.has(name)) throw new Error(`Skill not admitted by Runtime binding: ${name}`);
    return this.#delegate.loadFull(name);
  }
  async invoke(name: string, args: string, context: SkillContext): Promise<SkillResult> {
    if (!this.has(name)) return { success: false, content: '', error: `Skill not admitted: ${name}` };
    return this.#delegate.invoke(name, args, context);
  }
  async reload(): Promise<void> {
    throw new Error('A bound Skill registry is immutable; create a new Runtime binding.');
  }
}

interface PreparedLearnedStore {
  readonly store: LearnedAreaStore;
  readonly scope: ReturnType<typeof createLearnedCapabilityScope>;
  readonly testingCapabilityIds: string[];
}

interface PreparedProjectLearnedSkills {
  readonly stores: readonly PreparedLearnedStore[];
  readonly storeByCapabilityId: ReadonlyMap<string, LearnedAreaStore>;
  readonly discovery: NonNullable<import('@kodax-ai/agent').SkillPathsConfig['learnedArea']>;
}

class CompositeSkillRegistry implements ISkillRegistry {
  constructor(
    private readonly formal: ISkillRegistry,
    private readonly learned: ISkillRegistry,
  ) {}

  get discoveryIncomplete(): boolean {
    return this.formal.discoveryIncomplete === true || this.learned.discoveryIncomplete === true;
  }

  get skills(): ReadonlyMap<string, SkillMetadata> {
    return new Map(this.list().map((skill) => [skill.name, skill]));
  }
  get size(): number { return this.list().length; }
  async discover(): Promise<void> {}
  get(name: string): SkillMetadata | undefined {
    return this.formal.get(name) ?? this.learned.get(name);
  }
  has(name: string): boolean { return this.formal.has(name) || this.learned.has(name); }
  list(): SkillMetadata[] {
    const combined = new Map(this.learned.list().map((skill) => [skill.name, skill]));
    for (const skill of this.formal.list()) combined.set(skill.name, skill);
    return [...combined.values()];
  }
  listUserInvocable(): SkillMetadata[] {
    return this.list();
  }
  loadFull(name: string): Promise<Skill> {
    return this.formal.has(name) ? this.formal.loadFull(name) : this.learned.loadFull(name);
  }
  invoke(name: string, args: string, context: SkillContext): Promise<SkillResult> {
    return this.formal.has(name)
      ? this.formal.invoke(name, args, context)
      : this.learned.invoke(name, args, context);
  }
  async reload(): Promise<void> {
    throw new Error('A bound Skill registry is immutable; create a new Runtime binding.');
  }
}

async function resolveSkills(input: {
  readonly configHome: string;
  readonly workspace: RuntimeWorkspaceBinding;
  readonly selection?: readonly string[];
  readonly bindingId?: string;
  readonly ownerSessionRef?: string;
}): Promise<{
  readonly registry: ISkillRegistry;
  readonly refs: readonly RuntimeEffectiveSkillRef[];
  readonly revision: string;
  readonly protectedFormalSkillNames: readonly string[];
  readonly learnedSkills?: PreparedProjectLearnedSkills;
}> {
  const projectRoot = input.workspace.mode === 'fixed' ? input.workspace.root : undefined;
  const defaults = getDefaultSkillPaths(projectRoot);
  const standardUserSkillPaths = defaults.userPaths.filter((skillPath) => (
    path.basename(path.dirname(skillPath)) === '.agents'
  ));
  const learned = projectRoot === undefined
    ? undefined
    : await tryPrepareProjectLearnedSkills({
        configHome: input.configHome,
        projectRoot,
        ...(input.bindingId === undefined ? {} : { bindingId: input.bindingId }),
        ...(input.ownerSessionRef === undefined ? {} : { ownerSessionRef: input.ownerSessionRef }),
      });
  const registry = new SkillRegistry(projectRoot, {
    projectPaths: input.workspace.mode === 'managed' ? [] : defaults.projectPaths,
    userPaths: [
      path.join(input.configHome, 'skills'),
      ...standardUserSkillPaths,
    ],
    pluginPaths: defaults.pluginPaths,
    builtinPath: defaults.builtinPath,
    ...(learned === undefined ? {} : { learnedArea: learned.discovery }),
  });
  try {
    await registry.discover();
  } catch (error) {
    await releaseResolvedLearnedSkills(learned, input.bindingId);
    throw error;
  }
  try {
    const all = registry.list();
    const wildcard = input.selection === undefined || input.selection.includes('*');
    const selected = wildcard
      ? all.filter((skill) => skill.source !== 'project' && !skill.disableModelInvocation)
      : input.selection.map((name) => {
          const skill = registry.get(name);
          if (!skill) throw new Error(`Markdown Agent requires unknown Skill "${name}".`);
          if (skill.disableModelInvocation) throw new Error(`Skill "${name}" disables model invocation.`);
          return skill;
        });
    const refs: RuntimeEffectiveSkillRef[] = [];
    for (const metadata of selected.sort((left, right) => left.name.localeCompare(right.name))) {
      const revision = await skillRevision(await registry.loadFull(metadata.name));
      refs.push({ name: metadata.name, source: skillSource(metadata.source), revision });
    }
    const result = {
      registry: new PinnedSkillRegistry(registry, selected, wildcard && registry.discoveryIncomplete),
      refs,
      revision: stableHash(refs),
      protectedFormalSkillNames: all
        .filter((skill) => skill.source !== 'learned')
        .map((skill) => skill.name),
      ...(learned === undefined
        ? {}
        : {
            learnedSkills: {
              stores: learned.stores,
              storeByCapabilityId: learned.storeByCapabilityId,
              discovery: learned.discovery,
            },
          }),
    };
    await safeReleaseResolvedLearnedSkills(learned, input.bindingId);
    return result;
  } catch (error) {
    await safeReleaseResolvedLearnedSkills(learned, input.bindingId);
    throw error;
  }
}

async function tryPrepareProjectLearnedSkills(
  input: Parameters<typeof prepareProjectLearnedSkills>[0],
): Promise<Awaited<ReturnType<typeof prepareProjectLearnedSkills>> | undefined> {
  try {
    return await prepareProjectLearnedSkills(input);
  } catch (error: unknown) {
    emitKodaXDiagnostic({
      source: 'runtime:learned-skills',
      level: 'warn',
      message: `Learned Area disabled for this binding: ${errorMessage(error)}`,
    });
    return undefined;
  }
}

async function releaseResolvedLearnedSkills(
  learned: PreparedProjectLearnedSkills | undefined,
  bindingId: string | undefined,
): Promise<void> {
  if (learned === undefined || bindingId === undefined) return;
  await Promise.all(learned.stores.flatMap(({ store, testingCapabilityIds }) => (
    testingCapabilityIds.map((capabilityId) => (
      releaseLearnedSkillBinding(store, capabilityId, bindingId)
    ))
  )));
}

async function safeReleaseResolvedLearnedSkills(
  learned: PreparedProjectLearnedSkills | undefined,
  bindingId: string | undefined,
): Promise<void> {
  if (learned === undefined) return;
  await safeReleasePreparedStores(learned.stores, bindingId);
}

async function safeReleasePreparedStores(
  stores: readonly PreparedLearnedStore[],
  bindingId: string | undefined,
): Promise<void> {
  if (bindingId === undefined) return;
  const results = await Promise.allSettled(stores.flatMap(({ store, testingCapabilityIds }) => (
    testingCapabilityIds.map((capabilityId) => (
      releaseLearnedSkillBinding(store, capabilityId, bindingId)
    ))
  )));
  for (const result of results) {
    if (result.status !== 'rejected') continue;
    emitKodaXDiagnostic({
      source: 'runtime:learned-skills',
      level: 'warn',
      message: `Learned Skill binding release requires lease recovery: ${errorMessage(result.reason)}`,
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function prepareProjectLearnedSkills(input: {
  readonly configHome: string;
  readonly projectRoot: string;
  readonly bindingId?: string;
  readonly ownerSessionRef?: string;
}): Promise<PreparedProjectLearnedSkills> {
  const tenantId = `local:${input.configHome}`;
  const remote = tryGitRemote(input.projectRoot)?.trim();
  const remoteProjectId = remote === undefined
    ? undefined
    : canonicalMemoryProjectId(remote);
  const localProjectId = `local:${path.resolve(input.projectRoot).toLowerCase()}`;
  const primaryProjectId = remoteProjectId ?? localProjectId;
  const projectIds = [...new Set([primaryProjectId, localProjectId])];
  const scopes = projectIds.map((projectId) => createLearnedCapabilityScope(
    input.configHome,
    { tenantId, projectId },
  ));
  const rootDirs = projectIds.map((projectId) => resolveProjectLearnedAreaRoot(
    input.configHome,
    { tenantId, projectId },
  ));
  const expectedScopes: readonly [LearnedCapabilityScope, ...LearnedCapabilityScope[]] = [
    scopes[0]!,
    ...scopes.slice(1),
  ];
  const stores: PreparedLearnedStore[] = rootDirs.map((rootDir, index) => ({
    store: new LearnedAreaStore(rootDir),
    scope: scopes[index]!,
    testingCapabilityIds: [],
  }));
  const testingBindings: Record<string, string> = {};
  const storeByCapabilityId = new Map<string, LearnedAreaStore>();
  try {
    await Promise.all(stores.map(async ({ store }) => store.initialize()));
    await migrateLegacyLearnedSkillsForProject(input.configHome, stores[0]!.store, scopes[0]!);
    for (const prepared of stores) {
      for (const record of await prepared.store.listCapabilities()) {
        if (record.schemaVersion !== 2
          || !sameLearnedScope(record.scope, prepared.scope)
          || storeByCapabilityId.has(record.capabilityId)) continue;
        storeByCapabilityId.set(record.capabilityId, prepared.store);
        if (record.lifecycle !== 'testing'
          || input.bindingId === undefined
          || input.ownerSessionRef === undefined) continue;
        const admission = await admitLearnedSkillBinding(prepared.store, record.capabilityId, {
          bindingId: input.bindingId,
          ownerSessionRef: input.ownerSessionRef,
        });
        if (admission === undefined) continue;
        testingBindings[record.capabilityId] = admission.bindingId;
        prepared.testingCapabilityIds.push(record.capabilityId);
      }
    }
  } catch (error) {
    await safeReleasePreparedStores(stores, input.bindingId);
    throw error;
  }
  return {
    stores,
    storeByCapabilityId,
    discovery: {
      rootDir: rootDirs[0]!,
      additionalRootDirs: rootDirs.slice(1),
      expectedScope: scopes[0]!,
      expectedScopes,
      testingBindings,
    },
  };
}

function sameLearnedScope(
  left: { readonly configHomeHash: string; readonly tenantHash: string; readonly projectHash: string },
  right: { readonly configHomeHash: string; readonly tenantHash: string; readonly projectHash: string },
): boolean {
  return left.configHomeHash === right.configHomeHash
    && left.tenantHash === right.tenantHash
    && left.projectHash === right.projectHash;
}

function validateRemoteContract(
  name: string,
  contract: RuntimeRemoteToolContract,
  policy: RuntimeExecutionToolPolicy,
): void {
  const workspaceRank = { none: 0, read: 1, write: 2 } as const;
  if (workspaceRank[contract.workspaceEffect] > workspaceRank[policy.workspace]) {
    throw new Error(`Remote tool "${name}" requires broader workspace access.`);
  }
  const allowedOrigins = new Set(policy.network.mode === 'allowlist' ? policy.network.origins : []);
  if (contract.networkOrigins.some((origin) => !allowedOrigins.has(new URL(origin).origin))) {
    throw new Error(`Remote tool "${name}" requires a network origin outside toolPolicy.`);
  }
}

function resolveToolSurface(input: {
  readonly declared?: readonly string[];
  readonly policy: RuntimeExecutionToolPolicy;
  readonly hasSkills: boolean;
  readonly hasSkillScripts: boolean;
}): {
  readonly tools: readonly string[];
  readonly contracts: ReadonlyMap<string, RuntimeRemoteToolContract>;
  readonly registrations: ReadonlyMap<string, string>;
} {
  const allowed = new Set<string>();
  if (input.policy.workspace !== 'none') NATIVE_READ_TOOLS.forEach((name) => allowed.add(name));
  if (input.policy.workspace === 'write') NATIVE_WRITE_TOOLS.forEach((name) => allowed.add(name));
  if (input.hasSkills) allowed.add('skill');
  if (input.hasSkillScripts) allowed.add('run_skill_script');
  if (Object.keys(input.policy.mcp).length > 0 || (input.policy.hostTools?.length ?? 0) > 0) {
    MCP_TOOLS.forEach((name) => allowed.add(name));
  }
  if (input.policy.subagents === 'inherit') SUBAGENT_TOOLS.forEach((name) => allowed.add(name));

  const registered = new Map(getAllRegisteredTools().map((tool) => [tool.name, tool]));
  const contracts = new Map<string, RuntimeRemoteToolContract>();
  for (const name of input.policy.tools) {
    const contract = registered.get(name)?.remoteContract;
    if (!contract) throw new Error(`Tool "${name}" has no Runtime remote contract.`);
    validateRemoteContract(name, contract, input.policy);
    contracts.set(name, contract);
    allowed.add(name);
  }
  const registrations = new Map<string, string>();
  for (const name of allowed) {
    const active = registered.get(name);
    if (!active) throw new Error(`Runtime tool is unavailable: ${name}.`);
    if (!contracts.has(name) && active.source.kind !== 'builtin') {
      throw new Error(`Native Runtime tool "${name}" is shadowed by a non-builtin registration.`);
    }
    registrations.set(name, active.registrationId);
  }
  if (input.declared !== undefined) {
    const unavailable = input.declared.filter((name) => !allowed.has(name));
    if (unavailable.length > 0) {
      throw new Error(`Markdown Agent tools are denied by remote policy: ${unavailable.join(', ')}.`);
    }
    const tools = [...new Set(input.declared)].sort();
    return {
      tools,
      contracts,
      registrations: new Map(tools.map((name) => [name, registrations.get(name)!])),
    };
  }
  return { tools: [...allowed].sort(), contracts, registrations };
}

function skillsPrompt(skills: readonly RuntimeEffectiveSkillRef[], registry: ISkillRegistry): string {
  if (skills.length === 0) return '## Available Skills\n\nNo Skills are admitted for this deployment.';
  const admitted = new Set(skills.map(skill => skill.name));
  return formatSkillsSystemPrompt(registry.list().filter(skill => admitted.has(skill.name)));
}

function sensitivePath(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  const parts = relative.split(path.sep).map((part) => part.toLowerCase());
  return parts.some((part) => SENSITIVE_PATH_PARTS.has(part))
    || parts.some((part) => SENSITIVE_FILES.has(part) || part.startsWith('.env.'));
}

function nearestExistingPath(candidate: string): string {
  let current = candidate;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error('Tool path has no existing parent.');
    current = parent;
  }
  return current;
}

function resolveRealToolPath(root: string, candidate: string): { readonly root: string; readonly candidate: string } {
  const realRoot = fs.realpathSync(root);
  const existing = nearestExistingPath(candidate);
  const realExisting = fs.realpathSync(existing);
  if (!isInside(realRoot, realExisting)) throw new Error('Tool path escapes the bound workspace through a link.');
  const realCandidate = path.resolve(realExisting, path.relative(existing, candidate));
  if (!isInside(realRoot, realCandidate)) throw new Error('Tool path escapes the bound workspace through a link.');
  return { root: realRoot, candidate: realCandidate };
}

function resolveToolPath(root: string, raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw.trim().length === 0) throw new Error('Tool path must be a string.');
  const candidate = path.resolve(root, raw);
  if (!isInside(root, candidate)) throw new Error('Tool path escapes the bound workspace.');
  const real = resolveRealToolPath(root, candidate);
  if (sensitivePath(candidate, root) || sensitivePath(real.candidate, real.root)) {
    throw new Error('Secret-bearing paths are unavailable to remote Agents.');
  }
  return candidate;
}

function remoteRunEvents() {
  return {
    // Remote policy guardrails are the authority; A2A runs cannot wait for interactive approval.
    beforeToolExecute: async () => true,
  };
}

function authorizeMcp(
  name: string,
  input: Readonly<Record<string, unknown>>,
  policy: RuntimeExecutionToolPolicy,
): void {
  if (!MCP_TOOLS.includes(name as typeof MCP_TOOLS[number])) return;
  if (name === 'mcp_search') {
    const server = input.server;
    if (server === 'host') {
      if ((policy.hostTools?.length ?? 0) === 0) {
        throw new Error('MCP search requires an explicitly admitted server.');
      }
      return;
    }
    if (typeof server !== 'string' || policy.mcp[server] === undefined) {
      throw new Error('MCP search requires an explicitly admitted server.');
    }
    return;
  }
  const id = input.id;
  if (typeof id !== 'string') throw new Error('MCP calls require a canonical capability id.');
  const hostMatch = HOST_CAPABILITY_PATTERN.exec(id);
  if (hostMatch) {
    // Materialized host tools expose only the tool kind; the lease segment routes, hostTools authorize.
    if (name !== 'mcp_call' && name !== 'mcp_describe') {
      throw new Error('MCP capability id is invalid.');
    }
    if (!policy.hostTools?.includes(hostMatch[2] ?? '')) {
      throw new Error('MCP tool is not admitted by the remote policy.');
    }
    return;
  }
  const match = /^mcp:([^:]+):(tool|resource|prompt):(.+)$/.exec(id);
  if (!match) throw new Error('MCP capability id is invalid.');
  const [, server, kind, capability] = match;
  const admitted = policy.mcp[server ?? ''] ?? [];
  if (kind === 'tool' && !admitted.includes(capability ?? '')) {
    throw new Error('MCP tool is not admitted by the remote policy.');
  }
  if (kind !== 'tool' && !admitted.includes(capability ?? '')) {
    throw new Error('MCP capability is not admitted by the remote policy.');
  }
}

function workspaceBroker(root: string) {
  return {
    async resolveReadablePath(relativePath: string): Promise<string> {
      return resolveToolPath(root, relativePath) ?? root;
    },
    async stageOutput(suggestedName: string): Promise<{ readonly stagingId: string; readonly path: string }> {
      const stagingId = randomUUID();
      const safeName = path.basename(suggestedName).replace(/[^A-Za-z0-9._-]/g, '_') || 'output';
      const target = path.join(root, '.kodax-a2a-staging', `${stagingId}-${safeName}`);
      await mkdir(path.dirname(target), { recursive: true });
      return { stagingId, path: resolveToolPath(root, target) ?? target };
    },
  };
}

function createToolGuardrail(binding: BindingResources, workspaceRoot: string): ToolGuardrail {
  return {
    kind: 'tool',
    name: `runtime-remote-policy:${binding.bindingId}`,
    async beforeTool(call, context) {
      try {
        if (binding.workspaceByteLimit !== undefined
          && directoryBytes(workspaceRoot) > binding.workspaceByteLimit) {
          throw new Error('Remote workspace byte quota is already exceeded.');
        }
        if (!binding.effectiveTools.includes(call.name)) throw new Error('Tool is outside the bound surface.');
        const active = getAllRegisteredTools().find((tool) => tool.name === call.name);
        if (active?.registrationId !== binding.toolRegistrations.get(call.name)) {
          throw new Error('Tool registration changed after the Runtime binding was prepared.');
        }
        if (PATH_TOOLS.has(call.name)) {
          const pathKey = call.name === 'grep' || call.name === 'glob' ? 'path' : 'path';
          resolveToolPath(workspaceRoot, call.input[pathKey]);
        }
        authorizeMcp(call.name, call.input, binding.toolPolicy);
        const contract = binding.remoteContracts.get(call.name);
        if (contract) {
          const decision = await contract.authorizeCall(call.input, {
            workspaceAccess: binding.toolPolicy.workspace,
            allowedNetworkOrigins: binding.toolPolicy.network.mode === 'allowlist'
              ? binding.toolPolicy.network.origins
              : [],
            workspace: workspaceBroker(workspaceRoot),
            signal: context.abortSignal ?? new AbortController().signal,
          });
          if (!decision.allowed) throw new Error(decision.reason);
          return { action: 'rewrite', payload: { ...call, input: decision.input } };
        }
        return { action: 'allow' };
      } catch (error: unknown) {
        return { action: 'block', reason: error instanceof Error ? error.message : String(error) };
      }
    },
    async afterTool() {
      if (binding.workspaceByteLimit !== undefined
        && directoryBytes(workspaceRoot) > binding.workspaceByteLimit) {
        return { action: 'block', reason: 'Remote workspace byte quota exceeded.' };
      }
      return { action: 'allow' };
    },
  };
}

async function requiredWorkspaceRoot(
  host: RuntimeAgentBindingHost,
  binding: BindingResources,
  sessionId: string,
): Promise<string> {
  const session = await host.sessions.load(sessionId);
  const root = session.workspaceRoot ?? session.gitRoot;
  if (!root) throw new Error('Remote Runtime session has no bound workspace.');
  if (binding.workspace.mode === 'fixed' && path.resolve(root) !== binding.workspace.root) {
    throw new Error('Runtime session workspace does not match the fixed binding.');
  }
  if (binding.workspace.mode === 'managed' && !isInside(host.managedWorkspaceRoot, root)) {
    throw new Error('Runtime session workspace is outside the managed A2A root.');
  }
  return path.resolve(root);
}

async function localAgentResources(
  host: RuntimeAgentBindingHost,
  ref: RuntimeUserMarkdownAgentRef,
  workspace: RuntimeWorkspaceBinding,
  admission?: {
    readonly bindingId: string;
    readonly ownerSessionRef: string;
  },
): Promise<{
  readonly scope: KodaXAgentScope;
  readonly loaded: LoadedMarkdownAgent;
  readonly configurationRevision: string;
  readonly skills: Awaited<ReturnType<typeof resolveSkills>>;
}> {
  const cwd = workspace.mode === 'fixed' ? workspace.root : host.managedWorkspaceRoot;
  const result = await loadMarkdownAgentScope({ cwd, configHome: host.configHome, userOnly: true });
  const loaded = result.loaded.find((agent) => agent.name === ref.name && agent.source === 'markdown:user');
  const entry = result.scope.resolve(ref.name);
  if (!loaded || !entry || entry.source !== 'markdown:user') {
    await result.dispose();
    const failure = result.failed.find((item) => path.basename(item.path, '.md') === ref.name);
    throw new Error(failure?.reason ?? `User Markdown Agent not found: ${ref.name}`);
  }
  const configurationRevision = hashParts([await readFile(loaded.path)]);
  try {
    const skills = await resolveSkills({
      configHome: host.configHome,
      workspace,
      selection: loaded.requestedSkills,
      ...(admission === undefined ? {} : admission),
    });
    return { scope: result.scope, loaded, configurationRevision, skills };
  } catch (error: unknown) {
    await result.dispose();
    throw error;
  }
}

function resolvedLocal(
  ref: RuntimeUserMarkdownAgentRef,
  resources: Awaited<ReturnType<typeof localAgentResources>>,
): RuntimeResolvedLocalAgent {
  return {
    ref,
    agentId: `markdown:user:${ref.name}`,
    displayName: ref.name,
    description: resources.loaded.description,
    configurationRevision: resources.configurationRevision,
    effectiveSkills: resources.skills.refs,
    skillSetRevision: resources.skills.revision,
  };
}

export function createRuntimeAgentBindingService(
  host: RuntimeAgentBindingHost,
): RuntimeAgentBindingService {
  const owners = new Map<string, Set<string>>();
  const bindings = new Map<string, BindingResources>();

  const requireOwner = (ownerSessionId: string): Set<string> => {
    const owner = owners.get(ownerSessionId);
    if (!owner) throw new Error('Runtime Agent owner session is not active.');
    return owner;
  };
  const requireBinding = (ownerSessionId: string, bindingId: string): BindingResources => {
    const binding = bindings.get(bindingId);
    if (!binding || binding.ownerSessionId !== ownerSessionId) throw new Error('Runtime Agent binding not found.');
    return binding;
  };
  const release = async (binding: BindingResources): Promise<void> => {
    bindings.delete(binding.bindingId);
    owners.get(binding.ownerSessionId)?.delete(binding.bindingId);
    binding.scope?.dispose();
    await binding.skillScriptRunner?.dispose();
    await safeReleaseResolvedLearnedSkills(binding.learnedSkills, binding.bindingId);
  };

  const prepareLearnedSkillRun = async (
    binding: BindingResources,
    sessionId: string,
  ) => {
    const formalSkills = binding.skillRegistry.list()
      .filter((metadata) => metadata.source !== 'learned');
    const formalRegistry = new PinnedSkillRegistry(binding.skillRegistry, formalSkills);
    const withoutLearned = {
      context: {
        configHome: host.configHome,
        protectedFormalSkillNames: binding.protectedFormalSkillNames,
      },
      registry: formalRegistry,
      skills: binding.effectiveSkills.filter((skill) => skill.source !== 'learned'),
      release: async () => undefined,
    };
    if (binding.learnedSkills === undefined || binding.workspace.mode !== 'fixed') {
      return withoutLearned;
    }
    const runBindingId = `root_${randomUUID()}`;
    const learned = await tryPrepareProjectLearnedSkills({
      configHome: host.configHome,
      projectRoot: binding.workspace.root,
      bindingId: runBindingId,
      ownerSessionRef: sessionId,
    });
    if (learned === undefined) return withoutLearned;
    const learnedRegistry = new SkillRegistry(undefined, {
      projectPaths: [],
      userPaths: [],
      pluginPaths: [],
      builtinPath: path.join(learned.discovery.rootDir, '.no-formal-skills'),
      learnedArea: learned.discovery,
    });
    try {
      await Promise.all(learned.stores.map(({ store }) => reconcileLearnedSkillBindingOutcomes(store, {
        sessionId,
        bindingId: runBindingId,
      })));
      await learnedRegistry.discover();
    } catch (error: unknown) {
      await safeReleaseResolvedLearnedSkills(learned, runBindingId);
      emitKodaXDiagnostic({
        source: 'runtime:learned-skills',
        level: 'warn',
        message: `Learned Area disabled for this root run: ${errorMessage(error)}`,
      });
      return withoutLearned;
    }
    const registry = new CompositeSkillRegistry(formalRegistry, learnedRegistry);
    try {
      for (const metadata of registry.list()) {
        if (metadata.source !== 'learned' || metadata.learned === undefined) continue;
        const capabilityStore = learned.storeByCapabilityId.get(metadata.learned.capabilityId);
        if (capabilityStore === undefined) continue;
        await recordLearnedSkillOffered(capabilityStore, {
          sessionId,
          bindingId: runBindingId,
          capabilityId: metadata.learned.capabilityId,
          revision: metadata.learned.revision,
          fingerprint: metadata.learned.fingerprint,
        });
      }
    } catch (error: unknown) {
      await safeReleaseResolvedLearnedSkills(learned, runBindingId);
      emitKodaXDiagnostic({
        source: 'runtime:learned-skills',
        level: 'warn',
        message: `Learned usage receipts disabled for this root run: ${errorMessage(error)}`,
      });
      return withoutLearned;
    }
    const learnedSkills = registry.list()
      .filter((metadata) => metadata.source === 'learned' && metadata.learned !== undefined)
      .map((metadata): RuntimeEffectiveSkillRef => ({
        name: metadata.name,
        source: 'learned',
        revision: metadata.learned!.fingerprint,
      }));
    return {
      context: {
        configHome: host.configHome,
        protectedFormalSkillNames: binding.protectedFormalSkillNames,
        learnedSkillBindingId: runBindingId,
        admitLearnedSkillInvocation: async (
          input: Parameters<NonNullable<KodaXContextOptions['admitLearnedSkillInvocation']>>[0],
        ) => {
          const capabilityStore = learned.storeByCapabilityId.get(input.capabilityId);
          if (capabilityStore === undefined) {
            throw new Error(`Learned Skill capability is outside this project binding: ${input.capabilityId}`);
          }
          const receipt = await admitAndRecordLearnedSkillInvocation(capabilityStore, {
            sessionId,
            ownerSessionRef: sessionId,
            capabilityId: input.capabilityId,
            expectedRevision: input.revision,
            expectedFingerprint: input.fingerprint,
            bindingId: runBindingId,
          });
          return { invocationId: receipt.invocationId };
        },
        completeLearnedSkillOutcomes: async (
          input: Parameters<NonNullable<KodaXContextOptions['completeLearnedSkillOutcomes']>>[0],
        ) => {
          await Promise.all(learned.stores.map(({ store }) => completeLearnedSkillSessionOutcomes(store, {
            ...input,
            sessionId,
            bindingId: runBindingId,
          })));
        },
      },
      registry,
      skills: [
        ...binding.effectiveSkills.filter((skill) => skill.source !== 'learned'),
        ...learnedSkills,
      ],
      release: async () => {
        try {
          await Promise.all(learned.stores.map(({ store }) => reconcileLearnedSkillBindingOutcomes(store, {
            sessionId,
            bindingId: runBindingId,
          })));
        } catch (error: unknown) {
          emitKodaXDiagnostic({
            source: 'runtime:learned-skills',
            level: 'warn',
            message: `Learned Skill outcome reconciliation failed: ${errorMessage(error)}`,
          });
        } finally {
          await safeReleaseResolvedLearnedSkills(learned, runBindingId);
        }
      },
    };
  };

  const withLearnedSkillRelease = async (
    prepared: Awaited<ReturnType<typeof prepareLearnedSkillRun>>,
    start: () => Promise<RuntimeRunHandle>,
  ): Promise<RuntimeRunHandle> => {
    try {
      const handle = await start();
      return { ...handle, result: handle.result.finally(prepared.release) };
    } catch (error: unknown) {
      await prepared.release();
      throw error;
    }
  };

  return {
    async resolveLocal(input) {
      const workspace = normalizedWorkspace(input.workspace);
      const resources = await localAgentResources(host, input.ref, workspace);
      try { return resolvedLocal(input.ref, resources); }
      finally { resources.scope.dispose(); }
    },
    async openOwnerSession() {
      const ownerSessionId = randomUUID();
      owners.set(ownerSessionId, new Set());
      return { ownerSessionId };
    },
    async bindDefault(input) {
      const owner = requireOwner(input.ownerSessionId);
      const workspace = normalizedWorkspace(input.workspace);
      const toolPolicy = validatedToolPolicy(input.toolPolicy);
      const workspaceByteLimit = validateWorkspaceByteLimit(input.workspaceByteLimit);
      const bindingId = randomUUID();
      const skills = await resolveSkills({
        configHome: host.configHome,
        workspace,
        bindingId,
        ownerSessionRef: input.ownerSessionId,
      });
      const hasSkillScripts = Object.keys(toolPolicy.skillScripts).length > 0;
      const toolSurface = resolveToolSurface({ policy: toolPolicy, hasSkills: skills.refs.length > 0, hasSkillScripts });
      const skillScriptRunner = hasSkillScripts
        ? await host.createSkillScriptRunner?.({
            registry: skills.registry, admissions: toolPolicy.skillScripts,
            workspaceAccess: toolPolicy.workspace, network: toolPolicy.network, workspaceByteLimit,
          })
        : undefined;
      if (hasSkillScripts && !skillScriptRunner) {
        await releaseResolvedLearnedSkills(skills.learnedSkills, bindingId);
        throw new Error('Runtime isolated Skill script backend is unavailable.');
      }
      const toolPolicyRevision = stableHash(toolPolicy);
      const workspaceBindingRevision = stableHash(workspace);
      const executionPolicyRevision = stableHash({
        kind: 'runtime-default', profileId: input.profileId, toolPolicyRevision,
        workspaceBindingRevision, skillSetRevision: skills.revision,
        provider: host.defaultProvider, model: host.defaultModel, tools: toolSurface.tools,
        workspaceByteLimit,
      });
      if (input.expectedExecutionPolicyRevision && input.expectedExecutionPolicyRevision !== executionPolicyRevision) {
        await skillScriptRunner?.dispose();
        await releaseResolvedLearnedSkills(skills.learnedSkills, bindingId);
        throw new Error('Runtime default execution policy revision changed.');
      }
      const resources: BindingResources = {
        ownerSessionId: input.ownerSessionId, bindingId, kind: 'runtime-default',
        executionPolicyRevision, toolPolicyRevision, workspaceBindingRevision,
        workspace, toolPolicy, effectiveTools: toolSurface.tools,
        effectiveSkills: skills.refs, skillSetRevision: skills.revision,
        skillRegistry: skills.registry,
        protectedFormalSkillNames: skills.protectedFormalSkillNames,
        skillScriptRunner, remoteContracts: toolSurface.contracts,
        toolRegistrations: toolSurface.registrations, workspaceByteLimit,
        ...(skills.learnedSkills === undefined ? {} : { learnedSkills: skills.learnedSkills }),
      };
      bindings.set(bindingId, resources);
      owner.add(bindingId);
      return {
        ownerSessionId: input.ownerSessionId, bindingId, executionPolicyRevision,
        toolPolicyRevision, workspaceBindingRevision, skillSetRevision: skills.revision,
        effectiveSkills: skills.refs, effectiveTools: toolSurface.tools,
      };
    },
    async startDefault(input) {
      const binding = requireBinding(input.ownerSessionId, input.bindingId);
      if (binding.kind !== 'runtime-default') throw new Error('Runtime Agent binding kind mismatch.');
      if (binding.executionPolicyRevision !== input.expectedExecutionPolicyRevision) {
        throw new Error('Runtime default execution policy revision changed.');
      }
      const root = await requiredWorkspaceRoot(host, binding, input.sessionId);
      const learnedRun = await prepareLearnedSkillRun(binding, input.sessionId);
      return withLearnedSkillRelease(learnedRun, () => host.runs.start({
        sessionId: input.sessionId, input: input.input, permissionBroker: input.permissionBroker,
        agentContext: input.agentContext,
        options: {
          context: {
            executionCwd: root, gitRoot: root, managedTaskWorkspaceDir: root,
            ...learnedRun.context,
            toolVisibilityPolicy: (tool) => binding.effectiveTools.includes(tool.name),
            skillRegistry: learnedRun.registry,
            skillScriptRunner: binding.skillScriptRunner,
            assertReadablePath: (candidate) => { resolveToolPath(root, candidate); },
            skillsPrompt: skillsPrompt(learnedRun.skills, learnedRun.registry),
          },
          skillDynamicContext: { disable: true },
          guardrails: [createToolGuardrail(binding, root)],
          events: remoteRunEvents(),
        },
      }));
    },
    async bindLocal(input) {
      const owner = requireOwner(input.ownerSessionId);
      const workspace = normalizedWorkspace(input.workspace);
      const toolPolicy = validatedToolPolicy(input.toolPolicy);
      const workspaceByteLimit = validateWorkspaceByteLimit(input.workspaceByteLimit);
      const bindingId = randomUUID();
      const resources = await localAgentResources(host, input.ref, workspace, {
        bindingId,
        ownerSessionRef: input.ownerSessionId,
      });
      const resolved = resolvedLocal(input.ref, resources);
      if (input.expectedConfigurationRevision && input.expectedConfigurationRevision !== resolved.configurationRevision) {
        resources.scope.dispose();
        await releaseResolvedLearnedSkills(resources.skills.learnedSkills, bindingId);
        throw new Error('User Markdown Agent configuration revision changed.');
      }
      const toolSurface = resolveToolSurface({
        declared: resources.loaded.effectiveTools,
        policy: toolPolicy,
        hasSkills: resources.skills.refs.length > 0,
        hasSkillScripts: Object.keys(toolPolicy.skillScripts).length > 0,
      });
      const hasSkillScripts = Object.keys(toolPolicy.skillScripts).length > 0;
      const skillScriptRunner = hasSkillScripts
        ? await host.createSkillScriptRunner?.({
            registry: resources.skills.registry, admissions: toolPolicy.skillScripts,
            workspaceAccess: toolPolicy.workspace, network: toolPolicy.network, workspaceByteLimit,
          })
        : undefined;
      if (hasSkillScripts && !skillScriptRunner) {
        resources.scope.dispose();
        await releaseResolvedLearnedSkills(resources.skills.learnedSkills, bindingId);
        throw new Error('Runtime isolated Skill script backend is unavailable.');
      }
      const toolPolicyRevision = stableHash(toolPolicy);
      const workspaceBindingRevision = stableHash(workspace);
      const executionPolicyRevision = stableHash({
        kind: 'local-agent', profileId: input.profileId,
        configurationRevision: resolved.configurationRevision,
        toolPolicyRevision, workspaceBindingRevision,
        skillSetRevision: resources.skills.revision, tools: toolSurface.tools,
        workspaceByteLimit,
      });
      if (input.expectedExecutionPolicyRevision && input.expectedExecutionPolicyRevision !== executionPolicyRevision) {
        await skillScriptRunner?.dispose();
        resources.scope.dispose();
        await releaseResolvedLearnedSkills(resources.skills.learnedSkills, bindingId);
        throw new Error('Local Agent execution policy revision changed.');
      }
      const agent = resources.scope.resolve(input.ref.name)?.agent;
      if (!agent) {
        await skillScriptRunner?.dispose();
        resources.scope.dispose();
        await releaseResolvedLearnedSkills(resources.skills.learnedSkills, bindingId);
        throw new Error(`User Markdown Agent not found: ${input.ref.name}`);
      }
      const binding: BindingResources = {
        ownerSessionId: input.ownerSessionId, bindingId, kind: 'local-agent',
        executionPolicyRevision, toolPolicyRevision, workspaceBindingRevision,
        workspace, toolPolicy, effectiveTools: toolSurface.tools,
        effectiveSkills: resources.skills.refs, skillSetRevision: resources.skills.revision,
        skillRegistry: resources.skills.registry,
        protectedFormalSkillNames: resources.skills.protectedFormalSkillNames,
        skillScriptRunner, remoteContracts: toolSurface.contracts,
        toolRegistrations: toolSurface.registrations,
        ...(resources.skills.learnedSkills === undefined
          ? {}
          : { learnedSkills: resources.skills.learnedSkills }),
        workspaceByteLimit,
        scope: resources.scope, loadedAgent: resources.loaded, agent,
        configurationRevision: resources.configurationRevision,
      };
      bindings.set(bindingId, binding);
      owner.add(bindingId);
      return {
        ...resolved, ownerSessionId: input.ownerSessionId, bindingId,
        executionPolicyRevision, toolPolicyRevision, workspaceBindingRevision,
        effectiveTools: toolSurface.tools,
      };
    },
    async startLocal(input) {
      const binding = requireBinding(input.ownerSessionId, input.bindingId);
      if (binding.kind !== 'local-agent' || !binding.agent || !binding.scope) {
        throw new Error('Runtime Agent binding kind mismatch.');
      }
      const agent = binding.agent;
      const scope = binding.scope;
      if (binding.configurationRevision !== input.expectedConfigurationRevision) {
        throw new Error('User Markdown Agent configuration revision changed.');
      }
      if (binding.executionPolicyRevision !== input.expectedExecutionPolicyRevision) {
        throw new Error('Local Agent execution policy revision changed.');
      }
      const root = await requiredWorkspaceRoot(host, binding, input.sessionId);
      const learnedRun = await prepareLearnedSkillRun(binding, input.sessionId);
      const instructions = typeof agent.instructions === 'string'
        ? agent.instructions
        : agent.instructions({});
      return withLearnedSkillRelease(learnedRun, () => host.runs.start({
        sessionId: input.sessionId, input: input.input, permissionBroker: input.permissionBroker,
        agentContext: input.agentContext,
        options: {
          ...(agent.provider ? { provider: agent.provider } : {}),
          ...(agent.model ? { modelOverride: agent.model } : {}),
          ...(agent.effort ? { effort: agent.effort } : {}),
          context: {
            executionCwd: root, gitRoot: root, managedTaskWorkspaceDir: root,
            ...learnedRun.context,
            agentProfile: { name: agent.name, instructions }, agentScope: scope,
            toolVisibilityPolicy: (tool) => binding.effectiveTools.includes(tool.name),
            skillRegistry: learnedRun.registry,
            skillScriptRunner: binding.skillScriptRunner,
            assertReadablePath: (candidate) => { resolveToolPath(root, candidate); },
            skillsPrompt: skillsPrompt(learnedRun.skills, learnedRun.registry),
          },
          skillDynamicContext: { disable: true },
          guardrails: [createToolGuardrail(binding, root)],
          events: remoteRunEvents(),
        },
      }));
    },
    async prepareWorkspace(input) {
      const binding = requireBinding(input.ownerSessionId, input.bindingId);
      if (binding.workspace.mode === 'fixed') return binding.workspace.root;
      if (!/^[a-f0-9]{32,64}$/.test(input.contextKey)) {
        throw new Error('Managed Runtime workspace context key is invalid.');
      }
      const root = path.join(host.managedWorkspaceRoot, 'contexts', input.contextKey);
      await mkdir(root, { recursive: true });
      return root;
    },
    async releaseBinding(input) {
      requireOwner(input.ownerSessionId);
      await release(requireBinding(input.ownerSessionId, input.bindingId));
    },
    async closeOwnerSession(ownerSessionId) {
      const owner = requireOwner(ownerSessionId);
      for (const bindingId of [...owner]) await release(requireBinding(ownerSessionId, bindingId));
      owners.delete(ownerSessionId);
    },
  };
}
