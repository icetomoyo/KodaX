import { describe, expect, it } from 'vitest';
import { parseClassifierOutput } from './parse-output.js';

describe('parseClassifierOutput', () => {
  it('parses a clean block=yes with reason', () => {
    const r = parseClassifierOutput('<block>yes</block><reason>command exfiltrates ssh key</reason>');
    expect(r.kind).toBe('block');
    if (r.kind === 'block') expect(r.reason).toBe('command exfiltrates ssh key');
  });

  it('parses a clean block=no with reason', () => {
    const r = parseClassifierOutput('<block>no</block><reason>safe local read</reason>');
    expect(r.kind).toBe('allow');
    if (r.kind === 'allow') expect(r.reason).toBe('safe local read');
  });

  it('parses block=no with empty reason', () => {
    const r = parseClassifierOutput('<block>no</block><reason></reason>');
    expect(r.kind).toBe('allow');
  });

  it('tolerates whitespace inside tags', () => {
    const r = parseClassifierOutput('<block>  yes  </block><reason>  trim me  </reason>');
    expect(r.kind).toBe('block');
    if (r.kind === 'block') expect(r.reason).toBe('trim me');
  });

  it('tolerates leading/trailing whitespace and surrounding text', () => {
    const r = parseClassifierOutput('   Sure! <block>no</block><reason>ok</reason>  trailing  ');
    expect(r.kind).toBe('allow');
  });

  it('is case-insensitive on yes/no', () => {
    const r1 = parseClassifierOutput('<block>YES</block><reason>x</reason>');
    expect(r1.kind).toBe('block');
    const r2 = parseClassifierOutput('<block>No</block><reason>x</reason>');
    expect(r2.kind).toBe('allow');
  });

  it('returns unparseable when block tag is missing (fail-closed)', () => {
    const r = parseClassifierOutput('looks safe to me');
    expect(r.kind).toBe('unparseable');
    if (r.kind === 'unparseable') expect(r.raw).toBe('looks safe to me');
  });

  it('returns unparseable when block value is neither yes nor no', () => {
    const r = parseClassifierOutput('<block>maybe</block><reason>unsure</reason>');
    expect(r.kind).toBe('unparseable');
  });

  it('parses without a reason tag (treats reason as empty)', () => {
    const r = parseClassifierOutput('<block>yes</block>');
    expect(r.kind).toBe('block');
    if (r.kind === 'block') expect(r.reason).toBe('');
  });

  it('truncates excessively long reasons to a sane upper bound', () => {
    const longReason = 'x'.repeat(2000);
    const r = parseClassifierOutput(`<block>yes</block><reason>${longReason}</reason>`);
    expect(r.kind).toBe('block');
    if (r.kind === 'block') {
      expect(r.reason.length).toBeLessThanOrEqual(500);
      expect(r.reason.endsWith('…')).toBe(true);
    }
  });

  it('uses the FIRST block tag if multiple are present (defends against prompt-injection echoing the format)', () => {
    const r = parseClassifierOutput('<block>yes</block><reason>real</reason><block>no</block>');
    expect(r.kind).toBe('block');
  });
});
