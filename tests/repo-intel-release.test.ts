import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { noticePackages } from '../scripts/build-repo-intel.mjs';

interface Step {
  readonly name?: string;
  readonly run?: string;
  readonly if?: string;
  readonly env?: Readonly<Record<string, unknown>>;
}

const releaseSteps = (): readonly Step[] => {
  const workflow = parse(readFileSync(resolve('.github/workflows/release.yml'), 'utf8')) as {
    jobs: { build: { steps: Step[] } };
  };
  return workflow.jobs.build.steps;
};

describe('RepoIntel engine release (design §9: GitHub Release archives only, never npm)', () => {
  it('builds the engine on every release runner, Linux at the glibc 2.17 floor, and tests it there', () => {
    const steps = releaseSteps();
    const index = (name: string) => steps.findIndex(step => step.name === name);
    expect(steps[index('Compile Linux RepoIntel engine for glibc 2.17')]).toMatchObject({
      if: expect.stringContaining("runner.os == 'Linux'"),
      run: 'node scripts/build-linux-native.mjs repo-intel',
    });
    const build = steps[index('Build RepoIntel engine')];
    expect(build?.run).toBe('npm run build:repo-intel');
    expect(build?.if).not.toContain('runner.os');
    expect(build?.env).toMatchObject({ KODAX_NATIVE_PREBUILT: expect.stringContaining("runner.os == 'Linux'") });
    expect(index('Build RepoIntel engine')).toBeGreaterThan(index('Build'));
    expect(index('Build RepoIntel engine')).toBeLessThan(steps.findIndex(step => step.name?.startsWith('Build binary')));

    const tests = steps[index('RepoIntel engine tests')];
    expect(tests?.run).toContain('cargo test');
    expect(tests?.run).toContain('native/repo-intel/Cargo.toml');
    expect(tests?.if).not.toContain('runner.os');

    expect(steps[index('Enforce Linux glibc 2.17 ABI')]?.run).toContain('dist/repo-intel/${{ matrix.native_dir }}/kodax-repo-intel');
    expect(steps[index('Package archive')]?.run).toContain('kodax-repo-intel');
  });

  it('stages the engine beside the standalone binary and smokes it from there', () => {
    const builder = readFileSync(resolve('scripts/build-binary.mjs'), 'utf8');
    expect(builder).toContain("'dist', 'repo-intel'");
    expect(builder).toContain('KODAX_REPO_INTELLIGENCE_ENGINE');
    // `npm run build:binary` rebuilds the bundles first; that must not delete the staged engine.
    expect(readFileSync(resolve('scripts/build-bundle.mjs'), 'utf8')).toContain("entry === 'repo-intel'");
  });

  it('keeps the engine out of the npm package and out of the everyday build', () => {
    const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { scripts: Record<string, string>; files: string[] };
    expect(pkg.scripts['build:repo-intel']).toBe('node scripts/build-repo-intel.mjs');
    expect(pkg.scripts.build).not.toContain('repo-intel');
    expect(pkg.files.some(entry => entry.includes('repo-intel'))).toBe(false);
  });

  it('fails the npm tarball audit when the engine slips in', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'kodax-repo-intel-tarball-'));
    try {
      const program = join(scratch, 'package', 'dist', 'native', 'linux-x64');
      mkdirSync(program, { recursive: true });
      writeFileSync(join(program, 'kodax-repo-intel'), 'not really a program');
      const tarball = join(scratch, 'kodax.tgz');
      const packed = spawnSync('tar', ['-czf', 'kodax.tgz', 'package'], { cwd: scratch, encoding: 'utf8' });
      expect(packed.status, packed.stderr).toBe(0);
      const audited = spawnSync(process.execPath, [resolve('scripts/audit-runtime-tarball.mjs'), tarball], { cwd: scratch, encoding: 'utf8' });
      expect(audited.status).toBe(1);
      expect(audited.stderr).toContain('package/dist/native/linux-x64/kodax-repo-intel');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe('noticePackages', () => {
  const pkg = (name: string) => ({
    id: `${name}-id`, name, version: '1.0.0', license: 'MIT', manifest_path: `/r/${name}/Cargo.toml`,
    targets: [{ kind: [name === 'derive' ? 'proc-macro' : 'lib'] }],
  });
  const dep = (name: string, kinds: (string | null)[]) => ({ pkg: `${name}-id`, dep_kinds: kinds.map(kind => ({ kind })) });

  it('lists the packages compiled into the program: normal dependencies reachable from the engine', () => {
    const metadata = {
      packages: ['engine', 'sqlite', 'cc', 'tempfile', 'shared', 'helper', 'derive', 'syn'].map(pkg),
      resolve: {
        root: 'engine-id',
        nodes: [
          { id: 'engine-id', deps: [dep('sqlite', [null]), dep('tempfile', ['dev']), dep('shared', [null, 'build']), dep('derive', [null])] },
          { id: 'sqlite-id', deps: [dep('cc', ['build']), dep('helper', [null])] },
          { id: 'derive-id', deps: [dep('syn', [null])] },
          { id: 'shared-id', deps: [] },
          { id: 'helper-id', deps: [] },
          { id: 'cc-id', deps: [] },
          { id: 'tempfile-id', deps: [] },
          { id: 'syn-id', deps: [] },
        ],
      },
    };
    expect(noticePackages(metadata).map(found => found.name)).toEqual(['helper', 'shared', 'sqlite']);
  });
});
