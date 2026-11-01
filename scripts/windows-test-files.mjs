import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const RECOVERY_CONTRACTS = new Set([
  'packages/repl/src/common/core-config-lock.test.ts',
  'packages/repl/src/common/config-save.test.ts',
  'packages/repl/src/common/integration-config.test.ts',
  'packages/repl/src/interactive/session-migration.test.ts',
  'packages/repl/src/ui/utils/transcript-input-policy.test.ts',
  'packages/repl/src/permission/executor.test.ts',
  'packages/agent/src/session-lineage/persistence.test.ts',
  'packages/agent/src/external-agents/executor-plane.test.ts',
  'packages/llm/src/providers/anthropic-credentials.test.ts',
  'packages/llm/src/providers/oauth-routes.test.ts',
  'src/execution-facts.test.ts',
  'src/cli-provider-credentials.test.ts',
  'src/provider-credential-authorizer.test.ts',
  'src/runtime-agent-store.test.ts',
]);

/** Include the whole file so parameterized and nested platform cases retain their fixtures. */
export function discoverWindowsTestFiles(root) {
  const files = [];
  const visit = directory => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && /\.test\.tsx?$/.test(entry.name)) {
        const source = readFileSync(file, 'utf8');
        const relative = path.relative(root, file).replaceAll('\\', '/');
        if (RECOVERY_CONTRACTS.has(relative) || /windows/i.test(entry.name) || (/\bwin32\b/.test(source) && /\b(?:process\.platform|os\.platform\s*\()/u.test(source))) {
          files.push(relative);
        }
      }
    }
  };
  for (const directory of ['src', 'tests']) visit(path.join(root, directory));
  const packages = path.join(root, 'packages');
  if (existsSync(packages)) for (const entry of readdirSync(packages, { withFileTypes: true })) {
    if (entry.isDirectory()) visit(path.join(packages, entry.name, 'src'));
  }
  return files.sort();
}
