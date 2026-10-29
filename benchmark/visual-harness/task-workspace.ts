import { isUtf8 } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { readdir, readFile, readlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

interface FileSnapshot { path: string; encoding: 'utf8' | 'base64' | 'symlink'; content: string }
async function snapshot(root: string, directory = root): Promise<FileSnapshot[]> {
  const files: FileSnapshot[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    if (entry.isSymbolicLink()) files.push({ path: relative, encoding: 'symlink', content: await readlink(absolute) });
    else if (entry.isDirectory()) files.push(...await snapshot(root, absolute));
    else if (entry.isFile()) {
      const bytes = await readFile(absolute); const encoding = isUtf8(bytes) ? 'utf8' : 'base64';
      files.push({ path: relative, encoding, content: bytes.toString(encoding) });
    } else throw new Error(`Unsupported workspace entry: ${relative}`);
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export async function captureTaskChanges(original: string, final: string) {
  const before = await snapshot(original); const finalFiles = await snapshot(final);
  const old = new Map(before.map(file => [file.path, file]));
  const current = new Map(finalFiles.map(file => [file.path, file]));
  const display = (file: FileSnapshot | undefined) => !file ? null : file.encoding === 'utf8' ? file.content : `[${file.encoding}] ${file.content}`;
  const changes = [...new Set([...old.keys(), ...current.keys()])].sort().flatMap(file => {
    const previous = old.get(file); const next = current.get(file);
    return previous?.encoding === next?.encoding && previous?.content === next?.content ? []
      : [{ path: file, before: display(previous), after: display(next) }];
  });
  return { changes, finalFiles };
}

export async function evaluateConfigTask(original: string, final: string) {
  const workspaceEvidence = await captureTaskChanges(original, final);
  const source = workspaceEvidence.finalFiles.find(file => file.path === 'config.mjs');
  const tests = workspaceEvidence.finalFiles.find(file => file.path === 'config.test.mjs');
  let codeValidation: { passed: boolean; log: string };
  if (source?.encoding !== 'utf8' || tests?.encoding !== 'utf8') {
    codeValidation = { passed: false, log: 'Required config.mjs/config.test.mjs missing or not regular UTF-8 files; full deletion/link evidence retained.' };
  } else {
    const testPath = path.join(final, 'config.test.mjs');
    await writeFile(testPath, await readFile(path.join(original, 'config.test.mjs')));
    try {
      try { codeValidation = { passed: true, log: execFileSync(process.execPath, ['--test', 'config.test.mjs'], { cwd: final, timeout: 10_000, windowsHide: true, encoding: 'utf8' }) }; }
      catch (error) { codeValidation = { passed: false, log: String((error as { stdout?: string }).stdout ?? error) }; }
    } finally { await writeFile(testPath, tests.content); }
  }
  return { patch: source?.encoding === 'utf8' ? source.content : undefined, codeValidation, workspaceEvidence };
}
