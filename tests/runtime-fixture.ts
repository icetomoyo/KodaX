/** Internal core fixture. Product/packaging tests must import the public SDK instead. */
export * from '../src/sdk-runtime.js';
import {
  createKodaXHostRuntime,
  createKodaXRuntime as launchRuntime,
  type CreateKodaXHostRuntimeOptions,
  type KodaXDaemonRuntime,
  type KodaXRuntime,
} from '../src/sdk-runtime.js';

type RuntimeFixtureOptions = Omit<CreateKodaXHostRuntimeOptions, 'mode'> & {
  readonly mode?: 'embedded' | 'daemon';
};

/** Daemon clients connect to the one Host of their home; only an in-process Host can stand in for a legacy slot. */
export function createKodaXRuntime(options: Omit<RuntimeFixtureOptions, 'profile'> & { readonly mode: 'daemon'; readonly profile?: never }): Promise<KodaXDaemonRuntime>;
export function createKodaXRuntime(options?: RuntimeFixtureOptions & { readonly mode?: 'embedded' }): Promise<KodaXRuntime>;
export function createKodaXRuntime(options: RuntimeFixtureOptions = {}): Promise<KodaXRuntime> {
  return options.mode === 'daemon'
    ? launchRuntime({ ...options, mode: 'daemon' })
    : createKodaXHostRuntime({ ...options, mode: options.mode });
}
