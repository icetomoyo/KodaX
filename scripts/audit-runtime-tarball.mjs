#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function runTar(args) {
  const result = spawnSync('tar', args, {
    encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, shell: false,
  });
  if (result.status !== 0) {
    throw new Error(`tar failed: ${result.error?.message ?? result.stderr ?? result.stdout}`);
  }
  return result.stdout;
}

export function auditRuntimeTarball(tarballPath, options = {}) {
  const absoluteTarball = resolve(tarballPath);
  if (!existsSync(absoluteTarball)) throw new Error(`Tarball does not exist: ${absoluteTarball}`);
  // Windows bsdtar interprets drive prefixes as remote hosts; keep same-drive paths relative.
  const cwdRelative = relative(process.cwd(), absoluteTarball);
  const tarPath = cwdRelative.includes(':') ? absoluteTarball.replaceAll('\\', '/') : cwdRelative;
  const archiveEntries = runTar(['-tf', tarPath]).split(/\r?\n/);
  for (const required of ['package/dist/builtin/visual-review/SKILL.md', ...(options.requiredEntries ?? [])]) {
    if (!archiveEntries.includes(required)) throw new Error(`Tarball is missing required entry: ${required}`);
  }
  const pkg = JSON.parse(runTar(['-xOf', tarPath, 'package/package.json']));
  if (pkg.name !== '@kodax-ai/kodax') throw new Error('Expected the single @kodax-ai/kodax distribution.');
  const artifactEntries = [
    'package/dist/artifacts/dist/runtime-entry.js',
    'package/dist/artifacts/dist/docx.browser.js',
    'package/dist/artifacts/skills/artifact-review/SKILL.md',
    'package/dist/artifacts/LICENSE',
  ];
  for (const subpath of ['./artifacts', './artifacts/client', './artifacts/runtime', './artifacts/kodax']) {
    for (const condition of ['types', 'import']) {
      const target = pkg.exports?.[subpath]?.[condition];
      if (typeof target !== 'string' || !target.startsWith('./dist/artifacts/') || target.includes('..')) {
        throw new Error(`Missing or invalid Artifact export: ${subpath} ${condition}`);
      }
      artifactEntries.push(`package/${target.slice(2)}`);
    }
  }
  for (const entry of artifactEntries) {
    if (!archiveEntries.includes(entry)) throw new Error(`Tarball is missing required entry: ${entry}`);
    if (!runTar(['-xOf', tarPath, entry]).trim()) throw new Error(`Tarball has an empty required entry: ${entry}`);
  }
  for (const dependency of ['@aiden0z/pptx-renderer', 'docx-renderer', 'fast-xml-parser', 'jszip', 'pdfjs-dist', 'playwright-core', 'pngjs', 'pptxgenjs']) {
    if (typeof pkg.dependencies?.[dependency] !== 'string') throw new Error(`Missing Artifact dependency: ${dependency}`);
  }
  const entries = archiveEntries.filter(entry => entry.startsWith('package/dist/') && entry.endsWith('.js'));
  if (entries.length === 0) throw new Error('Tarball contains no package/dist/*.js bundle entries');
  for (const entry of entries) {
    const source = runTar(['-xOf', tarPath, entry]);
    for (const retired of ['You are a verification sidecar for an autonomous coding agent.',
      'emit_sidecar_verdict', 'KODAX_VERIFIER_LOG', 'KODAX_VERIFIER_PROVIDER', 'KODAX_VERIFIER_MODEL']) {
      if (source.includes(retired)) throw new Error(`${entry}: retired verifier runtime remains: ${retired}`);
    }
  }
  return { tarball: absoluteTarball, bundleEntries: entries.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!process.argv[2]) throw new Error('Usage: node scripts/audit-runtime-tarball.mjs <package.tgz>');
    const result = auditRuntimeTarball(process.argv[2]);
    process.stdout.write(`Runtime tarball audit passed: ${result.bundleEntries} bundle(s).\n`);
  } catch (error) {
    process.stderr.write(`[runtime-tarball-audit] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
