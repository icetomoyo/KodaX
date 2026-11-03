import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

import type { McpServerConfig, McpServersConfig } from "@kodax-ai/agent";
import { readCoreConfig as readCoreConfigFile, writeCoreConfigAtomically as publishCoreConfig,
  withConfigWriteLock, withCoreConfigWriteLock } from "./core-config-lock.js";

export type IntegrationDomain = "mcp" | "a2a" | "extensions";
export type IntegrationConfigSource = "user" | "legacy-user" | "default";

export interface McpIntegrationDocument {
  readonly version: 1;
  readonly servers: McpServersConfig;
}

export interface ExtensionsIntegrationDocument {
  readonly version: 1;
  readonly paths: readonly string[];
}

export interface IntegrationConfigSnapshot<T extends object> {
  readonly domain: IntegrationDomain;
  readonly source: IntegrationConfigSource;
  readonly path: string;
  readonly revision: string;
  readonly document: T;
  readonly loadedAt: string;
}

export interface IntegrationConfigDiagnostic {
  readonly code: "invalid-config" | "activation-failed" | "watcher-degraded";
  readonly message: string;
  readonly time: string;
}

export interface IntegrationConfigStatus {
  readonly domain: IntegrationDomain;
  readonly path: string;
  readonly revision?: string;
  readonly source?: IntegrationConfigSource;
  readonly lastReloadAt?: string;
  readonly diagnostic?: IntegrationConfigDiagnostic;
  readonly watching: boolean;
}

export interface LegacyIntegrationMigrationDomainPlan {
  readonly action: "create" | "none";
  readonly entries: number;
  readonly destination: string;
  readonly reason?: string;
}

export interface LegacyIntegrationMigrationPlan {
  readonly mcp: LegacyIntegrationMigrationDomainPlan;
  readonly extensions: LegacyIntegrationMigrationDomainPlan;
  readonly warnings: readonly string[];
}

export interface LegacyIntegrationMigrationResult extends LegacyIntegrationMigrationPlan {
  readonly applied: readonly ("mcp" | "extensions")[];
  readonly cleanedLegacy: boolean;
}

export class IntegrationConfigConflictError extends Error {
  constructor(
    file: string,
    expected: string | undefined,
    actual: string | undefined,
  ) {
    super(
      `Integration configuration revision changed for ${path.basename(file)} ` +
        `(expected ${expected ?? "missing"}, actual ${actual ?? "missing"}).`,
    );
    this.name = "IntegrationConfigConflictError";
  }
}

export type IntegrationDocumentValidator<T extends object> = (
  value: unknown,
) => T;
export type IntegrationConfigListener<T extends object> = (
  snapshot: IntegrationConfigSnapshot<T>,
  previous: IntegrationConfigSnapshot<T> | undefined,
) => Promise<void> | void;

type IntegrationReloadResult<T extends object> =
  | { readonly ok: true; readonly snapshot: IntegrationConfigSnapshot<T> }
  | { readonly ok: false; readonly error: string };

const DOMAIN_FILENAMES: Readonly<Record<IntegrationDomain, string>> = {
  mcp: "mcp.json",
  a2a: "a2a.json",
  extensions: "extensions.json",
};

const MCP_SERVER_KEYS = new Set([
  "type",
  "command",
  "args",
  "cwd",
  "env",
  "url",
  "headers",
  "connect",
  "startupTimeoutMs",
  "requestTimeoutMs",
  "auth",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function assertNoUnknownKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined)
    throw new Error(`${label} has unknown field "${unknown}".`);
}

function requireVersionOne(
  value: Readonly<Record<string, unknown>>,
  label: string,
): void {
  if (value.version !== 1) throw new Error(`${label} version must be 1.`);
}

function requireStringMap(
  value: unknown,
  label: string,
): Record<string, string> {
  const record = requireRecord(value, label);
  for (const [key, item] of Object.entries(record)) {
    if (key.trim().length === 0 || typeof item !== "string") {
      throw new Error(
        `${label} must contain non-empty string keys and string values.`,
      );
    }
  }
  return structuredClone(record as Record<string, string>);
}

function requireStringArray(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string" && item.trim().length > 0)
  ) {
    throw new Error(`${label} must be an array of non-empty strings.`);
  }
  return value.map((item) => item.trim());
}

function validatePositiveNumber(value: unknown, label: string): void {
  if (value !== undefined && (!Number.isFinite(value) || Number(value) <= 0)) {
    throw new Error(`${label} must be a positive number.`);
  }
}

