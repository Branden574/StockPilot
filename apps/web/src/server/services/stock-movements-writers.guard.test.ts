/**
 * THE APPS ONLY READ THE MOVEMENT LEDGER (docket S8, migration 0454).
 *
 * Security invariant (listed in scripts/security-test.sh).
 *
 * Every row of stock_movements is written by the database's stock-ledger
 * functions: adjust, transfer, receipts, counts, kits, returns, orders, and,
 * since 0454, an item's opening stock (open_item_stock, which every create
 * path and Duplicate call). The web app, the phone and the shared packages
 * read the table and never write it. This file holds the code to that.
 *
 * WHAT IS SCANNED. Every source file (.ts .tsx .js .jsx .mjs .cjs .mts .cts)
 * that git lists under apps/web/src, apps/mobile and packages (tracked files
 * and new files that are not ignored). Declaration files and test or spec
 * files are left out: they never ship. Comments and strings are never code:
 * the scan reads the TypeScript syntax tree.
 *
 * THE RULE. A `.from('stock_movements')` (a string or a plain template) is
 * followed directly by `.select(`. Anything else fails: `.insert(`,
 * `.update(`, `.upsert(`, `.delete(`, or a builder kept in a variable or
 * handed on, where the verb cannot be read.
 *
 * IF THIS FAILS. Write the movement through a ledger function (an RPC), never
 * through the table.
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

function literalText(node: ts.Node | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

/** Every `.from('stock_movements')` not followed directly by `.select(`. */
function findLedgerWrites(fileName: string, text: string): string[] {
  const kind = /\.(tsx|jsx)$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'from' &&
      literalText(node.arguments[0]) === TABLE
    ) {
      const parent = node.parent;
      const next =
        parent && ts.isPropertyAccessExpression(parent) && parent.expression === node
          ? parent.name.text
          : null;
      const nextIsCall =
        next !== null && parent.parent && ts.isCallExpression(parent.parent) && parent.parent.expression === parent;
      if (next !== 'select' || !nextIsCall) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        found.push(`${fileName}:${line + 1} .from('${TABLE}')${next ? `.${next}` : ' (builder not followed by a verb)'}`);
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

  it('every .from(stock_movements) is followed directly by .select(', () => {
    const found: string[] = [];
    let reads = 0;
    for (const f of files) {
      const text = readFileSync(path.join(REPO, f), 'utf8');
      if (!text.includes(TABLE)) continue;
      found.push(...findLedgerWrites(f, text));
      reads += (text.match(/\.from\(\s*['"`]stock_movements['"`]\s*\)/g) ?? []).length;
    }
    expect(found, 'write the movement through a ledger function (an RPC)').toEqual([]);
    // The scan sees the reads that exist (activity, reports, the phone).
    expect(reads).toBeGreaterThan(10);
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
      "const s = \"sb.from('stock_movements').insert({})\";",
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
});
