/**
 * CLI surface for constructed tools (FEATURE_088 follow-on, v0.7.28).
 *
 * Two entry points:
 *
 *   1. `kodax <constructed-tool-name> [args...]`
 *      Direct dispatch to a previously-activated constructed tool, without
 *      opening the REPL. Args map onto the artifact's `inputSchema` via
 *      `--key=value` / `--key value` / single positional → first required
 *      string field. The handler's return value is printed to stdout.
 *
 *   2. `kodax tools list | revoke <name>@<version> | inspect <name>[@<version>]`
 *      Inventory and lifecycle management of constructed tools from the
 *      shell, no REPL required.
 *
 * Bootstrap policy: the CLI binds a non-interactive 'reject' policy via
 * `configureRuntime`. activate() cannot succeed from this surface — that
 * is by design (REPL dialog is the one approved-activation path; CLI is
 * for *invoking* tools that are already activated). Rehydrate then runs,
 * making every `status='active'` artifact callable.
 */

import path from 'path';
import chalk from 'chalk';
import {
  configureRuntime,
  rehydrateActiveArtifacts,
  revoke as revokeArtifact,
  readArtifact,
  listConstructed,
  listTools,
  listToolDefinitions,
  getRegisteredToolDefinition,
  executeTool,
  type KodaXToolExecutionContext,
} from '@kodax/coding';

/**
 * Subcommand names that the kodax CLI reserves at the top level. The
 * direct-dispatch path uses this set to avoid hijacking commander
 * subcommands (e.g. a constructed tool literally named `skill` would
 * collide with `kodax skill`).
 */
const RESERVED_SUBCOMMAND_NAMES: ReadonlySet<string> = new Set([
  'skill',
  'acp',
  'completion',
  'tools',
  'serve',
]);

interface CliBootstrapContext {
  /** Resolved cwd used for both `.kodax/constructed/` lookup and tool execution. */
  readonly cwd: string;
}

/**
 * One-time bootstrap for non-REPL surfaces.
 *
 * Idempotent: calling twice is harmless. configureRuntime accepts the same
 * overrides; rehydrate re-registers atomically (registerActiveArtifact
 * unregisters any prior entry first).
 */
async function bootstrapForCli(cwd: string): Promise<void> {
  configureRuntime({
    cwd,
    // CLI surfaces have no interactive UI bound — reject any activate()
    // attempts. Activation must originate from the REPL, where a dialog
    // can solicit user approval.
    policy: async () => 'reject',
  });
  await rehydrateActiveArtifacts();
}

/**
 * Decide whether the current argv targets a constructed tool. Called
 * BEFORE commander parses, so it must be conservative — only fire when:
 *
 *   - argv[0] is non-empty
 *   - argv[0] is NOT a reserved subcommand
 *   - argv[0] is NOT a global flag (starts with '-')
 *   - bootstrap completes and the registry contains a tool with that name
 *     whose source.kind === 'constructed'
 *
 * Returns the resolved tool name on a match, or null to defer to commander.
 */
export async function detectConstructedToolDispatch(
  argv: readonly string[],
  cwd: string,
): Promise<string | null> {
  const head = argv[0];
  if (!head || head.startsWith('-')) return null;
  if (RESERVED_SUBCOMMAND_NAMES.has(head)) return null;

  await bootstrapForCli(cwd);

  const registration = getRegisteredToolDefinition(head);
  if (!registration) return null;
  if (registration.source.kind !== 'constructed') return null;
  return head;
}

/**
 * Translate `--key=value` / `--key value` / `--flag` / single positional
 * into a typed input object suitable for an inputSchema-validated tool.
 *
 * Type coercion is driven by `inputSchema.properties[key].type`:
 *   - 'string'  → as-is
 *   - 'integer' → parseInt with NaN guard
 *   - 'number'  → parseFloat with NaN guard
 *   - 'boolean' → standalone `--flag` → true; `--flag=false` → false; etc.
 *   - other     → JSON.parse fallback (arrays / nested objects via JSON
 *                 strings, e.g. `--items='["a","b"]'`)
 *
 * A single bare positional argument maps onto the first required string
 * property — convenient for one-arg tools (`kodax count_lines /tmp/x`).
 *
 * Throws on shape errors with a message the caller prints verbatim.
 */
