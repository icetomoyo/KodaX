import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { loadAuditedRuntimeProgram } from './windows-native-artifacts.js';

it('emits the pre-extraction broker bytes with literal slot substitution and one cached load', () => {
  const source = readFileSync(new URL('./sandbox-runtime.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('sandbox-runtime.ts', source, ts.ScriptTarget.Latest, true);
  let factory: ts.FunctionDeclaration | undefined;
  ts.forEachChild(ast, node => { if (ts.isFunctionDeclaration(node) && node.name?.text === 'asrtBrokerSource') factory = node; });
  if (!factory) throw new Error('Missing broker program assembly');
  const js = ts.transpileModule(factory.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const values = {
    SANDBOX_BROKER_REQUEST_MAX_BYTES: 2097152,
    WINDOWS_GIT_BROKER_SOURCE: "const marker = '$&';",
    SANDBOX_BROKER_CONTROL_MAX_BYTES: 65536,
    ELECTRON_NODE_ENV_SCRUB_IMPORT_LITERAL: JSON.stringify('data:text/javascript,delete process.env.ELECTRON_RUN_AS_NODE'),
    TARGET_ARGV_LOADER_LITERAL: JSON.stringify("eval(Buffer.from(process.argv[1],'base64').toString('utf8'))"),
    TARGET_ARGV_BOOTSTRAP_BASE64_LITERAL: JSON.stringify('abc+/='),
    ELECTRON_RUN_AS_NODE_ENV_LITERAL: JSON.stringify('ELECTRON_RUN_AS_NODE'),
  };
  const load = vi.fn(loadAuditedRuntimeProgram);
  const create = Function('loadAuditedRuntimeProgram', ...Object.keys(values), `let cachedBrokerSource; ${js}; return asrtBrokerSource;`) as (...args: unknown[]) => () => string;
  const program = create(load, ...Object.values(values));
  const text = program();
  // Captured from 68a02521c's original String.raw expression with these same values.
  expect(createHash('sha256').update(text).digest('hex')).toBe('4ccde6ff01dbdd90c0937b63ed606561e355b24d1b9e1d28cecfba4fb7a9ad5e');
  expect(text).toContain("const marker = '$&';");
  expect(text).not.toContain('{{KODAX_ASRT_SLOT_');
  expect(program()).toBe(text);
  expect(load).toHaveBeenCalledExactlyOnceWith('asrtBroker');
});
