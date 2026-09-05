import path from 'node:path';
import { emitKodaXDiagnostic, type McpServerConfig } from '@kodax-ai/agent';
import {
  buildMcpReverseCapabilities,
  combineExtensionRuntimes,
  createExtensionRuntime,
  dedupeExtensionPathsByEntrypoint,
  discoverExtensionsInDirectory,
  excludeExtensionPathsByEntrypoint,
  getActiveExtensionRuntime,
  registerConfiguredMcpCapabilityProvider,
  replaceConfiguredMcpCapabilityProvider,
  type KodaXOptions,
  type KodaXExtensionRuntime,
} from '@kodax-ai/coding';
import { parseMcpIntegrationDocument, readExtensionsIntegration, readMcpIntegration } from '@kodax-ai/repl';
import { startIntegrationHotReload, type IntegrationHotReloadHandle } from './integration-hot-reload.js';

/** Shared bootstrap for the CLI Host and an SDK-created Host. */
export async function createHostOwnedExtensionRuntime(
  configHome: string,
  config: Record<string, unknown>,
  onEvent: (message: string) => void = (message) => emitKodaXDiagnostic({ source: 'host-integrations', level: 'info', message }),
): Promise<{ readonly runtime: KodaXExtensionRuntime; readonly hotReload: IntegrationHotReloadHandle }> {
  let configuredPaths: readonly string[] = [];
  let servers: Record<string, McpServerConfig> = {};
  try { configuredPaths = readExtensionsIntegration(configHome).document.paths; }
  catch (error: unknown) { onEvent(`extensions: ${error instanceof Error ? error.message : String(error)}`); }
  try { servers = readMcpIntegration(configHome).document.servers; }
  catch (error: unknown) { onEvent(`mcp: ${error instanceof Error ? error.message : String(error)}`); }
  const configured = await dedupeExtensionPathsByEntrypoint(configuredPaths.map((entry) => path.resolve(configHome, entry)));
  const discovered = await excludeExtensionPathsByEntrypoint(
    await discoverExtensionsInDirectory(path.join(configHome, 'extensions')), configured,
  );
  const runtime = createExtensionRuntime({ config: { ...config, extensions: configured, mcpServers: servers } });
  const mcpOptions = {
    cacheDir: path.join(configHome, 'mcp-cache'),
    // Elicitation is enabled Host-wide per US20: MCP form/url requests stay
    // interactive when a surface is live and decline cleanly when none is.
    reverse: buildMcpReverseCapabilities({ cwd: process.cwd(), enableElicitation: true }),
  };
  try {
    await registerConfiguredMcpCapabilityProvider(runtime, servers, mcpOptions);
    await runtime.loadExtensions(discovered, { continueOnError: true, loadSource: 'discovery' });
    await runtime.loadExtensions(configured, { continueOnError: true, loadSource: 'config' });
    const hotReload = await startIntegrationHotReload({ runtime, configHome, mcpOptions, onEvent });
    return { runtime, hotReload };
  } catch (error: unknown) {
    try { await runtime.dispose(); }
    catch (cleanupError: unknown) { throw new AggregateError([error, cleanupError], 'Host integration initialization and cleanup failed.'); }
    throw error;
  }
}

/** A Host reuses bootstrap integrations; a direct Host owns its own instance. */
export async function createHostIntegrations(configHome: string, config: Record<string, unknown>): Promise<{
  readonly global: KodaXExtensionRuntime;
  forSession(sessionId: string): KodaXOptions['extensionRuntime'];
  createSession(sessionId: string, workspaceRoot: string, servers?: Readonly<Record<string, McpServerConfig>>): Promise<void>;
  releaseSession(sessionId: string): Promise<void>;
  close(): Promise<void>;
}> {
  const existing = getActiveExtensionRuntime();
  const owned = existing ? undefined : await createHostOwnedExtensionRuntime(configHome, config);
  // Activate the owned instance so Host features that resolve the active
  // runtime (command listing, reverse bridge) see it, matching the CLI path.
  owned?.runtime.activate();
  const global = existing ?? owned!.runtime;
  const sessions = new Map<string, KodaXExtensionRuntime>();
  const releaseSession = async (sessionId: string): Promise<void> => {
    const runtime = sessions.get(sessionId);
    if (!runtime) return;
    await runtime.dispose();
    sessions.delete(sessionId);
  };
  return {
    global,
    forSession(sessionId) {
      const session = sessions.get(sessionId);
      return session ? combineExtensionRuntimes(session, global) : global;
    },
    async createSession(sessionId, workspaceRoot, servers) {
      if (servers === undefined || Object.keys(servers).length === 0) return;
      const validated = parseMcpIntegrationDocument({ version: 1, servers }).servers;
      const runtime = createExtensionRuntime();
      try {
        await replaceConfiguredMcpCapabilityProvider(runtime, validated, {
          cacheDir: path.join(configHome, 'mcp-cache', 'sessions', encodeURIComponent(sessionId)),
          reverse: buildMcpReverseCapabilities({ cwd: workspaceRoot, enableElicitation: true }),
        });
        sessions.set(sessionId, runtime);
      } catch (error: unknown) {
        await runtime.dispose();
        throw error;
      }
    },
    releaseSession,
    async close() {
      owned?.hotReload.close();
      for (const sessionId of sessions.keys()) await releaseSession(sessionId);
      if (!existing) await global.dispose();
    },
  };
}