function parseMcpServer(name: string, value: unknown): McpServerConfig {
  if (name.trim().length === 0)
    throw new Error("MCP server names must not be empty.");
  const record = requireRecord(value, `MCP server "${name}"`);
  assertNoUnknownKeys(record, MCP_SERVER_KEYS, `MCP server "${name}"`);
  const type = record.type ?? "stdio";
  if (!["stdio", "sse", "streamable-http", "http"].includes(String(type))) {
    throw new Error(`MCP server "${name}" has an unsupported transport type.`);
  }
  if (type === "stdio") {
    if (
      typeof record.command !== "string" ||
      record.command.trim().length === 0
    ) {
      throw new Error(`MCP server "${name}" stdio transport requires command.`);
    }
  } else if (typeof record.url !== "string" || record.url.trim().length === 0) {
    throw new Error(
      `MCP server "${name}" ${String(type)} transport requires url.`,
    );
  }
  if (record.args !== undefined)
    requireStringArray(record.args, `MCP server "${name}" args`);
  if (record.cwd !== undefined && typeof record.cwd !== "string") {
    throw new Error(`MCP server "${name}" cwd must be a string.`);
  }
  if (record.env !== undefined)
    requireStringMap(record.env, `MCP server "${name}" env`);
  if (record.headers !== undefined)
    requireStringMap(record.headers, `MCP server "${name}" headers`);
  if (
    record.connect !== undefined &&
    !["lazy", "prewarm", "disabled"].includes(String(record.connect))
  ) {
    throw new Error(`MCP server "${name}" has an unsupported connect mode.`);
  }
  validatePositiveNumber(
    record.startupTimeoutMs,
    `MCP server "${name}" startupTimeoutMs`,
  );
  validatePositiveNumber(
    record.requestTimeoutMs,
    `MCP server "${name}" requestTimeoutMs`,
  );
  if (record.auth !== undefined) {
    const auth = requireRecord(record.auth, `MCP server "${name}" auth`);
    const authKeys = new Set([
      "type",
      "clientId",
      "authorizationUrl",
      "tokenUrl",
      "scopes",
      "redirectPort",
    ]);
    assertNoUnknownKeys(auth, authKeys, `MCP server "${name}" auth`);
    if (auth.type !== "oauth2")
      throw new Error(`MCP server "${name}" auth type must be oauth2.`);
    for (const key of ["clientId", "authorizationUrl", "tokenUrl"] as const) {
      if (auth[key] !== undefined && typeof auth[key] !== "string") {
        throw new Error(`MCP server "${name}" auth.${key} must be a string.`);
      }
    }
    if (auth.scopes !== undefined)
      requireStringArray(auth.scopes, `MCP server "${name}" auth.scopes`);
    validatePositiveNumber(
      auth.redirectPort,
      `MCP server "${name}" auth.redirectPort`,
    );
  }
  return structuredClone(record as McpServerConfig);
}

export function parseMcpIntegrationDocument(
  value: unknown,
): McpIntegrationDocument {
  const record = requireRecord(value, "MCP integration config");
  assertNoUnknownKeys(
    record,
    new Set(["version", "servers"]),
    "MCP integration config",
  );
  requireVersionOne(record, "MCP integration config");
  const rawServers = requireRecord(
    record.servers,
    "MCP integration config servers",
  );
  const servers: McpServersConfig = {};
  for (const [name, server] of Object.entries(rawServers)) {
    servers[name] = parseMcpServer(name, server);
  }
  return { version: 1, servers };
}

export function parseExtensionsIntegrationDocument(
  value: unknown,
): ExtensionsIntegrationDocument {
  const record = requireRecord(value, "Extensions integration config");
  assertNoUnknownKeys(
    record,
    new Set(["version", "paths"]),
    "Extensions integration config",
  );
  requireVersionOne(record, "Extensions integration config");
  const paths = requireStringArray(
    record.paths,
    "Extensions integration config paths",
  );
  if (new Set(paths).size !== paths.length) {
    throw new Error(
      "Extensions integration config paths must not contain duplicates.",
    );
  }
  return { version: 1, paths };
}

export function resolveIntegrationConfigPath(
  domain: IntegrationDomain,
  configHome: string,
): string {
  return path.join(
    path.resolve(configHome),
    "integrations",
    DOMAIN_FILENAMES[domain],
  );
}

