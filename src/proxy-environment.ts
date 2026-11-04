type ProcessValues = Readonly<Record<string, string | undefined>>;

const PROXY_VARIABLES = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'] as const;

function nodeHasEnvProxy(version: string): boolean {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  return major >= 25 || (major === 24 && minor >= 5) || (major === 22 && minor >= 21);
}

function envProxyEnabled(env: ProcessValues, execArgv: readonly string[]): boolean {
  const nodeOptions = (env.NODE_OPTIONS ?? '').split(/\s+/);
  return env.NODE_USE_ENV_PROXY === '1' || [...execArgv, ...nodeOptions].includes('--use-env-proxy');
}

/**
 * Explains which requests of this process would bypass a configured HTTP(S)_PROXY. Names the
 * variable but never its value, because proxy URLs can carry credentials.
 */
export function describeProxyEnvironmentGap(
  env: ProcessValues = process.env,
  versions: ProcessValues = process.versions,
  execArgv: readonly string[] = process.execArgv,
): string | undefined {
  const variable = PROXY_VARIABLES.find((name) => env[name]);
  if (variable === undefined) return undefined;
  const enabled = envProxyEnabled(env, execArgv);
  if (versions.bun !== undefined) {
    return enabled ? undefined
      : `${variable} is set. Model requests follow it, but web_fetch only does after you set NODE_USE_ENV_PROXY=1 and restart the KodaX daemon.`;
  }
  const node = versions.node ?? 'unknown';
  if (!nodeHasEnvProxy(node)) {
    return `${variable} is set, but Node ${node} cannot send requests through it. Use Node 22.21+ or 24.5+ with NODE_USE_ENV_PROXY=1, or the standalone KodaX binary.`;
  }
  return enabled ? undefined
    : `${variable} is set, but Node ignores it until NODE_USE_ENV_PROXY=1 is set. Set it and restart the KodaX daemon.`;
}
