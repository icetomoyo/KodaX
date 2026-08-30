import { describe, expect, it } from 'vitest';
import {
  evaluateExecPolicy,
  parseExecPolicy,
} from '../index.js';

describe('FEATURE_297 Exec Policy public surface', () => {
  it('exports the parser and evaluator from @kodax-ai/coding', () => {
    const parsed = parseExecPolicy(JSON.stringify({
      rules: [{
        prefix: ['git', 'status'],
        decision: 'allow',
        justification: 'Read repository status',
      }],
    }), 'memory');

    expect(parsed.ok).toBe(true);
    expect(evaluateExecPolicy({ tokens: ['git', 'status'] }, parsed.ok ? parsed.rules : []))
      .toMatchObject({ decision: 'allow' });
  });
});
