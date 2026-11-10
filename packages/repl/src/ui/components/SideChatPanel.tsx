import React, { useEffect, useRef, useState } from 'react';
import { randomUUID } from 'node:crypto';
import type { ClientSession, ClientSessionView } from '@kodax-ai/coding/client-contract';
import { Box, Text } from '../tui.js';
import { firstActiveRunId, type InkClientPlane } from '../client-plane.js';
import { useKeypress } from '../contexts/KeypressContext.js';
import { KeypressHandlerPriority } from '../types.js';
import { InputPrompt } from './InputPrompt.js';

export function sideCommand(text: string): { question: string } | undefined {
  const match = /^\/(?:side|btw)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return match ? { question: match[1] ?? '' } : undefined;
}

export function SideChatPanel({ plane, session, parentNeedsInput, draft, saveDraft, close }: {
  plane: InkClientPlane; session: ClientSession; parentNeedsInput: boolean;
  draft: string; saveDraft(value: string): void; close(): void;
}) {
  const [view, setView] = useState<ClientSessionView>();
  const [error, setError] = useState('');
  const [editor, resetEditor] = useState(0);
  const submitting = useRef(false);
  const [ready, setReady] = useState(false);
  const active = firstActiveRunId(view?.runs ?? []);
  const permission = view?.interactions.find(i => i.kind === 'permission');
  useEffect(() => {
    let mounted = true;
    let unsubscribe: (() => void) | undefined;
    void plane.observe(session.id, next => {
      if (mounted) { setView(next); setReady(true); }
    }).then(done => { if (mounted) unsubscribe = done; else done(); },
      reason => { if (mounted) setError(String(reason)); });
    return () => { mounted = false; unsubscribe?.(); };
  }, [plane, session.id]);
  useKeypress(KeypressHandlerPriority.Critical, key => {
    if (key.name !== 'escape') return false;
    if (active) void plane.stop(active).catch(reason => setError(String(reason)));
    else close();
    return true;
  }, [active, close, plane]);
  const submit = async (text: string) => {
    const command = sideCommand(text);
    if (command) {
      if (command.question) { setError('Return to the parent with /side before opening another side chat.'); return; }
      saveDraft(''); close(); return;
    }
    if (!text.trim() || submitting.current || !ready) return;
    if (permission && !['/allow', '/deny'].includes(text.trim())) {
      setError('Answer the side tool request with /allow or /deny.'); return;
    }
    submitting.current = true;
    try {
      if (permission) {
        const accepted = await plane.respondInteraction(permission.requestId, { kind: 'permission',
          decision: text.trim() === '/allow' ? { type: 'allow_once' } : { type: 'reject' } });
        if (!accepted) throw new Error('This request has already been resolved.');
      } else {
        await plane.submit({ sessionId: session.id, inputId: randomUUID(), text,
          delivery: active ? 'after_turn' : 'immediate' });
      }
      saveDraft(''); setError(''); resetEditor(n => n + 1);
    } catch (reason) { saveDraft(text); setError(String(reason)); resetEditor(n => n + 1); }
    finally { submitting.current = false; }
  };
  const items = view?.items ?? [];
  const start = items.findIndex(i => i.type === 'user' && i.inputId);
  return <Box flexDirection="column">
    <Text bold>Side chat · {session.sideChat?.parentSessionId} · /side to return</Text>
    <Text dimColor>{session.sideChat?.boundary ? 'Parent snapshot: ' + session.sideChat.boundary : 'No committed parent history'}</Text>
    {parentNeedsInput && <Text color="yellow">The parent needs your attention. Return with /side to respond.</Text>}
    {(start < 0 ? [] : items.slice(start)).slice(-16).map(item =>
      <Text key={item.id}>{item.type === 'tool' ? item.tool?.name : item.type}: {item.text}</Text>)}
    {permission && <Text color="yellow">Approve {permission.options.toolName} {permission.options.inputPreview}
      {' · /allow once or /deny'}</Text>}
    {active && <Text dimColor>Side agent running · Esc to stop</Text>}
    {error && <Text color="red">{error}</Text>}
    <InputPrompt key={editor} sessionId={session.id} initialValue={draft} prompt="side ›"
      autocompleteEnabled={false} onInputChange={saveDraft} onSubmit={payload => { void submit(payload.fullText); }} />
  </Box>;
}
