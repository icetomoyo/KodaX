import fs from "node:fs";
import path from "node:path";

import {
  createAgentExecutorPlane,
  type AgentCredentialBroker,
  type AgentTaskSnapshot,
  type ExternalAgentRegistration,
  type McpServerConfig,
} from "@kodax-ai/agent";
import {
  createExtensionRuntime,
  KODAX_DEFAULT_PROVIDER,
  loadMarkdownAgentScope,
  registerConfiguredMcpCapabilityProvider,
  resolveExtensionEntrypoint,
} from "@kodax-ai/coding";
import {
  IntegrationConfigController,
  KODAX_CONFIG_FILE,
  KODAX_DIR,
  KODAX_EXAMPLE_CONFIG_FILE,
  KODAX_INTEGRATION_EXAMPLE_FILES,
  getConfigTemplate,
  migrateLegacyIntegrationConfig,
  parseExtensionsIntegrationDocument,
  planLegacyIntegrationMigration,
  prepareRuntimeConfig,
  readExtensionsIntegration,
  readMcpIntegration,
  removeMcpServer,
  resolveIntegrationConfigPath,
  resolveRuntimeModelSelection,
  resolveRuntimeProviderSelection,
  upsertMcpServer,
  writeIntegrationDocument,
} from "@kodax-ai/repl";
import type { Command } from "commander";

import {
  migrateA2AIntegrationV1,
  removeA2AOutboundAgent,
  setA2AOutboundAgentEnabled,
  setA2AServerConfig,
  upsertA2AOutboundAgent,
} from "./a2a/config.js";
import {
  classifyA2AServerChange,
  CONFIGURED_A2A_TASK_RESPONSE_BYTES,
  configuredA2AArtifactPolicy,
  createConfiguredA2ARuntimeIntegration,
  createA2AServerHotOptions,
  createA2AServerOptionsFromConfig,
  createA2AAgentExecutorFactory,
  discoverA2ARegistration,
  inspectA2AIntegration,
  migrateA2ALegacyTaskOwners,
  parseA2AIntegrationDocument,
  prepareKodaXA2AServer,
  readA2AIntegration,
  type A2AAgentCard,
  type A2AIntegrationDocument,
  type A2ANetworkPolicy,
  type A2AOutboundEffect,
  type A2AOutboundAgentConfig,
  type A2AServerConfig,
} from "./a2a/index.js";
import { mergeCommandOptionsWithGlobals } from "./cli_option_helpers.js";
import { connectKodaXRuntime, createKodaXRuntime } from "./sdk-runtime.js";
import {
  isRuntimeDaemonPidAlive,
  observeRuntimeDaemonHealth,
} from "./runtime-daemon/lifecycle.js";
import {
  classifyRuntimeDaemonHealth,
  isSameRuntimeDaemonPath,
  readRuntimeDaemonLockOwner,
  readRuntimeDaemonToken,
  resolveRuntimeDaemonPathsFromConfigHome,
} from "./runtime-daemon/state.js";
import {
  doctorSandboxExecution,
  prepareSandboxRuntimeForSetup,
  sandboxRuntimeCapability,
  sandboxSetupGuidance,
} from "./sandbox-runtime.js";

type Output = (value: string) => void;

function stdout(value: string): void {
  process.stdout.write(`${value}\n`);
}

function stderr(value: string): void {
  process.stderr.write(`${value}\n`);
}

function json(value: unknown, output: Output = stdout): void {
  output(JSON.stringify(value, null, 2));
}

