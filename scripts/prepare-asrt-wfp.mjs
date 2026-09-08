import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const relativeSource = 'dist/sandbox/windows-sandbox-utils.js';
const originalHash = 'c9c03bce99b66882a7f605fc0494c7f0058abf8ecadc1bbc028994feb4d26852';
const patchedHash = '05936a46660ca29eae3568cd0e8ba6edc2ad1848b9ed7a31c33c7481e181afc9';
const readSource = (file) => readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
const hash = (source) => createHash('sha256').update(source).digest('hex');

function patchedSource(source) {
  const staging = mkdtempSync(path.join(tmpdir(), 'kodax-asrt-wfp-'));
  try {
    const file = path.join(staging, relativeSource);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, source);
    execFileSync('git', ['apply', '--ignore-whitespace', path.join(
      root, 'docs/patches/asrt-0.0.65-wfp-probe.patch',
    )], { cwd: staging, windowsHide: true, stdio: 'pipe' });
    const patched = readSource(file);
    if (hash(patched) !== patchedHash) throw new Error('ASRT WFP patch output does not match the audited source.');
    return patched;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

// Build/pack only. Never modify dependencies while SDK commands are running.
export function prepareAsrtWfp() {
  const require = createRequire(path.join(root, 'package.json'));
  const manifest = require.resolve('@anthropic-ai/sandbox-runtime/package.json');
  if (JSON.parse(readFileSync(manifest, 'utf8')).version !== '0.0.65') {
    throw new Error('The ASRT WFP patch requires the audited 0.0.65 release.');
  }
  const target = path.join(path.dirname(manifest), relativeSource);
  const source = readSource(target);
  if (hash(source) === patchedHash) return;
  if (hash(source) !== originalHash) throw new Error('Installed ASRT WFP source differs from the audited release.');
  const patched = patchedSource(source);
  // Replace the file rather than editing a package-manager cache hardlink.
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, patched, { flag: 'wx' });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  prepareAsrtWfp();
}
