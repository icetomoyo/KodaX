import { describe, expect, it } from 'vitest';

import { describeProxyEnvironmentGap } from './proxy-environment.js';

const node = (version: string) => ({ node: version });
const bun = { node: '24.3.0', bun: '1.4.4' };

describe('describeProxyEnvironmentGap', () => {
  it('stays silent without a proxy variable', () => {
    expect(describeProxyEnvironmentGap({}, node('20.20.2'), [])).toBeUndefined();
    expect(describeProxyEnvironmentGap({ NO_PROXY: 'localhost' }, node('22.23.1'), [])).toBeUndefined();
  });

  it('tells Node 20 users to upgrade or use the binary', () => {
    const message = describeProxyEnvironmentGap({ HTTPS_PROXY: 'http://p:1', NODE_USE_ENV_PROXY: '1' }, node('20.20.2'), []);
    expect(message).toMatch(/Node 20\.20\.2/);
    expect(message).toMatch(/22\.21/);
    expect(message).toMatch(/24\.5/);
    expect(message).toMatch(/binary/);
  });

  it.each(['22.20.0', '24.4.1', '23.11.0'])('treats Node %s as lacking http/https proxy support', (version) => {
    expect(describeProxyEnvironmentGap({ https_proxy: 'http://p:1' }, node(version), [])).toMatch(/binary/);
  });

  it.each(['22.21.0', '24.5.0', '25.1.0'])('asks Node %s users to set NODE_USE_ENV_PROXY', (version) => {
    const message = describeProxyEnvironmentGap({ HTTP_PROXY: 'http://p:1' }, node(version), []);
    expect(message).toMatch(/NODE_USE_ENV_PROXY=1/);
    expect(message).toMatch(/restart/i);
    expect(message).not.toMatch(/binary/);
  });

  it('stays silent when Node already uses the environment proxy', () => {
    expect(describeProxyEnvironmentGap({ HTTPS_PROXY: 'http://p:1', NODE_USE_ENV_PROXY: '1' }, node('22.23.1'), [])).toBeUndefined();
    expect(describeProxyEnvironmentGap({ HTTPS_PROXY: 'http://p:1' }, node('24.17.0'), ['--use-env-proxy'])).toBeUndefined();
    expect(describeProxyEnvironmentGap({ HTTPS_PROXY: 'http://p:1', NODE_OPTIONS: '--max-old-space-size=4096 --use-env-proxy' },
      node('24.17.0'), [])).toBeUndefined();
  });

  it('tells binary users that only web_fetch still needs NODE_USE_ENV_PROXY', () => {
    const message = describeProxyEnvironmentGap({ HTTPS_PROXY: 'http://p:1' }, bun, []);
    expect(message).toMatch(/web_fetch/);
    expect(message).toMatch(/NODE_USE_ENV_PROXY=1/);
    expect(describeProxyEnvironmentGap({ HTTPS_PROXY: 'http://p:1', NODE_USE_ENV_PROXY: '1' }, bun, [])).toBeUndefined();
  });

  it('names the variable without echoing its value, which can hold credentials', () => {
    const message = describeProxyEnvironmentGap({ HTTPS_PROXY: 'http://user:secret@p:1' }, node('22.23.1'), []);
    expect(message).toContain('HTTPS_PROXY');
    expect(message).not.toContain('secret');
  });
});
