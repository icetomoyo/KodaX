/** Host-owned user Stop; acceptance is distinct from execution settlement. */
export interface RuntimeStopControl {
  request(): Promise<{ readonly state: 'unknown' | 'confirmed' }>;
}

export interface RuntimeStopCallbacks {
  readonly onStopControl?: (control: RuntimeStopControl | undefined) => void;
  readonly onStopState?: (
    state: 'requesting' | 'accepted' | 'confirmed' | 'rejected',
    detail?: string,
  ) => void;
}
