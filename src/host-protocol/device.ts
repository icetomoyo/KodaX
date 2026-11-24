/**
 * The browsers paired with this Host, managed by its owner on the same
 * machine. A browser that opens the pairing link with the code trades it for a
 * device credential, and connects as `user` from then on, from the origin it
 * paired from. Only a Host that listens on the network and has pairing on
 * issues codes.
 */
import { z } from 'zod/v4';

import { HostId, hostCommandParams, hostList, hostParams, hostResult, type HostMethodRegistry } from './schema.js';

const Device = z.object({
  id: z.string(),
  /** What the owner called it when pairing. */
  name: z.string(),
  /** The browser origin it paired from, such as the tunnel's address. It connects from there only. */
  origin: z.string(),
  pairedAt: z.int(),
  lastSeenAt: z.int(),
});

export const DEVICE_METHODS = {
  /**
   * A one-time code that pairs one browser. Open `<address>/#pair=<code>` on
   * it before `expiresAt`. Sending the same `requestId` again answers with the
   * same code while it is good.
   */
  'device.pair': {
    primitive: 'command',
    resend: 'auto',
    plane: 'local',
    params: hostCommandParams({ name: z.string().trim().min(1).max(64) }),
    result: hostResult({ code: z.string(), expiresAt: z.int() }),
  },
  /** The devices paired with the Host. */
  'device.list': { primitive: 'query', plane: 'local', params: hostParams({}), result: hostList(Device) },
  /** Its connections close as `revoked`. A device that is not paired, such as one already revoked, answers the same. */
  'device.revoke': {
    primitive: 'command',
    resend: 'auto',
    plane: 'local',
    params: hostCommandParams({ deviceId: HostId }),
    result: hostResult({}),
  },
} as const satisfies HostMethodRegistry;
