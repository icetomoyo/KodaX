// The specifiers below are kept external by scripts/build-bundle.mjs, so every
// `loadCliComponent('./x.js', ...)` call must live in a file directly in src/.
declare const KODAX_CLI_LAZY_COMPONENTS: boolean | undefined;
function loadCliComponent<T>(file: string, source: () => Promise<T>): Promise<T> {
  // Node distributions defer optional commands; Bun binaries embed the literal source imports.
  if (typeof KODAX_CLI_LAZY_COMPONENTS !== 'undefined' && KODAX_CLI_LAZY_COMPONENTS && !('Bun' in globalThis)) {
    return import(new URL(file, import.meta.url).href) as Promise<T>;
  }
  return source();
}
export const loadProviderAuth = () => loadCliComponent('./provider-auth-cli.js', () => import('./provider-auth-cli.js'));
export const loadOneShotTask = () => loadCliComponent('./one-shot-task.js', () => import('./one-shot-task.js'));
export const loadA2AServer = () => loadCliComponent('./sdk-a2a.js', () => import('./a2a/server.js'));
export const loadIntegrationCli = () => loadCliComponent('./integration-cli.js', () => import('./integration-cli.js'));
export const loadStorageRepair = () => loadCliComponent('./storage-repair-cli.js', () => import('./storage-repair-cli.js'));
export const loadDoctor = () => loadCliComponent('./kodax_doctor.js', () => import('./kodax_doctor.js'));
export const loadAcpServer = () => loadCliComponent('./acp_server.js', () => import('./acp_server.js'));
