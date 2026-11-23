import { describe, expect, it } from 'vitest';
import { INTENT_CELLS, classifyLetter, scoreCell, type IntentCell } from './side-chat-intent.cases.js';

const cell = (name: string): IntentCell => {
  const found = INTENT_CELLS.find(c => c.name === name);
  if (!found) throw new Error(`no cell ${name}`);
  return found;
};
const send = (text: string, wake?: boolean) => ({ name: 'send_to_parent', input: wake === undefined ? { text } : { text, wake } });

describe('classifyLetter', () => {
  it('names which discussed cause a letter carries', () => {
    expect(classifyLetter('原因 B:盘符大小写不一致。')).toBe('B');
    expect(classifyLetter('A: stale cache.')).toBe('A');
    expect(classifyLetter('可能的原因:A:缓存过期;B:盘符大小写不一致。')).toBe('AB');
    expect(classifyLetter('Cause B: drive-letter case mismatch.')).toBe('B');
    expect(classifyLetter('请检查构建。')).toBe('other');
  });
});

describe('scoreCell', () => {
  it('passes a question back when the cell accepts no letter', () => {
    expect(scoreCell(cell('zh-singular'), [])).toEqual({ outcome: 'none', wake: false, pass: true });
  });

  it('accepts both a question back and a letter with both causes for the bare pronoun', () => {
    expect(scoreCell(cell('zh-ambiguous'), []).pass).toBe(true);
    expect(scoreCell(cell('zh-ambiguous'), [send('A:缓存过期。B:盘符大小写不一致。')]).pass).toBe(true);
    expect(scoreCell(cell('zh-ambiguous'), [send('B:盘符大小写不一致。')])).toMatchObject({ outcome: 'B', pass: false });
  });

  it('fails a letter that carries the wrong cause', () => {
    expect(scoreCell(cell('zh-recent-focus'), [send('A:缓存过期。')])).toMatchObject({ outcome: 'A', pass: false });
    expect(scoreCell(cell('zh-recent-focus'), [send('盘符大小写不一致会让同一文件被当成两个。')]).pass).toBe(true);
  });

  it('requires both causes when the user asks for the conclusion', () => {
    expect(scoreCell(cell('zh-whole'), [send('A:缓存过期;B:盘符大小写不一致。')]).pass).toBe(true);
    expect(scoreCell(cell('zh-whole'), [send('B:盘符大小写不一致。')]).pass).toBe(false);
  });

  it('checks wake against the cell', () => {
    expect(scoreCell(cell('zh-wake'), [send('B:盘符大小写不一致。', true)])).toEqual({ outcome: 'B', wake: true, pass: true });
    expect(scoreCell(cell('zh-wake'), [send('B:盘符大小写不一致。')]).pass).toBe(false);
    expect(scoreCell(cell('zh-selected'), [send('B:盘符大小写不一致。', true)]).pass).toBe(false);
  });

  it('fails more than one letter', () => {
    expect(scoreCell(cell('zh-selected'), [send('B:盘符。'), send('B:大小写。')])).toMatchObject({ outcome: 'multiple', pass: false });
  });
});
