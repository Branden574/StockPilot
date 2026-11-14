/**
 * THE APPS ONLY READ THE MOVEMENT LEDGER (docket S8).
 *
 * Security invariant (listed in scripts/security-test.sh).
 *
 * Every row of stock_movements is written by the database's stock-ledger
 * functions: adjust, transfer, receipts, counts, kits, returns, orders, and
 * an item's opening stock (open_item_stock, which every create path and
 * Duplicate call). The web app, the phone and the shared packages read the
 * table and never write it. This file holds the code to that.
 *
 * WHAT IS SCANNED. Every source file (.ts .tsx .js .jsx .mjs .cjs .mts .cts)
 * that git lists under apps/web/src, apps/mobile and packages (tracked files
 * and new files that are not ignored). Declaration files and test or spec
 * files are left out: they never ship. The scan reads the TypeScript syntax
 * tree, so comments are never code; a string or template in a TYPE position
 * (Database['public']['Tables']['stock_movements']) is never a request.
 *
 * THE RULES.
 *   1. A builder call `.from('stock_movements')` (also `?.from`, `['from']`,
 *      through parentheses or `as const`) is followed directly by `.select(`,
 *      and nothing later in the same chain is `.insert(`, `.update(`,
 *      `.upsert(` or `.delete(`. A builder kept in a variable or handed on is
 *      a failure: its verb cannot be read.
 *   2. Every other string or template text that names stock_movements fails
 *      (a constant, a helper argument, a REST path, an object field), unless
 *      it is one of the HOLDERS below, each a read or metadata, each pinned
 *      to its exact place.
 *   3. A `.from(` whose table is computed (a template with a part, a
 *      concatenation, a call) fails: the name it builds cannot be read.
 *
 * IF THIS FAILS. Write the movement through a ledger function (an RPC), never
 * through the table. A new READ that cannot be a plain .from('...').select(
 * goes in HOLDERS with the reason.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(__dirname, '../../../../..');
const ROOTS = ['apps/web/src', 'apps/mobile', 'packages'];
const TABLE = 'stock_movements';
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const LEFT_OUT = /(\.d\.(ts|mts|cts)$)|(\.(test|spec)\.[a-z]+$)/;
const WRITE_VERBS = new Set(['insert', 'update', 'upsert', 'delete']);

/** The one helper that takes a table name: it reads the row (checked below). */
const READ_HELPER = {
  name: 'readInActiveOrg',
  file: 'apps/web/src/server/services/lib/in-active-org.ts',
} as const;

/**
 * Places that name the table without a builder call, each a read or metadata.
 * `file` null = any file (the read helper's argument).
 */
const HOLDERS: ReadonlyArray<{
  file: string | null;
  why: string;
  holds: (lit: ts.Node) => boolean;
}> = [
  {
    file: null,
    why: 'the table argument of readInActiveOrg, which only reads (checked below)',
    holds: (lit) => {
      const call = lit.parent;
      return (
        !!call &&
        ts.isCallExpression(call) &&
        ts.isIdentifier(call.expression) &&
        call.expression.text === READ_HELPER.name &&
        call.arguments[1] === lit
      );
    },
  },
  {
    file: 'apps/web/src/components/realtime/inventory-realtime.tsx',
    why: 'the realtime subscription list (change events are read)',
    holds: (lit) => {
      const arr = lit.parent;
      const decl = arr?.parent;
      return (
        !!arr &&
        ts.isArrayLiteralExpression(arr) &&
        !!decl &&
        ts.isVariableDeclaration(decl) &&
        ts.isIdentifier(decl.name) &&
        decl.name.text === 'DEFAULT_TABLES'
      );
    },
  },
  {
    file: 'packages/core/src/modules/registry.ts',
    why: "a module's ownsTables metadata",
    holds: (lit) => {
      const arr = lit.parent;
      const prop = arr?.parent;
      return (
        !!arr &&
        ts.isArrayLiteralExpression(arr) &&
        !!prop &&
        ts.isPropertyAssignment(prop) &&
        ts.isIdentifier(prop.name) &&
        prop.name.text === 'ownsTables'
      );
    },
  },
];

function listSources(): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...ROOTS],
    { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return out
    .split('\n')
    .filter((f) => f && SOURCE.test(f) && !LEFT_OUT.test(f));
}

function parse(fileName: string, text: string): ts.SourceFile {
  const kind = /\.(tsx|jsx)$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
}

/** Through parentheses, `as`, `satisfies` and `!`. */
function unwrap(node: ts.Node): ts.Node {
  let n = node;
  while (
    ts.isParenthesizedExpression(n) ||
    ts.isAsExpression(n) ||
    ts.isSatisfiesExpression(n) ||
    ts.isNonNullExpression(n)
  ) {
    n = n.expression;
  }
  return n;
}

/** The node that stands for `node` in its parent (out through the same wrappers). */
function outer(node: ts.Node): ts.Node {
  let n = node;
  while (
    n.parent &&
    (ts.isParenthesizedExpression(n.parent) ||
      ts.isAsExpression(n.parent) ||
      ts.isSatisfiesExpression(n.parent) ||
      ts.isNonNullExpression(n.parent))
  ) {
    n = n.parent;
  }
  return n;
}

