/**
 * Output for CLI commands that report a result: readable text by default, the
 * result object unchanged with `--json`, and exit code 1 when the result says
 * something failed.
 */
import type { Command } from 'commander';

export const JSON_OPTION_HELP = 'Print the result as JSON';

export function withJsonOption(command: Command): Command {
  return command.option('--json', JSON_OPTION_HELP);
}

/**
 * Wraps an action that returns its result. Commander passes the command as the
 * last action argument; its `--json` picks the format.
 */
export function reported<A extends unknown[], T>(
  run: (...args: A) => T | Promise<T>,
  text: (value: Awaited<T>) => string = renderText,
  succeeded?: (value: Awaited<T>) => boolean,
): (...args: A) => Promise<void> {
  return async (...args: A) => {
    const value = await run(...args);
    const command = args.at(-1) as Command;
    process.stdout.write(`${command.opts().json === true ? JSON.stringify(value, null, 2) : text(value)}\n`);
    if (succeeded !== undefined && !succeeded(value)) process.exitCode = 1;
  };
}

/** A generic readable form of a JSON-shaped result. */
export function renderText(value: unknown): string {
  if (isEmpty(value)) return '(none)';
  return isRecord(value) || Array.isArray(value) ? renderLines(value, '').join('\n') : scalar(value);
}

function renderLines(value: readonly unknown[] | Readonly<Record<string, unknown>>, indent: string): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(item => {
      if (!isRecord(item) && !Array.isArray(item)) return [`${indent}- ${scalar(item)}`];
      const [first = '', ...rest] = renderLines(item, `${indent}  `);
      return [`${indent}- ${first.trimStart()}`, ...rest];
    });
  }
  return Object.entries(value).flatMap(([key, item]) => {
    if (item === undefined) return [];
    if (isEmpty(item)) return [`${indent}${key}: (none)`];
    if (isRecord(item) || Array.isArray(item)) return [`${indent}${key}:`, ...renderLines(item, `${indent}  `)];
    return [`${indent}${key}: ${scalar(item)}`];
  });
}

function scalar(value: unknown): string {
  if (value === true) return 'yes';
  if (value === false) return 'no';
  if (value === null) return '-';
  return String(value);
}

function isEmpty(value: unknown): boolean {
  return Array.isArray(value) ? value.length === 0 : isRecord(value) && Object.keys(value).length === 0;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
