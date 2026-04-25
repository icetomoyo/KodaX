import { describe, expect, it } from 'vitest';
import { runAstRules } from './ast-rules.js';

const VALID_HANDLER = `
  export async function handler(input, ctx) {
    return 'ok';
  }
`;

describe('runAstRules', () => {
  describe('no-eval', () => {
    it('flags literal eval(...) calls', () => {
      const code = `
        export async function handler(input, ctx) {
          return eval(input.code);
        }
      `;
      const result = runAstRules(code);
      expect(result.ok).toBe(false);
      expect(result.violations.map((v) => v.rule)).toContain('no-eval');
    });

    it('does not flag a string property literally named "eval"', () => {
      const code = `
        export async function handler(input, ctx) {
          return { kind: 'eval' };
        }
      `;
      const result = runAstRules(code);
      expect(result.violations.map((v) => v.rule)).not.toContain('no-eval');
    });

    it('does not flag aliased eval (delegated to LLM review)', () => {
      // This documents the deliberate gap. Hard rules only catch literal
      // call sites; obfuscation is the LLM reviewer's job.
      const code = `
        export async function handler(input, ctx) {
          const e = eval;
          return e(input.code);
        }
      `;
      const result = runAstRules(code);
      // The reference to `eval` is not a CallExpression, so no flag.
      // A later LLM-review test asserts it gets caught at review time.
      expect(result.violations.map((v) => v.rule)).not.toContain('no-eval');
    });
  });

  describe('no-Function-constructor', () => {
    it('flags new Function(...)', () => {
      const code = `
        export async function handler(input, ctx) {
          const fn = new Function('return 1');
          return fn();
        }
      `;
      const result = runAstRules(code);
      expect(result.violations.map((v) => v.rule)).toContain('no-Function-constructor');
    });

    it('flags bare Function(...) without new', () => {
      const code = `
        export async function handler(input, ctx) {
          return Function('return 1')();
        }
      `;
      const result = runAstRules(code);
      expect(result.violations.map((v) => v.rule)).toContain('no-Function-constructor');
    });
  });

  describe('require-handler-signature', () => {
    it('passes for `export async function handler(input, ctx)`', () => {
      const result = runAstRules(VALID_HANDLER);
      expect(result.ok).toBe(true);
    });

    it('passes for `export const handler = async (input, ctx) => {}`', () => {
      const code = `
        export const handler = async (input, ctx) => {
          return 'ok';
        };
      `;
      const result = runAstRules(code);
      expect(result.ok).toBe(true);
    });

    it('passes for `export const handler = async function (input, ctx) {}`', () => {
      const code = `
        export const handler = async function (input, ctx) {
          return 'ok';
        };
      `;
      const result = runAstRules(code);
      expect(result.ok).toBe(true);
    });

    it('fails when no `handler` export exists', () => {
      const code = `
        export async function notHandler(input, ctx) {
          return 'ok';
        }
      `;
      const result = runAstRules(code);
      expect(result.ok).toBe(false);
      expect(result.violations.map((v) => v.rule)).toContain('require-handler-signature');
    });

    it('fails when handler is not async (function decl)', () => {
      const code = `
        export function handler(input, ctx) {
          return 'ok';
        }
      `;
      const result = runAstRules(code);
      expect(result.ok).toBe(false);
      const sig = result.violations.find((v) => v.rule === 'require-handler-signature');
      expect(sig?.message).toMatch(/must be async/);
    });

    it('fails when handler arrow form is not async', () => {
      const code = `
        export const handler = (input, ctx) => 'ok';
      `;
      const result = runAstRules(code);
      expect(result.ok).toBe(false);
      const sig = result.violations.find((v) => v.rule === 'require-handler-signature');
      expect(sig?.message).toMatch(/async/);
    });

    it('fails when handler accepts < 2 parameters', () => {
      const code = `
        export async function handler(input) {
          return 'ok';
        }
      `;
      const result = runAstRules(code);
      expect(result.ok).toBe(false);
      const sig = result.violations.find((v) => v.rule === 'require-handler-signature');
      expect(sig?.message).toMatch(/at least \(input, ctx\)/);
    });

    it('fails when handler is exported as a non-function value', () => {
      const code = `
        export const handler = 'not a function';
      `;
      const result = runAstRules(code);
      expect(result.ok).toBe(false);
      const sig = result.violations.find((v) => v.rule === 'require-handler-signature');
      expect(sig?.message).toMatch(/function/);
    });
  });

  describe('combined', () => {
    it('reports multiple violations in one pass', () => {
      const code = `
        export function handler(input) {
          eval('1');
          new Function('return 2')();
          return 'ok';
        }
      `;
      const result = runAstRules(code);
      expect(result.ok).toBe(false);
      const ruleIds = result.violations.map((v) => v.rule);
      expect(ruleIds).toContain('no-eval');
      expect(ruleIds).toContain('no-Function-constructor');
      expect(ruleIds).toContain('require-handler-signature');
    });

    it('clean handler passes without violations', () => {
      const result = runAstRules(VALID_HANDLER);
      expect(result.ok).toBe(true);
      expect(result.violations).toHaveLength(0);
    });
  });
});
