import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertHostDataRoot, servedHostDataRoot } from './host-data-root.js';

const home = path.resolve('/srv/tenant-a');
const own = path.join(home, '.kodax');

describe('servedHostDataRoot', () => {
  it('names the Host\'s own data root for every command that runs a Host in this process', () => {
    expect(servedHostDataRoot(['host', 'serve', '--home', home])).toBe(own);
    expect(servedHostDataRoot(['daemon', 'serve', `--home=${home}`])).toBe(own);
    expect(servedHostDataRoot(['a2a', 'serve', '--port', '9000', '--home', home])).toBe(own);
  });

  it('takes --config-home over --home, as the serve command does', () => {
    const configHome = path.resolve('/srv/tenant-a-config');
    expect(servedHostDataRoot(['host', 'serve', '--config-home', configHome, '--home', home])).toBe(configHome);
  });

  it('names nothing when the command keeps the default root or runs no Host here', () => {
    expect(servedHostDataRoot(['host', 'serve'])).toBeUndefined();
    expect(servedHostDataRoot(['host', 'start', '--home', home])).toBeUndefined();
    expect(servedHostDataRoot(['-p', 'host serve --home x'])).toBeUndefined();
    expect(servedHostDataRoot(['host', 'serve', '--', '--home', home])).toBeUndefined();
  });
});

describe('assertHostDataRoot', () => {
  it('lets a Host serve when this process reads its own data root', () => {
    expect(() => assertHostDataRoot(own, [own, path.join(home, '.kodax', '.')])).not.toThrow();
  });

  it('refuses to serve from another root, so no Host reads or changes another\'s data', () => {
    const shared = path.resolve('/home/owner/.kodax');
    expect(() => assertHostDataRoot(own, [own, shared])).toThrow(`KODAX_HOME=${own}`);
  });
});
