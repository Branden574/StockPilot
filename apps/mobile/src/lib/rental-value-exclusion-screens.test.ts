import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { attrText, parseTsx, tagOf, walkJsx, type JsxNode } from './__fixtures__/jsx-touch-audit';

/**
 * B78: Inventory value leaves out rental items, on the phone as on the web.
 * WIRING PINS for the Reports screen, whose reads live inline in the
 * component (the vitest config keeps app/ and screen modules out of the
 * run, so the source is read with the TypeScript parser).
 *
 * VALUE on Home and on Reports reads the inventory_value RPC, which leaves
 * rental items out since the B78 migration: no phone change. Avg value / SKU
 * on Reports divided that value by ITEMS, a count that still includes rental
 * items (the counts follow-up), so the two numbers would describe different
 * sets of items. Reports now runs one more head count, the active items
 * that are not rental items, inside the same Promise.all as every other
 * figure, so a failed read shows "couldn't load", never a zero, and Avg
 * value / SKU divides by it. ITEMS keeps its count.
 */

const REPORTS = 'src/screens/reports.tsx';
const source = readFileSync(path.resolve(__dirname, '../..', REPORTS), 'utf8');
const sf = parseTsx(source, REPORTS);
const flat = (node: ts.Node): string => node.getText(sf).replace(/\s+/g, ' ');

function find<T extends ts.Node>(test: (n: ts.Node) => n is T): T[] {
  const out: T[] = [];
  const visit = (n: ts.Node) => {
    if (test(n)) out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** The figures' reads: the array handed to Promise.all in load(). */
const reads = (() => {
  const calls = find(
    (n): n is ts.CallExpression =>
      ts.isCallExpression(n) && n.expression.getText(sf) === 'Promise.all',
  );
  if (calls.length !== 1) throw new Error(`expected one Promise.all, found ${calls.length}`);
  const arg = calls[0]!.arguments[0];
  if (!arg || !ts.isArrayLiteralExpression(arg)) throw new Error('Promise.all takes no array');
  return arg.elements.map((e) => flat(e));
})();

/** The names the results are destructured into, in order. */
const names = (() => {
  const decls = find(
    (n): n is ts.VariableDeclaration =>
      ts.isVariableDeclaration(n) &&
      ts.isArrayBindingPattern(n.name) &&
      n.initializer?.getText(sf) === 'results',
  );
  if (decls.length !== 1)
    throw new Error(`expected one destructuring of results, found ${decls.length}`);
  return (decls[0]!.name as ts.ArrayBindingPattern).elements.map((e) => e.getText(sf));
})();

const rentalExcluded = (read: string) =>
  read.includes("supabase .from('inventory_items')") &&
  read.includes(".select('id', { count: 'exact', head: true })") &&
  read.includes(".eq('is_rental', false)");

describe('phone Reports: Avg value / SKU leaves rental items out (B78)', () => {
  it('one head count of the active items that are not rental items is among the figures’ reads', () => {
    const hits = reads.filter(rentalExcluded);
    expect(hits).toHaveLength(1);
    // The same items ITEMS counts, less the rental items: this organization,
    // active, not deleted.
    expect(hits[0]).toContain(".eq('organization_id', orgId)");
    expect(hits[0]).toContain(".eq('status', 'active')");
    expect(hits[0]).toContain(".is('deleted_at', null)");
  });

  it('its result feeds valueItemCount, and a failed read is "couldn’t load", never a zero', () => {
    const at = reads.findIndex(rentalExcluded);
    expect(at, 'the rental-free head count is among the reads').toBeGreaterThan(-1);
    expect(names).toHaveLength(reads.length);
    const name = names[at]!;
    expect(flat(sf)).toContain(`valueItemCount: ${name}.count ?? 0,`);
    expect(flat(sf)).toMatch(/interface ReportSummary \{[^}]*valueItemCount: number;/);
    // Every read of the array is checked before the figures are set.
    const check = source.indexOf('if (results.some((r) => r.error)) {');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(source.indexOf("kind: 'ready',"));
  });

  it('Avg value / SKU divides VALUE by that count, never by ITEMS', () => {
    const rows: JsxNode[] = [];
    walkJsx(sf, (el) => {
      if (tagOf(el, sf) === 'ReportRow' && attrText(el, 'title', sf) === 'Avg value / SKU') {
        rows.push(el);
      }
    });
    expect(rows).toHaveLength(1);
    const value = attrText(rows[0]!, 'value', sf)!.replace(/\s+/g, ' ');
    expect(value).toContain(
      'summary.valueItemCount > 0 ? summary.inventoryValue / summary.valueItemCount : 0',
    );
    expect(value).not.toContain('summary.itemCount');
  });

  it('ITEMS keeps counting rental items until the counts follow-up changes it on purpose', () => {
    const items = reads[names.indexOf('items')]!;
    expect(items).toContain("supabase .from('inventory_items')");
    expect(items).not.toContain('is_rental');
    expect(flat(sf)).toContain('itemCount: items.count ?? 0,');
  });
});
