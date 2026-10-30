import { createKodaXRuntime } from '@kodax-ai/kodax/runtime';
import { createKodaXRuntime as createFromRoot } from '@kodax-ai/kodax';

void createKodaXRuntime({ mode: 'daemon', execPolicy: { adminRules: [] }, autoReview: { administratorPolicy: 'Keep private.' } });
void createFromRoot({ mode: 'daemon' });
// @ts-expect-error Private runtime creation is no longer a public contract.
void createKodaXRuntime();
// @ts-expect-error Embedded ownership is retired.
void createKodaXRuntime({ mode: 'embedded' });
// @ts-expect-error Internal Host construction cannot be requested by an SDK client.
void createKodaXRuntime({ mode: 'daemon', sharedDaemonHost: true });
// @ts-expect-error In-process executor injection cannot start a hidden Host.
void createKodaXRuntime({ mode: 'daemon', externalAgents: undefined });
// @ts-expect-error Root entry must not retain the retired constructor overload.
void createFromRoot({ mode: 'embedded' });
// @ts-expect-error The internal owner constructor is not publicly exported.
import { createKodaXHostRuntime } from '@kodax-ai/kodax/runtime';
// @ts-expect-error Inline rollback is not publicly exported.
import { acquireKodaXInlineOwner } from '@kodax-ai/kodax';
