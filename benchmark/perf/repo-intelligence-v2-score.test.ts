import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  callersFromReferences,
  classifyExtraDefinition,
  oldDefinitionKeys,
  scoreDefinitions,
  scoreImportEdges,
  v2DefinitionKeys,
  type V2Definition,
} from './repo-intelligence-v2-score.js';

const def = (name: string, kind: string, container: string | null, line: number, endLine = line): V2Definition =>
  ({ path: 'src/a.ts', name, kind, container, line, endLine });

const outline: V2Definition[] = [
  def('Store', 'class', null, 1, 20),
  def('get', 'method', 'Store', 3, 6),
  def('Shape', 'interface', null, 22, 25),
  def('area', 'method', 'Shape', 23),
  def('run', 'function', null, 30, 40),
  def('inner', 'function', 'run', 32, 35),
  def('limit', 'variable', null, 42),
  def('Kind', 'type', null, 44),
  def('Color', 'enum', null, 46, 48),
];

describe('v2DefinitionKeys', () => {
  it('keys top-level definitions and methods of classes the way the compiler truth does', () => {
    const keys = v2DefinitionKeys(new Map([['src/a.ts', outline]]));
    expect([...keys.lines.keys()].sort()).toEqual([
      'src/a.ts:Color', 'src/a.ts:Kind', 'src/a.ts:Shape', 'src/a.ts:Store', 'src/a.ts:Store.get', 'src/a.ts:run',
    ]);
    expect(keys.lines.get('src/a.ts:Store.get')).toEqual([3]);
  });

  it('counts what the truth does not list instead of scoring it', () => {
    const keys = v2DefinitionKeys(new Map([['src/a.ts', outline]]));
    expect(keys.notComparable).toEqual({ 'method in interface': 1, 'nested function': 1, variable: 1 });
  });
});

describe('oldDefinitionKeys', () => {
  const symbol = (qualifiedName: string, kind: string, line = 1, filePath = 'src/a.ts') => ({ qualifiedName, kind, line, filePath });

  it('keeps only symbols the truth lists, in files the truth covers', () => {
    const keys = oldDefinitionKeys([
      symbol('src/a.ts:Store', 'class'),
      symbol('src/a.ts:Store.get', 'method', 3),
      symbol('src/a.ts:Shape.area', 'method'),
      symbol('src/a.ts:LIMIT', 'constant'),
      symbol('src/b.py:run', 'function', 1, 'src/b.py'),
    ], new Set(['src/a.ts']));
    expect([...keys.lines.keys()].sort()).toEqual(['src/a.ts:Store', 'src/a.ts:Store.get']);
    expect(keys.notComparable).toEqual({ 'method outside a class': 1, constant: 1 });
  });
});

describe('scoreDefinitions', () => {
  it('scores keys against the truth and checks lines on the matches', () => {
    const truth = new Map([
      ['src/a.ts:run', { kind: 'function', lines: [30] }],
      ['src/a.ts:Store', { kind: 'class', lines: [1] }],
      ['src/a.ts:gone', { kind: 'function', lines: [50] }],
    ] as const);
    const engine = { lines: new Map([['src/a.ts:run', [30]], ['src/a.ts:Store', [2]], ['src/a.ts:extra', [9]]]), notComparable: {} };
    const score = scoreDefinitions(truth, engine);
    expect(score.metric).toMatchObject({ tp: 2, fp: 1, fn: 1 });
    expect(score.recallByKind.function).toMatchObject({ tp: 1, fn: 1 });
    expect(score.lineAgreement).toEqual({ checked: 2, agree: 1, rate: 0.5 });
    expect(score.falsePositives).toEqual(['src/a.ts:extra']);
    expect(score.falseNegatives).toEqual(['src/a.ts:gone']);
  });
});

describe('classifyExtraDefinition', () => {
  const source = ts.createSourceFile('src/a.ts', [
    "describe('x', () => {",
    '  function helper() {}',
    '  const table = { run: () => 1 };',
    '});',
    'class Plane {',
    '  readonly tasks = { cancel: () => 1 };',
    '}',
    "fs.appendFileSync('a');",
    'function make() { return class Local { go() {} }; }',
  ].join('\n'), ts.ScriptTarget.Latest, true);

  it('accepts a real declaration in a local scope, which the truth leaves out', () => {
    expect(classifyExtraDefinition(source, 'src/a.ts:helper', [2])).toBe('local declaration');
    expect(classifyExtraDefinition(source, 'src/a.ts:run', [3])).toBe('local declaration');
    expect(classifyExtraDefinition(source, 'src/a.ts:Local.go', [9])).toBe('local declaration');
  });

  it('names a member credited to the wrong class, and a name that declares nothing on its line', () => {
    expect(classifyExtraDefinition(source, 'src/a.ts:Plane.cancel', [6])).toBe('wrong container');
    expect(classifyExtraDefinition(source, 'src/a.ts:appendFileSync', [8])).toBe('no declaration on that line');
    expect(classifyExtraDefinition(source, 'src/a.ts:helper', [5])).toBe('no declaration on that line');
  });
});

describe('callersFromReferences', () => {
  const outlines = new Map([['src/a.ts', outline]]);

  it('credits every function, class or method around a call, as the truth does', () => {
    const result = callersFromReferences([
      { path: 'src/a.ts', line: 4, kind: 'call' },
      { path: 'src/a.ts', line: 33, kind: 'call' },
    ], outlines, 'src/b.ts:target');
    expect([...result.callers].sort()).toEqual(['src/a.ts:Store', 'src/a.ts:Store.get', 'src/a.ts:run']);
  });

  it('counts `new` as a call, and skips type uses, self-calls and top-level code', () => {
    const result = callersFromReferences([
      { path: 'src/a.ts', line: 36, kind: 'class' },
      { path: 'src/a.ts', line: 37, kind: 'type' },
      { path: 'src/a.ts', line: 38, kind: 'call' },
      { path: 'src/a.ts', line: 60, kind: 'call' },
    ], outlines, 'src/a.ts:run');
    expect([...result.callers]).toEqual([]);
    expect(result.outsideUnits).toBe(1);
  });

  it('keeps one wrong caller per file the truth does not cover', () => {
    const result = callersFromReferences([
      { path: 'tool/x.py', line: 3, kind: 'call' },
      { path: 'tool/x.py', line: 9, kind: 'call' },
    ], outlines, 'src/a.ts:run');
    expect([...result.callers]).toEqual(['tool/x.py:*']);
    expect(result.outsideTruthFiles).toBe(2);
  });
});

describe('scoreImportEdges', () => {
  it('scores file edges, counting built package output as the source behind it and leaving JSON out', () => {
    const sources = new Set(['a.ts', 'b.ts', 'd.ts', 'e.ts', 'packages/p/src/index.ts']);
    const truth = new Map([
      ['a.ts', new Set(['b.ts', 'packages/p/dist/index.d.ts', 'packages/q/dist/x.d.ts', 'c.json'])],
      ['e.ts', new Set(['b.ts'])],
    ]);
    const engine = new Map([['a.ts', new Set(['b.ts', 'packages/p/src/index.ts', 'd.ts', 'c.json', 'a.ts'])]]);
    const score = scoreImportEdges(truth, engine, sources);
    expect(score.metric).toMatchObject({ tp: 2, fp: 1, fn: 1 });
    expect(score.falsePositives).toEqual(['a.ts -> d.ts']);
    expect(score.falseNegatives).toEqual(['e.ts -> b.ts']);
    expect(score.buildOutputDropped).toBe(1);
  });
});
