import type { KodaXClientHostServices } from './client-host-authorization.js';
import type { KodaXRuntime } from './sdk-runtime.js';
import { createExecutionProfile, hostToolMetadata } from './execution-profile.js';

/** Recreate the Session-scoped ports for each actual Host admission. */
export function createExecutionServices(runtime: KodaXRuntime, sessionId?: string): KodaXClientHostServices {
  return {
    get identity() { return runtime.identity; },
    credentials: runtime.credentials, hostTools: runtime.hostTools, executionBindings: runtime.executionBindings,
    async createExecutionProfile(context, hostTools = []) {
      if ((runtime.capabilities?.productExecutionProfile as { version?: number } | undefined)?.version !== 2) {
        throw Object.assign(new Error('Execution profiles require an upgraded Host.'), { code: 'daemon_upgrade_required' });
      }
      if (context.defaultSkill !== undefined && (runtime.capabilities?.productExecutionBinding as { version?: number } | undefined)?.version !== 1) {
        throw Object.assign(new Error('Default Skills require an upgraded Host.'), { code: 'daemon_upgrade_required' });
      }
      if (sessionId === undefined) throw new Error('An execution profile requires a Session identity.');
      if (!runtime.catalog.executionTools) throw new Error('Host tool catalog is unavailable.');
      const catalog = await runtime.catalog.executionTools(sessionId);
      const names = new Set(catalog.map(tool => tool.name));
      for (const tool of hostTools) {
        if (names.has(tool.name)) throw new Error(`Host tool collides with a registered tool: ${tool.name}`);
        names.add(tool.name);
      }
      return createExecutionProfile(context, [...catalog, ...hostTools.map(hostToolMetadata)]);
    },
  };
}