/** A call of `.from(`, `?.from(` or `['from'](`. */
function isFromCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const callee = unwrap(node.expression);
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text === 'from';
  if (ts.isElementAccessExpression(callee)) {
    const key = unwrap(callee.argumentExpression);
    return (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) && key.text === 'from';
  }
  return false;
}

/** The method names called on a builder, in order: `.select().eq()` -> ['select', 'eq']. */
function chainAfter(call: ts.CallExpression): string[] {
  const names: string[] = [];
  let cur: ts.Node = outer(call);
  for (;;) {
    const p = cur.parent;
    if (!p) break;
    let name: string | null = null;
    if (ts.isPropertyAccessExpression(p) && p.expression === cur) name = p.name.text;
    else if (ts.isElementAccessExpression(p) && p.expression === cur) {
      const key = unwrap(p.argumentExpression);
      name = ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key) ? key.text : '[computed]';
    }
    if (name === null) break;
    const called = outer(p).parent;
    if (!called || !ts.isCallExpression(called) || called.expression !== outer(p)) {
      names.push(name);
      break;
    }
    names.push(name);
    cur = outer(called);
  }
  return names;
}

const BUILTINS = new Set([
  'Array', 'Buffer', 'Object', 'String', 'Set', 'Map', 'Promise', 'Iterator',
  'Uint8Array', 'Uint8ClampedArray', 'Uint16Array', 'Uint32Array', 'Int8Array',
  'Int16Array', 'Int32Array', 'Float32Array', 'Float64Array', 'BigInt64Array',
  'BigUint64Array',
]);

function isBuiltinFrom(call: ts.CallExpression): boolean {
  const callee = unwrap(call.expression);
  const obj = ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)
    ? unwrap(callee.expression)
    : null;
  return !!obj && ts.isIdentifier(obj) && BUILTINS.has(obj.text);
}

function isTableText(node: ts.Node): node is ts.StringLiteralLike | ts.TemplateLiteralLikeNode {
  return (
    (ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)) &&
    node.text.includes(TABLE)
  );
}

function inTypePosition(node: ts.Node): boolean {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isTypeNode(p)) return true;
  }
  return false;
}

