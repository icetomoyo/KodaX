import { describe, expect, it } from 'vitest';
import { toolKodaxManual } from '../packages/coding/src/tools/manual.js';
import topics from '../packages/coding/src/self-knowledge/manual-topics.json';
import { CASES } from './manual-commands.cases.js';
import { answerManual, injectedTopics, messagesFor, observe } from './manual-commands.eval.js';

describe('manual commands eval cases', () => {
  it('render an injected topic exactly as the shipped manual renders it', async () => {
    const shipped = await toolKodaxManual({ topic: 'commands' }, { backups: new Map() });
    const commands = topics.find(topic => topic.id === 'commands')!;
    expect(await answerManual({ topic: 'commands' }, [{ ...commands, body: commands.body.join('\n') }])).toBe(shipped);
  });

  it('inject only the topics that differ from the shipped manual', () => {
    const changed = topics.map(topic => topic.id === 'doctor' ? { ...topic, body: ['old text'] } : topic);
    expect(injectedTopics(changed, topics)).toEqual([expect.objectContaining({ id: 'doctor', body: 'old text' })]);
  });

  it('end every first request on the answered manual call', () => {
    const messages = messagesFor(CASES[0]!, 'topic text');
    expect(messages[1]).toMatchObject({ role: 'assistant', content: [{ type: 'tool_use', id: 'manual-1', input: { topic: 'troubleshooting' } }] });
    expect(messages[2]).toMatchObject({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'manual-1', content: 'topic text' }] });
  });

  it('records the Host, session and reasoning commands an answer names', () => {
    expect(observe({ text: 'Run `kodax host restart`, then `kodax daemon logs`. In the REPL: /thinking off.', toolCalls: [] })).toEqual({
      tools: [], cliCommands: ['kodax host restart', 'kodax daemon logs'], namesDaemonCommand: true, reasoningOff: ['/thinking off'],
    });
  });
});