export function parseArgsByInputSchema(
  argv: readonly string[],
  inputSchema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const props = (inputSchema?.properties as Record<string, { type?: string }> | undefined) ?? {};
  const required = (inputSchema?.required as string[] | undefined) ?? [];

  const out: Record<string, unknown> = {};
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const eqIdx = arg.indexOf('=');
    let key: string;
    let rawValue: string | undefined;
    if (eqIdx >= 0) {
      key = arg.slice(2, eqIdx);
      rawValue = arg.slice(eqIdx + 1);
    } else {
      key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        rawValue = next;
        i += 1;
      } else {
        rawValue = undefined;
      }
    }
    out[key] = coerceValue(key, rawValue, props[key]);
  }

  if (positionals.length === 1) {
    const firstStringRequired = required.find(
      (name) => (props[name]?.type ?? 'string') === 'string' && out[name] === undefined,
    );
    if (firstStringRequired) {
      out[firstStringRequired] = positionals[0];
    } else if (out['_'] === undefined) {
      out._ = positionals[0];
    }
  } else if (positionals.length > 1) {
    throw new Error(
      `Tool received ${positionals.length} positional arguments, but only 0 or 1 are supported. `
      + `Use --<key>=<value> for additional fields.`,
    );
  }

  return out;
}

function coerceValue(
  key: string,
  rawValue: string | undefined,
  prop: { type?: string } | undefined,
): unknown {
  const type = prop?.type ?? 'string';
  if (rawValue === undefined) {
    if (type === 'boolean') return true;
    throw new Error(`Flag --${key} expects a value (none provided).`);
  }
  switch (type) {
    case 'string':
      return rawValue;
    case 'integer': {
      const n = Number.parseInt(rawValue, 10);
      if (!Number.isFinite(n)) {
        throw new Error(`--${key} expects an integer, got '${rawValue}'.`);
      }
      return n;
    }
    case 'number': {
      const n = Number.parseFloat(rawValue);
      if (!Number.isFinite(n)) {
        throw new Error(`--${key} expects a number, got '${rawValue}'.`);
      }
      return n;
    }
    case 'boolean':
      return parseBooleanValue(key, rawValue);
    default:
      // For arrays / nested objects, expect a JSON string. Falls back to
      // the raw string if JSON.parse fails so the schema validator
      // downstream can produce a more informative error.
      try {
        return JSON.parse(rawValue);
      } catch {
        return rawValue;
      }
  }
}

function parseBooleanValue(key: string, raw: string): boolean {
  const lowered = raw.trim().toLowerCase();
  if (lowered === 'true' || lowered === '1' || lowered === 'yes') return true;
  if (lowered === 'false' || lowered === '0' || lowered === 'no') return false;
  throw new Error(`--${key} expects a boolean, got '${raw}'.`);
}

/**
 * Direct-dispatch entry point. Resolves the tool, parses args, runs the
 * handler with a minimal execution context, prints the result string, and
 * exits with status 0. Errors abort with status 1 and a message on stderr.
 */
export async function runConstructedToolDispatch(
  toolName: string,
  argv: readonly string[],
  cwd: string,
): Promise<void> {
  const registration = getRegisteredToolDefinition(toolName);
  if (!registration) {
    // Should not happen — detectConstructedToolDispatch already checked.
    // Keep the guard for robustness against concurrent revoke races.
    process.stderr.write(`kodax: tool '${toolName}' is not registered.\n`);
    process.exit(1);
  }

  if (argv.includes('--help') || argv.includes('-h')) {
    printToolHelp(toolName, registration);
    return;
  }

  let input: Record<string, unknown>;
  try {
    input = parseArgsByInputSchema(argv, registration.input_schema as Record<string, unknown>);
  } catch (err) {
    process.stderr.write(`kodax: ${(err as Error).message}\n`);
    process.exit(1);
  }

  const ctx = {
    backups: new Map<string, string>(),
    executionCwd: cwd,
  } as KodaXToolExecutionContext;

  const result = await executeTool(toolName, input, ctx);
  // The handler always returns a string (registry contract). Print it
  // verbatim — error wrapping happens upstream in executeTool.
  process.stdout.write(result.endsWith('\n') ? result : `${result}\n`);
}

function printToolHelp(toolName: string, registration: { description: string; input_schema?: unknown; source: { kind: string; version?: string } }): void {
  const schema = (registration.input_schema as Record<string, unknown> | undefined) ?? {};
  const props = (schema.properties as Record<string, { type?: string; description?: string }> | undefined) ?? {};
  const required = (schema.required as string[] | undefined) ?? [];

  console.log(chalk.cyan(`\n${toolName}${registration.source.version ? `@${registration.source.version}` : ''}`));
  console.log(chalk.dim(`  ${registration.description}\n`));
  console.log(chalk.bold('Inputs:'));
  if (Object.keys(props).length === 0) {
    console.log(chalk.dim('  (no inputs)'));
  } else {
    for (const [key, p] of Object.entries(props)) {
      const tag = required.includes(key) ? chalk.red('required') : chalk.dim('optional');
      const typeLabel = p.type ?? 'string';
      console.log(`  --${key.padEnd(20)} ${chalk.dim(typeLabel.padEnd(8))} ${tag}  ${p.description ?? ''}`);
    }
  }
  console.log();
  console.log(chalk.bold('Examples:'));
  const firstReq = required[0];
  if (firstReq && props[firstReq]?.type === 'string') {
    console.log(chalk.dim(`  kodax ${toolName} <${firstReq}>`));
    console.log(chalk.dim(`  kodax ${toolName} --${firstReq}=<value>`));
  } else if (Object.keys(props).length > 0) {
    const sample = Object.entries(props)
      .slice(0, 2)
      .map(([k, p]) => `--${k}=<${p.type ?? 'value'}>`)
      .join(' ');
    console.log(chalk.dim(`  kodax ${toolName} ${sample}`));
  } else {
    console.log(chalk.dim(`  kodax ${toolName}`));
  }
  console.log();
}

