import { describe, expect, it } from 'vitest';
import { extractBashIntent } from './bash-intent.js';

describe('extractBashIntent', () => {
  it('returns "bash" for empty input', () => {
    expect(extractBashIntent('')).toBe('bash');
    expect(extractBashIntent('   ')).toBe('bash');
  });

  it('returns simple commands as-is', () => {
    expect(extractBashIntent('git status')).toBe('git status');
    expect(extractBashIntent('npm test')).toBe('npm test');
    expect(extractBashIntent('ls -la')).toBe('ls -la');
  });

  it('skips cd prefix and takes the meaningful command', () => {
    expect(extractBashIntent('cd /path/to/project && git push origin main'))
      .toBe('git push origin main');
    expect(extractBashIntent('cd src && npm run build'))
      .toBe('npm build');
  });

  it('skips export prefix', () => {
    expect(extractBashIntent('export NODE_ENV=production && node server.js'))
      .toBe('node server.js');
  });

  it('handles multiple chained commands — takes last non-skip', () => {
    expect(extractBashIntent('cd /app && export FOO=1 && git commit -m "fix"'))
      .toBe('git commit -m "fix"');
  });

  it('strips leading env var assignments', () => {
    expect(extractBashIntent('DOCKER_BUILDKIT=1 docker build -t app .'))
      .toBe('docker build -t app .');
    expect(extractBashIntent('NODE_ENV=test CI=true npm test'))
      .toBe('npm test');
  });

  it('extracts core command from pipe chains', () => {
    expect(extractBashIntent('cat package.json | grep version | head -1'))
      .toBe('grep version');
    expect(extractBashIntent('echo "hello" | wc -l'))
      .toBe('wc -l');
  });

  it('normalizes npm run to npm shorthand', () => {
    expect(extractBashIntent('npm run test -- --coverage'))
      .toBe('npm test --coverage');
    expect(extractBashIntent('npm run build'))
      .toBe('npm build');
    expect(extractBashIntent('npm run lint -- --fix'))
      .toBe('npm lint --fix');
  });

  it('truncates long commands to 60 characters', () => {
    const longCommand = 'git log --oneline --graph --all --decorate --color=always --pretty=format:"%h %d %s (%cr) <%an>"';
    const result = extractBashIntent(longCommand);
    expect(result.length).toBeLessThanOrEqual(60);
    expect(result).toMatch(/…$/);
  });

  it('handles combined cd + env + pipe', () => {
    expect(extractBashIntent('cd /app && FOO=1 cat log.txt | grep ERROR'))
      .toBe('grep ERROR');
  });

  it('preserves single-segment commands with flags', () => {
    expect(extractBashIntent('git push --force-with-lease origin feature'))
      .toBe('git push --force-with-lease origin feature');
  });

  it('handles source prefix skip', () => {
    expect(extractBashIntent('source .env && node app.js'))
      .toBe('node app.js');
  });

  it('returns "bash" when all segments are skip prefixes', () => {
    expect(extractBashIntent('cd /app && pushd /src && export VAR=1'))
      .toBe('bash');
  });

  it('returns env var assignment as-is when no real command follows', () => {
    expect(extractBashIntent('DOCKER_BUILDKIT=1'))
      .toBe('DOCKER_BUILDKIT=1');
  });
});
