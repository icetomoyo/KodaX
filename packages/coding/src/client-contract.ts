/** Product data shared by SDK clients and UIs; independent of Host implementation. */
export interface ClientSession {
  readonly id: string;
  readonly title: string;
  readonly gitRoot?: string;
  readonly workspaceRoot?: string;
  readonly surface?: string;
  readonly profileId?: string;
  readonly createdAt?: string;
}

export interface ClientSessionSummary extends ClientSession {
  /** Opaque continuation token for list pagination. */
  readonly cursor?: string;
  readonly msgCount: number;
  readonly tag?: string;
  readonly projectKey?: string;
  readonly archived?: boolean;
}

export interface ClientSessionFilter {
  readonly projectRoot?: string;
  readonly scope?: 'user' | 'managed-task-worker' | 'all';
  readonly includeArchived?: boolean;
  readonly limit?: number;
  readonly before?: string;
  readonly tag?: string;
  readonly surface?: string;
  readonly cursor?: string;
}

export interface KodaXProductClient {
  readonly sessions: {
    list(filter?: ClientSessionFilter): Promise<readonly ClientSessionSummary[]>;
    read(sessionId: string): Promise<ClientSession>;
  };
  /** Release this connection. The Host and its work retain their own lifetime. */
  disconnect(): Promise<void>;
}
