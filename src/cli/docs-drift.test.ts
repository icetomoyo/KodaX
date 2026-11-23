import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command, Option } from 'commander';
import { describe, expect, it } from 'vitest';
import { createKodaXProgram } from './program.js';
import { loadLazyCommand } from './root.js';

const repo = fileURLToPath(new URL('../../', import.meta.url));

function visibleSubcommand(command: Command, name: string): Command | undefined {
  return command.commands.find((child) =>
    !(child as Command & { _hidden?: boolean })._hidden
    && (child.name() === name || child.aliases().includes(name)));
}

function findOption(command: Command, flag: string): Option | undefined {
  for (let current: Command | null = command; current; current = current.parent) {
    const option = current.options.find((candidate) => candidate.long === flag || candidate.short === flag);
    if (option) return option;
  }
  return undefined;
}

/** Shell-like words; quoted strings stay whole and a `#` comment ends the line. */
function words(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/"[^"]*"|'[^']*'|\S+/g)) {
    if (match[0].startsWith('#')) break;
    out.push(match[0]);
  }
  return out;
}

/** Why `kodax …` as written would not reach a visible command, or undefined when it would. */
function problemWith(root: Command, invocation: string): string | undefined {
  const tokens = words(invocation).slice(1);
  let command = root;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!.replace(/[,.;:)]+$/, '');
    if (token === '--' || /^["'/]/.test(token)) return undefined; // the rest is a prompt or a checked command
    if (/^[<[{$]/.test(token) || token === '...' || token === '…') continue; // placeholder
    if (token.startsWith('-')) {
      const [flags, inline] = token.split('=');
      for (const flag of flags!.split('|')) {
        const option = findOption(command, flag);
        if (!option || option.hidden) return `unknown option ${flag}`;
        if (option.required && inline === undefined) index += 1;
      }
      continue;
    }
    if (command.commands.length === 0) continue;
    const alternatives = token.split('|');
    const found = alternatives.map((name) => visibleSubcommand(command, name));
    if (found.some((child) => !child)) return `no visible command ${token} under ${command.name()}`;
    if (alternatives.length > 1) return undefined;
    command = found[0]!;
  }
  return undefined;
}

/** `kodax …` in inline code spans and as the first word of a code-block line. */
function invocations(text: string): string[] {
  const found = [...text.matchAll(/`(kodax(?:\s[^`]*)?)`/g)].map((match) => match[1]!.replace(/\s+/g, ' '));
  for (const line of text.split('\n')) {
    const trimmed = line.trim().replace(/^\$\s+/, '');
    if (/^kodax(\s+[-"'/a-z<]|$)/.test(trimmed) && !line.includes('`')) found.push(trimmed);
  }
  return found;
}

function markdownFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return markdownFiles(path);
    return name.endsWith('.md') ? [path] : [];
  });
}

function userFacingTexts(): { name: string; text: string }[] {
  const docs = ['README.md', 'README_CN.md', ...markdownFiles(join(repo, 'public_docs')).map((path) => path.slice(repo.length))];
  const manual = JSON.parse(readFileSync(join(repo, 'packages/coding/src/self-knowledge/manual-topics.json'), 'utf8')) as
    { id: string; body: string[] }[];
  return [
    ...docs.map((name) => ({ name, text: readFileSync(join(repo, name), 'utf8') })),
    ...manual.map((topic) => ({ name: `manual topic ${topic.id}`, text: topic.body.join('\n') })),
  ];
}

describe('kodax commands named in user-facing docs', () => {
  it('reach a visible command and option of the command tree', async () => {
    const root = createKodaXProgram({ version: '9.9.9' });
    for (const command of root.commands) await loadLazyCommand(root, command);
    const stale = userFacingTexts().flatMap(({ name, text }) => invocations(text).flatMap((invocation) => {
      const problem = problemWith(root, invocation);
      return problem ? [`${name}: \`${invocation}\` (${problem})`] : [];
    }));
    expect(stale).toEqual([]);
  });

  it('include every visible top-level command in the manual commands topic', () => {
    const root = createKodaXProgram({ version: '9.9.9' });
    const commands = userFacingTexts().find(({ name }) => name === 'manual topic commands')!.text;
    const missing = root.commands
      .filter((command) => !(command as Command & { _hidden?: boolean })._hidden)
      .map((command) => command.name())
      .filter((name) => !new RegExp(`\`kodax ${name}\\b`).test(commands));
    expect(missing).toEqual([]);
  });

  it('flags a hidden alias, a removed flag and an unknown subcommand', async () => {
    const root = createKodaXProgram({ version: '9.9.9' });
    for (const command of root.commands) await loadLazyCommand(root, command);
    expect(problemWith(root, 'kodax daemon stop')).toMatch(/daemon/);
    expect(problemWith(root, 'kodax --auto "fix it"')).toMatch(/--auto/);
    expect(problemWith(root, 'kodax host restat')).toMatch(/restat/);
    expect(problemWith(root, 'kodax host start|stop|logs')).toBeUndefined();
    expect(problemWith(root, 'kodax --provider kimi "explain this"')).toBeUndefined();
  });
});
