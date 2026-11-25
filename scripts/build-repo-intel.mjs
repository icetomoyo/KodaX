// Builds the RepoIntel engine and stages it in dist/repo-intel/<platform>-<arch>/
// with its licence and third-party notices. Only the GitHub Release archives
// carry it (build-binary copies it beside the standalone binary); dist/repo-intel
// is not in package.json "files", so the npm package never does.
//
// Linux release builds compile in the glibc 2.17 container first
// (`node scripts/build-linux-native.mjs repo-intel`) and set KODAX_NATIVE_PREBUILT=1.

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const crate = path.join(root, 'native', 'repo-intel');
const LICENSE_FILE = /^(licen[cs]e|copying|notice)/i;

/**
 * The packages compiled into the program, sorted by name: normal dependencies
 * reachable from the crate. Proc-macros only run while compiling, so they and
 * what only they use are left out.
 */
export function noticePackages(metadata) {
  const nodes = new Map(metadata.resolve.nodes.map(node => [node.id, node]));
  const procMacros = new Set(metadata.packages
    .filter(pkg => pkg.targets?.some(target => target.kind.includes('proc-macro')))
    .map(pkg => pkg.id));
  const reached = new Set();
  const visit = (id) => {
    for (const dep of nodes.get(id)?.deps ?? []) {
      if (reached.has(dep.pkg) || procMacros.has(dep.pkg) || !dep.dep_kinds.some(kind => kind.kind === null)) continue;
      reached.add(dep.pkg);
      visit(dep.pkg);
    }
  };
  visit(metadata.resolve.root);
  return metadata.packages.filter(pkg => reached.has(pkg.id)).sort((a, b) => a.name.localeCompare(b.name));
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: crate, env: process.env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with exit ${result.status}: ${result.stderr}`);
  return result.stdout;
}

function rustTarget(targetArch) {
  if (process.platform === 'linux') return targetArch === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu';
  if (process.platform === 'darwin') return targetArch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  if (targetArch !== process.arch) throw new Error(`The Windows engine must be built on its target architecture, not for ${targetArch}.`);
  return /^host: (.+)$/m.exec(run('rustc', ['-vV']))?.[1]?.trim();
}

/**
 * A package's licence texts. Some published crates leave theirs out; those are
 * kept in native/repo-intel/licenses/<name>.txt, copied from the upstream repository.
 */
function licenceTexts(pkg) {
  const directory = path.dirname(pkg.manifest_path);
  const files = readdirSync(directory).filter(name => LICENSE_FILE.test(name)).sort();
  if (files.length > 0) return files.map(name => `--- ${name} ---\n${readFileSync(path.join(directory, name), 'utf8').trim()}`);
  const kept = path.join(crate, 'licenses', `${pkg.name}.txt`);
  if (!existsSync(kept)) {
    throw new Error(`${pkg.name} ${pkg.version} publishes no licence file. Copy it from ${pkg.repository ?? 'its repository'} to ${path.relative(root, kept)}.`);
  }
  return [`--- LICENSE (from ${pkg.repository ?? 'the upstream repository'}) ---\n${readFileSync(kept, 'utf8').trim()}`];
}

function notices(target) {
  const metadata = JSON.parse(run(process.env.CARGO || 'cargo', ['metadata', '--format-version', '1', '--locked', '--filter-platform', target]));
  const sections = noticePackages(metadata).map((pkg) => {
    const source = pkg.repository ? `\nSource: ${pkg.repository}` : '';
    return `=== ${pkg.name} ${pkg.version} (${pkg.license ?? 'see licence files'}) ===${source}\n${licenceTexts(pkg).join('\n\n')}`;
  });
  return `Third-party software in the KodaX RepoIntel engine\n\n${sections.join('\n\n')}\n`;
}

function main() {
  const targetArch = process.env.KODAX_NATIVE_TARGET_ARCH ?? process.arch;
  const prebuilt = process.env.KODAX_NATIVE_PREBUILT === '1';
  if (prebuilt && process.platform !== 'linux') throw new Error('KODAX_NATIVE_PREBUILT is only valid for Linux builds.');
  const target = rustTarget(targetArch);
  const program = `kodax-repo-intel${process.platform === 'win32' ? '.exe' : ''}`;
  const crossTarget = process.platform === 'win32' ? [] : ['--target', target];
  if (!prebuilt) run(process.env.CARGO || 'cargo', ['build', '--release', '--locked', ...crossTarget]);
  const built = path.join(crate, prebuilt ? 'target-manylinux-2.17' : 'target', ...(crossTarget.length ? [target] : []), 'release', program);
  if (!existsSync(built)) throw new Error(`The engine was not built at ${built}.`);

  const output = path.join(root, 'dist', 'repo-intel', `${process.platform}-${targetArch}`);
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  copyFileSync(built, path.join(output, program));
  copyFileSync(path.join(crate, 'LICENSE-APACHE'), path.join(output, 'LICENSE-APACHE-repo-intel.txt'));
  writeFileSync(path.join(output, 'THIRD-PARTY-NOTICES-repo-intel.txt'), notices(target), 'utf8');
  process.stdout.write(`[build-repo-intel] staged ${path.relative(root, output)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[build-repo-intel] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
