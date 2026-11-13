/**
 * FEATURE_308 Phase 2c: read real local KodaX sessions for offline replay.
 * Raw sessions are private and never leave the machine; only code lives in the repo.
 *
 * A session file is a lineage JSONL: one `lineage_entry` per line, message
 * entries carry `message: { role, content }`. Order in the file is used as-is
 * (abandoned branches are not filtered), which can only add evidence noise.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildEvidence, collectSegments, shouldReflect, signalsOf } from '@kodax-ai/agent';
import type { KodaXMessage } from '@kodax-ai/llm';

import { renderReflectionInput } from '../../../packages/coding/src/memory/note-reflection.js';

export const SESSIONS_ROOT = path.join(os.homedir(), '.kodax', 'sessions');

export interface RealSession {
  readonly id: string;
  readonly project: string;
  readonly file: string;
  readonly bytes: number;
}

const TOP_LEVEL = /^\d{8}_\d{6}_[0-9a-z]+\.jsonl$/;

export function listSessions(root: string = SESSIONS_ROOT): readonly RealSession[] {
  const sessions: RealSession[] = [];
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory() || project.name.startsWith('.')) continue;
    for (const name of readdirSync(path.join(root, project.name))) {
      if (!TOP_LEVEL.test(name) || name.endsWith('.islands.jsonl')) continue;
      const file = path.join(root, project.name, name);
      sessions.push({ id: name.replace(/\.jsonl$/, ''), project: project.name, file, bytes: statSync(file).size });
    }
  }
  return sessions;
}

interface LineageLine {
  readonly _type?: string;
  readonly entry?: { readonly type?: string; readonly logicalId?: string; readonly message?: { readonly role?: string; readonly content?: unknown } };
}

export function readMessages(file: string): readonly KodaXMessage[] {
  const seen = new Set<string>();
  const messages: KodaXMessage[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.startsWith('{"_type":"lineage_entry"')) continue;
    let parsed: LineageLine;
    try {
      parsed = JSON.parse(line) as LineageLine;
    } catch {
      continue;
    }
    const entry = parsed.entry;
    const message = entry?.message;
    if (entry?.type !== 'message' || message === undefined) continue;
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    if (entry.logicalId !== undefined) {
      if (seen.has(entry.logicalId)) continue;
      seen.add(entry.logicalId);
    }
    messages.push({ role: message.role, content: message.content as KodaXMessage['content'] });
  }
  return messages;
}

export interface SessionSurvey {
  readonly id: string;
  readonly project: string;
  readonly messages: number;
  readonly userTurns: number;
  readonly gate: boolean;
  readonly evidenceChars: number;
  readonly requestChars: number;
}

export function surveySession(session: RealSession): SessionSurvey {
  const messages = readMessages(session.file);
  const evidence = buildEvidence(messages);
  return {
    id: session.id,
    project: session.project,
    messages: messages.length,
    userTurns: signalsOf(collectSegments(messages)).userTurns,
    gate: shouldReflect(messages),
    evidenceChars: evidence.segments.reduce((sum, segment) => sum + segment.text.length, 0),
    requestChars: renderReflectionInput(evidence, []).length,
  };
}
