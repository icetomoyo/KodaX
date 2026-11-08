/** A separate trusted Main whose process is killed by the public SDK recovery test. */
import { connectKodaXClient } from '../src/sdk-client.js';
import type { ClientSubmitInput } from '@kodax-ai/coding/client-contract';

let bindingId: string | undefined;
const client = await connectKodaXClient({ homeDir: process.argv[2]!, endpoint: process.argv[3]!,
  clientInfo: { name: 'Input owner', instanceId: 'input-owner', instanceSecret: 'owner'.repeat(16) },
  async authorizeExecution(_request, services) {
    bindingId ??= (await services.executionBindings.register(async (_input, scoped) => {
      const credential = await scoped.credentials.registerScoped({ providers: ['input-fixture'] }, async () => 'fixture-only');
      return { credential: { mode: 'scoped', leaseId: credential.id, providers: ['input-fixture'] },
        businessBinding: { id: 'input-expert', revision: '1' }, profile: {} };
    })).id;
    return { binding: { leaseId: bindingId } };
  },
});
process.on('message', async (message: { input: ClientSubmitInput }) => {
  try { process.send?.({ result: await client.inputs.submit(message.input) }); }
  catch (error: unknown) { process.send?.({ error: error instanceof Error ? error.message : String(error) }); }
});
process.send?.({ ready: true, pid: process.pid });