async function assertA2AConfigOwnerCompatible(
  configHome = KODAX_DIR,
  requireStopped = false,
): Promise<void> {
  const resolvedConfigHome = path.resolve(configHome);
  const daemonRoot = path.join(resolvedConfigHome, "runtime", "daemon");
  if (!fs.existsSync(daemonRoot)) return;
  const profiles = fs
    .readdirSync(daemonRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  for (const profile of profiles) {
    const paths = resolveRuntimeDaemonPathsFromConfigHome(
      resolvedConfigHome,
      profile,
    );
    const observation = await observeRuntimeDaemonHealth(paths);
    if (fs.existsSync(paths.stateFile) && observation.state === undefined) {
      throw new Error(
        `Daemon profile "${profile}" has unreadable ownership state; clean or restart it before changing A2A configuration.`,
      );
    }
    const state = observation.state;
    if (state === undefined) {
      const lockOwner = readRuntimeDaemonLockOwner(paths.lockFile);
      if (lockOwner && isRuntimeDaemonPidAlive(lockOwner.pid)) {
        throw new Error(
          `Daemon profile "${profile}" is starting without verifiable A2A config ownership; wait for it or stop it before changing A2A configuration.`,
        );
      }
      continue;
    }
    if (state.configHome === undefined) {
      throw new Error(
        `Running or stale daemon profile "${profile}" does not declare its A2A config home; restart or clean it with the current KodaX version before changing A2A configuration.`,
      );
    }
    if (!isSameRuntimeDaemonPath(state.configHome, resolvedConfigHome)) {
      throw new Error(
        `Daemon profile "${profile}" declares a different A2A config home; refuse to mutate ambiguous ownership state.`,
      );
    }
    const health = classifyRuntimeDaemonHealth(observation);
    if (
      requireStopped &&
      (health === "healthy" ||
        observation.pidAlive ||
        observation.endpointReachable)
    ) {
      throw new Error(
        `Daemon profile "${profile}" is still running; stop every daemon before explicitly migrating A2A config version 1.`,
      );
    }
    if (health === "stale" || health === "missing") continue;
    if (health !== "healthy") {
      throw new Error(
        `Daemon profile "${profile}" ownership cannot be verified; stop or restart it before changing A2A configuration.`,
      );
    }
    try {
      const runtime = await connectKodaXRuntime({
        profile,
        endpoint: state.endpoint,
        daemonToken: readRuntimeDaemonToken(paths),
        autoStart: false,
        requirements: { externalAgentAdmin: 1, a2aConfigReconciler: 1 },
      });
      await runtime.close();
    } catch (error: unknown) {
      throw new Error(
        `Running daemon profile "${profile}" cannot safely apply A2A config version 2; restart it with the current KodaX version before changing A2A configuration.`,
        { cause: error },
      );
    }
  }
}

function repeat(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function parseEffect(value: string): A2AOutboundEffect {
  if (!["none", "read", "write", "unknown"].includes(value))
    throw new Error("A2A effect must be none, read, write, or unknown.");
  return value as A2AOutboundEffect;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
    throw new Error("A2A port must be 1-65535.");
  return port;
}

function privateAllowed(url: URL, explicit: boolean): boolean {
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return explicit || ["localhost", "127.0.0.1", "::1"].includes(hostname);
}

function assertLoopbackHostname(hostname: string): void {
  if (!["localhost", "127.0.0.1", "::1"].includes(hostname.toLowerCase())) {
    throw new Error(
      "The built-in A2A listener is loopback-only; use a reverse proxy for remote access.",
    );
  }
}

function networkPolicy(
  origins: readonly string[],
  allowPrivateAddresses: boolean,
  allowInsecureHttp = false,
): A2ANetworkPolicy {
  return {
    allowedOrigins: [...new Set(origins)],
    allowPrivateAddresses,
    allowInsecureHttp,
    requestTimeoutMs: 15_000,
    maxResponseBytes: 2_097_152,
    maxRedirects: 3,
  };
}

interface A2ANetworkOverrides {
  readonly allowPrivate?: boolean;
  readonly allowInsecureHttp?: boolean;
}

function configuredNetworkAccess(
  config: A2AOutboundAgentConfig,
  overrides: A2ANetworkOverrides,
): {
  readonly allowPrivateAddresses: boolean;
  readonly allowInsecureHttp: boolean;
} {
  return {
    allowPrivateAddresses:
      config.network?.allowPrivateAddresses === true ||
      overrides.allowPrivate === true,
    allowInsecureHttp:
      config.network?.allowInsecureHttp === true ||
      overrides.allowInsecureHttp === true,
  };
}

function configuredRegistrationInput(
  name: string,
  config: A2AOutboundAgentConfig,
) {
  return {
    agentId: `external:${name}`,
    agentCardUrl: config.cardUrl,
    ...(config.credentialEnv
      ? { credentialRef: `env:${config.credentialEnv}` }
      : {}),
    ...(config.authentication
      ? {
          authentication: {
            type: "oauth2-client-credentials" as const,
            scheme: config.authentication.scheme,
            issuer: config.authentication.issuer,
            tokenUrl: config.authentication.tokenUrl,
            clientId: config.authentication.clientId,
            clientSecretRef: `env:${config.authentication.clientSecretEnv}`,
            scopes: config.authentication.scopes,
            ...(config.authentication.resource
              ? { resource: config.authentication.resource }
              : {}),
            clientAuthentication: config.authentication.clientAuthentication,
          },
        }
      : {}),
    effects: { remote: config.effect },
  } as const;
}

async function discoverConfiguredAgent(
  name: string,
  overrides: A2ANetworkOverrides,
  requireEnabled = false,
): Promise<{
  readonly config: A2AIntegrationDocument["agents"][string];
  readonly card: A2AAgentCard;
  readonly registration: ExternalAgentRegistration;
}> {
  const config = readA2AIntegration(KODAX_DIR).document.agents[name];
  if (!config) throw new Error(`Unknown configured A2A Agent: ${name}.`);
  if (requireEnabled && !config.enabled)
    throw new Error(`Configured A2A Agent is disabled: ${name}.`);
  const cardUrl = new URL(config.cardUrl);
  const access = configuredNetworkAccess(config, overrides);
  const discovered = await discoverA2ARegistration(
    configuredRegistrationInput(name, config),
    {
      networkPolicy: networkPolicy(
        [cardUrl.origin],
        privateAllowed(cardUrl, access.allowPrivateAddresses),
        access.allowInsecureHttp,
      ),
      pollIntervalMs: 500,
    },
  );
  return {
    config,
    card: discovered.agentCard,
    registration: discovered.registration,
  };
}

function environmentCredentialBroker(): AgentCredentialBroker {
  const environmentName = (reference: string): string => {
    if (!reference.startsWith("env:") || reference.length === 4) {
      throw new Error(
        "Configured A2A credentials must use an environment reference.",
      );
    }
    return reference.slice(4);
  };
  return {
    isAvailable(reference) {
      const value = process.env[environmentName(reference)];
      return typeof value === "string" && value.length > 0;
    },
    async withCredential(reference, use) {
      const value = process.env[environmentName(reference)];
      if (!value) throw new Error("Configured A2A credential is unavailable.");
      return use(value);
    },
  };
}

function registrationInterfaceUrl(
  registration: ExternalAgentRegistration,
): URL {
  const value = registration.executorConfig?.interfaceUrl;
  if (typeof value !== "string")
    throw new Error("Configured A2A registration has no interface URL.");
  return new URL(value);
}

async function waitForA2ATask(
  getTask: () => Promise<AgentTaskSnapshot>,
): Promise<AgentTaskSnapshot> {
  let task = await getTask();
  while (task.state === "submitted" || task.state === "working") {
    await new Promise((resolve) => setTimeout(resolve, 50));
    task = await getTask();
  }
  return task;
}

async function callConfiguredAgent(
  name: string,
  prompt: string,
  overrides: A2ANetworkOverrides,
): Promise<AgentTaskSnapshot> {
  const { config, registration } = await discoverConfiguredAgent(
    name,
    overrides,
    true,
  );
  const access = configuredNetworkAccess(config, overrides);
  const cardUrl = new URL(config.cardUrl);
  const plane = await createAgentExecutorPlane({
    factories: [
      createA2AAgentExecutorFactory((active) => {
        const endpointUrl = registrationInterfaceUrl(active);
        const tokenUrl = config.authentication
          ? new URL(config.authentication.tokenUrl)
          : undefined;
        return {
          networkPolicy: networkPolicy(
            [
              cardUrl.origin,
              endpointUrl.origin,
              ...(tokenUrl ? [tokenUrl.origin] : []),
            ],
            privateAllowed(endpointUrl, access.allowPrivateAddresses) &&
              (tokenUrl === undefined ||
                privateAllowed(tokenUrl, access.allowPrivateAddresses)),
            access.allowInsecureHttp,
          ),
          maxTaskResponseBytes: CONFIGURED_A2A_TASK_RESPONSE_BYTES,
          pollIntervalMs: 500,
        };
      }),
    ],
    policy: () => ({ allowed: true }),
    credentialBroker: environmentCredentialBroker(),
    artifactPolicy: configuredA2AArtifactPolicy,
  });
  try {
    await plane.registrations.upsert(registration);
    const started = await plane.tasks.start({
      agentId: registration.agentId,
      objective: prompt,
      input: prompt,
      context: { actorId: "kodax-cli" },
      readOnly: config.effect === "none" || config.effect === "read",
    });
    return await waitForA2ATask(() => plane.tasks.get(started.taskId));
  } finally {
    await plane.close();
  }
}

function configureConfigCommands(program: Command): void {
  const config = program
    .command("config")
    .description("Inspect canonical KodaX configuration templates");
  config
    .command("template [domain]")
    .description("Print the canonical core, mcp, a2a, or extensions template")
    .action((domain = "core") => {
      if (!["core", "mcp", "a2a", "extensions"].includes(domain))
        throw new Error("Unknown template domain.");
      stdout(
        getConfigTemplate(
          domain as "core" | "mcp" | "a2a" | "extensions",
        ).trimEnd(),
      );
    });
  config
    .command("paths")
    .description("Print active and example configuration paths")
    .action(() =>
      json({
        home: KODAX_DIR,
        core: KODAX_CONFIG_FILE,
        integrations: {
          mcp: resolveIntegrationConfigPath("mcp", KODAX_DIR),
          extensions: resolveIntegrationConfigPath("extensions", KODAX_DIR),
          a2a: resolveIntegrationConfigPath("a2a", KODAX_DIR),
        },
        coreExample: KODAX_EXAMPLE_CONFIG_FILE,
        integrationExamples: KODAX_INTEGRATION_EXAMPLE_FILES,
      }),
    );
}

interface IntegrationDiskStatus {
  readonly domain: "mcp" | "a2a" | "extensions";
  readonly path: string;
  readonly state: "valid" | "invalid";
  readonly source?: "user" | "legacy-user" | "default";
  readonly revision?: string;
  readonly loadedAt?: string;
  readonly diagnostic?: string;
}

function integrationStatus(): readonly IntegrationDiskStatus[] {
  const domains = [
    {
      domain: "mcp" as const,
      read: () => readMcpIntegration(KODAX_DIR),
      fallbackPath: KODAX_CONFIG_FILE,
    },
    {
      domain: "a2a" as const,
      read: () => readA2AIntegration(KODAX_DIR),
      fallbackPath: undefined,
    },
    {
      domain: "extensions" as const,
      read: () => readExtensionsIntegration(KODAX_DIR),
      fallbackPath: KODAX_CONFIG_FILE,
    },
  ];
  return domains.map(({ domain, read, fallbackPath }) => {
    const configPath = resolveIntegrationConfigPath(domain, KODAX_DIR);
    try {
      const snapshot = read();
      return {
        domain,
        path: snapshot.path,
        state: "valid" as const,
        source: snapshot.source,
        revision: snapshot.revision,
        loadedAt: snapshot.loadedAt,
      };
    } catch {
      const usesLegacySource =
        !fs.existsSync(configPath) &&
        fallbackPath !== undefined &&
        fs.existsSync(fallbackPath);
      return {
        domain,
        path: usesLegacySource ? fallbackPath : configPath,
        state: "invalid" as const,
        source: usesLegacySource ? ("legacy-user" as const) : ("user" as const),
        diagnostic:
          "Integration configuration is invalid; check the file against its versioned schema.",
      };
    }
  });
}

function configureIntegrationManagement(program: Command): void {
  const integrations = program
    .command("integrations")
    .description("Validate, migrate, and inspect split integration config");
  integrations.command("status").action(() => json(integrationStatus()));
  integrations.command("validate").action(() => {
    const domains = integrationStatus();
    json({ ok: domains.every((domain) => domain.state === "valid"), domains });
  });
  integrations
    .command("reload")
    .description(
      "Validate current disk snapshots; running hosts watch independently",
    )
    .action(() => {
      const domains = integrationStatus();
      json({
        ok: domains.every((domain) => domain.state === "valid"),
        domains,
      });
    });
  integrations
    .command("migrate")
    .option("--apply", "Create missing split files")
    .option(
      "--cleanup-legacy",
      "Remove migrated legacy fields from config.json",
    )
    .action((options: { apply?: boolean; cleanupLegacy?: boolean }) => {
      if (options.cleanupLegacy && !options.apply) {
        throw new Error("--cleanup-legacy requires --apply.");
      }
      const result = options.apply
        ? migrateLegacyIntegrationConfig({
            configHome: KODAX_DIR,
            cleanupLegacy: options.cleanupLegacy === true,
          })
        : planLegacyIntegrationMigration(KODAX_DIR);
      json(result);
    });
}

function configureMcpCommands(program: Command): void {
  const mcp = program
    .command("mcp")
    .description("Manage MCP servers in integrations/mcp.json");
  mcp
    .command("list")
    .action(() => json(readMcpIntegration(KODAX_DIR).document.servers));
  mcp
    .command("add <name>")
    .option("--command <command>", "stdio command")
    .option("--arg <value>", "stdio argument (repeatable)", repeat, [])
    .option("--cwd <dir>", "stdio working directory")
    .option("--url <url>", "HTTP/SSE endpoint")
    .option("--transport <type>", "stdio, sse, http, or streamable-http")
    .option("--connect <mode>", "lazy, prewarm, or disabled", "lazy")
    .action(
      (
        name: string,
        options: {
          command?: string;
          arg: string[];
          cwd?: string;
          url?: string;
          transport?: string;
          connect: string;
        },
      ) => {
        if (Boolean(options.command) === Boolean(options.url))
          throw new Error("Choose exactly one of --command or --url.");
        const server: McpServerConfig = options.command
          ? {
              type: "stdio",
              command: options.command,
              args: options.arg,
              ...(options.cwd ? { cwd: path.resolve(options.cwd) } : {}),
              connect: options.connect as "lazy",
            }
          : {
              type: (options.transport ??
                "streamable-http") as "streamable-http",
              url: options.url!,
              connect: options.connect as "lazy",
            };
        json({ name, config: upsertMcpServer(name, server) });
      },
    );
  mcp
    .command("remove <name>")
    .action((name: string) => json({ name, removed: removeMcpServer(name) }));
}

async function writeExtensions(paths: readonly string[]): Promise<void> {
  const current = readExtensionsIntegration(KODAX_DIR);
  writeIntegrationDocument({
    domain: "extensions",
    configHome: KODAX_DIR,
    ...(current.source === "user"
      ? { expectedRevision: current.revision }
      : {}),
    document: { version: 1, paths },
    validate: parseExtensionsIntegrationDocument,
  });
}

async function validateExtensions(paths: readonly string[]): Promise<void> {
  const runtime = createExtensionRuntime();
  try {
    await runtime.loadExtensions([...paths], {
      continueOnError: false,
      loadSource: "config",
    });
  } finally {
    await runtime.dispose();
  }
}

async function createA2AServerExtensionRuntime(): Promise<
  ReturnType<typeof createExtensionRuntime>
> {
  const runtime = createExtensionRuntime();
  try {
    await registerConfiguredMcpCapabilityProvider(
      runtime,
      readMcpIntegration(KODAX_DIR).document.servers,
    );
    await runtime.loadExtensions(
      [...readExtensionsIntegration(KODAX_DIR).document.paths],
      { continueOnError: true, loadSource: "config" },
    );
    runtime.activate();
    return runtime;
  } catch (error: unknown) {
    await runtime.dispose();
    throw error;
  }
}

function configureExtensionCommands(program: Command): void {
  const extensions = program
    .command("extensions")
    .description("Manage extensions in integrations/extensions.json");
  extensions
    .command("list")
    .action(() => json(readExtensionsIntegration(KODAX_DIR).document.paths));
  extensions
    .command("add <extensionPath>")
    .action(async (extensionPath: string) => {
      const resolved = await resolveExtensionEntrypoint(
        path.resolve(extensionPath),
      );
      await validateExtensions([resolved]);
      const current = readExtensionsIntegration(KODAX_DIR).document.paths;
      if (!current.includes(resolved))
        await writeExtensions([...current, resolved]);
      json({ added: resolved });
    });
  extensions
    .command("remove <extensionPath>")
    .action(async (extensionPath: string) => {
      let resolved = path.resolve(extensionPath);
      try {
        resolved = await resolveExtensionEntrypoint(resolved);
      } catch {
        /* Removing a missing exact path remains valid. */
      }
      const current = readExtensionsIntegration(KODAX_DIR).document.paths;
      const next = current.filter((item) => path.resolve(item) !== resolved);
      await writeExtensions(next);
      json({ removed: current.length !== next.length, path: resolved });
    });
  extensions
    .command("reload")
    .description("Validate the complete candidate set atomically")
    .action(async () => {
      const paths = readExtensionsIntegration(KODAX_DIR).document.paths;
      await validateExtensions(paths);
      json({ ok: true, validated: paths.length });
    });
}

function groupPairs(
  values: readonly string[],
  label: string,
): Record<string, readonly string[]> {
  const result: Record<string, string[]> = {};
  for (const value of values) {
    const separator = value.indexOf(":");
    if (separator < 1 || separator === value.length - 1)
      throw new Error(`${label} must use name:value.`);
    const name = value.slice(0, separator);
    const item = value.slice(separator + 1);
    result[name] = [...(result[name] ?? []), item];
  }
  return result;
}

function configureA2AExpose(command: Command, version: string): void {
  command
    .command("expose [agent]")
    .description(
      "Publish the Runtime default Agent or one ~/.kodax/agents Markdown Agent",
    )
    .option("--name <name>", "Public Agent Card name", "KodaX Agent")
    .option(
      "--description <text>",
      "Public Agent Card description",
      "Completes approved general tasks.",
    )
    .option("--auth <type>", "bearer-env or oauth2-jwt", "bearer-env")
    .option(
      "--token-env <name>",
      "Bearer token environment variable",
      "KODAX_A2A_TOKEN",
    )
    .option(
      "--principal <id>",
      "Authenticated principal id",
      "configured-client",
    )
    .option("--oauth-scheme <name>", "Published OAuth2 security scheme name")
    .option("--oauth-issuer <url>", "Trusted access-token issuer")
    .option("--oauth-audience <value>", "Expected access-token audience")
    .option("--oauth-jwks-url <url>", "Issuer JWKS endpoint")
    .option(
      "--oauth-token-url <url>",
      "Published client-credentials token endpoint",
    )
    .option("--oauth-metadata-url <url>", "Published RFC 8414 metadata URL")
    .option(
      "--required-scope <scope>",
      "Required OAuth2 scope (repeatable)",
      repeat,
      [],
    )
    .option("--workspace-mode <mode>", "managed or fixed", "managed")
    .option("--workspace-root <path>", "Absolute root for fixed mode")
    .option("--workspace-access <mode>", "none, read, or write")
    .option(
      "--tool <name>",
      "Exact narrow Extension Tool (repeatable)",
      repeat,
      [],
    )
    .option(
      "--mcp <server:capability>",
      "Exact MCP tool admission (repeatable)",
      repeat,
      [],
    )
    .option(
      "--skill-script <skill:scripts/path>",
      "Exact isolated Skill script (repeatable)",
      repeat,
      [],
    )
    .option(
      "--network-origin <origin>",
      "Exact script network origin (repeatable)",
      repeat,
      [],
    )
    .option(
      "--public-base-url <url>",
      "HTTPS public URL when served behind a reverse proxy",
    )
    .option("--data-dir <dir>", "Durable task store", "~/.kodax/a2a/tasks")
    .action(
      async (
        agent: string | undefined,
        options: {
          name: string;
          description: string;
          auth: string;
          tokenEnv: string;
          principal: string;
          oauthScheme?: string;
          oauthIssuer?: string;
          oauthAudience?: string;
          oauthJwksUrl?: string;
          oauthTokenUrl?: string;
          oauthMetadataUrl?: string;
          requiredScope: string[];
          workspaceMode: string;
          workspaceRoot?: string;
          workspaceAccess?: string;
          tool: string[];
          mcp: string[];
          skillScript: string[];
          networkOrigin: string[];
          publicBaseUrl?: string;
          dataDir: string;
        },
      ) => {
        if (agent) {
          const scope = await loadMarkdownAgentScope({
            cwd: process.cwd(),
            configHome: KODAX_DIR,
            userOnly: true,
          });
          try {
            const loaded = scope.loaded.some(
              (entry) =>
                entry.name === agent && entry.source === "markdown:user",
            );
            if (!loaded) {
              const failure = scope.failed.find(
                (entry) => path.basename(entry.path, ".md") === agent,
              );
              throw new Error(
                failure?.reason ?? `User Markdown Agent not found: ${agent}`,
              );
            }
          } finally {
            scope.dispose();
          }
        }
        if (!["managed", "fixed"].includes(options.workspaceMode))
          throw new Error("workspace-mode must be managed or fixed.");
        if (options.workspaceMode === "fixed" && !options.workspaceRoot)
          throw new Error("--workspace-root is required for fixed mode.");
        const workspace =
          options.workspaceMode === "managed"
            ? { mode: "managed" as const }
            : {
                mode: "fixed" as const,
                root: path.resolve(options.workspaceRoot!),
              };
        const workspaceAccess =
          options.workspaceAccess ??
          (workspace.mode === "managed" ? "write" : "read");
        if (!["none", "read", "write"].includes(workspaceAccess))
          throw new Error("workspace-access must be none, read, or write.");
        const skillScripts = groupPairs(options.skillScript, "skill-script");
        const network =
          options.networkOrigin.length > 0
            ? { mode: "allowlist" as const, origins: options.networkOrigin }
            : { mode: "deny" as const };
        const execution = {
          kind: agent ? ("local-agent" as const) : ("runtime-default" as const),
          ...(agent
            ? { agentRef: { source: "markdown:user" as const, name: agent } }
            : {}),
          workspace,
          toolPolicy: {
            workspace: workspaceAccess,
            process: options.skillScript.length > 0 ? "isolated" : "deny",
            network,
            tools: options.tool,
            mcp: groupPairs(options.mcp, "mcp"),
            skillScripts,
            subagents: "deny",
          },
        };
        const current = readA2AIntegration(KODAX_DIR);
        if (!["bearer-env", "oauth2-jwt"].includes(options.auth)) {
          throw new Error("--auth must be bearer-env or oauth2-jwt.");
        }
        const authentication =
          options.auth === "bearer-env"
            ? {
                type: "bearer-env",
                tokenEnv: options.tokenEnv,
                principalId: options.principal,
              }
            : {
                type: "oauth2-jwt",
                scheme: options.oauthScheme,
                issuer: options.oauthIssuer,
                audience: options.oauthAudience,
                jwksUrl: options.oauthJwksUrl,
                tokenUrl: options.oauthTokenUrl,
                ...(options.oauthMetadataUrl
                  ? { metadataUrl: options.oauthMetadataUrl }
                  : {}),
                requiredScopes: options.requiredScope,
              };
        const parsed = parseA2AIntegrationDocument({
          version: 2,
          agents: current.document.agents,
          server: {
            execution,
            published: {
              name: options.name,
              description: options.description,
              version,
              skills: [
                {
                  id: "general",
                  name: "General",
                  description: options.description,
                  tags: [],
                },
              ],
              inputModes: ["text/plain", "application/json"],
              outputModes: ["text/plain"],
            },
            ...(options.publicBaseUrl
              ? { publicBaseUrl: options.publicBaseUrl }
              : {}),
            authentication,
            dataDir: options.dataDir,
          },
        });
        await assertA2AConfigOwnerCompatible();
        setA2AServerConfig(KODAX_DIR, parsed.server);
        json({
          configured: true,
          server: parsed.server,
          credential:
            options.auth === "bearer-env"
              ? `env:${options.tokenEnv}`
              : "external-oauth2-issuer",
        });
      },
    );
}

async function serveA2A(options: {
  readonly hostname: string;
  readonly port: number;
  readonly profile: string;
  readonly home?: string;
  readonly provider?: string;
  readonly model?: string;
}): Promise<void> {
  assertLoopbackHostname(options.hostname);
  const controller = new IntegrationConfigController<A2AIntegrationDocument>({
    domain: "a2a",
    configHome: KODAX_DIR,
    validate: parseA2AIntegrationDocument,
    read: () => readA2AIntegration(KODAX_DIR),
  });
  const initial = await controller.initialize();
  if (!initial.document.server)
    throw new Error(
      "A2A server is not configured; run kodax a2a expose first.",
    );
  const extensionRuntime = await createA2AServerExtensionRuntime();
  const outboundIntegration = createConfiguredA2ARuntimeIntegration({
    configHome: KODAX_DIR,
  });
  let runtime: Awaited<ReturnType<typeof createKodaXRuntime>> | undefined;
  const requestedBase = `http://${options.hostname.includes(":") ? `[${options.hostname}]` : options.hostname}:${options.port}`;
  let outboundHandle:
    Awaited<ReturnType<typeof outboundIntegration.start>> | undefined;
  let server: Awaited<ReturnType<typeof prepareKodaXA2AServer>> | undefined;
  let applied = initial.document.server;
  try {
    const environmentProvider = process.env.KODAX_PROVIDER;
    const config = prepareRuntimeConfig();
    const defaultProvider = resolveRuntimeProviderSelection({
      explicitProvider: options.provider,
      environmentProvider,
      configuredProvider: config.provider,
      defaultProvider: KODAX_DEFAULT_PROVIDER,
    });
    const defaultModel = resolveRuntimeModelSelection({
      explicitProvider: options.provider,
      environmentProvider,
      explicitModel: options.model,
      configuredProvider: config.provider,
      configuredModel: config.model,
    });
    runtime = await createKodaXRuntime({
      mode: "embedded",
      isolation: "inline",
      profile: options.profile,
      ...(options.home ? { homeDir: path.resolve(options.home) } : {}),
      defaultProvider,
      ...(defaultModel ? { defaultModel } : {}),
      externalAgents: outboundIntegration.runtimeOptions,
    });
    outboundHandle = await outboundIntegration.start(runtime);
    const prepared = await prepareKodaXA2AServer(
      createA2AServerOptionsFromConfig({
        runtime,
        config: initial.document.server,
        listenBaseUrl: requestedBase,
      }),
    );
    server = prepared;
    const baseUrl = await prepared.listen({
      hostname: options.hostname,
      port: options.port,
      ...(initial.document.server.publicBaseUrl
        ? { publicBaseUrl: initial.document.server.publicBaseUrl }
        : {}),
    });
    controller.subscribe((snapshot) => {
      const next = snapshot.document.server;
      const change = classifyA2AServerChange(applied, next);
      if (change.kind === "restart-required" || !next) {
        stderr(
          `[a2a] valid config change pending restart: ${change.fields.join(", ") || "server"}`,
        );
        return;
      }
      if (change.kind === "hot") {
        prepared.updateHot(
          createA2AServerHotOptions({ config: next, listenBaseUrl: baseUrl }),
        );
        applied = next;
        stderr(`[a2a] hot-reloaded: ${change.fields.join(", ")}`);
      }
    });
    controller.startWatching();
    stdout(`A2A server listening on ${baseUrl}`);
    stdout(`Agent Card: ${baseUrl}/.well-known/agent-card.json`);
    await new Promise<void>((resolve) => {
      const stop = (): void => resolve();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
  } finally {
    controller.close();
    await server?.close();
    outboundHandle?.close();
    await runtime?.close();
    await extensionRuntime.dispose();
  }
}

function configureA2ACommands(program: Command, version: string): void {
  const a2a = program
    .command("a2a")
    .description("Call third-party A2A Agents or expose KodaX as an A2A Agent");
  a2a
    .command("migrate")
    .description(
      "Explicitly migrate a legacy non-empty A2A version 1 file to version 2",
    )
    .option(
      "--confirm-daemons-stopped",
      "Confirm every daemon using this config home has been stopped",
    )
    .action(async (options: { confirmDaemonsStopped?: boolean }) => {
      const inspection = inspectA2AIntegration(KODAX_DIR);
      if (inspection.sourceVersion === 2) {
        json({
          migrated: false,
          path: inspection.snapshot.path,
          version: inspection.snapshot.document.version,
        });
        return;
      }
      if (options.confirmDaemonsStopped !== true) {
        throw new Error(
          "A2A version 1 migration requires --confirm-daemons-stopped.",
        );
      }
      await assertA2AConfigOwnerCompatible(KODAX_DIR, true);
      const result = migrateA2AIntegrationV1(
        KODAX_DIR,
        inspection.snapshot.revision,
      );
      json({
        migrated: result.migrated,
        path: result.snapshot.path,
        version: result.snapshot.document.version,
      });
    });
  a2a
    .command("migrate-tasks")
    .description("Plan or apply the offline pre-realm A2A task-owner migration")
    .option(
      "--subject <id>",
      "OAuth subject whose existing tasks should be migrated",
    )
    .option("--apply", "Apply the planned task-store changes")
    .option(
      "--confirm-server-stopped",
      "Confirm the A2A server using this task store has been stopped",
    )
    .action(
      (options: {
        subject?: string;
        apply?: boolean;
        confirmServerStopped?: boolean;
      }) => {
        if (options.apply === true && options.confirmServerStopped !== true) {
          throw new Error(
            "A2A task-owner migration requires --confirm-server-stopped when --apply is used.",
          );
        }
        const server = readA2AIntegration(KODAX_DIR).document.server;
        if (!server)
          throw new Error(
            "A2A task-owner migration requires a configured server.",
          );
        let subject: string;
        let securityRealm: string;
        if (server.authentication.type === "bearer-env") {
          subject = server.authentication.principalId;
          if (options.subject !== undefined && options.subject !== subject) {
            throw new Error(
              "A2A bearer task-owner migration subject must match server.authentication.principalId.",
            );
          }
          securityRealm = `bearer-env:${server.authentication.tokenEnv}`;
        } else {
          subject = options.subject?.trim() ?? "";
          if (subject.length === 0) {
            throw new Error(
              "OAuth A2A task-owner migration requires --subject.",
            );
          }
          securityRealm = `oauth2-jwt:${server.authentication.issuer}`;
        }
        json(
          migrateA2ALegacyTaskOwners({
            dataDir: server.dataDir,
            mappings: [{ subject, securityRealm }],
            apply: options.apply === true,
          }),
        );
      },
    );
  a2a
    .command("list")
    .action(() => json(readA2AIntegration(KODAX_DIR).document));
  a2a
    .command("add <name> <cardUrl>")
    .option("--credential-env <name>", "Bearer token environment variable")
    .option("--oauth-scheme <name>", "Agent Card OAuth2 security scheme name")
    .option("--oauth-issuer <url>", "Trusted OAuth2 issuer identifier")
    .option(
      "--oauth-token-url <url>",
      "Pinned OAuth2 token endpoint (must match the Agent Card)",
    )
    .option("--oauth-client-id <id>", "OAuth2 client identifier")
    .option(
      "--oauth-client-secret-env <name>",
      "OAuth2 client secret environment variable",
    )
    .option(
      "--oauth-scope <scope>",
      "OAuth2 scope to request (repeatable)",
      repeat,
      [],
    )
    .option("--oauth-resource <uri>", "RFC 8707 resource indicator")
    .option(
      "--oauth-client-auth <method>",
      "client-secret-basic or client-secret-post",
    )
    .option(
      "--disabled",
      "Store without activating the Agent for orchestration",
    )
    .option(
      "--allow-private",
      "Persist permission to connect to private network addresses",
    )
    .option(
      "--allow-insecure-http",
      "Persist permission to use plaintext HTTP beyond exact loopback",
    )
    .option(
      "--effect <effect>",
      "none, read, write, or unknown",
      parseEffect,
      "unknown",
    )
    .option("--no-test", "Store without fetching the Agent Card")
    .action(
      async (
        name: string,
        cardUrl: string,
        options: {
          credentialEnv?: string;
          oauthScheme?: string;
          oauthIssuer?: string;
          oauthTokenUrl?: string;
          oauthClientId?: string;
          oauthClientSecretEnv?: string;
          oauthScope: string[];
          oauthResource?: string;
          oauthClientAuth?: string;
          disabled?: boolean;
          allowPrivate?: boolean;
          allowInsecureHttp?: boolean;
          effect: A2AOutboundEffect;
          test?: boolean;
        },
      ) => {
        const oauthRequested =
          [
            options.oauthScheme,
            options.oauthIssuer,
            options.oauthTokenUrl,
            options.oauthClientId,
            options.oauthClientSecretEnv,
            options.oauthResource,
            options.oauthClientAuth,
          ].some((value) => value !== undefined) ||
          options.oauthScope.length > 0;
        const rawCandidate = {
          cardUrl,
          enabled: options.disabled !== true,
          ...(options.credentialEnv
            ? { credentialEnv: options.credentialEnv }
            : {}),
          ...(oauthRequested
            ? {
                authentication: {
                  type: "oauth2-client-credentials",
                  scheme: options.oauthScheme,
                  issuer: options.oauthIssuer,
                  tokenUrl: options.oauthTokenUrl,
                  clientId: options.oauthClientId,
                  clientSecretEnv: options.oauthClientSecretEnv,
                  scopes: options.oauthScope,
                  ...(options.oauthResource
                    ? { resource: options.oauthResource }
                    : {}),
                  clientAuthentication:
                    options.oauthClientAuth ?? "client-secret-basic",
                },
              }
            : {}),
          ...(options.allowPrivate === true ||
          options.allowInsecureHttp === true
            ? {
                network: {
                  allowPrivateAddresses: options.allowPrivate === true,
                  allowInsecureHttp: options.allowInsecureHttp === true,
                },
              }
            : {}),
          effect: options.effect,
        };
        const candidate = parseA2AIntegrationDocument({
          version: 2,
          agents: { [name]: rawCandidate },
        }).agents[name]!;
        if (options.test !== false) {
          const url = new URL(cardUrl);
          await discoverA2ARegistration(
            configuredRegistrationInput(name, candidate),
            {
              networkPolicy: networkPolicy(
                [url.origin],
                privateAllowed(
                  url,
                  candidate.network?.allowPrivateAddresses === true,
                ),
                candidate.network?.allowInsecureHttp === true,
              ),
              pollIntervalMs: 500,
            },
          );
        }
        await assertA2AConfigOwnerCompatible();
        upsertA2AOutboundAgent(KODAX_DIR, name, candidate);
        json({
          added: name,
          cardUrl,
          enabled: candidate.enabled,
          authentication:
            candidate.authentication?.type ??
            (candidate.credentialEnv ? "http-bearer" : "none"),
        });
      },
    );
  a2a.command("remove <name>").action(async (name: string) => {
    await assertA2AConfigOwnerCompatible();
    json({ name, removed: removeA2AOutboundAgent(KODAX_DIR, name) });
  });
  a2a
    .command("enable <name>")
    .description("Hot-activate a configured Agent for new orchestration")
    .action(async (name: string) => {
      await assertA2AConfigOwnerCompatible();
      const snapshot = setA2AOutboundAgentEnabled(KODAX_DIR, name, true);
      json({ name, enabled: snapshot.document.agents[name]?.enabled === true });
    });
  a2a
    .command("disable <name>")
    .description("Stop new orchestration without canceling in-flight tasks")
    .action(async (name: string) => {
      await assertA2AConfigOwnerCompatible();
      const snapshot = setA2AOutboundAgentEnabled(KODAX_DIR, name, false);
      json({ name, enabled: snapshot.document.agents[name]?.enabled === true });
    });
  a2a
    .command("test <name>")
    .option("--allow-private", "One-shot private network authorization")
    .option("--allow-insecure-http", "One-shot plaintext HTTP authorization")
    .action(async (name: string, options: A2ANetworkOverrides) => {
      const result = await discoverConfiguredAgent(name, options);
      json({
        ok: true,
        name: result.card.name,
        version: result.card.version,
        skills: result.card.skills,
      });
    });
  a2a
    .command("call <name> <prompt>")
    .option("--allow-private", "One-shot private network authorization")
    .option("--allow-insecure-http", "One-shot plaintext HTTP authorization")
    .action(
      async (
        name: string,
        prompt: string,
        options: A2ANetworkOverrides,
      ) => {
        json(await callConfiguredAgent(name, prompt, options));
      },
    );
  configureA2AExpose(a2a, version);
  a2a
    .command("serve")
    .option("--host <hostname>", "Loopback hostname", "127.0.0.1")
    .option("--port <port>", "Non-zero listener port", parsePort, 8765)
    .option("--profile <name>", "Runtime profile", "a2a-server")
    .option("--home <dir>", "Runtime home directory")
    .option("--provider <name>", "Default provider")
    .option("--model <name>", "Default model")
    .action(
      (
        localOptions: {
          host: string;
          port: number;
          profile: string;
          home?: string;
          provider?: string;
          model?: string;
        },
        command: Command,
      ) => {
        const options = mergeCommandOptionsWithGlobals(localOptions, command);
        return serveA2A({
          hostname: options.host,
          port: options.port,
          profile: options.profile,
          home: options.home,
          provider: options.provider,
          model: options.model,
        });
      },
    );
}

function configureSandboxCommands(program: Command): void {
  const sandbox = program
    .command("sandbox")
    .description(
      "Inspect or provision the ASRT Skill-script isolation backend",
    );
  sandbox
    .command("doctor")
    .action(async () => {
      const doctor = await doctorSandboxExecution();
      json({
        ...doctor,
        capability: sandboxRuntimeCapability(),
        guidance: sandboxSetupGuidance(doctor),
      });
    });
  sandbox
    .command("setup")
    .description("Activate or diagnose the platform ASRT backend (Windows may show UAC)")
    .action(async () => {
      const doctor = await doctorSandboxExecution();
      if (doctor.platform === "win32" && !doctor.ready) {
        stderr(
          "KodaX sandbox setup will request one-time UAC approval; the terminal itself does not need Administrator mode.",
        );
      }
      json(await prepareSandboxRuntimeForSetup({ initialDoctor: doctor }));
    });
}

export function configureIntegrationCommands(
  program: Command,
  options: { readonly version: string },
): void {
  configureConfigCommands(program);
  configureIntegrationManagement(program);
  configureMcpCommands(program);
  configureExtensionCommands(program);
  configureA2ACommands(program, options.version);
  configureSandboxCommands(program);
}
