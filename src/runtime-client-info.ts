/** Display classification only; never authority for process control. */
export type RuntimeDaemonClientType = 'app' | 'cli' | 'diagnostic' | 'automation' | 'unknown';

export interface RuntimeClientInfo {
  readonly name: string;
  /** Stable host-generated identity used only after daemon authentication. */
  readonly instanceId?: string;
  /** Stable host-generated secret; persist in OS keychain to resume client-owned leases. */
  readonly instanceSecret?: string;
  readonly title?: string;
  readonly version?: string;
  /** Display-only classification; never use it for authorization or process control. */
  readonly clientType?: RuntimeDaemonClientType;
}