// ============================================================
// `kodax tools` subcommands
// ============================================================

/**
 * Pretty-print the constructed-tool inventory. Builtin tools are NOT
 * listed by default — `--all` toggles that for diagnostics.
 */
export async function runToolsList(opts: { all?: boolean; cwd: string }): Promise<void> {
  await bootstrapForCli(opts.cwd);
  const constructed = listConstructed();

  if (constructed.length === 0 && !opts.all) {
    console.log(chalk.dim('No constructed tools registered.'));
    console.log(chalk.dim(`(searched ${path.resolve(opts.cwd, '.kodax', 'constructed')})`));
    return;
  }

  if (constructed.length > 0) {
    console.log(chalk.cyan('\nConstructed tools:\n'));
    for (const reg of constructed) {
      const version = reg.source.version ?? '?';
      console.log(`  ${chalk.bold(reg.name)}@${version}  ${chalk.dim(reg.description)}`);
    }
    console.log();
  }

  if (opts.all) {
    const constructedNames = new Set(constructed.map((r) => r.name));
    const otherNames = listTools().filter((n) => !constructedNames.has(n));
    console.log(chalk.cyan('Builtin / extension tools:\n'));
    for (const name of otherNames) {
      const reg = getRegisteredToolDefinition(name);
      const kind = reg?.source.kind ?? 'unknown';
      console.log(`  ${name.padEnd(36)} ${chalk.dim(kind)}`);
    }
    console.log();
  }
}

/**
 * Revoke a constructed tool by `name@version`. Idempotent: revoking an
 * unknown spec exits 0 with a noop message (matches runtime semantics).
 */
export async function runToolsRevoke(spec: string, opts: { cwd: string }): Promise<void> {
  const atIdx = spec.lastIndexOf('@');
  if (atIdx <= 0 || atIdx === spec.length - 1) {
    process.stderr.write(
      `kodax tools revoke: expected '<name>@<version>', got '${spec}'.\n`,
    );
    process.exit(1);
  }
  const name = spec.slice(0, atIdx);
  const version = spec.slice(atIdx + 1);

  await bootstrapForCli(opts.cwd);

  const before = await readArtifact(name, version);
  if (!before) {
    console.log(chalk.dim(`No artifact found for ${name}@${version} — nothing to revoke.`));
    return;
  }
  if (before.status === 'revoked') {
    console.log(chalk.dim(`${name}@${version} is already revoked (no-op).`));
    return;
  }

  await revokeArtifact(name, version);
  console.log(chalk.green(`✓ Revoked ${name}@${version}.`));
  console.log(chalk.dim('  The handler is no longer registered. The artifact JSON and .js source are preserved on disk for audit.'));
}

/**
 * Print the full manifest JSON for a constructed artifact. Without a
 * version, prints the highest-versioned active entry; with a version,
 * locates that exact entry (regardless of status).
 */
export async function runToolsInspect(spec: string, opts: { cwd: string }): Promise<void> {
  await bootstrapForCli(opts.cwd);

  const atIdx = spec.lastIndexOf('@');
  let name: string;
  let version: string | undefined;
  if (atIdx > 0) {
    name = spec.slice(0, atIdx);
    version = spec.slice(atIdx + 1);
  } else {
    name = spec;
  }

  if (version) {
    const artifact = await readArtifact(name, version);
    if (!artifact) {
      process.stderr.write(`kodax tools inspect: no artifact found for ${name}@${version}.\n`);
      process.exit(1);
    }
    console.log(JSON.stringify(artifact, null, 2));
    return;
  }

  // No version → pick the active registration if present, else any
  // registration. listConstructed walks every name; filter to the requested.
  const candidates = listConstructed().filter((r) => r.name === name);
  if (candidates.length === 0) {
    process.stderr.write(
      `kodax tools inspect: no constructed tool found for '${name}'. Try 'kodax tools list'.\n`,
    );
    process.exit(1);
  }
  const winner = candidates[candidates.length - 1]!;
  const artifact = await readArtifact(name, winner.source.version!);
  if (!artifact) {
    process.stderr.write(
      `kodax tools inspect: registry shows ${name} but the manifest is not on disk. Re-run after bootstrap.\n`,
    );
    process.exit(1);
  }
  console.log(JSON.stringify(artifact, null, 2));
}
