import path from 'node:path';

/** Commands whose `serve` runs a Host in this process. */
const HOST_SERVING_COMMANDS = new Set(['host', 'daemon', 'a2a']);

/**
 * The data root a Host-serving command names with `--config-home` or `--home`,
 * or undefined when it keeps the default. Read from argv before the full CLI
 * loads, because KodaX modules fix the data root when they are first imported.
 */
export function servedHostDataRoot(args: readonly string[]): string | undefined {
  if (!HOST_SERVING_COMMANDS.has(args[0] ?? '') || args[1] !== 'serve') return undefined;
  const values = new Map<string, string>();
  for (let index = 2; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === '--') break;
    const [name, inline] = token.split(/=(.*)/su, 2);
    if (name !== '--home' && name !== '--config-home') continue;
    const value = inline ?? args[++index];
    if (value !== undefined) values.set(name, value);
  }
  const configHome = values.get('--config-home');
  if (configHome !== undefined) return path.resolve(configHome);
  const home = values.get('--home');
  return home === undefined ? undefined : path.join(path.resolve(home), '.kodax');
}

/**
 * Makes a served Host's process keep all of its data (settings, keys, memory,
 * Skills, MCP servers) in the Host's own root, as a Host the launcher starts does.
 */
export function useServedHostDataRoot(args: readonly string[], env: NodeJS.ProcessEnv = process.env): void {
  const root = servedHostDataRoot(args);
  if (root !== undefined) env.KODAX_HOME = root;
}

function samePath(left: string, right: string): boolean {
  const identity = (value: string): string => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return identity(left) === identity(right);
}

/**
 * Refuses to serve when this process reads another data root than the Host's
 * own. Serving anyway would let this Host read and change another Host's
 * settings, memory and Skills, which breaks tenants that share one machine.
 */
export function assertHostDataRoot(configHome: string, processRoots: readonly string[]): void {
  const other = processRoots.find(root => !samePath(root, configHome));
  if (other === undefined) return;
  throw new Error(
    `This Host keeps its data in ${configHome}, but this process reads ${other}. `
    + `Start it with the kodax command, or set KODAX_HOME=${configHome}.`,
  );
}