function coreConfigPath(configHome: string): string {
  return path.join(path.resolve(configHome), "config.json");
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function readJsonFile(file: string): {
  readonly raw: string;
  readonly value: unknown;
} {
  const raw = readFileSync(file, "utf8");
  try {
    return { raw, value: JSON.parse(raw) as unknown };
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON: ${reason}`);
  }
}

function snapshot<T extends object>(input: {
  readonly domain: IntegrationDomain;
  readonly source: IntegrationConfigSource;
  readonly path: string;
  readonly raw: string;
  readonly document: T;
}): IntegrationConfigSnapshot<T> {
  return {
    domain: input.domain,
    source: input.source,
    path: input.path,
    revision: hashText(input.raw),
    document: structuredClone(input.document),
    loadedAt: new Date().toISOString(),
  };
}

function readCoreConfig(configHome: string): Record<string, unknown> {
  return readCoreConfigFile(coreConfigPath(configHome));
}

export function readMcpIntegration(
  configHome: string,
): IntegrationConfigSnapshot<McpIntegrationDocument> {
  const file = resolveIntegrationConfigPath("mcp", configHome);
  if (existsSync(file)) {
    const parsed = readJsonFile(file);
    return snapshot({
      domain: "mcp",
      source: "user",
      path: file,
      raw: parsed.raw,
      document: parseMcpIntegrationDocument(parsed.value),
    });
  }
  const coreFile = coreConfigPath(configHome);
  const legacy = readCoreConfig(configHome).mcpServers;
  const document = parseMcpIntegrationDocument({
    version: 1,
    servers: legacy === undefined ? {} : legacy,
  });
  return snapshot({
    domain: "mcp",
    source: legacy === undefined ? "default" : "legacy-user",
    path: legacy === undefined ? file : coreFile,
    raw: JSON.stringify(document),
    document,
  });
}

export function readExtensionsIntegration(
  configHome: string,
): IntegrationConfigSnapshot<ExtensionsIntegrationDocument> {
  const file = resolveIntegrationConfigPath("extensions", configHome);
  if (existsSync(file)) {
    const parsed = readJsonFile(file);
    return snapshot({
      domain: "extensions",
      source: "user",
      path: file,
      raw: parsed.raw,
      document: parseExtensionsIntegrationDocument(parsed.value),
    });
  }
  const coreFile = coreConfigPath(configHome);
  const legacy = readCoreConfig(configHome).extensions;
  const document = parseExtensionsIntegrationDocument({
    version: 1,
    paths: legacy === undefined ? [] : legacy,
  });
  return snapshot({
    domain: "extensions",
    source: legacy === undefined ? "default" : "legacy-user",
    path: legacy === undefined ? file : coreFile,
    raw: JSON.stringify(document),
    document,
  });
}

function likelySecretWarnings(servers: unknown): readonly string[] {
  if (!isRecord(servers)) return [];
  const warnings: string[] = [];
  const secretName = /(token|secret|password|api[_-]?key|authorization)/i;
  for (const [serverName, rawServer] of Object.entries(servers)) {
    if (!isRecord(rawServer)) continue;
    for (const field of ["env", "headers"] as const) {
      const values = rawServer[field];
      if (!isRecord(values)) continue;
      for (const [name, value] of Object.entries(values)) {
        if (
          secretName.test(name) &&
          typeof value === "string" &&
          !value.startsWith("${env:")
        ) {
          warnings.push(
            `MCP server "${serverName}" ${field}.${name} may contain a literal secret.`,
          );
        }
      }
    }
  }
  return warnings;
}

export function planLegacyIntegrationMigration(
  configHome: string,
): LegacyIntegrationMigrationPlan {
  const core = readCoreConfig(configHome);
  const mcpDestination = resolveIntegrationConfigPath("mcp", configHome);
  const extensionDestination = resolveIntegrationConfigPath(
    "extensions",
    configHome,
  );
  const legacyServers = core.mcpServers;
  const legacyExtensions = core.extensions;
  const mcpEntries = isRecord(legacyServers)
    ? Object.keys(legacyServers).length
    : 0;
  const extensionEntries = Array.isArray(legacyExtensions)
    ? legacyExtensions.length
    : 0;
  const domainPlan = (
    destination: string,
    entries: number,
    present: boolean,
  ): LegacyIntegrationMigrationDomainPlan =>
    existsSync(destination)
      ? { action: "none", entries, destination, reason: "destination-exists" }
      : present
        ? { action: "create", entries, destination }
        : { action: "none", entries: 0, destination, reason: "legacy-absent" };
  return {
    mcp: domainPlan(mcpDestination, mcpEntries, legacyServers !== undefined),
    extensions: domainPlan(
      extensionDestination,
      extensionEntries,
      legacyExtensions !== undefined,
    ),
    warnings: likelySecretWarnings(legacyServers),
  };
}

function writeCoreConfigAtomically(
  configHome: string,
  config: Record<string, unknown>,
): void {
  const file = coreConfigPath(configHome);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    publishCoreConfig(file, `${JSON.stringify(config, null, 2)}\n`);
  } catch (error: unknown) {
    throw new Error("Failed to atomically clean legacy integration fields.", {
      cause: error,
    });
  }
}

export function migrateLegacyIntegrationConfig(input: {
  readonly configHome: string;
  readonly cleanupLegacy?: boolean;
}): LegacyIntegrationMigrationResult {
  return withCoreConfigWriteLock(coreConfigPath(input.configHome), () =>
    migrateLegacyIntegrationConfigUnlocked(input),
  );
}

function migrateLegacyIntegrationConfigUnlocked(input: {
  readonly configHome: string;
  readonly cleanupLegacy?: boolean;
}): LegacyIntegrationMigrationResult {
  const plan = planLegacyIntegrationMigration(input.configHome);
  const core = readCoreConfig(input.configHome);
  const mcpDocument =
    plan.mcp.action === "create"
      ? parseMcpIntegrationDocument({
          version: 1,
          servers: isRecord(core.mcpServers) ? core.mcpServers : {},
        })
      : undefined;
  const extensionsDocument =
    plan.extensions.action === "create"
      ? parseExtensionsIntegrationDocument({
          version: 1,
          paths: Array.isArray(core.extensions) ? core.extensions : [],
        })
      : undefined;
  const applied: ("mcp" | "extensions")[] = [];
  if (mcpDocument) {
    try {
      writeIntegrationDocument({
        domain: "mcp",
        configHome: input.configHome,
        expectedRevision: null,
        document: mcpDocument,
        validate: parseMcpIntegrationDocument,
      });
      applied.push("mcp");
    } catch (error) {
      if (!(error instanceof IntegrationConfigConflictError)) throw error;
    }
  }
  if (extensionsDocument) {
    try {
      writeIntegrationDocument({
        domain: "extensions",
        configHome: input.configHome,
        expectedRevision: null,
        document: extensionsDocument,
        validate: parseExtensionsIntegrationDocument,
      });
      applied.push("extensions");
    } catch (error) {
      if (!(error instanceof IntegrationConfigConflictError)) throw error;
    }
  }
  let cleanedLegacy = false;
  if (input.cleanupLegacy && existsSync(coreConfigPath(input.configHome))) {
    const next = { ...core };
    if (existsSync(plan.mcp.destination)) delete next.mcpServers;
    if (existsSync(plan.extensions.destination)) delete next.extensions;
    if (!isDeepStrictEqualForConfig(core, next)) {
      writeCoreConfigAtomically(input.configHome, next);
      cleanedLegacy = true;
    }
  }
  return { ...plan, applied, cleanedLegacy };
}

function isDeepStrictEqualForConfig(
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function currentUserRevision(file: string): string | undefined {
  return existsSync(file) ? hashText(readFileSync(file, "utf8")) : undefined;
}

export function writeIntegrationDocument<T extends object>(input: {
  readonly domain: IntegrationDomain;
  readonly configHome: string;
  readonly document: T;
  readonly validate: IntegrationDocumentValidator<T>;
  /** `null` means the destination must still be absent when committed. */
  readonly expectedRevision?: string | null;
}): IntegrationConfigSnapshot<T> {
  const file = resolveIntegrationConfigPath(input.domain, input.configHome);
  const document = input.validate(input.document);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  return withConfigWriteLock(file, `${file}.lock`, () => {
    const actualRevision = currentUserRevision(file);
    const expectedRevision =
      input.expectedRevision === null ? undefined : input.expectedRevision;
    if (
      input.expectedRevision !== undefined &&
      actualRevision !== expectedRevision
    ) {
      throw new IntegrationConfigConflictError(
        file,
        expectedRevision,
        actualRevision,
      );
    }
    const raw = `${JSON.stringify(document, null, 2)}\n`;
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    const temporaryFd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(temporaryFd, raw, "utf8");
      fsyncSync(temporaryFd);
    } finally {
      closeSync(temporaryFd);
    }
    try {
      if (input.expectedRevision === null) {
        linkSync(temporary, file);
        unlinkSync(temporary);
      } else {
        renameSync(temporary, file);
      }
    } catch (error: unknown) {
      if (existsSync(temporary)) unlinkSync(temporary);
      if (input.expectedRevision === null && existsSync(file)) {
        throw new IntegrationConfigConflictError(
          file,
          undefined,
          currentUserRevision(file),
        );
      }
      throw new Error(`Failed to atomically replace ${path.basename(file)}.`, {
        cause: error,
      });
    }
    return snapshot({
      domain: input.domain,
      source: "user",
      path: file,
      raw,
      document,
    });
  });
}

function metadataSignature(file: string): string {
  if (!existsSync(file)) return "missing";
  const stats = statSync(file);
  return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}`;
}

function observationSignature(files: readonly string[]): string {
  return files.map((file) => `${file}:${metadataSignature(file)}`).join("|");
}

function safeDiagnostic(
  code: IntegrationConfigDiagnostic["code"],
  message: string,
): IntegrationConfigDiagnostic {
  return {
    code,
    message,
    time: new Date().toISOString(),
  };
}

export class IntegrationConfigController<T extends object> {
  readonly #domain: IntegrationDomain;
  readonly #path: string;
  readonly #fallbackPath: string | undefined;
  readonly #observedPaths: readonly string[];
  readonly #read: () => IntegrationConfigSnapshot<T>;
  readonly #validate: IntegrationDocumentValidator<T>;
  readonly #coldStartDefault: T | undefined;
  #active: IntegrationConfigSnapshot<T> | undefined;
  #diagnostic: IntegrationConfigDiagnostic | undefined;
  #diagnosticPath: string | undefined;
  #diagnosticSource: IntegrationConfigSource | undefined;
  #observedMetadata = "";
  readonly #watchers: FSWatcher[] = [];
  #watchTimer: ReturnType<typeof setTimeout> | undefined;
  #fallbackTimer: ReturnType<typeof setInterval> | undefined;
  #reloadTail: Promise<void> = Promise.resolve();
  readonly #listeners = new Set<IntegrationConfigListener<T>>();

  constructor(options: {
    readonly domain: IntegrationDomain;
    readonly configHome: string;
    readonly validate: IntegrationDocumentValidator<T>;
    readonly read: () => IntegrationConfigSnapshot<T>;
    /**
     * Optional legacy source consulted only while the split domain file is
     * absent. It participates in both filesystem watching and polling.
     */
    readonly fallbackPath?: string;
    /**
     * Explicit fail-closed document used only when the first disk read is
     * invalid. The diagnostic remains visible and a later valid file replaces
     * this snapshot through the normal reload path.
     */
    readonly coldStartDefault?: T;
  }) {
    this.#domain = options.domain;
    this.#path = resolveIntegrationConfigPath(
      options.domain,
      options.configHome,
    );
    this.#fallbackPath =
      options.fallbackPath === undefined
        ? undefined
        : path.resolve(options.fallbackPath);
    this.#observedPaths =
      this.#fallbackPath === undefined
        ? [this.#path]
        : [this.#path, this.#fallbackPath];
    this.#validate = options.validate;
    this.#read = options.read;
    this.#coldStartDefault =
      options.coldStartDefault === undefined
        ? undefined
        : structuredClone(this.#validate(options.coldStartDefault));
  }

  async initialize(): Promise<IntegrationConfigSnapshot<T>> {
    const result = await this.reload();
    if (!result.ok && !this.#active && this.#coldStartDefault !== undefined) {
      const document = structuredClone(this.#coldStartDefault);
      this.#active = snapshot({
        domain: this.#domain,
        source: "default",
        path: this.#path,
        raw: JSON.stringify(document),
        document,
      });
    }
    if (!this.#active) {
      throw new Error(
        result.ok
          ? "Integration configuration did not produce a snapshot."
          : result.error,
      );
    }
    return structuredClone(this.#active);
  }

  snapshot(): IntegrationConfigSnapshot<T> | undefined {
    return this.#active ? structuredClone(this.#active) : undefined;
  }

  status(): IntegrationConfigStatus {
    const diagnosticPath = this.#diagnostic ? this.#diagnosticPath : undefined;
    const diagnosticSource = this.#diagnostic
      ? this.#diagnosticSource
      : undefined;
    return {
      domain: this.#domain,
      path: diagnosticPath ?? this.#active?.path ?? this.#path,
      ...(this.#active
        ? {
            revision: this.#active.revision,
            lastReloadAt: this.#active.loadedAt,
          }
        : {}),
      ...((diagnosticSource ?? this.#active?.source)
        ? { source: diagnosticSource ?? this.#active?.source }
        : {}),
      ...(this.#diagnostic ? { diagnostic: this.#diagnostic } : {}),
      watching: this.#watchers.length > 0,
    };
  }

  subscribe(listener: IntegrationConfigListener<T>): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  reload(): Promise<IntegrationReloadResult<T>> {
    const pending = this.#reloadTail.then(() => this.#reloadNow());
    this.#reloadTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  async #reloadNow(): Promise<IntegrationReloadResult<T>> {
    this.#observedMetadata = observationSignature(this.#observedPaths);
    let candidate: IntegrationConfigSnapshot<T>;
    try {
      candidate = this.#read();
      this.#validate(candidate.document);
    } catch {
      const failure = this.#failureLocation();
      this.#diagnosticPath = failure.path;
      this.#diagnosticSource = failure.source;
      this.#diagnostic = safeDiagnostic(
        "invalid-config",
        "Integration configuration is invalid; check the file against its versioned schema.",
      );
      return { ok: false, error: this.#diagnostic.message };
    }
    const previous = this.#active ? structuredClone(this.#active) : undefined;
    try {
      for (const listener of this.#listeners)
        await listener(structuredClone(candidate), previous);
    } catch {
      this.#diagnosticPath = candidate.path;
      this.#diagnosticSource = candidate.source;
      this.#diagnostic = safeDiagnostic(
        "activation-failed",
        "Integration configuration could not be activated; the previous configuration remains active.",
      );
      return { ok: false, error: this.#diagnostic.message };
    }
    this.#active = candidate;
    this.#diagnostic = undefined;
    this.#diagnosticPath = undefined;
    this.#diagnosticSource = undefined;
    return { ok: true, snapshot: structuredClone(candidate) };
  }

  async ensureCurrent(): Promise<IntegrationReloadResult<T>> {
    if (
      observationSignature(this.#observedPaths) === this.#observedMetadata &&
      this.#active
    ) {
      return { ok: true, snapshot: structuredClone(this.#active) };
    }
    return this.reload();
  }

  startWatching(debounceMs = 100, fallbackMs = 2_000): void {
    if (this.#watchers.length > 0 || this.#fallbackTimer) return;
    mkdirSync(path.dirname(this.#path), { recursive: true, mode: 0o700 });
    const observedByDirectory = new Map<string, Set<string>>();
    for (const file of this.#observedPaths) {
      const directory = path.dirname(file);
      const names = observedByDirectory.get(directory) ?? new Set<string>();
      names.add(path.basename(file));
      observedByDirectory.set(directory, names);
    }
    for (const [directory, names] of observedByDirectory) {
      try {
        const watcher = watch(directory, (_event, filename) => {
          if (filename !== null && !names.has(filename.toString())) return;
          if (this.#watchTimer) clearTimeout(this.#watchTimer);
          this.#watchTimer = setTimeout(() => {
            this.#watchTimer = undefined;
            void this.reload();
          }, debounceMs);
          this.#watchTimer.unref?.();
        });
        // A configuration watcher follows its host lifecycle; it must not keep
        // a CLI or daemon process alive after the owning runtime has stopped.
        watcher.unref();
        watcher.on("error", () => {
          this.#diagnostic = safeDiagnostic(
            "watcher-degraded",
            "Integration watcher is degraded; metadata polling remains active.",
          );
        });
        this.#watchers.push(watcher);
      } catch {
        this.#diagnostic = safeDiagnostic(
          "watcher-degraded",
          "Integration watcher is degraded; metadata polling remains active.",
        );
      }
    }
    this.#fallbackTimer = setInterval(() => {
      void this.ensureCurrent();
    }, fallbackMs);
    this.#fallbackTimer.unref?.();
  }

  close(): void {
    if (this.#watchTimer) clearTimeout(this.#watchTimer);
    this.#watchTimer = undefined;
    if (this.#fallbackTimer) clearInterval(this.#fallbackTimer);
    this.#fallbackTimer = undefined;
    for (const watcher of this.#watchers) watcher.close();
    this.#watchers.length = 0;
    this.#listeners.clear();
  }

  #failureLocation(): {
    readonly path: string;
    readonly source: IntegrationConfigSource;
  } {
    if (existsSync(this.#path)) return { path: this.#path, source: "user" };
    if (this.#fallbackPath && existsSync(this.#fallbackPath)) {
      return { path: this.#fallbackPath, source: "legacy-user" };
    }
    return { path: this.#path, source: "default" };
  }
}
