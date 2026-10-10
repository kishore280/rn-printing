/**
 * The review rules of the kernel's coding style (Documentation/process/coding-style.rst), as a test.
 * They are measured, not argued about: a file, a function or a nesting level over its limit fails here.
 * There is no allow-list. When a rule fails, split the code; do not raise the limit.
 *
 *  - Chapter 6: functions are short and do one thing   -> at most 60 lines.
 *  - Chapter 1: more than 3 levels of indent is a sign -> at most 3 nested statements.
 *  - A file with one reason to change                  -> at most 500 lines.
 *  - No way around the type checker                    -> no `any`, `@ts-ignore`, `@ts-nocheck`.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const MAX_FILE_LINES = 500;
const MAX_FUNCTION_LINES = 60;
const MAX_NESTING = 3;

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.ts$/.test(e.name) && !/\.d\.ts$/.test(e.name) ? [p] : [];
  });
}

const FILES = sources(path.join(__dirname, '..', 'src'));

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
}

const isBranch = (n: ts.Node): boolean =>
  ts.isIfStatement(n) || ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n) ||
  ts.isWhileStatement(n) || ts.isDoStatement(n) || ts.isTryStatement(n) || ts.isSwitchStatement(n);

/** Deepest nesting of branches. An `else if` is not a deeper level. */
function nesting(node: ts.Node, depth: number): number {
  let deepest = depth;
  ts.forEachChild(node, (c) => {
    if (ts.isFunctionLike(c)) return; // a nested function is measured on its own
    const elseIf = ts.isIfStatement(c) && ts.isIfStatement(c.parent) && c.parent.elseStatement === c;
    deepest = Math.max(deepest, nesting(c, depth + (isBranch(c) && !elseIf ? 1 : 0)));
  });
  return deepest;
}

function functionName(n: ts.FunctionLikeDeclaration): string {
  if (n.name) return n.name.getText();
  const parent = n.parent;
  return ts.isVariableDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isPropertyAssignment(parent)
    ? parent.name.getText()
    : '(anonymous)';
}

function functions(sf: ts.SourceFile): Array<{ name: string; lines: number; nesting: number }> {
  const out: Array<{ name: string; lines: number; nesting: number }> = [];
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionLike(n) && 'body' in n && n.body) {
      const from = sf.getLineAndCharacterOfPosition(n.getStart()).line;
      const to = sf.getLineAndCharacterOfPosition(n.end).line;
      out.push({ name: functionName(n as ts.FunctionLikeDeclaration), lines: to - from + 1, nesting: nesting(n.body, 0) });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const rel = (f: string): string => path.relative(path.join(__dirname, '..'), f);

describe('Linus review rules (src/)', () => {
  it('finds the source files', () => {
    expect(FILES.length).toBeGreaterThan(20);
  });

  it(`no file is longer than ${MAX_FILE_LINES} lines`, () => {
    const long = FILES.map((f) => ({ f: rel(f), n: fs.readFileSync(f, 'utf8').split('\n').length })).filter((x) => x.n > MAX_FILE_LINES);
    expect(long).toEqual([]);
  });

  it(`no function is longer than ${MAX_FUNCTION_LINES} lines`, () => {
    const long = FILES.flatMap((f) =>
      functions(parse(f)).filter((x) => x.lines > MAX_FUNCTION_LINES).map((x) => `${rel(f)}: ${x.name} (${x.lines} lines)`),
    );
    expect(long).toEqual([]);
  });

  it(`no function nests more than ${MAX_NESTING} levels`, () => {
    const deep = FILES.flatMap((f) =>
      functions(parse(f)).filter((x) => x.nesting > MAX_NESTING).map((x) => `${rel(f)}: ${x.name} (${x.nesting} levels)`),
    );
    expect(deep).toEqual([]);
  });

  it('nothing switches the type checker off', () => {
    const bad = FILES.filter((f) => /@ts-(ignore|nocheck)|:\s*any\b|\bas any\b|<any>/.test(fs.readFileSync(f, 'utf8')));
    expect(bad.map(rel)).toEqual([]);
  });
});
