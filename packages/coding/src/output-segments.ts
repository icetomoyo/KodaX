export type KodaXOutputSegmentMode = 'replace' | 'append';

export interface KodaXOutputSegmentStarted {
  readonly responseId: string;
  /** Assistant message being generated; distinct from its owning Turn and physical requests. */
  readonly outputId?: string;
  readonly providerRequestId: string;
  readonly mode: KodaXOutputSegmentMode;
}

export interface KodaXOutputSegmentDelta {
  readonly providerRequestId: string;
  readonly text: string;
}

export interface KodaXOutputSegmentActiveState {
  readonly responseId: string;
  readonly providerRequestId: string;
  readonly mode: KodaXOutputSegmentMode;
  /** Runtime journal sequence of the segment start, when the reducer has one. */
  readonly startedAtSeq?: number;
  readonly assistantText: string;
  readonly thinkingText: string;
}

export interface KodaXOutputSegmentProjection {
  /** Effective append segments in provider-call order. Replaced segments are never retained. */
  readonly retained: readonly KodaXOutputSegmentActiveState[];
  readonly active?: KodaXOutputSegmentActiveState;
}

export type KodaXOutputSegmentProjectionEvent =
  | ({ readonly type: 'segment.started'; readonly startedAtSeq?: number } &
      KodaXOutputSegmentStarted)
  | ({ readonly type: 'assistant.delta' } & KodaXOutputSegmentDelta)
  | ({ readonly type: 'thinking.delta' } & KodaXOutputSegmentDelta);

export interface KodaXOutputSegmentProjectionResult {
  readonly state: KodaXOutputSegmentProjection;
  readonly accepted: boolean;
}

export function createOutputSegmentProjection(): KodaXOutputSegmentProjection {
  return { retained: [] };
}

export function reduceOutputSegmentProjection(
  state: KodaXOutputSegmentProjection,
  event: KodaXOutputSegmentProjectionEvent,
): KodaXOutputSegmentProjectionResult {
  if (event.type === 'segment.started') {
    if (
      state.active?.responseId === event.responseId &&
      state.active.providerRequestId === event.providerRequestId &&
      state.active.mode === event.mode
    ) {
      return { state, accepted: true };
    }
    const currentResponseId =
      state.active?.responseId ?? state.retained[state.retained.length - 1]?.responseId;
    const sameResponse = currentResponseId === undefined || currentResponseId === event.responseId;
    const retainActive = event.mode === 'append' ? state.active : undefined;
    return {
      accepted: true,
      state: {
        retained: sameResponse
          ? (retainActive ? [...state.retained, retainActive] : state.retained)
          : [],
        active: {
          responseId: event.responseId,
          providerRequestId: event.providerRequestId,
          mode: event.mode,
          ...(event.startedAtSeq !== undefined ? { startedAtSeq: event.startedAtSeq } : {}),
          assistantText: '',
          thinkingText: '',
        },
      },
    };
  }

  if (state.active?.providerRequestId !== event.providerRequestId) {
    return { state, accepted: false };
  }
  return {
    accepted: true,
    state: {
      ...state,
      active: {
        ...state.active,
        ...(event.type === 'assistant.delta'
          ? { assistantText: state.active.assistantText + event.text }
          : { thinkingText: state.active.thinkingText + event.text }),
      },
    },
  };
}

export function effectiveOutputSegmentText(
  state: KodaXOutputSegmentProjection,
  kind: 'assistant' | 'thinking',
): string {
  const key = kind === 'assistant' ? 'assistantText' : 'thinkingText';
  return state.retained.map((segment) => segment[key]).join('') + (state.active?.[key] ?? '');
}