/** Every `.from(<literal>)` on any table whose chain writes, or has no verb. */
export function findBuilderWrites(fileName: string, text: string): string[] {
  const sf = parse(fileName, text);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (isFromCall(node)) {
      const chain = chainAfter(node);
      const arg = node.arguments[0] ? node.arguments[0].getText(sf) : '';
      if (chain.length === 0) {
        found.push(`${where(sf, node)} .from(${arg}) (builder not followed by a verb)`);
      } else if (chain[0] !== 'select' || chain.some((n) => WRITE_VERBS.has(n))) {
        found.push(`${where(sf, node)} .from(${arg}).${offending(chain)}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** The call that breaks the read: the first verb when it is not select, else the first write. */
function offending(chain: readonly string[]): string {
  return chain[0] !== 'select' ? chain[0]! : chain.find((n) => WRITE_VERBS.has(n))!;
}

function where(sf: ts.SourceFile, node: ts.Node): string {
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return `${sf.fileName}:${line + 1}`;
}

/** Every place the apps could write stock_movements (rules 1-3). */
function findLedgerWrites(fileName: string, text: string): string[] {
  const sf = parse(fileName, text);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    // Rule 3: a computed table name (Array.from, Buffer.from and the like
    // are not table builders).
    if (isFromCall(node) && node.arguments[0] && !isBuiltinFrom(node)) {
      const a = unwrap(node.arguments[0]);
      if (ts.isTemplateExpression(a) || ts.isBinaryExpression(a) || ts.isCallExpression(a)) {
        found.push(`${where(sf, node)} .from(${a.getText(sf)}) (computed table name)`);
      }
    }
    // Rules 1 and 2: every text naming the table.
    if (isTableText(node) && !inTypePosition(node)) {
      const asArg = outer(node);
      const call = asArg.parent;
      const fromArg =
        ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
          ? !!call && isFromCall(call) && call.arguments[0] === asArg
          : false;
      if (fromArg) {
        const chain = chainAfter(call as ts.CallExpression);
        if (chain.length === 0) {
          found.push(`${where(sf, node)} .from('${TABLE}') (builder not followed by a verb)`);
        } else if (chain[0] !== 'select' || chain.some((n) => WRITE_VERBS.has(n))) {
          found.push(`${where(sf, node)} .from('${TABLE}').${offending(chain)}`);
        }
      } else if (
        !HOLDERS.some((h) => (h.file === null || h.file === fileName) && h.holds(node))
      ) {
        found.push(`${where(sf, node)} '${TABLE}' named outside .from('${TABLE}').select(`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe('stock_movements is read, never written, by the apps', () => {
  const files = listSources();

  it('scans the web app, the phone and the packages', () => {
    expect(files.some((f) => f.startsWith('apps/web/src/'))).toBe(true);
    expect(files.some((f) => f.startsWith('apps/mobile/'))).toBe(true);
    expect(files.some((f) => f.startsWith('packages/'))).toBe(true);
    expect(files.length).toBeGreaterThan(500);
  });

  it('no app code writes stock_movements: reads only, the table named nowhere else, no computed table names', () => {
    const found: string[] = [];
    let reads = 0;
    let scanned = 0;
    for (const f of files) {
      const text = readFileSync(path.join(REPO, f), 'utf8');
      // A file that neither names the table nor calls a builder cannot break a rule.
      if (!text.includes(TABLE) && !/\.from\(|\[\s*['"`]from['"`]\s*\]/.test(text)) continue;
      scanned += 1;
      found.push(...findLedgerWrites(f, text));
      reads += (text.match(/\.from\(\s*['"`]stock_movements['"`]\s*\)/g) ?? []).length;
    }
    expect(found, 'write the movement through a ledger function (an RPC)').toEqual([]);
    // The scan sees the reads that exist (activity, reports, the phone), and
    // every builder file, not only the files that name the table.
    expect(reads).toBeGreaterThan(10);
    expect(scanned).toBeGreaterThan(200);
  });

  it('control: each write form is caught, a read and a comment are not', () => {
    const sample = [
      "sb.from('stock_movements').insert({ item_id: 'x' });",
      'sb.from("stock_movements").update({ notes: null }).eq("id", 1);',
      'sb.from(`stock_movements`).upsert([]);',
      "sb.from('stock_movements').delete().eq('id', 1);",
      "const q = sb.from('stock_movements'); q.insert({});",
      "send(sb.from('stock_movements'));",
      "sb.from('stock_movements').select('id').eq('id', 1);",
      "// sb.from('stock_movements').insert({})",
    ].join('\n');
    const hits = findLedgerWrites('sample.ts', sample);
    expect(hits.map((h) => h.replace(/^sample\.ts:\d+ /, ''))).toEqual([
      ".from('stock_movements').insert",
      ".from('stock_movements').update",
      ".from('stock_movements').upsert",
      ".from('stock_movements').delete",
      ".from('stock_movements') (builder not followed by a verb)",
      ".from('stock_movements') (builder not followed by a verb)",
    ]);
  });

  // Every way a writer could name the table without a plain .from('...') read
  // (the review's evasion list): each must be caught on its own line.
  it.each([
    ['a constant', "const T = 'stock_movements'; sb.from(T).insert({});"],
    ['as const', "sb.from('stock_movements' as const).insert({});"],
    ['parentheses', "sb.from(('stock_movements')).insert({});"],
    ['a template with a part', "const p = 'stock'; sb.from(`${p}_movements`).insert({});"],
    ['a concatenation', "sb.from('stock_' + 'movements').insert({});"],
    ['element access', "sb['from']('stock_movements').insert({});"],
    ['a helper taking the name', "function w(t: string) { return sb.from(t).insert({}); } w('stock_movements');"],
    ['a read, then a write in the same chain', "sb.from('stock_movements').select('id').delete();"],
    ['optional chaining', "sb?.from('stock_movements')?.insert({});"],
    ['schema().from()', "sb.schema('public').from('stock_movements').upsert([]);"],
    ['a raw REST fetch', "fetch(url + '/rest/v1/stock_movements', { method: 'POST', body });"],
    ['a raw REST fetch in a template', 'fetch(`${url}/rest/v1/stock_movements`, { method: "POST", body });'],
    ['a string in an object', "post({ table: 'stock_movements', row });"],
  ])('control: %s is caught', (_label, code) => {
    expect(findLedgerWrites('sample.ts', code).length).toBeGreaterThan(0);
  });

  it('control: reads, comments, strings in types and the listed holders are not caught', () => {
    const reads = [
      "sb.from('stock_movements').select('id').eq('id', 1);",
      "sb.from(('stock_movements' as const)).select('id', { count: 'exact', head: true });",
      "sb?.from('stock_movements')?.select('id');",
      "// sb.from('stock_movements').insert({})",
      "/* fetch('/rest/v1/stock_movements', { method: 'POST' }) */",
      "type T = Database['public']['Tables']['stock_movements']['Row'];",
      "type U = 'stock_movements' | 'inventory_items';",
      "await readInActiveOrg(ctx, 'stock_movements', id, 'Movement not found.');",
    ].join('\n');
    expect(findLedgerWrites('sample.ts', reads)).toEqual([]);
  });

  it('the read helper that takes the table name only reads it', () => {
    const text = readFileSync(path.join(REPO, READ_HELPER.file), 'utf8');
    expect(text).toContain(`export async function ${READ_HELPER.name}`);
    expect(findBuilderWrites(READ_HELPER.file, text)).toEqual([]);
    expect(findBuilderWrites('sample.ts', 'sb.from(table).update({});')).toHaveLength(1);
  });
});
