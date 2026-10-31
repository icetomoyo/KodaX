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

export function createKodaXRuntime(options: RuntimeFixtureOptions & { readonly mode: 'daemon' }): Promise<KodaXDaemonRuntime>;
export function createKodaXRuntime(options?: RuntimeFixtureOptions): Promise<KodaXRuntime>;
export function createKodaXRuntime(options: RuntimeFixtureOptions = {}): Promise<KodaXRuntime> {
  return options.mode === 'daemon'
    ? launchRuntime({ ...options, mode: 'daemon' })
    : createKodaXHostRuntime({ ...options, mode: options.mode });
}
