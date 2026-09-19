import { expect, it } from 'vitest';
import type { KodaXSessionData } from '@kodax-ai/agent';
import type { ClientSessionView } from '@kodax-ai/coding/client-contract';
import { clientViewToHistoryItems, type ClientViewItemMemo } from '../packages/repl/src/ui/client-plane.js';
import { buildTranscriptRows } from '../packages/repl/src/ui/utils/transcript-layout.js';
import { createClassicPlaneDisplayDiffer } from '../packages/repl/src/interactive/classic-plane-display.js';
import { appendPersistedUiHistorySnapshot } from '../packages/repl/src/ui/InkREPL.js';
import { SessionViewOwner, persistSessionViewItems, restoreSessionViewItems } from './session-view.js';

it.each(['revise', 'blocked', 'budget-exhausted'] as const)('preserves %s Verifier meaning in both consumers and restored history', async classification => {
  const owner = new SessionViewOwner(async () => ({ session: { id: 'session', title: 'Verifier' },
    settings: {}, items: [], queue: [], interactions: [], runs: [] }), async () => undefined);
  const events = owner.events('session', 'run');
  const lines: string[] = [];
  const classic = createClassicPlaneDisplayDiffer(line => lines.push(line));
  await classic([]);
  const verdict = classification === 'blocked' ? 'blocked' as const : 'revise' as const;
  const delivery = classification === 'budget-exhausted' ? classification
    : classification === 'blocked' ? 'terminal-block' as const : 'synthetic-user-message' as const;
  const event = { source: 'sidecar-verifier' as const, recipient: 'main-agent' as const,
    content: 'Check the result.', suggestedFix: 'Fix the assertion.', verdict, delivery };
  try {
    events.onSidecarMessage?.(event);
    let view: ClientSessionView | undefined;
    const observer = await owner.observe('session', next => { view = next; });
    observer.close();
    const items = view!.items;
    const header = `Sidecar Verifier — ${classification === 'budget-exhausted' ? 'budget exhausted' : classification}`;
    const data: KodaXSessionData = { messages: [], title: 'Verifier', gitRoot: '', uiHistory: persistSessionViewItems(items) };
    expect(restoreSessionViewItems('session', data)).toEqual(items);
    const inkHistory = appendPersistedUiHistorySnapshot([], clientViewToHistoryItems(items));
    expect(inkHistory[0]).toMatchObject({ sidecarVerdict: verdict, sidecarDelivery: delivery });
    expect(restoreSessionViewItems('session', { ...data, uiHistory: inkHistory })[0]?.sidecar).toEqual({ verdict, delivery });
    for (const displayed of [items, restoreSessionViewItems('session', data)]) {
      const ink = buildTranscriptRows({ items: clientViewToHistoryItems(displayed), viewportWidth: 120 });
      expect(ink.map(row => row.text).join('\n')).toContain(header);
      if (classification !== 'revise') expect(ink.some(row => row.text.includes('— revise'))).toBe(false);
      expect(displayed[0]?.sidecar).toEqual({ verdict, delivery });
    }
    await classic(items);
    expect(lines.join('\n')).toContain(header);
    expect(lines.join('\n')).toContain('Suggested fix: Fix the assertion.');
    // The existing disk encoding remains readable without a migration.
    const restored = restoreSessionViewItems('session', { messages: [], title: 'Legacy', gitRoot: '',
      uiHistory: [{ id: 'old', type: 'sidecar', text: 'Old verifier', icon: classification }] });
    expect(restored[0]?.sidecar).toEqual(classification === 'budget-exhausted'
      ? { delivery: classification } : { verdict: classification });
  } finally { await owner.close(); }
});

it('renders unknown legacy Verifier classification neutrally rather than inventing revise', async () => {
  const items = restoreSessionViewItems('session', { messages: [], title: 'Legacy', gitRoot: '',
    uiHistory: [{ type: 'sidecar', text: 'Unknown result', icon: 'legacy-other' }] });
  expect(items[0]?.sidecar).toBeUndefined();
  const saved = appendPersistedUiHistorySnapshot([], clientViewToHistoryItems(items));
  expect(restoreSessionViewItems('session', { messages: [], title: 'Resaved', gitRoot: '', uiHistory: saved })[0]?.sidecar).toBeUndefined();
  const rows = buildTranscriptRows({ items: clientViewToHistoryItems(items), viewportWidth: 120 });
  expect(rows.some(row => row.text.includes('Sidecar Verifier'))).toBe(true);
  expect(rows.some(row => row.text.includes('— revise'))).toBe(false);
  const lines: string[] = [];
  const classic = createClassicPlaneDisplayDiffer(line => lines.push(line));
  await classic([]);
  await classic(items);
  expect(lines).toEqual(['sidecar:Sidecar Verifier\nUnknown result']);
});

it('invalidates Ink memoized Verifier rendering when only its classification changes', () => {
  const memo: ClientViewItemMemo = { entries: new Map() };
  const item = { id: 'verifier', type: 'sidecar' as const, text: 'Same body' };
  const first = clientViewToHistoryItems([{ ...item, sidecar: { verdict: 'revise' } }], { memo });
  const next = clientViewToHistoryItems([{ ...item, sidecar: { verdict: 'blocked' } }], { memo });
  expect(next[0]).not.toBe(first[0]);
  expect(next[0]).toMatchObject({ type: 'sidecar', verdict: 'blocked' });
});
