import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { InkClientPlane } from '../client-plane.js';
import type { TranscriptSnapshot } from '../utils/transcript-surface.js';
import type { PromptBrowseAnchor, PromptBrowseWindow } from '../utils/prompt-history-browse.js';
import { readPromptBrowseWindow } from '../utils/prompt-history-browse.js';

interface BrowseDisplay {
  readonly snapshot: TranscriptSnapshot;
  readonly window?: PromptBrowseWindow;
  readonly anchor?: PromptBrowseAnchor;
  readonly hint: string;
}

/** Own only the ordinary transcript body; prompt and execution controls stay live. */
export function usePromptHistoryBrowse(
  plane: Pick<InkClientPlane, 'readHistory' | 'readHistoryEntry'> | undefined,
  sessionId: string | undefined,
  enabled: boolean,
) {
  const [display, setDisplay] = useState<BrowseDisplay | null>(null);
  const current = useRef(display);
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const reset = useCallback(() => {
    generation.current++;
    request.current?.abort();
    request.current = null;
    current.current = null;
    setDisplay(null);
  }, []);
  useLayoutEffect(() => { reset(); return reset; }, [sessionId, enabled, plane, reset]);

  const browse = useCallback((snapshot: TranscriptSnapshot, anchor: PromptBrowseAnchor | undefined,
    atBoundary: boolean, direction: 'older' | 'newer' = 'older') => {
    if (!enabled || !plane || !sessionId || request.current) return;
    const captured = current.current ?? { snapshot, hint: 'Browsing saved content · End: latest' };
    current.current = captured;
    setDisplay(captured);
    if (!atBoundary || (direction === 'older' && captured.window && !captured.window.nextCursor)) return;
    if (!anchor) {
      setDisplay({ ...captured, hint: 'Cannot locate this position in saved history · End: latest' });
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    const started = generation.current;
    setDisplay({ ...captured, hint: `Loading ${direction === 'older' ? 'earlier' : 'newer'} history · End: latest` });
    void readPromptBrowseWindow(plane, sessionId, anchor, captured.window, controller.signal, direction)
      .then(window => {
        if (generation.current !== started || controller.signal.aborted) return;
        const hasPreviews = window.items.some(item => item.totalTextLength !== undefined);
        const next: BrowseDisplay = { window, anchor,
          hint: hasPreviews ? 'Saved previews · Ctrl+O: full transcript · ↑: earlier · End: latest'
            : 'Browsing saved content · ↑: earlier · End: latest',
          snapshot: { ...captured.snapshot, items: window.items, isLoading: false, isThinking: false,
            currentResponse: '', thinkingContent: '', activeToolCalls: [], currentTool: undefined,
            iterationHistory: [], managedLiveEvents: [], isCompacting: false, lastLiveActivityLabel: undefined } };
        current.current = next;
        setDisplay(next);
      }).catch((error: unknown) => {
        if (generation.current !== started || controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        setDisplay({ ...captured, hint: `${message} · ↑: retry · End: latest` });
      }).finally(() => {
        if (request.current === controller) request.current = null;
      });
  }, [enabled, plane, sessionId]);
  return { display, browse, reset, loading: () => request.current !== null };
}
