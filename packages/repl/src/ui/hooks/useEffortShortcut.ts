import { useCallback, useEffect, useRef, useState } from 'react';
import type { CommandResultData } from '../../commands/types.js';
import type { ClipboardToastSurfaceProps } from '../components/ClipboardToastSurface.js';

/** Feedback for the effort hotkey; slash commands retain their detailed receipts. */
export function useEffortShortcut(
  selectNext: (signal: AbortSignal) => Promise<CommandResultData | undefined>,
  reportError: (message: string) => Promise<void>,
  sessionId: string,
): { cycle: () => Promise<void>; cancel: () => void; notice: ClipboardToastSurfaceProps | undefined } {
  const [notice, setNotice] = useState<ClipboardToastSurfaceProps>();
  const queue = useRef(Promise.resolve());
  const latest = useRef(0);
  const lifetime = useRef<AbortController>(undefined);
  const cancel = useCallback(() => { lifetime.current?.abort(); setNotice(undefined); }, []);
  useEffect(() => {
    const owner = new AbortController();
    lifetime.current = owner;
    queue.current = Promise.resolve();
    setNotice(undefined);
    return () => owner.abort();
  }, [sessionId]);
  useEffect(() => {
    if (!notice || notice.pending) return;
    const timer = setTimeout(() => setNotice(current => current === notice ? undefined : current), 2000);
    return () => clearTimeout(timer);
  }, [notice]);
  const cycle = (): Promise<void> => {
    const owner = lifetime.current;
    if (!owner || owner.signal.aborted) return Promise.resolve();
    const request = ++latest.current;
    setNotice({ text: 'Updating effort…', pending: true });
    const write = async () => {
      if (owner.signal.aborted) return;
      let result: CommandResultData | undefined;
      try { result = await selectNext(owner.signal); }
      catch (error) { result = { success: false, message: `Host effort selection failed: ${String(error)}` }; }
      if (owner.signal.aborted) return;
      if (request === latest.current) setNotice(result?.success ? { text: result.message } : undefined);
      if (result && !result.success) await reportError(result.message ?? 'Host effort selection failed');
    };
    queue.current = queue.current.then(write, write);
    return queue.current;
  };
  return { cycle, cancel, notice };
}
