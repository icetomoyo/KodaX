/**
 * Hard AST rules — first-tier static check for constructed tool handlers.
 *
 * Three rules, picked for maximum determinism + minimum cost (DD §14.5.1):
 *   1. no-eval                    — any literal eval(...) call
 *   2. no-Function-constructor    — new Function(...) and bare Function(...)
 *   3. require-handler-signature  — module must export `handler` as an async
 *                                   function/arrow/function-expression with
 *                                   at least 2 parameters.
 *
 * Pass = enter LLM static review (second tier).
 * Fail = block stage(); errors surface in TestResult.errors.
 *
 * Limitations (deliberately):
 *   - We do NOT chase aliases (`const e = eval; e('...')`).
 *   - We do NOT walk property accesses (`globalThis.eval`).
 *   - We do NOT analyze string concat to spot `['req','uire'].join('')`.
 * All of those are LLM-review territory — the rule set here is the
 * "cheap, certain" first cut.
 *
 * Uses the bundled TypeScript compiler (already a KodaX dep) as the
 * parser. Source kind is JS — handlers are limited to language='javascript'
 * by load-handler; we just parse-as-JS to match.
 */

import * as ts from 'typescript';

export type AstRuleId =
  | 'no-eval'
  | 'no-Function-constructor'
  | 'require-handler-signature';

export interface AstRuleViolation {
  readonly rule: AstRuleId;
  readonly message: string;
}

export interface AstCheckResult {
  readonly ok: boolean;
  readonly violations: readonly AstRuleViolation[];
}

export function runAstRules(jsCode: string): AstCheckResult {
  const sourceFile = ts.createSourceFile(
    'handler.js',
    jsCode,
    ts.ScriptTarget.ES2022,
    /*setParentNodes*/ true,
    ts.ScriptKind.JS,
  );

  const violations: AstRuleViolation[] = [];

  // Walk for call-site rules.
  const walk = (node: ts.Node): void => {
    // no-eval: literal `eval(...)` call.
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'eval'
    ) {
      violations.push({
        rule: 'no-eval',
        message: "Calls to 'eval' are forbidden in constructed handlers.",
      });
    }

    // no-Function-constructor:
    //   - `new Function(...)`
    //   - bare `Function(...)` (the constructor is callable without `new`)
    if (
      (ts.isNewExpression(node) || ts.isCallExpression(node))
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'Function'
    ) {
      violations.push({
        rule: 'no-Function-constructor',
        message: "Calls to 'Function(...)' / 'new Function(...)' are forbidden (equivalent to eval).",
      });
    }

    ts.forEachChild(node, walk);
  };
  walk(sourceFile);

  // Handler signature check (single pass over top-level statements).
  const sigResult = checkHandlerSignature(sourceFile);
  if (!sigResult.ok) {
    violations.push({
      rule: 'require-handler-signature',
      message: sigResult.reason,
    });
  }

  return { ok: violations.length === 0, violations };
}

// ----------------------------------------------------------------
// require-handler-signature
// ----------------------------------------------------------------

interface SignatureCheckResult {
  readonly ok: true;
  readonly reason?: undefined;
}

interface SignatureFailure {
  readonly ok: false;
  readonly reason: string;
}

function checkHandlerSignature(
  sourceFile: ts.SourceFile,
): SignatureCheckResult | SignatureFailure {
  // Three acceptable forms:
  //   1. export async function handler(input, ctx) { ... }
  //   2. export const handler = async (input, ctx) => { ... }
  //   3. export const handler = async function (input, ctx) { ... }

  for (const stmt of sourceFile.statements) {
    // Form 1: top-level `export async function handler(...)`.
    if (
      ts.isFunctionDeclaration(stmt)
      && stmt.name?.text === 'handler'
      && hasSyntaxKind(stmt, ts.SyntaxKind.ExportKeyword)
    ) {
      if (!hasSyntaxKind(stmt, ts.SyntaxKind.AsyncKeyword)) {
        return { ok: false, reason: "'handler' export must be async." };
      }
      if (stmt.parameters.length < 2) {
        return {
          ok: false,
          reason: "'handler' must accept at least (input, ctx) parameters.",
        };
      }
      return { ok: true };
    }

    // Forms 2 & 3: `export const handler = async ...`.
    if (
      ts.isVariableStatement(stmt)
      && hasSyntaxKind(stmt, ts.SyntaxKind.ExportKeyword)
    ) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || decl.name.text !== 'handler') {
          continue;
        }
        const init = decl.initializer;
        if (!init) {
          return {
            ok: false,
            reason: "'handler' export must be initialized to a function.",
          };
        }
        if (!ts.isArrowFunction(init) && !ts.isFunctionExpression(init)) {
          return {
            ok: false,
            reason:
              "'handler' export must be an async function "
              + '(function declaration / async arrow / async function expression).',
          };
        }
        const isAsync = (init.modifiers ?? []).some(
          (m) => m.kind === ts.SyntaxKind.AsyncKeyword,
        );
        if (!isAsync) {
          return { ok: false, reason: "'handler' export must be async." };
        }
        if (init.parameters.length < 2) {
          return {
            ok: false,
            reason: "'handler' must accept at least (input, ctx) parameters.",
          };
        }
        return { ok: true };
      }
    }
  }

  return {
    ok: false,
    reason:
      "Module must export 'handler' as one of: "
      + '`export async function handler(input, ctx) {...}` / '
      + '`export const handler = async (input, ctx) => {...}` / '
      + '`export const handler = async function (input, ctx) {...}`.',
  };
}

function hasSyntaxKind(node: ts.Node, kind: ts.SyntaxKind): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const mods = ts.getModifiers(node);
  return Boolean(mods?.some((m) => m.kind === kind));
}
