export interface TextSnapshot {
  readonly state: 'missing' | 'present';
  readonly content: string;
  readonly revision: string;
  readonly slotId: string;
  readonly canonicalPath: string;
}

export interface CommitOutcome {
  readonly status: 'written' | 'stale' | 'committed_uncertain';
  readonly slotId?: string;
  readonly currentRevision?: string;
  readonly preContent?: string;
  readonly preRevision?: string;
  readonly postRevision?: string;
  readonly abandonedLock?: boolean;
  readonly message?: string;
}

export declare const textTransactionProtocol: 4;

export declare class TrustedTextTransactionRoot {
  constructor(rootPath: string, stateRoot?: string);
  snapshot(target: string): Promise<TextSnapshot>;
  commit(
    target: string,
    expectedRevision: string,
    content: string,
    createParents: boolean,
    timeoutMs: number,
  ): Promise<CommitOutcome>;
}
